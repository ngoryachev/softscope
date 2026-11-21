/**
 * Prompt → Change → Verify beyond the fake agent's one appended line: deletions, binary
 * files, a file created and removed again across a refinement, linked dependencies,
 * cancel during the checks, discard while the agent runs, and the user's uncommitted
 * deletions and staged additions. Custom in-test agents, no Claude.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/http/app';
import { FakeSchemaAgent } from '../src/server/agent/fake';
import { FakeChangeAgent } from '../src/server/agent/fake-change';
import type { ChangeAgent, ChangeRunRequest } from '../src/server/agent/types';
import { RepoSession } from '../src/server/session';
import type { ApiError, ApplyResponse, ChangeStatus } from '../src/shared/api';
import type { ChangeResult } from '../src/shared/change-schema';
import {
  agentGraph,
  cleanupTemps,
  commitAll,
  copyFixtureAsGitRepo,
  gitOut,
  sseEvents,
  tempCache,
  tempWorkDir,
  waitFor,
} from './helpers';

afterAll(cleanupTemps);

const APP_ID = 'L4:root/app';
const LOGGING_ID = `L3:${APP_ID}/logging`;
const LOG_FILE = 'src/util/log.ts';

const l4Reply = agentGraph([
  {
    slug: 'app',
    kind: 'application',
    title: 'sample-app',
    paths: ['src'],
    hasDetail: true,
    evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 5 }],
  },
]);

const l3Reply = agentGraph([
  {
    slug: 'logging',
    title: 'logging',
    paths: ['src/util'],
    hasDetail: true,
    evidence: [{ file: LOG_FILE, startLine: 1, endLine: 3 }],
  },
]);

type App = ReturnType<typeof createApp>['app'];

let repo: string;
let workDir: string;

/** A change agent scripted per call: each step edits the worktree and returns its report. */
function scripted(steps: Array<(req: ChangeRunRequest) => Partial<ChangeResult> | void>): ChangeAgent & { calls: ChangeRunRequest[] } {
  const calls: ChangeRunRequest[] = [];
  return {
    name: 'scripted',
    calls,
    async run(req) {
      calls.push(req);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      const partial = step ? step(req) ?? {} : {};
      return { summary: 'scripted', changedFiles: [], checks: [], scopeExpansion: null, ...partial };
    },
  };
}

function build(changeAgent: ChangeAgent): App {
  const schemaAgent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply, [`L3:${APP_ID}`]: l3Reply }, strict: true });
  const deps = { agent: schemaAgent, cache: tempCache(), changeAgent, workDir };
  const session = new RepoSession(repo, deps);
  return createApp({ ...deps, session }).app;
}

const post = (app: App, url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function loadViews(app: App): Promise<void> {
  expect((await app.request('/api/graph?level=L4&scope=root')).status).toBe(200);
  expect((await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`)).status).toBe(200);
}

async function startChange(app: App, task = 'do the thing'): Promise<string> {
  const res = await post(app, '/api/change', { nodeIds: [LOGGING_ID], edgeIds: [], task });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const status = async (app: App, id: string): Promise<ChangeStatus> => {
  const res = await app.request(`/api/change/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ChangeStatus;
};

async function settled(app: App, id: string): Promise<ChangeStatus> {
  let last: ChangeStatus | null = null;
  await waitFor(() => {
    void status(app, id).then((s) => {
      last = s;
    });
    return last !== null && (last as ChangeStatus).status !== 'running';
  }, 15_000);
  return status(app, id);
}

const worktrees = (dir: string) => gitOut(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));

beforeEach(() => {
  repo = copyFixtureAsGitRepo();
  workDir = tempWorkDir();
});

describe('the diff beyond appended lines', () => {
  it('reports a file the agent deleted and removes it from the user tree on apply', async () => {
    const agent = scripted([
      (req) => {
        rmSync(join(req.workspaceDir, LOG_FILE));
        return { changedFiles: [LOG_FILE] };
      },
    ]);
    const app = build(agent);
    await loadViews(app);
    const done = await settled(app, await startChange(app, 'remove the logger'));

    expect(done.status).toBe('done');
    expect(done.files.map((f) => [f.path, f.status, f.outsideLimits])).toEqual([[LOG_FILE, 'deleted', false]]);
    expect(done.affected.map((a) => a.nodeId)).toEqual([APP_ID, LOGGING_ID]);
    expect(existsSync(join(repo, LOG_FILE))).toBe(true);

    const res = await post(app, `/api/change/${done.id}/apply`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApplyResponse).applied).toEqual([LOG_FILE]);
    expect(existsSync(join(repo, LOG_FILE))).toBe(false);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe(` D ${LOG_FILE}`.trim());
  });

  it('carries a binary change through the diff and applies it byte for byte', async () => {
    const BLOB = 'src/util/blob.bin';
    const before = Buffer.from([0, 1, 2, 3, 0, 255]);
    const after = Buffer.from([0, 9, 9, 9, 0, 255, 7]);
    writeFileSync(join(repo, BLOB), before);
    commitAll(repo, 'binary');

    const agent = scripted([
      (req) => {
        writeFileSync(join(req.workspaceDir, BLOB), after);
        return { changedFiles: [BLOB] };
      },
    ]);
    const app = build(agent);
    await loadViews(app);
    const done = await settled(app, await startChange(app, 'rewrite the blob'));

    expect(done.files).toHaveLength(1);
    expect(done.files[0]).toMatchObject({ path: BLOB, binary: true, status: 'modified', outsideLimits: false, hunks: [] });

    expect((await post(app, `/api/change/${done.id}/apply`, {})).status).toBe(200);
    expect(readFileSync(join(repo, BLOB))).toEqual(after);
  });

  it('drops a file from the diff when a refinement removes what the first run created, and the rest still applies', async () => {
    const NEW = 'src/util/created.ts';
    const agent = scripted([
      (req) => {
        writeFileSync(join(req.workspaceDir, NEW), 'export const created = 1;\n');
        appendFileSync(join(req.workspaceDir, LOG_FILE), '// first run\n');
        return { changedFiles: [NEW, LOG_FILE] };
      },
      (req) => {
        rmSync(join(req.workspaceDir, NEW));
        return { changedFiles: [NEW] };
      },
    ]);
    const app = build(agent);
    await loadViews(app);
    const id = await startChange(app, 'create a helper');
    const first = await settled(app, id);
    expect(first.files.map((f) => [f.path, f.status])).toEqual([[NEW, 'added'], [LOG_FILE, 'modified']]);

    expect((await post(app, `/api/change/${id}/refine`, { task: 'drop the helper again' })).status).toBe(200);
    const second = await settled(app, id);
    expect(second.status).toBe('done');
    // The helper is back to "never existed": only the log edit remains, and it must apply.
    expect(second.files.map((f) => [f.path, f.status])).toEqual([[LOG_FILE, 'modified']]);
    const apply = await post(app, `/api/change/${id}/apply`, {});
    expect(apply.status, JSON.stringify(await apply.clone().json())).toBe(200);
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('// first run');
    expect(existsSync(join(repo, NEW))).toBe(false);
  });

  it('reports a rename done as delete plus create, and applies it', async () => {
    const agent = scripted([
      (req) => {
        const text = readFileSync(join(req.workspaceDir, LOG_FILE), 'utf8');
        rmSync(join(req.workspaceDir, LOG_FILE));
        writeFileSync(join(req.workspaceDir, 'src/util/logger.ts'), text);
        return { changedFiles: [LOG_FILE, 'src/util/logger.ts'] };
      },
    ]);
    const app = build(agent);
    await loadViews(app);
    const done = await settled(app, await startChange(app, 'rename log.ts to logger.ts'));
    expect(done.status).toBe('done');
    const byPath = Object.fromEntries(done.files.map((f) => [f.path, f]));
    expect(byPath['src/util/logger.ts']).toMatchObject({ outsideLimits: false });
    expect(byPath['src/util/logger.ts']!.status === 'renamed' || byPath['src/util/logger.ts']!.status === 'added').toBe(true);
    if (byPath['src/util/logger.ts']!.status === 'added') expect(byPath[LOG_FILE]).toMatchObject({ status: 'deleted' });
    else expect(byPath['src/util/logger.ts']!.oldPath).toBe(LOG_FILE);
    expect(done.affected.map((a) => a.nodeId)).toEqual([APP_ID, LOGGING_ID]);

    expect((await post(app, `/api/change/${done.id}/apply`, {})).status).toBe(200);
    expect(existsSync(join(repo, LOG_FILE))).toBe(false);
    expect(existsSync(join(repo, 'src/util/logger.ts'))).toBe(true);
  });

  it('keeps a file the first run created and a refinement edited as one addition', async () => {
    const NEW = 'src/util/created.ts';
    const agent = scripted([
      (req) => {
        writeFileSync(join(req.workspaceDir, NEW), 'export const created = 1;\n');
        return { changedFiles: [NEW] };
      },
      (req) => {
        writeFileSync(join(req.workspaceDir, NEW), 'export const created = 2;\n');
        return { changedFiles: [NEW] };
      },
    ]);
    const app = build(agent);
    await loadViews(app);
    const id = await startChange(app, 'create a helper');
    await settled(app, id);
    expect((await post(app, `/api/change/${id}/refine`, { task: 'bump it' })).status).toBe(200);
    const second = await settled(app, id);
    expect(second.files.map((f) => [f.path, f.status])).toEqual([[NEW, 'added']]);
    const added = second.files[0]!.hunks.flatMap((h) => h.lines.filter((l) => l.type === '+').map((l) => l.text));
    expect(added).toEqual(['export const created = 2;']);

    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(200);
    expect(readFileSync(join(repo, NEW), 'utf8')).toBe('export const created = 2;\n');
  });
});

describe('the user tree the worktree reproduces', () => {
  it('mirrors an uncommitted deletion and a staged new file, and the diff stays the agent’s own', async () => {
    rmSync(join(repo, 'src/cli.ts'));
    writeFileSync(join(repo, 'src/staged.ts'), 'export const staged = 1;\n');
    gitOut(repo, ['add', 'src/staged.ts']);

    const app = build(new FakeChangeAgent());
    await loadViews(app);
    const done = await settled(app, await startChange(app, 'prefix log lines'));

    expect(done.status).toBe('done');
    expect(existsSync(join(done.workspaceDir, 'src/cli.ts'))).toBe(false);
    expect(readFileSync(join(done.workspaceDir, 'src/staged.ts'), 'utf8')).toBe('export const staged = 1;\n');
    expect(done.files.map((f) => f.path)).toEqual([LOG_FILE]);

    expect((await post(app, `/api/change/${done.id}/apply`, {})).status).toBe(200);
    // The user's own state is untouched by the apply: still deleted, still staged.
    const porcelain = gitOut(repo, ['status', '--porcelain']).split('\n').filter(Boolean).sort();
    expect(porcelain).toEqual([' D src/cli.ts', ` M ${LOG_FILE}`, 'A  src/staged.ts']);
  });

  it('links ignored node_modules of the root and of a package into the worktree, and removing the worktree leaves them alone', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    gitOut(repo, ['rm', '-r', '-q', '--cached', 'node_modules']);
    gitOut(repo, ['add', '.gitignore']);
    gitOut(repo, ['commit', '--quiet', '-m', 'ignore dependencies']);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    mkdirSync(join(repo, 'packages/core/node_modules/dep'), { recursive: true });
    writeFileSync(join(repo, 'packages/core/node_modules/dep/package.json'), '{"name":"dep"}\n');

    const app = build(new FakeChangeAgent());
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);
    expect(done.status).toBe('done');
    expect(done.startSnapshot.dirty).toBe(false);

    const rootLink = join(done.workspaceDir, 'node_modules');
    const pkgLink = join(done.workspaceDir, 'packages/core/node_modules');
    expect(lstatSync(rootLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(pkgLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(rootLink, 'left-pad/package.json'))).toBe(true);
    expect(existsSync(join(pkgLink, 'dep/package.json'))).toBe(true);
    // Linked dependencies are not part of the change.
    expect(done.files.map((f) => f.path)).toEqual([LOG_FILE]);

    expect((await post(app, `/api/change/${id}/discard`)).status).toBe(200);
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(existsSync(join(repo, 'node_modules/left-pad/package.json'))).toBe(true);
    expect(existsSync(join(repo, 'packages/core/node_modules/dep/package.json'))).toBe(true);
    expect(worktrees(repo)).toHaveLength(1);
  });

  it('removes the worktree on apply without touching the linked dependencies', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    gitOut(repo, ['rm', '-r', '-q', '--cached', 'node_modules']);
    gitOut(repo, ['add', '.gitignore']);
    gitOut(repo, ['commit', '--quiet', '-m', 'ignore dependencies']);

    const app = build(new FakeChangeAgent());
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);
    expect(lstatSync(join(done.workspaceDir, 'node_modules')).isSymbolicLink()).toBe(true);

    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(200);
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(existsSync(join(repo, 'node_modules/left-pad/package.json'))).toBe(true);
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('softscope:');
  });
});

describe('cancel and discard while work is under way', () => {
  it('cancel during the checks stops the running check and reports a cancelled change', async () => {
    // The user's uncommitted package.json is reproduced in the worktree, so the slow
    // typecheck below is what the server runs there.
    const pkgPath = join(repo, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts = { typecheck: 'node -e "console.log(\'slow start\'); setTimeout(() => {}, 30000)"' };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const agent = scripted([
      (req) => {
        writeFileSync(join(req.workspaceDir, LOG_FILE), 'export function log() { return "changed"; }\n');
        return { changedFiles: [LOG_FILE] };
      },
    ]);
    const app = build(agent);
    await loadViews(app);
    const id = await startChange(app, 'change the logger');
    const stream = await app.request(`/api/change/${id}/progress`);
    // Wait until the server reports the check as its current activity.
    const seen: string[] = [];
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const readUntilCheck = async () => {
      while (!seen.some((e) => e.includes('"tool":"check"'))) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        seen.push(...lines.filter((l) => l.startsWith('data: ')));
      }
    };
    await readUntilCheck();
    expect(seen.some((e) => e.includes('npm run typecheck'))).toBe(true);

    const startedCancel = Date.now();
    const cancel = await post(app, `/api/change/${id}/cancel`);
    expect(await cancel.json()).toEqual({ cancelled: true });
    const after = await settled(app, id);
    // The 30 s check was killed, not waited for.
    expect(Date.now() - startedCancel).toBeLessThan(10_000);
    expect(after.status).toBe('cancelled');
    // Whatever the agent did before the cancel is still shown.
    expect(after.files.map((f) => f.path)).toEqual([LOG_FILE]);
    expect(after.result?.changedFiles).toEqual([LOG_FILE]);
    expect(existsSync(after.workspaceDir)).toBe(true);
    reader.releaseLock();
    expect((await post(app, `/api/change/${id}/discard`)).status).toBe(200);
  });

  it('discard while the agent runs aborts it, removes the worktree and stays discarded', async () => {
    const app = build(new FakeChangeAgent({ delayMs: 5000 }));
    await loadViews(app);
    const id = await startChange(app);
    const before = await status(app, id);
    expect(before.status).toBe('running');
    const stream = await app.request(`/api/change/${id}/progress`);

    const res = await post(app, `/api/change/${id}/discard`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChangeStatus).status).toBe('discarded');
    const events = sseEvents(await stream.text());
    expect(events.map((e) => e.type)).toEqual(['started', 'cancelled']);

    // The aborted run must not flip the state back to "cancelled" afterwards.
    await new Promise((r) => setTimeout(r, 100));
    expect((await status(app, id)).status).toBe('discarded');
    expect(existsSync(before.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    // A new change can start right away.
    const next = await settled(app, await startChange(app, 'again'));
    expect(next.status).toBe('done');
  });
});
