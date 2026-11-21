import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/http/app';
import { describeToolInput } from '../src/server/agent/claude';
import { FakeSchemaAgent } from '../src/server/agent/fake';
import { RepoSession } from '../src/server/session';
import type { ContextResponse, FileResponse, GraphResponse, RepoState } from '../src/shared/api';
import type { Snapshot } from '../src/shared/graph';
import { agentGraph, cleanupTemps, commitAll, copyFixtureAsGitRepo, tempCache } from './helpers';

afterAll(cleanupTemps);

const APP_ID = 'L4:root/app';
const LOGGING_ID = `L3:${APP_ID}/logging`;

const l4Reply = agentGraph(
  [
    {
      slug: 'app',
      kind: 'application',
      title: 'sample-app',
      paths: ['src'],
      hasDetail: true,
      evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 5 }],
    },
    {
      slug: 'fs',
      kind: 'runtime-boundary',
      title: 'filesystem',
      boundary: true,
      evidence: [{ file: 'src/index.ts', startLine: 2, endLine: 2 }],
    },
  ],
  [
    { from: 'app', to: 'fs', kind: 'reads', confirmed: false, reason: 'path comes from a variable', evidence: [] },
  ],
);

const l3Reply = agentGraph([
  {
    slug: 'logging',
    title: 'logging',
    paths: ['src/util'],
    hasDetail: true,
    evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 3 }],
  },
]);

const l2Reply = agentGraph([
  {
    slug: 'log',
    kind: 'function',
    title: 'log',
    paths: ['src/util/log.ts'],
    evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 3 }],
  },
]);

let repo: string;
let agent: FakeSchemaAgent;
let api: ReturnType<typeof createApp>;

function build(withSession = true, slow = false) {
  const cache = tempCache();
  agent = new FakeSchemaAgent({
    replies: { 'L4:root': l4Reply, [`L3:${APP_ID}`]: l3Reply, [`L2:${LOGGING_ID}`]: l2Reply },
    progress: { [`L2:${LOGGING_ID}`]: [{ tool: 'Read', detail: 'src/util/log.ts' }, { tool: 'Grep', detail: 'export function' }] },
    strict: true,
    ...(slow ? { delayMs: 300 } : {}),
  });
  const session = withSession ? new RepoSession(repo, { agent, cache }) : undefined;
  api = createApp({ agent, cache, ...(session ? { session } : {}) });
  return api.app;
}

beforeEach(() => {
  repo = copyFixtureAsGitRepo();
});

describe('/api/state', () => {
  it('reports the open repository and the levels that can be generated', async () => {
    const res = await build().request('/api/state');
    const state = (await res.json()) as RepoState;

    expect(res.status).toBe(200);
    expect(state.repoPath).toBe(repo);
    expect(state.repoName).toBe('sample-app');
    expect(state.isGitRepo).toBe(true);
    expect(state.snapshot?.branch).toBe('main');
    expect(state.generatableLevels).toEqual(['L4', 'L3', 'L2']);
    expect(state.fakeAgent).toBe(true);
  });

  it('reports no repository before one is opened', async () => {
    const state = (await (await build(false).request('/api/state')).json()) as RepoState;
    expect(state.repoPath).toBeNull();
    expect(state.snapshot).toBeNull();
  });
});

describe('/api/repo', () => {
  it('opens a repository posted by the UI', async () => {
    const app = build(false);
    const res = await app.request('/api/repo', {
      method: 'POST',
      body: JSON.stringify({ path: repo }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as RepoState).repoName).toBe('sample-app');
    expect(api.current()?.repoPath).toBe(repo);
  });

  it('rejects a missing path and a path that is not a directory', async () => {
    const app = build(false);
    const post = (body: unknown) =>
      app.request('/api/repo', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });

    expect((await post({})).status).toBe(400);
    expect((await post({ path: '/definitely/not/here' })).status).toBe(400);
    expect((await post({ path: join(repo, 'package.json') })).status).toBe(400);
  });
});

describe('/api/graph', () => {
  it('returns the L4 view with its issues and openable scopes', async () => {
    const res = await build().request('/api/graph?level=L4&scope=root');
    const body = (await res.json()) as GraphResponse;

    expect(res.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.view.scope).toMatchObject({ level: 'L4', id: 'root' });
    expect(body.view.nodes.map((n) => n.title)).toEqual(['sample-app', 'filesystem']);
    expect(body.view.edges[0]).toMatchObject({ status: 'unverified', reason: 'path comes from a variable' });
    expect(body.issues.some((i) => i.kind === 'edge-unverified')).toBe(true);
    expect(body.openable).toEqual([{ level: 'L3', id: APP_ID, label: 'sample-app', paths: ['src'] }]);
  });

  it('defaults to the root L4 scope and flags the second request as cached', async () => {
    const app = build();
    expect(((await (await app.request('/api/graph')).json()) as GraphResponse).cached).toBe(false);
    expect(((await (await app.request('/api/graph')).json()) as GraphResponse).cached).toBe(true);
    expect(agent.calls).toHaveLength(1);
  });

  it('generates an L3 scope lazily when the UI opens the node', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    const body = (await (await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`)).json()) as GraphResponse;

    expect(body.view.nodes.map((n) => n.title)).toEqual(['logging']);
    expect(agent.callsFor('L3', APP_ID)).toBe(1);
  });

  it('marks a view stale once the working tree moves', async () => {
    const app = build();
    const before = (await (await app.request('/api/graph')).json()) as GraphResponse;
    expect(before.stale).toBe(false);

    appendFileSync(join(repo, 'src/util/log.ts'), '\nexport const extra = 1;\n');

    const snapshot = (await (await app.request('/api/snapshot')).json()) as Snapshot;
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.stateId).not.toBe(before.view.snapshot.stateId);
  });

  it('serves the previous schema as cached and stale after a commit, and regenerates with refresh=1', async () => {
    const app = build();
    const before = (await (await app.request('/api/graph')).json()) as GraphResponse;

    appendFileSync(join(repo, 'src/util/log.ts'), '\nexport const extra = 2;\n');
    commitAll(repo, 'second');

    const after = (await (await app.request('/api/graph')).json()) as GraphResponse;
    expect(after.cached).toBe(true);
    expect(after.stale).toBe(true);
    expect(after.view.snapshot.commit).toBe(before.view.snapshot.commit);
    expect(agent.calls).toHaveLength(1);

    const fresh = (await (await app.request('/api/graph?level=L4&scope=root&refresh=1')).json()) as GraphResponse;
    expect(fresh.cached).toBe(false);
    expect(fresh.stale).toBe(false);
    expect(fresh.view.snapshot.commit).not.toBe(before.view.snapshot.commit);
    expect(agent.calls).toHaveLength(2);

    const again = (await (await app.request('/api/graph')).json()) as GraphResponse;
    expect(again.cached).toBe(true);
    expect(again.stale).toBe(false);
    expect(agent.calls).toHaveLength(2);
  });

  it('answers 404 for a scope that no view offers', async () => {
    const res = await build().request('/api/graph?level=L3&scope=L4:root/ghost');
    expect(res.status).toBe(404);
  });

  it('answers 501 for a level with no prompt builder and 400 for a nonsense level', async () => {
    const app = build();
    expect((await app.request(`/api/graph?level=L1&scope=${encodeURIComponent(LOGGING_ID)}`)).status).toBe(501);
    expect((await app.request('/api/graph?level=L9')).status).toBe(400);
  });

  it('generates an L2 scope lazily and serves it from the cache afterwards', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);
    const first = (await (await app.request(graphUrl('L2', LOGGING_ID))).json()) as GraphResponse;

    expect(first.view.scope).toMatchObject({ level: 'L2', id: LOGGING_ID });
    expect(first.view.nodes.map((n) => n.title)).toEqual(['log']);
    expect(agent.callsFor('L2', LOGGING_ID)).toBe(1);

    const second = (await (await app.request(graphUrl('L2', LOGGING_ID))).json()) as GraphResponse;
    expect(second.cached).toBe(true);
    expect(agent.calls).toHaveLength(3);
  });
});

const graphUrl = (level: string, scopeId: string, extra = '') =>
  `/api/graph${extra}?level=${level}&scope=${encodeURIComponent(scopeId)}`;

/** Polls `condition` until it holds; the agent is reached only after a few awaited ticks. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sseEvents = (body: string) =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; [k: string]: unknown });

describe('/api/graph/progress and /api/graph/cancel', () => {
  it('streams the started, activity and done events of a running generation', async () => {
    const app = build(true, true);
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);

    const pending = app.request(graphUrl('L2', LOGGING_ID));
    await waitFor(() => agent.callsFor('L2', LOGGING_ID) === 1);
    const stream = await app.request(graphUrl('L2', LOGGING_ID, '/progress'));
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const events = sseEvents(await stream.text());

    expect(events.map((e) => e.type)).toEqual(['started', 'activity', 'activity', 'done']);
    expect(events[0]).toMatchObject({ level: 'L2', scopeId: LOGGING_ID });
    expect(typeof events[0]!.startedAt).toBe('string');
    expect(events[1]).toMatchObject({ tool: 'Read', detail: 'src/util/log.ts' });
    expect(events[2]).toMatchObject({ tool: 'Grep', detail: 'export function' });
    expect((await pending).status).toBe(200);
  });

  it('answers a single idle event when nothing is running for the scope', async () => {
    const app = build();
    const stream = await app.request(graphUrl('L2', LOGGING_ID, '/progress'));
    expect(stream.status).toBe(200);
    expect(sseEvents(await stream.text())).toEqual([{ type: 'idle', level: 'L2', scopeId: LOGGING_ID }]);
  });

  it('cancels the running generation: the view request fails as cancelled, nothing is cached', async () => {
    const app = build(true, true);
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);

    const pending = app.request(graphUrl('L2', LOGGING_ID));
    await waitFor(() => agent.callsFor('L2', LOGGING_ID) === 1);
    const cancel = await app.request('/api/graph/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'L2', scopeId: LOGGING_ID }),
    });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ cancelled: true });

    const res = await pending;
    expect(res.status).toBe(499);
    expect(await res.json()).toMatchObject({ error: 'cancelled' });
    expect(agent.calls).toHaveLength(3);

    // The next request is a fresh generation, not a cache hit.
    const again = (await (await app.request(graphUrl('L2', LOGGING_ID))).json()) as GraphResponse;
    expect(again.cached).toBe(false);
    expect(agent.callsFor('L2', LOGGING_ID)).toBe(2);
  });

  it('ends an open progress stream with the cancelled event and keeps the next request fresh', async () => {
    const app = build(true, true);
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);

    const pending = app.request(graphUrl('L2', LOGGING_ID));
    await waitFor(() => agent.callsFor('L2', LOGGING_ID) === 1);
    // The stream is open (headers sent) before the cancel arrives; its body ends with the cancel.
    const stream = await app.request(graphUrl('L2', LOGGING_ID, '/progress'));
    await app.request('/api/graph/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'L2', scopeId: LOGGING_ID }),
    });

    const events = sseEvents(await stream.text());
    expect(events.map((e) => e.type)).toEqual(['started', 'activity', 'activity', 'cancelled']);
    expect((await pending).status).toBe(499);
    // Once the job is gone the stream reports idle rather than hanging.
    expect(sseEvents(await (await app.request(graphUrl('L2', LOGGING_ID, '/progress'))).text())).toEqual([
      { type: 'idle', level: 'L2', scopeId: LOGGING_ID },
    ]);
  });

  it('streams the error event when the agent fails', async () => {
    // A strict fake without an L2 reply fails after its delay, the way a broken agent would.
    const cache = tempCache();
    agent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply, [`L3:${APP_ID}`]: l3Reply }, strict: true, delayMs: 300 });
    const app = createApp({ agent, cache, session: new RepoSession(repo, { agent, cache }) }).app;
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);

    const pending = app.request(graphUrl('L2', LOGGING_ID));
    await waitFor(() => agent.callsFor('L2', LOGGING_ID) === 1);
    const events = sseEvents(await (await app.request(graphUrl('L2', LOGGING_ID, '/progress'))).text());

    expect(events.map((e) => e.type)).toEqual(['started', 'error']);
    expect(events[1]).toMatchObject({ message: expect.stringContaining('no reply') });
    expect((await pending).status).toBe(502);
  });

  it('rejects a nonsense level on the progress stream', async () => {
    const app = build();
    expect((await app.request('/api/graph/progress?level=L9&scope=root')).status).toBe(400);
  });

  it('rejects a cancel without a level or scope, and reports false when nothing runs', async () => {
    const app = build();
    const post = (body: unknown) =>
      app.request('/api/graph/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({})).status).toBe(400);
    const idle = await post({ level: 'L2', scopeId: LOGGING_ID });
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ cancelled: false });
  });

  it('answers 409 when no repository is open', async () => {
    const app = build(false);
    expect((await app.request(graphUrl('L2', LOGGING_ID, '/progress'))).status).toBe(409);
    expect((await app.request('/api/graph/cancel', { method: 'POST', body: '{}' })).status).toBe(409);
  });

  it('answers 409 when no repository is open', async () => {
    const app = build(false);
    expect((await app.request('/api/graph')).status).toBe(409);
    expect((await app.request('/api/snapshot')).status).toBe(409);
    expect((await app.request('/api/file?path=package.json')).status).toBe(409);
  });
});

describe('/api/file', () => {
  it('returns the lines of a file inside the repository', async () => {
    const res = await build().request('/api/file?path=src/util/log.ts');
    const body = (await res.json()) as FileResponse;

    expect(res.status).toBe(200);
    expect(body.path).toBe('src/util/log.ts');
    expect(body.lines[0]).toContain('export function log');
    expect(body.truncated).toBe(false);
  });

  it('refuses a traversal, an absolute path and the repository root itself', async () => {
    const app = build();
    expect((await app.request('/api/file?path=../../../etc/passwd')).status).toBe(400);
    expect((await app.request('/api/file?path=/etc/passwd')).status).toBe(400);
    expect((await app.request('/api/file?path=')).status).toBe(400);
    expect((await app.request('/api/file?path=.')).status).toBe(400);
  });

  it('refuses a symlink inside the repository that points outside it', async () => {
    // The lexical check alone cannot see this: the path stays under the repository and
    // only the link target leaves it.
    const outside = join(repo, '..', 'outside-of-repo.txt');
    writeFileSync(outside, 'not part of the analyzed repository\n', 'utf8');
    symlinkSync(outside, join(repo, 'escape.txt'));
    const app = build();

    const res = await app.request('/api/file?path=escape.txt');
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('not part of the analyzed repository');
  });

  it('answers 404 for a path that is not a file', async () => {
    const app = build();
    expect((await app.request('/api/file?path=src/nope.ts')).status).toBe(404);
    expect((await app.request('/api/file?path=src')).status).toBe(404);
  });
});

describe('/api/context', () => {
  const FS_ID = 'L4:root/fs';
  const postContext = (app: ReturnType<typeof build>, body: unknown, extra = '') =>
    app.request(`/api/context${extra}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('builds the context of a selection across the loaded L4 and L3 views', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);

    const res = await postContext(app, { nodeIds: [APP_ID, LOGGING_ID], edgeIds: [], task: 'add a request id' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextResponse;

    expect(body.task).toBe('add a request id');
    expect(body.nodes.map((n) => [n.id, n.level, n.title])).toEqual([
      [APP_ID, 'L4', 'sample-app'],
      [LOGGING_ID, 'L3', 'logging'],
    ]);
    // The node's 1-5 and the external relation's evidence (none) → one range per file.
    expect(body.files).toEqual([
      { file: 'src/index.ts', ranges: [{ startLine: 1, endLine: 5 }] },
      { file: 'src/util/log.ts', ranges: [{ startLine: 1, endLine: 3 }] },
    ]);
    expect(body.size).toEqual({ files: 2, lines: 8 });
    expect(body.relations.internal).toEqual([]);
    expect(body.relations.external).toEqual([
      expect.objectContaining({
        from: { id: APP_ID, title: 'sample-app' },
        to: { id: FS_ID, title: 'filesystem' },
        kind: 'reads',
        status: 'unverified',
        reason: 'path comes from a variable',
      }),
    ]);
    expect(body.stale).toBe(false);
    expect(body.warnings).toEqual([]);
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]!.scopes.map((s) => `${s.level}:${s.id}`)).toEqual(['L4:root', `L3:${APP_ID}`]);
    expect(body.limits.paths).toEqual(['src', 'src/util']);
    expect(agent.calls).toHaveLength(2);
  });

  it('renders the same context as Markdown on request', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');

    const res = await postContext(app, { nodeIds: [APP_ID], edgeIds: [], task: 'rename it' }, '?format=markdown');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('## Task');
    expect(text).toContain('rename it');
    expect(text).toContain('## Selected entities');
    expect(text).toContain('**sample-app**');
    expect(text).toContain('- src/index.ts:1-5');
    expect(text).toContain('### External');
    expect(text).toContain('sample-app → filesystem (reads) — unverified: path comes from a variable');
    expect(text).toContain('## Size');
  });

  it('never generates: an id of a view that is not loaded becomes a warning', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);

    const logId = `L2:${LOGGING_ID}/log`;
    const body = (await (await postContext(app, { nodeIds: [APP_ID, logId], edgeIds: [] })).json()) as ContextResponse;

    expect(body.nodes.map((n) => n.id)).toEqual([APP_ID]);
    expect(body.warnings).toEqual([expect.stringContaining(`view L2:${LOGGING_ID}, which is not loaded`)]);
    expect(agent.callsFor('L2', LOGGING_ID)).toBe(0);
    expect(agent.calls).toHaveLength(2);
  });

  it('marks the context stale once the repository moves', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    appendFileSync(join(repo, 'src/util/log.ts'), '\nexport const extra = 3;\n');

    const body = (await (await postContext(app, { nodeIds: [APP_ID], edgeIds: [] })).json()) as ContextResponse;
    expect(body.stale).toBe(true);
    expect(body.warnings).toEqual([expect.stringContaining('the repository is now at')]);
  });

  it('answers 400 for a malformed body and 409 without a repository', async () => {
    const app = build();
    expect((await postContext(app, 'not json')).status).toBe(400);
    expect((await postContext(app, { nodeIds: 'L4:root/app', edgeIds: [] })).status).toBe(400);
    expect((await postContext(app, { nodeIds: [1], edgeIds: [] })).status).toBe(400);
    expect((await postContext(app, { nodeIds: [] })).status).toBe(400);
    expect((await postContext(app, { nodeIds: [], edgeIds: [], task: 7 })).status).toBe(400);
    expect((await postContext(app, { nodeIds: [], edgeIds: [] })).status).toBe(200);

    expect((await postContext(build(false), { nodeIds: [], edgeIds: [] })).status).toBe(409);
  });
});

describe('progress activity paths', () => {
  it('shows the files the agent reads relative to the analyzed repository', () => {
    expect(describeToolInput('Read', { file_path: join(repo, 'src/util/log.ts') }, repo)).toBe('src/util/log.ts');
    expect(describeToolInput('Grep', { pattern: 'log', path: join(repo, 'src') }, repo)).toBe('log in src');
    expect(describeToolInput('Grep', { pattern: 'log', path: repo }, repo)).toBe('log in .');
    // Outside the repository, and without a repository, the path is left as it came.
    expect(describeToolInput('Read', { file_path: '/etc/hosts' }, repo)).toBe('/etc/hosts');
    expect(describeToolInput('Read', { file_path: join(repo, 'src/util/log.ts') })).toBe(join(repo, 'src/util/log.ts'));
    expect(describeToolInput('Glob', { pattern: `${repo}/**/*.ts` }, repo)).toBe(`${repo}/**/*.ts`);
  });
});

describe('/api/context — more', () => {
  const FS_ID = 'L4:root/fs';
  const APP_FS_EDGE = `L4:root|${APP_ID}->${FS_ID}|reads`;
  const postContext = (app: ReturnType<typeof build>, body: unknown, extra = '') =>
    app.request(`/api/context${extra}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('a selected relation pulls in both endpoints and is internal; a boundary node falls back to its evidence file', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');

    const body = (await (await postContext(app, { nodeIds: [], edgeIds: [APP_FS_EDGE] })).json()) as ContextResponse;
    expect(body.nodes.map((n) => n.id)).toEqual([APP_ID, FS_ID]);
    expect(body.nodes[1]).toMatchObject({ boundary: true, scope: { id: 'root', label: 'sample-app' } });
    expect(body.relations.internal.map((r) => [r.id, r.status])).toEqual([[APP_FS_EDGE, 'unverified']]);
    expect(body.relations.external).toEqual([]);
    // 1-5 of the app and 2-2 of the boundary node merge into one range.
    expect(body.files).toEqual([{ file: 'src/index.ts', ranges: [{ startLine: 1, endLine: 5 }] }]);
    expect(body.size).toEqual({ files: 1, lines: 5 });
    expect(body.limits.paths).toEqual(['src', 'src/index.ts']);
    expect(body.task).toBe('');
    expect(body.warnings).toEqual([]);
  });

  it('includes views served from the cache by a fresh session', async () => {
    const cache = tempCache();
    const first = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply }, strict: true });
    const warm = createApp({ agent: first, cache, session: new RepoSession(repo, { agent: first, cache }) }).app;
    expect((await warm.request('/api/graph?level=L4&scope=root')).status).toBe(200);
    expect(first.calls).toHaveLength(1);

    const second = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply }, strict: true });
    const cold = createApp({ agent: second, cache, session: new RepoSession(repo, { agent: second, cache }) }).app;
    // Nothing loaded yet in this session: the id is a warning, not a generation.
    const before = (await (await postContext(cold, { nodeIds: [APP_ID], edgeIds: [] })).json()) as ContextResponse;
    expect(before.nodes).toEqual([]);
    expect(before.warnings).toEqual([expect.stringContaining('view L4:root, which is not loaded')]);
    expect(second.calls).toHaveLength(0);

    const graph = (await (await cold.request('/api/graph?level=L4&scope=root')).json()) as GraphResponse;
    expect(graph.cached).toBe(true);
    expect(second.calls).toHaveLength(0);
    const after = (await (await postContext(cold, { nodeIds: [APP_ID], edgeIds: [] })).json()) as ContextResponse;
    expect(after.nodes.map((n) => n.id)).toEqual([APP_ID]);
    expect(after.warnings).toEqual([]);
    expect(second.calls).toHaveLength(0);
  });

  it('resolves an L2 id once that view was loaded and lists every scope under the snapshot', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);
    await app.request(`/api/graph?level=L2&scope=${encodeURIComponent(LOGGING_ID)}`);
    const logId = `L2:${LOGGING_ID}/log`;

    const body = (await (await postContext(app, { nodeIds: [APP_ID, LOGGING_ID, logId], edgeIds: [] })).json()) as ContextResponse;
    expect(body.nodes.map((n) => n.level)).toEqual(['L4', 'L3', 'L2']);
    expect(body.warnings).toEqual([]);
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]!.scopes.map((s) => s.level)).toEqual(['L4', 'L3', 'L2']);
    // The L3 node (src/util/log.ts 1-3) and the L2 function (same lines) collapse into one range.
    expect(body.files).toEqual([
      { file: 'src/index.ts', ranges: [{ startLine: 1, endLine: 5 }] },
      { file: 'src/util/log.ts', ranges: [{ startLine: 1, endLine: 3 }] },
    ]);
    expect(body.limits.paths).toEqual(['src', 'src/util', 'src/util/log.ts']);
  });

  it('keeps the error shape for a malformed body whatever the format, and ignores unknown formats', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');

    const bad = await postContext(app, { nodeIds: 'x', edgeIds: [] }, '?format=markdown');
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain('application/json');
    expect(((await bad.json()) as { error: string }).error).toMatch(/nodeIds/);

    const json = await postContext(app, { nodeIds: [APP_ID], edgeIds: [] }, '?format=json');
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toContain('application/json');

    const empty = await postContext(app, { nodeIds: [], edgeIds: [] }, '?format=markdown');
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('_No items resolved._');

    // Extra keys are tolerated, a null task is not.
    expect((await postContext(app, { nodeIds: [], edgeIds: [], extra: 1 })).status).toBe(200);
    expect((await postContext(app, { nodeIds: [], edgeIds: [], task: null })).status).toBe(400);
    expect((await postContext(app, [])).status).toBe(400);
    expect((await postContext(app, 'null')).status).toBe(400);
  });

  it('a regenerated view replaces the old one in the context', async () => {
    const app = build();
    await app.request('/api/graph?level=L4&scope=root');
    appendFileSync(join(repo, 'src/util/log.ts'), '\nexport const extra = 3;\n');
    const stale = (await (await postContext(app, { nodeIds: [APP_ID], edgeIds: [] })).json()) as ContextResponse;
    expect(stale.stale).toBe(true);

    // A plain request keeps serving the generated view, flagged stale; Regenerate replaces it.
    const kept = (await (await app.request('/api/graph?level=L4&scope=root')).json()) as GraphResponse;
    expect(kept.stale).toBe(true);
    expect((await (await postContext(app, { nodeIds: [APP_ID], edgeIds: [] })).json() as ContextResponse).stale).toBe(true);
    const fresh = (await (await app.request('/api/graph?level=L4&scope=root&refresh=1')).json()) as GraphResponse;
    expect(fresh.view.snapshot.dirty).toBe(true);
    const after = (await (await postContext(app, { nodeIds: [APP_ID], edgeIds: [] })).json()) as ContextResponse;
    expect(after.stale).toBe(false);
    expect(after.warnings).toEqual([]);
    expect(after.snapshots).toHaveLength(1);
    expect(after.snapshots[0]!.dirty).toBe(true);
  });
});
