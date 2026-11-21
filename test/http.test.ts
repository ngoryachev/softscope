import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/http/app';
import { FakeSchemaAgent } from '../src/server/agent/fake';
import { RepoSession } from '../src/server/session';
import type { FileResponse, GraphResponse, RepoState } from '../src/shared/api';
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
