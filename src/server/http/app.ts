/**
 * The local HTTP API. Bound to 127.0.0.1 by the entry point — this server reads the
 * user's files and talks to their Claude login, so it is never exposed.
 *
 * The app is a factory taking its dependencies, so tests drive it through
 * `app.request()` with a fake agent and a temporary cache.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { UnofficialStatusCode } from 'hono/utils/http-status';
import type {
  ApiError,
  ApplyRequest,
  CancelRequest,
  ChangeProgressEvent,
  ChangeRequest,
  ChangeStartResponse,
  ContextRequest,
  FileResponse,
  OpenRepoRequest,
  ProgressEvent,
  RefineRequest,
  RepoState,
} from '../../shared/api';
import { renderContextMarkdown } from '../../shared/context-markdown';
import { LEVELS, type Level } from '../../shared/graph';
import { AgentError, type ChangeAgent, type SchemaAgent } from '../agent/types';
import { generatableLevels } from '../agent/prompts';
import type { FileCache } from '../cache/file-cache';
import {
  ApplyConflictError,
  ChangeActiveError,
  ChangeNotFoundError,
  ChangeStateError,
  ChangeUnavailableError,
  NoRepoError,
  OutsideLimitsError,
  WorkspaceRefusedError,
} from '../change/manager';
import { staysInsideRepo } from '../indexer/files';
import { GenerationCancelledError, LevelNotSupportedError, RepoSession, ScopeNotFoundError } from '../session';

export interface AppDeps {
  agent: SchemaAgent;
  cache: FileCache;
  /** The change agent (SPEC §8.5); without one the change endpoints answer 501. */
  changeAgent?: ChangeAgent;
  /** Parent directory of the change worktrees. */
  workDir?: string;
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

const TERMINAL_EVENTS = new Set<string>(['done', 'error', 'cancelled']);

/**
 * A running job as Server-Sent Events: the buffered events are replayed on connect, live
 * ones follow, and the stream ends with the terminal event. A single `idle` event when
 * nothing is running. Shared by the generation and the change progress endpoints.
 */
function streamJob<E extends { type: string }>(
  c: Context,
  subscribe: (listener: (event: E) => void) => (() => void) | null,
  idle: E,
): Response {
  return streamSSE(c, async (stream) => {
    let finish: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Writes are serialised: the listener is synchronous but the write is not, and
    // two interleaved writes would corrupt the event framing.
    let queue = Promise.resolve();
    const send = (event: E) => {
      queue = queue
        .then(() => stream.writeSSE({ data: JSON.stringify(event), event: 'progress' }))
        .catch(() => undefined);
    };
    const detach = subscribe((event) => {
      send(event);
      if (TERMINAL_EVENTS.has(event.type)) finish();
    });
    if (!detach) {
      send(idle);
      await queue;
      return;
    }
    stream.onAbort(() => finish());
    await ended;
    detach();
    await queue;
  });
}

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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** The body of `POST /api/change`: a selection plus a non-empty instruction. */
function parseChangeRequest(body: unknown): ChangeRequest | null {
  const input = parseContextRequest(body);
  if (!input || typeof input.task !== 'string' || input.task.trim().length === 0) return null;
  return { nodeIds: input.nodeIds, edgeIds: input.edgeIds, task: input.task };
}

/** The body of `POST /api/context`, or null when it is not one. */
function parseContextRequest(body: unknown): ContextRequest | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (!isStringArray(record.nodeIds) || !isStringArray(record.edgeIds)) return null;
  if (record.task !== undefined && typeof record.task !== 'string') return null;
  return {
    nodeIds: record.nodeIds,
    edgeIds: record.edgeIds,
    ...(typeof record.task === 'string' ? { task: record.task } : {}),
  };
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
    changeAgent: deps.changeAgent?.name ?? null,
    activeChangeId: null,
  });

  const sessionDeps = () => ({
    agent: deps.agent,
    cache: deps.cache,
    ...(deps.changeAgent ? { changeAgent: deps.changeAgent } : {}),
    ...(deps.workDir ? { workDir: deps.workDir } : {}),
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
    // The same repository again (a second browser tab, a reload that re-posts the path):
    // the session stays, and with it the open change.
    if (session && session.repoPath === path) return c.json(session.state());
    // Another repository: the old session's open change would be unreachable from now
    // on, so it is cancelled and its worktree removed before the switch.
    if (session) await session.close();
    try {
      session = new RepoSession(path, sessionDeps());
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
    return streamJob<ProgressEvent>(c, (listener) => active.subscribe(level, scopeId, listener), { type: 'idle', level, scopeId });
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

  /**
   * The structured context of a selection (SPEC §8.4), from the views this session has
   * already produced. Never generates: an id of a view not loaded yet becomes a warning.
   * `?format=markdown` renders the same context as text.
   */
  app.post('/api/context', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const body = await c.req.json().catch(() => null);
    const input = parseContextRequest(body);
    if (!input) {
      return c.json({ error: 'A JSON body with nodeIds and edgeIds (string arrays) and an optional task is required.' }, 400);
    }
    const context = session.selectionContext(input);
    if (c.req.query('format') === 'markdown') {
      return c.text(renderContextMarkdown(context), 200, { 'content-type': 'text/markdown; charset=utf-8' });
    }
    return c.json(context);
  });

  /* ---- Prompt → Change → Verify (SPEC §6.4, §6.5, FR-09..FR-11) ---------------------- */

  /** Maps the change manager's typed errors to status codes; 500 for anything else. */
  const failed = (c: Context, err: unknown): Response => {
    const reply = (status: 404 | 409 | 500 | 501 | 502, error: string, extra: Partial<ApiError> = {}) =>
      c.json({ error, ...extra } satisfies ApiError, status);
    if (err instanceof ChangeNotFoundError) return reply(404, err.message);
    if (err instanceof ChangeUnavailableError) return reply(501, err.message);
    if (err instanceof NoRepoError || err instanceof WorkspaceRefusedError) return reply(409, err.message);
    if (err instanceof ChangeActiveError) return reply(409, err.message, { detail: err.activeId });
    if (err instanceof ChangeStateError) return reply(409, err.message);
    if (err instanceof ApplyConflictError) return reply(409, err.message, err.files.length ? { conflictFiles: err.files } : {});
    if (err instanceof OutsideLimitsError) return reply(409, err.message, { outsideFiles: err.files });
    if (err instanceof AgentError) return reply(502, err.message, err.detail ? { detail: err.detail } : {});
    return reply(500, err instanceof Error ? err.message : String(err));
  };

  /**
   * Starts a change over a selection: the context is built from the loaded views, a
   * worktree mirroring the working tree is created and the change agent runs in it.
   * One open change per session (409 otherwise); 409 for a directory without git.
   */
  app.post('/api/change', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const body = await c.req.json().catch(() => null);
    const input = parseChangeRequest(body);
    if (!input) {
      return c.json({ error: 'A JSON body with nodeIds and edgeIds (string arrays) and a non-empty task is required.' }, 400);
    }
    try {
      const started: ChangeStartResponse = session.changes.start(input);
      return c.json(started);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.get('/api/change/:id', (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    try {
      return c.json(session.changes.status(c.req.param('id')));
    } catch (err) {
      return failed(c, err);
    }
  });

  app.get('/api/change/:id/progress', (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const id = c.req.param('id');
    const active = session;
    try {
      active.changes.status(id);
    } catch (err) {
      return failed(c, err);
    }
    return streamJob<ChangeProgressEvent>(c, (listener) => active.changes.subscribe(id, listener), { type: 'idle', changeId: id });
  });

  app.post('/api/change/:id/cancel', (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    try {
      return c.json({ cancelled: session.changes.cancel(c.req.param('id')) });
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post('/api/change/:id/refine', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as Partial<RefineRequest>;
    if (typeof body.task !== 'string' || body.task.trim().length === 0) {
      return c.json({ error: 'A non-empty task is required.' }, 400);
    }
    try {
      session.changes.refine(c.req.param('id'), body.task);
      return c.json(session.changes.status(c.req.param('id')));
    } catch (err) {
      return failed(c, err);
    }
  });

  /**
   * Lands the patch in the user's tree. 409 with `outsideFiles` when a file lies outside
   * the selected area and `confirmOutside` is not set; 409 when the repository moved or
   * the patch does not apply — nothing is applied then.
   */
  app.post('/api/change/:id/apply', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as Partial<ApplyRequest>;
    if (body.confirmOutside !== undefined && typeof body.confirmOutside !== 'boolean') {
      return c.json({ error: 'confirmOutside must be a boolean.' }, 400);
    }
    try {
      return c.json(session.changes.apply(c.req.param('id'), body.confirmOutside === true));
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post('/api/change/:id/discard', async (c) => {
    if (!session) return c.json({ error: 'No repository is open.' }, 409);
    try {
      await session.changes.discard(c.req.param('id'));
      return c.json(session.changes.status(c.req.param('id')));
    } catch (err) {
      return failed(c, err);
    }
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
