/**
 * Prompt → Change → Verify over the HTTP API, with the fake agents: worktree isolation,
 * the diff and its limits flags, affected components, the checks, apply and its guards,
 * discard, progress and cancel, refine. No Claude.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/http/app';
import { FakeSchemaAgent } from '../src/server/agent/fake';
import { FakeChangeAgent, type FakeChangeAgentOptions } from '../src/server/agent/fake-change';
import { RepoSession } from '../src/server/session';
import type { ApiError, ApplyResponse, ChangeStatus, RepoState } from '../src/shared/api';
import type { SelectionContext, Snapshot } from '../src/shared/graph';
import { ownerFile, workspaceOwner } from '../src/server/change/workspace';
import { spawnSync } from 'node:child_process';

/** The pid of a process that has already exited: an owner that is gone. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid!;
}
import {
  agentGraph,
  cleanupTemps,
  commitAll,
  copyFixture,
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
  {
    slug: 'core',
    kind: 'package',
    title: 'core',
    paths: ['packages/core'],
    evidence: [{ file: 'packages/core/src/math.ts', startLine: 1, endLine: 1 }],
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
  {
    slug: 'http',
    title: 'http',
    paths: ['src/server'],
    evidence: [{ file: 'src/server/http.ts', startLine: 1, endLine: 1 }],
  },
]);

let repo: string;
let workDir: string;
let schemaAgent: FakeSchemaAgent;
let changeAgent: FakeChangeAgent;

type App = ReturnType<typeof createApp>['app'];

function build(opts: FakeChangeAgentOptions = {}, over: { repo?: string; withChangeAgent?: boolean } = {}): App {
  const cache = tempCache();
  schemaAgent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply, [`L3:${APP_ID}`]: l3Reply }, strict: true });
  changeAgent = new FakeChangeAgent(opts);
  const withChange = over.withChangeAgent ?? true;
  const deps = {
    agent: schemaAgent,
    cache,
    ...(withChange ? { changeAgent } : {}),
    workDir,
  };
  const session = new RepoSession(over.repo ?? repo, deps);
  return createApp({ ...deps, session }).app;
}

const post = (app: App, url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

/** Loads L4 and L3 so the selection resolves and the views can be affected. */
async function loadViews(app: App): Promise<void> {
  expect((await app.request('/api/graph?level=L4&scope=root')).status).toBe(200);
  expect((await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`)).status).toBe(200);
}

async function startChange(app: App, task = 'add a prefix to log lines', nodeIds = [LOGGING_ID]): Promise<string> {
  const res = await post(app, '/api/change', { nodeIds, edgeIds: [], task });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const status = async (app: App, id: string): Promise<ChangeStatus> => {
  const res = await app.request(`/api/change/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ChangeStatus;
};

/** Waits until the agent and the checks are through. */
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

describe('POST /api/change — isolation and verification', () => {
  it('edits a worktree outside the repository and leaves the user tree untouched until apply', async () => {
    const app = build();
    await loadViews(app);
    const before = readFileSync(join(repo, LOG_FILE), 'utf8');

    const id = await startChange(app);
    const done = await settled(app, id);

    expect(done.status).toBe('done');
    expect(done.task).toBe('add a prefix to log lines');
    expect(done.workspaceDir.startsWith(workDir)).toBe(true);
    expect(done.workspaceDir.startsWith(repo)).toBe(false);
    expect(existsSync(join(done.workspaceDir, LOG_FILE))).toBe(true);
    expect(readFileSync(join(done.workspaceDir, LOG_FILE), 'utf8')).toContain('softscope: add a prefix to log lines');
    // The user's tree: same bytes, nothing to report to git.
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toBe(before);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    // The worktree is registered on the user's repository, with the main tree first.
    expect(worktrees(repo)).toHaveLength(2);

    expect(done.result).toMatchObject({ changedFiles: [LOG_FILE], scopeExpansion: null });
    expect(done.files).toHaveLength(1);
    expect(done.files[0]).toMatchObject({ path: LOG_FILE, status: 'modified', outsideLimits: false, binary: false });
    const added = done.files[0]!.hunks.flatMap((h) => h.lines.filter((l) => l.type === '+'));
    expect(added).toEqual([{ type: '+', text: '// softscope: add a prefix to log lines' }]);
    expect(done.context.limits.paths).toEqual(['src/util']);
    expect(done.startSnapshot.dirty).toBe(false);
    expect(done.history).toHaveLength(1);
    expect(done.history[0]).toMatchObject({ task: 'add a prefix to log lines' });
    expect(typeof done.history[0]!.finishedAt).toBe('string');
    expect(changeAgent.calls).toHaveLength(1);
    expect(changeAgent.calls[0]!.workspaceDir).toBe(done.workspaceDir);
    expect(changeAgent.calls[0]!.context.task).toBe('add a prefix to log lines');
  });

  it('runs the typecheck, lint and test scripts of the worktree with npm and reports each', async () => {
    const app = build();
    await loadViews(app);
    const done = await settled(app, await startChange(app));

    expect(done.checkCommands).toEqual(['npm run typecheck', 'npm run lint', 'npm run test']);
    expect(done.checks.map((c) => [c.name, c.ok, c.exitCode, c.timedOut])).toEqual([
      ['typecheck', true, 0, false],
      ['lint', false, 1, false],
      ['test', true, 0, false],
    ]);
    expect(done.checks[0]!.outputTail).toContain('typecheck ok');
    expect(done.checks[1]!.outputTail).toContain('lint failed: src/util/log.ts');
    expect(done.checks[1]!.command).toBe('npm run lint');
    // The agent may run the checks itself; the server hands it exactly these commands.
    expect(changeAgent.calls[0]!.checks.map((c) => c.argv)).toEqual([
      ['npm', 'run', 'typecheck'],
      ['npm', 'run', 'lint'],
      ['npm', 'run', 'test'],
    ]);
  });

  it('lists the components of the loaded views whose evidence or paths the change touched', async () => {
    const app = build();
    await loadViews(app);
    const done = await settled(app, await startChange(app));

    // The L3 node by evidence, the L4 application by its `src` path; `core` and `http` are not hit.
    expect(done.affected.map((a) => [a.nodeId, a.level, a.scope.id, a.files])).toEqual([
      [APP_ID, 'L4', 'root', [LOG_FILE]],
      [LOGGING_ID, 'L3', APP_ID, [LOG_FILE]],
    ]);
    expect(done.affectedViews.map((s) => `${s.level}:${s.id}`)).toEqual(['L4:root', `L3:${APP_ID}`]);
  });

  it('builds the change on top of the uncommitted changes and untracked files of the user tree', async () => {
    const app = build();
    await loadViews(app);
    appendFileSync(join(repo, 'src/index.ts'), '\nexport const userEdit = true;\n');
    writeFileSync(join(repo, 'src/extra.ts'), 'export const untracked = 1;\n');

    const done = await settled(app, await startChange(app));

    expect(done.startSnapshot.dirty).toBe(true);
    expect(readFileSync(join(done.workspaceDir, 'src/index.ts'), 'utf8')).toContain('userEdit');
    expect(readFileSync(join(done.workspaceDir, 'src/extra.ts'), 'utf8')).toBe('export const untracked = 1;\n');
    expect(readFileSync(join(done.workspaceDir, LOG_FILE), 'utf8')).toContain('softscope:');
    // The diff is the agent's work only: the user's own changes are the base.
    expect(done.files.map((f) => f.path)).toEqual([LOG_FILE]);
    // The user's dependencies are reachable from the worktree.
    expect(existsSync(join(done.workspaceDir, 'node_modules/left-pad/package.json'))).toBe(true);
  });

  it('refuses to start while the repository has unmerged paths', async () => {
    gitOut(repo, ['checkout', '--quiet', '-b', 'other']);
    writeFileSync(join(repo, LOG_FILE), 'export function log() { return "other"; }\n');
    commitAll(repo, 'other side');
    gitOut(repo, ['checkout', '--quiet', 'main']);
    writeFileSync(join(repo, LOG_FILE), 'export function log() { return "main"; }\n');
    commitAll(repo, 'main side');
    // A conflicting merge leaves unmerged paths behind.
    expect(() => gitOut(repo, ['merge', 'other'])).toThrow();
    expect(gitOut(repo, ['ls-files', '-u']).trim()).not.toBe('');

    const app = build();
    await loadViews(app);
    const res = await post(app, '/api/change', { nodeIds: [LOGGING_ID], edgeIds: [], task: 'x' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error).toMatch(/commit or stash/);
    expect(worktrees(repo)).toHaveLength(1);
  });

  it('answers 409 for a directory without git, and 501 without a change agent', async () => {
    const plain = copyFixture();
    const app = build({}, { repo: plain });
    const res = await post(app, '/api/change', { nodeIds: [], edgeIds: [], task: 'x' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error).toMatch(/git/);

    const without = build({}, { withChangeAgent: false });
    expect((await post(without, '/api/change', { nodeIds: [], edgeIds: [], task: 'x' })).status).toBe(501);
  });

  it('allows one open change at a time and a new one after discard', async () => {
    const app = build();
    await loadViews(app);
    const first = await startChange(app);
    const second = await post(app, '/api/change', { nodeIds: [LOGGING_ID], edgeIds: [], task: 'another' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: expect.stringContaining('still open'), detail: first });

    await settled(app, first);
    expect((await post(app, '/api/change', { nodeIds: [LOGGING_ID], edgeIds: [], task: 'another' })).status).toBe(409);

    expect((await post(app, `/api/change/${first}/discard`)).status).toBe(200);
    const third = await startChange(app, 'another');
    expect(third).not.toBe(first);
    expect((await settled(app, third)).status).toBe('done');
  });

  it('answers 409 when the selection resolves to nothing, without creating a worktree', async () => {
    const app = build();
    await loadViews(app);
    const res = await post(app, '/api/change', { nodeIds: ['L4:root/ghost'], edgeIds: [], task: 'x' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error).toMatch(/resolves to nothing/);
    expect(worktrees(repo)).toHaveLength(1);
    expect(changeAgent.calls).toHaveLength(0);
  });

  it('answers 400 for a malformed body and 404 for an unknown change', async () => {
    const app = build();
    expect((await post(app, '/api/change', 'not json')).status).toBe(400);
    expect((await post(app, '/api/change', { nodeIds: [], edgeIds: [] })).status).toBe(400);
    expect((await post(app, '/api/change', { nodeIds: [], edgeIds: [], task: '   ' })).status).toBe(400);
    expect((await post(app, '/api/change', { nodeIds: 'x', edgeIds: [], task: 'y' })).status).toBe(400);
    expect((await app.request('/api/change/nope')).status).toBe(404);
    expect((await app.request('/api/change/nope/progress')).status).toBe(404);
    expect((await post(app, '/api/change/nope/cancel')).status).toBe(404);
    expect((await post(app, '/api/change/nope/apply', {})).status).toBe(404);
    expect((await post(app, '/api/change/nope/discard')).status).toBe(404);
    expect((await post(app, '/api/change/nope/refine', { task: 'x' })).status).toBe(404);
  });

  it('answers 409 on every change endpoint when no repository is open', async () => {
    const cache = tempCache();
    const app = createApp({ agent: new FakeSchemaAgent(), cache, changeAgent: new FakeChangeAgent(), workDir }).app;
    expect((await post(app, '/api/change', { nodeIds: [], edgeIds: [], task: 'x' })).status).toBe(409);
    expect((await app.request('/api/change/x')).status).toBe(409);
    expect((await app.request('/api/change/x/progress')).status).toBe(409);
    expect((await post(app, '/api/change/x/cancel')).status).toBe(409);
    expect((await post(app, '/api/change/x/refine', { task: 'x' })).status).toBe(409);
    expect((await post(app, '/api/change/x/apply', {})).status).toBe(409);
    expect((await post(app, '/api/change/x/discard')).status).toBe(409);
  });

  it('passes a scope-expansion request through, and reports a failed agent', async () => {
    const app = build({ scopeExpansion: { needed: true, reason: 'the caller in src/index.ts must change too', suggestedPaths: ['src/index.ts'] } });
    await loadViews(app);
    const done = await settled(app, await startChange(app));
    expect(done.result?.scopeExpansion).toEqual({
      needed: true,
      reason: 'the caller in src/index.ts must change too',
      suggestedPaths: ['src/index.ts'],
    });

    expect((await post(app, `/api/change/${done.id}/discard`)).status).toBe(200);
    const broken = build({ fail: true });
    await loadViews(broken);
    const failed = await settled(broken, await startChange(broken));
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('told to fail');
    expect(failed.files).toEqual([]);
    expect(existsSync(failed.workspaceDir)).toBe(true); // kept for inspection or discard
  });
});

describe('POST /api/change/:id/apply and /discard', () => {
  it('applies the patch to the user tree, removes the worktree and returns the new snapshot', async () => {
    const app = build();
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);

    const res = await post(app, `/api/change/${id}/apply`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyResponse;
    expect(body.applied).toEqual([LOG_FILE]);
    expect(body.snapshot.stateId).not.toBe(done.startSnapshot.stateId);
    expect(body.snapshot.dirty).toBe(true);
    expect(body.affectedViews.map((s) => s.level)).toEqual(['L4', 'L3']);

    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('// softscope: add a prefix to log lines');
    // Applied, not committed, not staged.
    expect(gitOut(repo, ['status', '--porcelain']).replace(/\n$/, '')).toBe(` M ${LOG_FILE}`);
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect((await status(app, id)).status).toBe('applied');
    // Applying twice is refused.
    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(409);
    // The live snapshot the UI polls has moved.
    expect(((await (await app.request('/api/snapshot')).json()) as { stateId: string }).stateId).toBe(body.snapshot.stateId);
  });

  it('applies a new file as well', async () => {
    const app = build({ target: 'src/util/created.ts' });
    await loadViews(app);
    const id = await startChange(app, 'create a helper');
    const done = await settled(app, id);
    expect(done.files[0]).toMatchObject({ path: 'src/util/created.ts', status: 'added', outsideLimits: false });

    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(200);
    expect(readFileSync(join(repo, 'src/util/created.ts'), 'utf8')).toBe('// softscope: create a helper\n');
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('?? src/util/created.ts');
  });

  it('refuses to apply when the user edited the same lines meanwhile, names the file, and applies nothing', async () => {
    const app = build();
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);

    // The fake appends to the end of the file; so does the user: the hunk no longer fits.
    appendFileSync(join(repo, LOG_FILE), '\nexport const meanwhile = 1;\n');
    const res = await post(app, `/api/change/${id}/apply`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiError;
    expect(body.error).toContain(LOG_FILE);
    expect(body.error).toMatch(/uncommitted changes appeared since/);
    expect(body.error).toMatch(/Nothing was applied/);
    expect(body.conflictFiles).toEqual([LOG_FILE]);

    const text = readFileSync(join(repo, LOG_FILE), 'utf8');
    expect(text).toContain('meanwhile');
    expect(text).not.toContain('softscope:');
    expect(existsSync(done.workspaceDir)).toBe(true);
    expect((await status(app, id)).status).toBe('done');
    // The worktree can still be dropped.
    expect((await post(app, `/api/change/${id}/discard`)).status).toBe(200);
    expect(existsSync(done.workspaceDir)).toBe(false);
  });

  it('applies on top of unrelated edits and commits the user made meanwhile, and says the repository moved', async () => {
    const app = build();
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);

    // The user kept working: an edit elsewhere, a commit of another file, a dirty tree.
    appendFileSync(join(repo, 'src/cli.ts'), '\nexport const committedMeanwhile = 1;\n');
    commitAll(repo, 'meanwhile');
    appendFileSync(join(repo, 'src/index.ts'), '\nexport const editedMeanwhile = 1;\n');
    const live = (await (await app.request('/api/snapshot')).json()) as Snapshot;
    expect(live.stateId).not.toBe(done.startSnapshot.stateId);

    const res = await post(app, `/api/change/${id}/apply`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyResponse;
    expect(body.applied).toEqual([LOG_FILE]);
    expect(body.movedSince).toBe(true);
    expect(body.note).toMatch(/moved since the change started/);
    expect(body.note).toContain(done.startSnapshot.shortCommit);
    expect(body.note).toContain(live.shortCommit);
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('softscope:');
    expect(readFileSync(join(repo, 'src/index.ts'), 'utf8')).toContain('editedMeanwhile');
    expect(readFileSync(join(repo, 'src/cli.ts'), 'utf8')).toContain('committedMeanwhile');
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect((await status(app, id)).status).toBe('applied');
  });

  it('reports no move when the tree is exactly as the change found it', async () => {
    const app = build();
    await loadViews(app);
    const id = await startChange(app);
    await settled(app, id);
    const body = (await (await post(app, `/api/change/${id}/apply`, {})).json()) as ApplyResponse;
    expect(body.movedSince).toBe(false);
    expect(body.note).toBe('');
  });

  it('flags a file outside the selected area and requires confirmOutside to apply it', async () => {
    const app = build({ alsoEdit: 'src/index.ts' });
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);

    expect(done.files.map((f) => [f.path, f.outsideLimits])).toEqual([
      ['src/index.ts', true],
      [LOG_FILE, false],
    ]);
    // Both views are affected; the L3 `http` node and the L4 `core` node are not.
    expect(done.affected.map((a) => a.nodeId)).toEqual([APP_ID, LOGGING_ID]);

    const refused = await post(app, `/api/change/${id}/apply`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('outside the selected area'), outsideFiles: ['src/index.ts'] });
    expect(readFileSync(join(repo, 'src/index.ts'), 'utf8')).not.toContain('softscope:');
    expect((await post(app, `/api/change/${id}/apply`, { confirmOutside: 'yes' })).status).toBe(400);

    const applied = await post(app, `/api/change/${id}/apply`, { confirmOutside: true });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as ApplyResponse).applied).toEqual(['src/index.ts', LOG_FILE]);
    expect(readFileSync(join(repo, 'src/index.ts'), 'utf8')).toContain('softscope:');
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('softscope:');
  });

  it('discard removes the worktree and leaves no trace', async () => {
    const app = build();
    await loadViews(app);
    const id = await startChange(app);
    const done = await settled(app, id);
    expect(existsSync(done.workspaceDir)).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);

    const res = await post(app, `/api/change/${id}/discard`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChangeStatus).status).toBe('discarded');
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    expect((await post(app, `/api/change/${id}/discard`)).status).toBe(409);
    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(409);
  });
});

describe('the open change across reloads and restarts', () => {
  it('exposes the open change in the state so a reloaded UI can pick it up', async () => {
    const app = build();
    await loadViews(app);
    expect(((await (await app.request('/api/state')).json()) as RepoState).activeChangeId).toBeNull();

    const id = await startChange(app);
    expect(((await (await app.request('/api/state')).json()) as RepoState).activeChangeId).toBe(id);
    await settled(app, id);
    expect(((await (await app.request('/api/state')).json()) as RepoState).activeChangeId).toBe(id);

    expect((await post(app, `/api/change/${id}/discard`)).status).toBe(200);
    expect(((await (await app.request('/api/state')).json()) as RepoState).activeChangeId).toBeNull();
  });

  it('a new session removes the worktrees a dead server run left behind and starts clean', async () => {
    const first = build();
    await loadViews(first);
    const id = await startChange(first);
    const done = await settled(first, id);
    expect(existsSync(done.workspaceDir)).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);
    expect(workspaceOwner(done.workspaceDir)).toBe(process.pid);

    // "Server restart": the owning process is gone, and a fresh session opens the same
    // repository over the same work directory.
    writeFileSync(ownerFile(done.workspaceDir), `${deadPid()}\n`);
    const second = build();
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(((await (await second.request('/api/state')).json()) as RepoState).activeChangeId).toBeNull();
    expect((await second.request(`/api/change/${id}`)).status).toBe(404);
    // The user's tree is untouched by the cleanup.
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    await loadViews(second);
    expect((await settled(second, await startChange(second))).status).toBe('done');
  });

  it('leaves the worktree of a change another live server instance owns alone', async () => {
    const first = build();
    await loadViews(first);
    const id = await startChange(first);
    const done = await settled(first, id);
    const firstAgent = changeAgent;

    // A second instance on the same repository (this process stands in for it: the owner pid is alive).
    const second = build();
    expect(existsSync(done.workspaceDir)).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);
    expect(((await (await second.request('/api/state')).json()) as RepoState).activeChangeId).toBeNull();

    // The first instance still owns its change and can land it.
    expect((await post(first, `/api/change/${id}/apply`, {})).status).toBe(200);
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('softscope:');
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(existsSync(ownerFile(done.workspaceDir))).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(firstAgent.calls).toHaveLength(1);
  });

  it('re-opening the same repository keeps the session and its open change; another repository closes it first', async () => {
    const app = build({ delayMs: 400 });
    await loadViews(app);
    const id = await startChange(app);
    const openRepo = (path: string) => post(app, '/api/repo', { path });

    // The same path again while the agent is still running: nothing is lost.
    const same = await openRepo(repo);
    expect(same.status).toBe(200);
    expect(((await same.json()) as RepoState).activeChangeId).toBe(id);
    expect((await app.request(`/api/change/${id}`)).status).toBe(200);
    const done = await settled(app, id);
    expect(done.status).toBe('done');
    expect(worktrees(repo)).toHaveLength(2);

    // Another repository: the open change is discarded on the way out, no worktree remains.
    const other = copyFixtureAsGitRepo();
    const switched = await openRepo(other);
    expect(switched.status).toBe(200);
    expect(((await switched.json()) as RepoState).repoPath).toBe(other);
    expect(((await switched.json().catch(() => ({}))) as RepoState).activeChangeId ?? null).toBeNull();
    expect(existsSync(done.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    expect((await app.request(`/api/change/${id}`)).status).toBe(404);
  });

  it('discards a change that is still running when the session switches repositories', async () => {
    const app = build({ delayMs: 5000 });
    await loadViews(app);
    const id = await startChange(app);
    await waitFor(() => changeAgent.calls.length === 1);
    const running = await status(app, id);
    expect(running.status).toBe('running');

    const other = copyFixtureAsGitRepo();
    const started = Date.now();
    expect((await post(app, '/api/repo', { path: other })).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4000); // the abort is honoured, not waited out
    expect(existsSync(running.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
  });
});

describe('the fake change agent', () => {
  it('prefers a commentable file under the limits over a package.json in the context', async () => {
    const dir = copyFixture();
    const context: SelectionContext = {
      task: 'demo',
      nodes: [],
      files: [{ file: 'packages/core/package.json', ranges: [{ startLine: 1, endLine: 1 }] }],
      size: { files: 1, lines: 1 },
      relations: { internal: [], external: [] },
      snapshots: [],
      warnings: [],
      stale: false,
      limits: { paths: ['packages/core'], note: '' },
    };
    const before = readFileSync(join(dir, 'packages/core/package.json'), 'utf8');
    const result = await new FakeChangeAgent().run({ workspaceDir: dir, context, task: 'demo', checks: [] });
    expect(result.changedFiles).toEqual(['packages/core/src/index.ts']);
    expect(readFileSync(join(dir, 'packages/core/src/index.ts'), 'utf8')).toContain('// softscope: demo');
    expect(readFileSync(join(dir, 'packages/core/package.json'), 'utf8')).toBe(before);
    expect(() => JSON.parse(readFileSync(join(dir, 'packages/core/package.json'), 'utf8'))).not.toThrow();
  });
});

describe('GET /api/change/:id/progress, cancel and refine', () => {
  it('streams started, activity and done keyed by the change id, then idle', async () => {
    const app = build({ delayMs: 300, progress: [{ tool: 'Read', detail: 'src/util/log.ts' }] });
    await loadViews(app);
    const id = await startChange(app);
    await waitFor(() => changeAgent.calls.length === 1);

    const stream = await app.request(`/api/change/${id}/progress`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const events = sseEvents(await stream.text());
    expect(events[0]).toMatchObject({ type: 'started', changeId: id });
    expect(typeof events[0]!.startedAt).toBe('string');
    expect(events[1]).toMatchObject({ type: 'activity', tool: 'Read', detail: 'src/util/log.ts' });
    expect(events[2]).toMatchObject({ type: 'activity', tool: 'Edit', detail: LOG_FILE });
    // The server's own check runs are reported too.
    expect(events.filter((e) => e.type === 'activity' && e.tool === 'check').map((e) => e.detail)).toEqual([
      'npm run typecheck',
      'npm run lint',
      'npm run test',
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: 'done', changeId: id });

    expect((await settled(app, id)).status).toBe('done');
    expect(sseEvents(await (await app.request(`/api/change/${id}/progress`)).text())).toEqual([{ type: 'idle', changeId: id }]);
  });

  it('cancel aborts the agent, ends the stream with cancelled and keeps the worktree', async () => {
    const app = build({ delayMs: 5000 });
    await loadViews(app);
    const id = await startChange(app);
    await waitFor(() => changeAgent.calls.length === 1);
    const stream = await app.request(`/api/change/${id}/progress`);

    const cancel = await post(app, `/api/change/${id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ cancelled: true });

    const events = sseEvents(await stream.text());
    expect(events.map((e) => e.type)).toEqual(['started', 'cancelled']);
    const after = await settled(app, id);
    expect(after.status).toBe('cancelled');
    expect(after.files).toEqual([]);
    expect(after.checks).toEqual([]);
    expect(existsSync(after.workspaceDir)).toBe(true);
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).not.toContain('softscope:');
    // Nothing runs any more; a second cancel says so.
    expect(await (await post(app, `/api/change/${id}/cancel`)).json()).toEqual({ cancelled: false });
    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(409); // no diff to apply
    expect((await post(app, `/api/change/${id}/discard`)).status).toBe(200);
    expect(existsSync(after.workspaceDir)).toBe(false);
  });

  it('streams the error event when the agent fails', async () => {
    const app = build({ fail: true, delayMs: 300 });
    await loadViews(app);
    const id = await startChange(app);
    await waitFor(() => changeAgent.calls.length === 1);
    const events = sseEvents(await (await app.request(`/api/change/${id}/progress`)).text());
    expect(events.map((e) => e.type)).toEqual(['started', 'error']);
    expect(events[1]).toMatchObject({ changeId: id, message: expect.stringContaining('told to fail') });
  });

  it('refine runs the agent again in the same worktree, re-runs the checks and widens the diff', async () => {
    const app = build();
    await loadViews(app);
    const id = await startChange(app, 'first instruction');
    const first = await settled(app, id);
    expect(first.checks).toHaveLength(3);

    const refine = await post(app, `/api/change/${id}/refine`, { task: 'second instruction' });
    expect(refine.status).toBe(200);
    expect(((await refine.json()) as ChangeStatus).status).toBe('running');
    expect((await post(app, `/api/change/${id}/refine`, { task: 'too early' })).status).toBe(409);

    const second = await settled(app, id);
    expect(second.status).toBe('done');
    expect(second.task).toBe('second instruction');
    expect(second.history.map((h) => h.task)).toEqual(['first instruction', 'second instruction']);
    expect(second.workspaceDir).toBe(first.workspaceDir);
    expect(changeAgent.calls).toHaveLength(2);
    expect(changeAgent.calls[1]!.previous?.changedFiles).toEqual([LOG_FILE]);
    expect(changeAgent.calls[1]!.task).toBe('second instruction');
    const added = second.files[0]!.hunks.flatMap((h) => h.lines.filter((l) => l.type === '+').map((l) => l.text));
    expect(added).toEqual(['// softscope: first instruction', '// softscope: second instruction']);
    expect(second.checks).toHaveLength(3);
    expect(second.checks[1]!.ok).toBe(false);

    expect((await post(app, `/api/change/${id}/refine`, { task: '' })).status).toBe(400);
    expect((await post(app, `/api/change/${id}/apply`, {})).status).toBe(200);
    expect(readFileSync(join(repo, LOG_FILE), 'utf8')).toContain('second instruction');
    expect((await post(app, `/api/change/${id}/refine`, { task: 'after apply' })).status).toBe(409);
  });
});
