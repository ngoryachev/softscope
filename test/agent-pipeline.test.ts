/**
 * The cache -> agent -> validation pipeline of `RepoSession`, with the agent faked
 * through its interface. The point of these tests is laziness: the agent must run once
 * per opened scope, and never for a scope the user did not open (SPEC §4.4, §6.2).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeSchemaAgent, indexDerivedReply } from '../src/server/agent/fake';
import { summarizeForAgent } from '../src/server/indexer/index';
import { LevelNotSupportedError, RepoSession, ScopeNotFoundError } from '../src/server/session';
import type { FileCache } from '../src/server/cache/file-cache';
import { agentGraph, cleanupTemps, commitAll, copyFixture, copyFixtureAsGitRepo, tempCache } from './helpers';

afterAll(cleanupTemps);

const CORE_ID = 'L4:root/core';
const UI_ID = 'L4:root/ui';

/** L4: two packages plus a boundary node, both packages openable. */
const l4Reply = agentGraph(
  [
    {
      slug: 'core',
      kind: 'package',
      title: '@sample/core',
      paths: ['packages/core'],
      hasDetail: true,
      evidence: [{ file: 'packages/core/package.json', startLine: 1, endLine: 2 }],
    },
    {
      slug: 'ui',
      kind: 'package',
      title: '@sample/ui',
      paths: ['packages/ui'],
      hasDetail: true,
      evidence: [{ file: 'packages/ui/package.json', startLine: 1, endLine: 2 }],
    },
    {
      slug: 'react',
      kind: 'external-dependency',
      title: 'react',
      boundary: true,
      evidence: [{ file: 'packages/ui/src/index.tsx', startLine: 1, endLine: 1 }],
    },
  ],
  [
    { from: 'ui', to: 'core', evidence: [{ file: 'packages/ui/src/index.tsx', startLine: 2, endLine: 2 }] },
    { from: 'ui', to: 'react', evidence: [{ file: 'packages/ui/src/index.tsx', startLine: 1, endLine: 1 }] },
  ],
);

const coreL3Reply = agentGraph(
  [
    {
      slug: 'math',
      title: 'arithmetic',
      paths: ['packages/core/src/math.ts'],
      evidence: [{ file: 'packages/core/src/math.ts', startLine: 1, endLine: 3 }],
    },
    {
      slug: 'schema',
      title: 'schema',
      paths: ['packages/core/src/index.ts'],
      evidence: [{ file: 'packages/core/src/index.ts', startLine: 1, endLine: 5 }],
    },
  ],
  [{ from: 'schema', to: 'math', evidence: [{ file: 'packages/core/src/index.ts', startLine: 2, endLine: 2 }] }],
);

let repo: string;
let cache: FileCache;
let agent: FakeSchemaAgent;
let session: RepoSession;

function newSession(): RepoSession {
  return new RepoSession(repo, { agent, cache });
}

beforeEach(() => {
  repo = copyFixtureAsGitRepo();
  cache = tempCache();
  agent = new FakeSchemaAgent({
    replies: { 'L4:root': l4Reply, [`L3:${CORE_ID}`]: coreL3Reply },
    strict: true,
  });
  session = newSession();
});

describe('L4', () => {
  it('generates once and serves the second request from the cache', async () => {
    const first = await session.graph({ level: 'L4', scopeId: 'root' });
    expect(first.cached).toBe(false);
    expect(first.stale).toBe(false);
    expect(first.view.nodes.map((n) => n.title)).toEqual(['@sample/core', '@sample/ui', 'react']);
    expect(first.view.edges.every((e) => e.status === 'confirmed')).toBe(true);
    expect(agent.calls).toHaveLength(1);

    const second = await session.graph({ level: 'L4', scopeId: 'root' });
    expect(second.cached).toBe(true);
    expect(agent.calls).toHaveLength(1);

    // A fresh session (a restarted server) still must not reach the agent.
    const third = await newSession().graph({ level: 'L4', scopeId: 'root' });
    expect(third.cached).toBe(true);
    expect(agent.calls).toHaveLength(1);
  });

  it('offers the openable scopes and skips the boundary node', async () => {
    const { openable } = await session.graph({ level: 'L4', scopeId: 'root' });
    expect(openable).toEqual([
      { level: 'L3', id: CORE_ID, label: '@sample/core', paths: ['packages/core'] },
      { level: 'L3', id: UI_ID, label: '@sample/ui', paths: ['packages/ui'] },
    ]);
  });

  it('regenerates with refresh=true and does not reuse the cached reply', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    const again = await session.graph({ level: 'L4', scopeId: 'root', refresh: true });

    expect(again.cached).toBe(false);
    expect(agent.calls).toHaveLength(2);
  });

  it('runs the agent once when the same scope is requested concurrently', async () => {
    agent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply }, strict: true, delayMs: 20 });
    session = newSession();

    const [a, b] = await Promise.all([
      session.graph({ level: 'L4', scopeId: 'root' }),
      session.graph({ level: 'L4', scopeId: 'root' }),
    ]);

    expect(agent.calls).toHaveLength(1);
    expect(a.view.nodes).toHaveLength(b.view.nodes.length);
  });

  it('keeps the in-flight entry consistent when a refresh overlaps a plain request', async () => {
    agent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply }, strict: true, delayMs: 20 });
    session = newSession();

    await Promise.all([
      session.graph({ level: 'L4', scopeId: 'root' }),
      session.graph({ level: 'L4', scopeId: 'root', refresh: true }),
      session.graph({ level: 'L4', scopeId: 'root' }),
    ]);

    // The plain requests share one run, the refresh is the second: a stale in-flight
    // entry would leak a third agent call here or on the next request.
    expect(agent.calls).toHaveLength(2);
    expect((await session.graph({ level: 'L4', scopeId: 'root' })).cached).toBe(true);
    expect(agent.calls).toHaveLength(2);
  });
});

describe('lazy L3', () => {
  it('generates only the application the user opened', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    const core = await session.graph({ level: 'L3', scopeId: CORE_ID });

    expect(core.view.scope).toMatchObject({ level: 'L3', id: CORE_ID, paths: ['packages/core'] });
    expect(core.view.nodes.map((n) => n.title)).toEqual(['arithmetic', 'schema']);
    expect(agent.callsFor('L3', CORE_ID)).toBe(1);
    // The neighbouring package was never analyzed — the key requirement of SPEC 6.2.
    expect(agent.callsFor('L3', UI_ID)).toBe(0);
    expect(agent.calls).toHaveLength(2);

    await session.graph({ level: 'L3', scopeId: CORE_ID });
    expect(agent.callsFor('L3', CORE_ID)).toBe(1);
  });

  it('passes the opened L4 node to the agent as the parent of the L3 scope', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const request = agent.calls.at(-1)!;
    expect(request.parent?.scope.level).toBe('L4');
    expect(request.parent?.node.title).toBe('@sample/core');
    expect(request.index.name).toBe('sample-app');
  });

  it('generates the parent level first when the UI asks for an L3 scope directly', async () => {
    const core = await session.graph({ level: 'L3', scopeId: CORE_ID });

    expect(core.view.nodes).toHaveLength(2);
    expect(agent.callsFor('L4', 'root')).toBe(1);
    expect(agent.callsFor('L3', CORE_ID)).toBe(1);
  });

  it('gives the agent the whole repository when the application covers it', async () => {
    // The one-application case: the L4 node names "." as its area, so the L3 scope and
    // the digest it is built from have to cover every file, not just the evidence file.
    const wholeRepo = agentGraph([
      {
        slug: 'app',
        kind: 'application',
        title: 'sample-app',
        paths: ['.'],
        hasDetail: true,
        evidence: [{ file: 'package.json', startLine: 1, endLine: 2 }],
      },
    ]);
    agent = new FakeSchemaAgent({ replies: { 'L4:root': wholeRepo }, strict: false });
    session = newSession();

    const l4 = await session.graph({ level: 'L4', scopeId: 'root' });
    expect(l4.openable).toEqual([{ level: 'L3', id: 'L4:root/app', label: 'sample-app', paths: ['.'] }]);

    await session.graph({ level: 'L3', scopeId: 'L4:root/app' });
    const request = agent.calls.at(-1)!;
    expect(request.scope.paths).toEqual(['.']);
    const digest = summarizeForAgent(request.index, request.scope);
    expect(digest).toContain(`files in scope: ${request.index.files.length}`);
    expect(digest).toContain('packages/core/src/math.ts');
  });

  it('reports an unknown scope rather than inventing one', async () => {
    await expect(session.graph({ level: 'L3', scopeId: 'L4:root/nope' })).rejects.toThrow(ScopeNotFoundError);
  });

  it('reports a level that has no prompt builder yet', async () => {
    await expect(session.graph({ level: 'L2', scopeId: CORE_ID })).rejects.toThrow(LevelNotSupportedError);
  });
});

describe('snapshot changes', () => {
  it('regenerates after a commit and keeps the entry of the previous commit', async () => {
    const first = await session.graph({ level: 'L4', scopeId: 'root' });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const two = 2;\n');
    commitAll(repo, 'second');

    const afterCommit = await newSession().graph({ level: 'L4', scopeId: 'root' });

    expect(afterCommit.view.snapshot.commit).not.toBe(first.view.snapshot.commit);
    expect(afterCommit.cached).toBe(false);
    expect(agent.calls).toHaveLength(2);

    // Still cached for the commit it was generated at.
    expect(cache.get({ repoPath: repo, stateId: first.view.snapshot.stateId, level: 'L4', scopeId: 'root' })).not.toBeNull();
  });

  it('regenerates after an uncommitted edit', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const three = 3;\n');

    const dirty = await newSession().graph({ level: 'L4', scopeId: 'root' });

    expect(dirty.view.snapshot.dirty).toBe(true);
    expect(dirty.cached).toBe(false);
    expect(agent.calls).toHaveLength(2);
  });

  it('re-validates a cached reply against the files that are on disk now', async () => {
    // A reply cached for the current state, citing a file that does not exist. Evidence
    // is checked on every read, so a cache hit cannot resurrect a stale node.
    const stale = agentGraph([
      {
        slug: 'core',
        title: '@sample/core',
        paths: ['packages/core'],
        evidence: [{ file: 'packages/core/src/removed.ts', startLine: 1, endLine: 3 }],
      },
    ]);
    cache.set(
      { repoPath: repo, stateId: session.liveSnapshot().stateId, level: 'L4', scopeId: 'root' },
      { scope: { level: 'L4', id: 'root', label: 'sample-app', paths: ['.'] }, snapshot: session.liveSnapshot(), agent: 'fake', raw: stale },
    );

    const response = await session.graph({ level: 'L4', scopeId: 'root' });

    expect(response.cached).toBe(true);
    expect(agent.calls).toHaveLength(0);
    expect(response.view.nodes).toHaveLength(0);
    expect(response.issues.some((i) => i.kind === 'node-dropped')).toBe(true);
  });
});

describe('a directory without git', () => {
  /** The fallback path of step 1: no commit to pin a schema to, so the file list stands in. */
  const plainSession = () => {
    const dir = copyFixture();
    const plainAgent = new FakeSchemaAgent({
      replies: {
        'L4:root': agentGraph([
          { slug: 'app', paths: ['src'], evidence: [{ file: 'package.json', startLine: 1, endLine: 2 }] },
        ]),
      },
    });
    return { dir, plainAgent, plainSession: new RepoSession(dir, { agent: plainAgent, cache: tempCache() }) };
  };

  it('invalidates the cached schema after a file is edited', async () => {
    const { dir, plainAgent, plainSession: s } = plainSession();
    const first = await s.graph({ level: 'L4', scopeId: 'root' });

    appendFileSync(join(dir, 'src/index.ts'), '\nexport const edited = 1;\n');
    const second = await s.graph({ level: 'L4', scopeId: 'root' });

    expect(second.view.snapshot.stateId).not.toBe(first.view.snapshot.stateId);
    expect(second.cached).toBe(false);
    expect(plainAgent.calls).toHaveLength(2);
  });

  it('reuses the index while the directory is untouched', () => {
    // `liveSnapshot` walks the tree on every call here, so the state id it produces has
    // to match the one the index was built with, or every request would re-index.
    const { plainSession: s } = plainSession();
    expect(s.index()).toBe(s.index());
  });

  it('invalidates the cached schema after a file is added', async () => {
    const { dir, plainAgent, plainSession: s } = plainSession();
    const first = await s.graph({ level: 'L4', scopeId: 'root' });

    writeFileSync(join(dir, 'src/added.ts'), 'export const added = 1;\n');

    // SPEC 9.1/9.4: a new file is a new repository state, so the state id has to move,
    // the index has to be rebuilt and the schema may not be served as current.
    expect(s.liveSnapshot().stateId).not.toBe(first.view.snapshot.stateId);
    expect(s.index().files).toContain('src/added.ts');

    const second = await s.graph({ level: 'L4', scopeId: 'root' });
    expect(second.cached).toBe(false);
    expect(plainAgent.calls).toHaveLength(2);
  });
});

describe('fake agent for UI work', () => {
  it('derives a clickable graph from the index alone, with unverified edges only', async () => {
    const indexAgent = new FakeSchemaAgent({ fallback: indexDerivedReply });
    const uiSession = new RepoSession(repo, { agent: indexAgent, cache: tempCache() });

    const l4 = await uiSession.graph({ level: 'L4', scopeId: 'root' });

    expect(l4.view.nodes.length).toBeGreaterThan(0);
    expect(l4.view.edges.every((e) => e.status === 'unverified')).toBe(true);
    expect(l4.view.notes[0]).toContain('No code was analyzed');

    const openable = l4.openable[0]!;
    const l3 = await uiSession.graph({ level: 'L3', scopeId: openable.id });
    expect(l3.view.scope.id).toBe(openable.id);
  });
});
