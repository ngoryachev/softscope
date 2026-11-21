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
    evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 3 }],
  },
]);

let repo: string;
let agent: FakeSchemaAgent;
let api: ReturnType<typeof createApp>;

function build(withSession = true) {
  const cache = tempCache();
  agent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply, [`L3:${APP_ID}`]: l3Reply }, strict: true });
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
    expect(state.generatableLevels).toEqual(['L4', 'L3']);
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
    expect((await app.request(`/api/graph?level=L2&scope=${encodeURIComponent(APP_ID)}`)).status).toBe(501);
    expect((await app.request('/api/graph?level=L9')).status).toBe(400);
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
