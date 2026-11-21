/**
 * The local HTTP API. Bound to 127.0.0.1 by the entry point — this server reads the
 * user's files and talks to their Claude login, so it is never exposed.
 *
 * The app is a factory taking its dependencies, so tests drive it through
 * `app.request()` with a fake agent and a temporary cache.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { UnofficialStatusCode } from 'hono/utils/http-status';
import type { ApiError, CancelRequest, FileResponse, OpenRepoRequest, ProgressEvent, RepoState } from '../../shared/api';
import { LEVELS, type Level } from '../../shared/graph';
import { AgentError, type SchemaAgent } from '../agent/types';
import { generatableLevels } from '../agent/prompts';
import type { FileCache } from '../cache/file-cache';
import { staysInsideRepo } from '../indexer/files';
import { GenerationCancelledError, LevelNotSupportedError, RepoSession, ScopeNotFoundError } from '../session';

export interface AppDeps {
  agent: SchemaAgent;
  cache: FileCache;
  /** Pre-opened repository; otherwise the UI posts a path to /api/repo. */
  session?: RepoSession;
}

export interface SoftscopeApp {
  app: Hono;
  current(): RepoSession | null;
}

const MAX_VIEWED_LINES = 4000;

/** nginx's "client closed request": the generation was cancelled, there is no view. */
const CANCELLED_STATUS = 499 as UnofficialStatusCode;

const TERMINAL_EVENTS = new Set<ProgressEvent['type']>(['done', 'error', 'cancelled']);

function isLevel(value: string | undefined): value is Level {
  return value !== undefined && (LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve a repository-relative path, refusing anything that leaves the repository —
 * including through a symlink inside it, which the lexical check alone cannot see.
 */
function safeResolve(repoPath: string, candidate: string): string | null {
  if (candidate.length === 0 || isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate)) return null;
  const abs = resolve(repoPath, candidate);
  const rel = relative(repoPath, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!staysInsideRepo(repoPath, abs)) return null;
  return abs;
}

export function createApp(deps: AppDeps): SoftscopeApp {
  let session: RepoSession | null = deps.session ?? null;
  const app = new Hono();

  const emptyState = (): RepoState => ({
    repoPath: null,
    repoName: '',
    isGitRepo: false,
    snapshot: null,
    generatableLevels: generatableLevels(),
    fakeAgent: deps.agent.name === 'fake',
  });

  app.get('/api/state', (c) => c.json(session ? session.state() : emptyState()));

  app.post('/api/repo', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<OpenRepoRequest>;
    if (typeof body.path !== 'string' || body.path.trim().length === 0) {
      return c.json({ error: 'A repository path is required.' }, 400);
    }
    const path = resolve(body.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    try {
      if (!statSync(path).isDirectory()) return c.json({ error: `${path} is not a directory.` }, 400);
    } catch {
      return c.json({ error: `${path} does not exist.` }, 400);
    }
    try {
      session = new RepoSession(path, { agent: deps.agent, cache: deps.cache });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(session.state());
  });

  app.get('/api/snapshot', (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    return c.json(session.liveSnapshot());
  });

  app.get('/api/graph', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const level = c.req.query('level') ?? 'L4';
    if (!isLevel(level)) return c.json({ error: `Unknown level "${level}".` }, 400);
    const scopeId = c.req.query('scope') ?? 'root';
    const refresh = c.req.query('refresh') === '1';
    try {
      return c.json(await session.graph({ level, scopeId, refresh }));
    } catch (err) {
      if (err instanceof GenerationCancelledError) {
        return c.json({ error: 'cancelled', detail: err.message } satisfies ApiError, CANCELLED_STATUS);
      }
      if (err instanceof ScopeNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof LevelNotSupportedError) return c.json({ error: err.message }, 501);
      if (err instanceof AgentError) {
        const failure: ApiError = { error: err.message, ...(err.detail ? { detail: err.detail } : {}) };
        return c.json(failure, 502);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * The progress of a running generation as Server-Sent Events: the buffered events are
   * replayed on connect, live ones follow, and the stream ends with the terminal event.
   * A single `idle` event when nothing is running for that scope.
   */
  app.get('/api/graph/progress', (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const level = c.req.query('level') ?? 'L4';
    if (!isLevel(level)) return c.json({ error: `Unknown level "${level}".` }, 400);
    const scopeId = c.req.query('scope') ?? 'root';
    const active = session;
    return streamSSE(c, async (stream) => {
      let finish: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // Writes are serialised: the listener is synchronous but the write is not, and
      // two interleaved writes would corrupt the event framing.
      let queue = Promise.resolve();
      const send = (event: ProgressEvent) => {
        queue = queue
          .then(() => stream.writeSSE({ data: JSON.stringify(event), event: 'progress' }))
          .catch(() => undefined);
      };
      const detach = active.subscribe(level, scopeId, (event) => {
        send(event);
        if (TERMINAL_EVENTS.has(event.type)) finish();
      });
      if (!detach) {
        send({ type: 'idle', level, scopeId });
        await queue;
        return;
      }
      stream.onAbort(() => finish());
      await ended;
      detach();
      await queue;
    });
  });

  app.post('/api/graph/cancel', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as Partial<CancelRequest>;
    if (!isLevel(body.level) || typeof body.scopeId !== 'string') {
      return c.json({ error: 'A level and a scopeId are required.' }, 400);
    }
    const cancelled = session.cancel(body.level, body.scopeId);
    return c.json({ cancelled });
  });

  app.get('/api/file', (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const path = c.req.query('path') ?? '';
    const abs = safeResolve(session.repoPath, path);
    if (!abs) return c.json({ error: 'Path is outside the analyzed repository.' }, 400);
    let text: string;
    try {
      if (!statSync(abs).isFile()) return c.json({ error: 'Not a file.' }, 404);
      text = readFileSync(abs, 'utf8');
    } catch {
      return c.json({ error: 'File not found.' }, 404);
    }
    const all = text.split('\n');
    if (all[all.length - 1] === '') all.pop();
    const body: FileResponse = {
      path: sep === '/' ? relative(session.repoPath, abs) : relative(session.repoPath, abs).split(sep).join('/'),
      lines: all.slice(0, MAX_VIEWED_LINES),
      truncated: all.length > MAX_VIEWED_LINES,
    };
    return c.json(body);
  });

  return { app, current: () => session };
}

/** Serves the built UI from `dist/web` with an SPA fallback. Not used in tests. */
export async function mountWebUi(app: Hono, distDir: string): Promise<boolean> {
  let indexHtml: string;
  try {
    indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
  } catch {
    return false;
  }
  const { serveStatic } = await import('@hono/node-server/serve-static');
  // An absolute root: serve-static joins it with the (already traversal-checked)
  // request path, so the assets are found whatever directory the server was started in.
  app.use('/assets/*', serveStatic({ root: distDir }));
  app.get('*', (c) => c.html(indexHtml));
  return true;
}
