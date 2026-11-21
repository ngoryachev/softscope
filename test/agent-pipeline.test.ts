/**
 * The cache -> agent -> validation pipeline of `RepoSession`, with the agent faked
 * through its interface. The point of these tests is laziness: the agent must run once
 * per opened scope, and never for a scope the user did not open (SPEC §4.4, §6.2).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeToolInput } from '../src/server/agent/claude';
import { FakeSchemaAgent, indexDerivedReply } from '../src/server/agent/fake';
import type { SchemaAgent } from '../src/server/agent/types';
import { buildPrompt, generatableLevels, supportsLevel } from '../src/server/agent/prompts';
import { summarizeForAgent } from '../src/server/indexer/index';
import { GenerationCancelledError, LevelNotSupportedError, RepoSession, ScopeNotFoundError } from '../src/server/session';
import type { ProgressEvent } from '../src/shared/api';
import type { FileCache } from '../src/server/cache/file-cache';
import {
  agentGraph,
  cleanupTemps,
  commitAll,
  copyFixture,
  copyFixtureAsGitRepo,
  gitCheckout,
  l1Graph,
  switchToNewBranch,
  tempCache,
} from './helpers';

afterAll(cleanupTemps);

const CORE_ID = 'L4:root/core';
const UI_ID = 'L4:root/ui';
const MATH_ID = `L3:${CORE_ID}/math`;
const SCHEMA_ID = `L3:${CORE_ID}/schema`;
const VALIDATION_ID = `L2:${SCHEMA_ID}/validation`;
const SCHEMA_CONST_ID = `L2:${SCHEMA_ID}/schema-const`;
const INDEX_FILE = 'packages/core/src/index.ts';

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
      hasDetail: true,
      evidence: [{ file: 'packages/core/src/math.ts', startLine: 1, endLine: 3 }],
    },
    {
      slug: 'schema',
      title: 'schema',
      paths: ['packages/core/src/index.ts'],
      hasDetail: true,
      evidence: [{ file: 'packages/core/src/index.ts', startLine: 1, endLine: 5 }],
    },
  ],
  [{ from: 'schema', to: 'math', evidence: [{ file: 'packages/core/src/index.ts', startLine: 2, endLine: 2 }] }],
);

/**
 * L2 of the "schema" subsystem: a group, an entity shared with the neighbouring
 * "arithmetic" subsystem, the `add` function of that subsystem as a linked boundary
 * node, and a boundary node whose link points nowhere.
 */
const schemaL2Reply = agentGraph(
  [
    {
      slug: 'validation',
      kind: 'module',
      title: 'validation',
      paths: ['packages/core/src/index.ts'],
      // The one entity whose behaviour can be opened at L1.
      hasDetail: true,
      evidence: [{ file: 'packages/core/src/index.ts', startLine: 1, endLine: 5 }],
    },
    {
      slug: 'schema-const',
      kind: 'constant',
      title: 'schema',
      paths: ['packages/core/src/index.ts'],
      memberOf: ['validation', 'add'],
      evidence: [{ file: 'packages/core/src/index.ts', startLine: 4, endLine: 4 }],
    },
    {
      slug: 'add',
      kind: 'function',
      title: 'add',
      boundary: true,
      subsystemId: MATH_ID,
      evidence: [{ file: 'packages/core/src/math.ts', startLine: 1, endLine: 3 }],
    },
    {
      slug: 'zod',
      kind: 'external-dependency',
      title: 'zod',
      boundary: true,
      subsystemId: 'L3:L4:root/core/nowhere',
      evidence: [{ file: 'packages/core/src/index.ts', startLine: 1, endLine: 1 }],
    },
  ],
  [
    { from: 'validation', to: 'add', kind: 'imports', evidence: [{ file: 'packages/core/src/index.ts', startLine: 2, endLine: 2 }] },
    { from: 'validation', to: 'zod', kind: 'imports', evidence: [{ file: 'packages/core/src/index.ts', startLine: 1, endLine: 1 }] },
  ],
  { diagramKind: 'data-flow' },
);

/** L1 of the "validation" entity: a small state machine over the lines of index.ts. */
const validationL1Reply = l1Graph(
  'state-machine',
  [
    { slug: 'empty', kind: 'state', role: 'initial', evidence: [{ file: INDEX_FILE, startLine: 1, endLine: 1 }] },
    { slug: 'parsed', kind: 'state', role: 'state', evidence: [{ file: INDEX_FILE, startLine: 2, endLine: 2 }] },
    { slug: 'valid', kind: 'state', role: 'final', evidence: [{ file: INDEX_FILE, startLine: 3, endLine: 3 }] },
  ],
  [
    { from: 'empty', to: 'parsed', kind: 'transitions-to', label: 'parse', evidence: [{ file: INDEX_FILE, startLine: 2, endLine: 2 }] },
    { from: 'parsed', to: 'valid', kind: 'transitions-to', label: 'ok', confirmed: false, reason: 'the guard was not read', evidence: [] },
  ],
);

const unsupportedL1Reply = l1Graph('unsupported', [], [], {
  supported: false,
  reason: 'validation is a table of zod schemas; there is no sequence of steps to show',
});

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
    replies: {
      'L4:root': l4Reply,
      [`L3:${CORE_ID}`]: coreL3Reply,
      [`L2:${SCHEMA_ID}`]: schemaL2Reply,
      [`L1:${VALIDATION_ID}`]: validationL1Reply,
    },
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

  it('reports an L1 scope that no L2 view offers rather than inventing one', async () => {
    // Every level has a prompt builder now; the unknown scope is what fails, not the level.
    await expect(session.graph({ level: 'L1', scopeId: SCHEMA_ID })).rejects.toThrow(ScopeNotFoundError);
    await expect(session.graph({ level: 'L1', scopeId: `L2:${SCHEMA_ID}/ghost` })).rejects.toThrow(ScopeNotFoundError);
    expect(agent.callsFor('L1', SCHEMA_ID)).toBe(0);
    expect(agent.calls.every((c) => c.scope.level !== 'L1')).toBe(true);
    expect(new LevelNotSupportedError('L1').message).toContain('L1');
  });
});

describe('lazy L2', () => {
  const openSchema = async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });
    return session.graph({ level: 'L2', scopeId: SCHEMA_ID });
  };

  it('offers the L2 scopes of the subsystems and generates only the one the user opened', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    const core = await session.graph({ level: 'L3', scopeId: CORE_ID });
    expect(core.openable.map((s) => s.id)).toEqual([MATH_ID, SCHEMA_ID]);

    const schema = await session.graph({ level: 'L2', scopeId: SCHEMA_ID });

    expect(schema.view.scope).toMatchObject({ level: 'L2', id: SCHEMA_ID, paths: ['packages/core/src/index.ts'] });
    expect(schema.view.diagramKind).toBe('data-flow');
    expect(schema.view.nodes.map((n) => n.title)).toEqual(['validation', 'schema', 'add', 'zod']);
    expect(agent.callsFor('L2', SCHEMA_ID)).toBe(1);
    // The neighbouring subsystem was never analyzed (SPEC 6.2).
    expect(agent.callsFor('L2', MATH_ID)).toBe(0);
    expect(agent.calls).toHaveLength(3);
    // Only the entity with detail opens into its L1 behaviour view; the constant and the boundary nodes do not.
    expect(schema.openable).toEqual([{ level: 'L1', id: VALIDATION_ID, label: 'validation', paths: ['packages/core/src/index.ts'] }]);
  });

  it('hands the agent the parent L3 node and the neighbouring subsystems', async () => {
    await openSchema();

    const request = agent.calls.at(-1)!;
    expect(request.scope.level).toBe('L2');
    expect(request.parent?.scope).toMatchObject({ level: 'L3', id: CORE_ID });
    expect(request.parent?.node.title).toBe('schema');
    expect(request.parent?.siblings).toEqual([{ id: MATH_ID, title: 'arithmetic', paths: ['packages/core/src/math.ts'] }]);
  });

  it('keeps a boundary link to a sibling subsystem and drops one that points nowhere', async () => {
    const schema = await openSchema();

    const add = schema.view.nodes.find((n) => n.title === 'add')!;
    expect(add.boundary).toBe(true);
    expect(add.subsystemId).toBe(MATH_ID);
    expect(add.childScope).toBeNull();

    const zod = schema.view.nodes.find((n) => n.title === 'zod')!;
    expect(zod.subsystemId).toBe('');
    expect(schema.issues.filter((i) => i.kind === 'subsystem-link-dropped')).toHaveLength(1);
    expect(schema.issues.find((i) => i.kind === 'subsystem-link-dropped')?.nodeId).toBe(zod.id);
  });

  it('keeps an entity that is a member of its group and of the neighbouring boundary node', async () => {
    const schema = await openSchema();

    const entity = schema.view.nodes.find((n) => n.title === 'schema')!;
    expect(entity.memberOf).toEqual([`L2:${SCHEMA_ID}/validation`, `L2:${SCHEMA_ID}/add`]);
  });

  it('caches the L2 and serves the way back up without calling the agent', async () => {
    await openSchema();
    expect(agent.calls).toHaveLength(3);

    const again = await session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    expect(again.cached).toBe(true);
    expect(agent.calls).toHaveLength(3);

    // Breadcrumbs: back to L3, back to L4 — both from memory, neither reaches the agent.
    expect((await session.graph({ level: 'L3', scopeId: CORE_ID })).cached).toBe(true);
    expect((await session.graph({ level: 'L4', scopeId: 'root' })).cached).toBe(true);
    expect(agent.calls).toHaveLength(3);

    // A restarted server: the L2 deep link resolves L4 and L3 from the cache too.
    const later = await newSession().graph({ level: 'L2', scopeId: SCHEMA_ID });
    expect(later.cached).toBe(true);
    expect(later.view.nodes.find((n) => n.title === 'add')?.subsystemId).toBe(MATH_ID);
    expect(agent.calls).toHaveLength(3);
  });

  it('marks the L2 stale after an uncommitted edit, like any other level', async () => {
    const fresh = await openSchema();
    expect(fresh.stale).toBe(false);
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const seven = 7;\n');

    const dirty = await session.graph({ level: 'L2', scopeId: SCHEMA_ID });

    expect(dirty.cached).toBe(true);
    expect(dirty.stale).toBe(true);
    expect(agent.calls).toHaveLength(3);
  });

  it('cancels a running generation, caches nothing and generates again next time', async () => {
    agent = new FakeSchemaAgent({
      replies: { 'L4:root': l4Reply, [`L3:${CORE_ID}`]: coreL3Reply, [`L2:${SCHEMA_ID}`]: schemaL2Reply },
      strict: true,
      delayMs: 200,
    });
    session = newSession();
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const pending = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    await waitFor(() => agent.callsFor('L2', SCHEMA_ID) === 1);
    expect(session.cancel('L2', SCHEMA_ID)).toBe(true);
    await expect(pending).rejects.toThrow(GenerationCancelledError);

    const stateId = session.liveSnapshot().stateId;
    expect(cache.get({ repoPath: repo, stateId, level: 'L2', scopeId: SCHEMA_ID, agent: 'fake' })).toBeNull();
    // Nothing is running any more, so there is nothing to cancel or to subscribe to.
    expect(session.cancel('L2', SCHEMA_ID)).toBe(false);
    expect(session.subscribe('L2', SCHEMA_ID, () => undefined)).toBeNull();

    const retry = await session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    expect(retry.cached).toBe(false);
    expect(agent.callsFor('L2', SCHEMA_ID)).toBe(2);
  });

  it('reports progress once for two concurrent requests that share one agent call', async () => {
    agent = new FakeSchemaAgent({
      replies: { 'L4:root': l4Reply, [`L3:${CORE_ID}`]: coreL3Reply, [`L2:${SCHEMA_ID}`]: schemaL2Reply },
      progress: { [`L2:${SCHEMA_ID}`]: [{ tool: 'Read', detail: 'packages/core/src/index.ts' }] },
      strict: true,
      delayMs: 100,
    });
    session = newSession();
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const events: ProgressEvent[] = [];
    const [a, b] = [session.graph({ level: 'L2', scopeId: SCHEMA_ID }), session.graph({ level: 'L2', scopeId: SCHEMA_ID })];
    await waitFor(() => agent.callsFor('L2', SCHEMA_ID) === 1);
    // A late subscriber gets the buffered events first, then the live ones.
    const detach = session.subscribe('L2', SCHEMA_ID, (e) => events.push(e));
    expect(detach).not.toBeNull();
    await Promise.all([a, b]);

    expect(agent.callsFor('L2', SCHEMA_ID)).toBe(1);
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'activity')).toMatchObject([{ tool: 'Read', detail: 'packages/core/src/index.ts' }]);
    expect(events.at(-1)?.type).toBe('done');
    expect(agent.calls.at(-1)?.signal?.aborted).toBe(false);
  });
});

describe('generation jobs', () => {
  const l2Progress = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ tool: 'Read', detail: `packages/core/src/file-${i}.ts` }));

  const slowSession = (delayMs: number, progress?: Record<string, Array<{ tool: string; detail: string }>>) => {
    agent = new FakeSchemaAgent({
      replies: { 'L4:root': l4Reply, [`L3:${CORE_ID}`]: coreL3Reply, [`L2:${SCHEMA_ID}`]: schemaL2Reply },
      strict: true,
      delayMs,
      ...(progress ? { progress } : {}),
    });
    session = newSession();
  };

  const cacheEntry = (level: 'L4' | 'L3' | 'L2', scopeId: string) =>
    cache.get({ repoPath: repo, stateId: session.liveSnapshot().stateId, level, scopeId, agent: 'fake' });

  it('cancelling the parent L3 fails a deep-linked L2 request as cancelled and caches neither level', async () => {
    slowSession(200);
    await session.graph({ level: 'L4', scopeId: 'root' });

    const pending = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    await waitFor(() => agent.callsFor('L3', CORE_ID) === 1);
    // The L2 job does not exist yet: the parent level is what is running.
    expect(session.cancel('L2', SCHEMA_ID)).toBe(false);
    expect(session.cancel('L3', CORE_ID)).toBe(true);

    await expect(pending).rejects.toThrow(GenerationCancelledError);
    expect(cacheEntry('L3', CORE_ID)).toBeNull();
    expect(cacheEntry('L2', SCHEMA_ID)).toBeNull();
    expect(agent.callsFor('L2', SCHEMA_ID)).toBe(0);

    // Nothing is poisoned: the next request walks down again.
    const retry = await session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    expect(retry.cached).toBe(false);
    expect(agent.callsFor('L3', CORE_ID)).toBe(2);
    expect(agent.callsFor('L2', SCHEMA_ID)).toBe(1);
  });

  it('aborting the request signal cancels the job and tells subscribers so', async () => {
    slowSession(200);
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const pending = session.graph({ level: 'L2', scopeId: SCHEMA_ID, signal: controller.signal });
    await waitFor(() => agent.callsFor('L2', SCHEMA_ID) === 1);
    expect(session.subscribe('L2', SCHEMA_ID, (e) => events.push(e))).not.toBeNull();
    controller.abort();

    await expect(pending).rejects.toThrow(GenerationCancelledError);
    expect(agent.calls.at(-1)?.signal?.aborted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['started', 'cancelled']);
    expect(cacheEntry('L2', SCHEMA_ID)).toBeNull();
  });

  it('cancel fails every request that joined the same generation', async () => {
    slowSession(200);
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const a = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    const b = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    await waitFor(() => agent.callsFor('L2', SCHEMA_ID) === 1);
    expect(session.cancel('L2', SCHEMA_ID)).toBe(true);

    await expect(a).rejects.toThrow(GenerationCancelledError);
    await expect(b).rejects.toThrow(GenerationCancelledError);
    expect(agent.callsFor('L2', SCHEMA_ID)).toBe(1);
  });

  it('treats a reply that arrives after the abort as cancelled and caches nothing', async () => {
    const fake = new FakeSchemaAgent({
      replies: { 'L4:root': l4Reply, [`L3:${CORE_ID}`]: coreL3Reply, [`L2:${SCHEMA_ID}`]: schemaL2Reply },
      strict: true,
      delayMs: 150,
    });
    agent = fake;
    // An agent that does not honour the abort signal: the SDK may well keep going for a
    // while after it is asked to stop. The session, not the agent, decides what counts.
    const stubborn: SchemaAgent = {
      name: fake.name,
      generate(req) {
        const ignoringAbort = { ...req };
        delete ignoringAbort.signal;
        return fake.generate(ignoringAbort);
      },
    };
    session = new RepoSession(repo, { agent: stubborn, cache });
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const events: ProgressEvent[] = [];
    const pending = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    await waitFor(() => fake.callsFor('L2', SCHEMA_ID) === 1);
    session.subscribe('L2', SCHEMA_ID, (e) => events.push(e));
    expect(session.cancel('L2', SCHEMA_ID)).toBe(true);

    await expect(pending).rejects.toThrow(GenerationCancelledError);
    expect(events.at(-1)?.type).toBe('cancelled');
    expect(cacheEntry('L2', SCHEMA_ID)).toBeNull();
  });

  it('reports an agent failure as an error event and forgets the job', async () => {
    slowSession(100);
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const events: ProgressEvent[] = [];
    // The strict fake has no reply for the "arithmetic" subsystem, so it fails after its delay.
    const pending = session.graph({ level: 'L2', scopeId: MATH_ID });
    await waitFor(() => agent.callsFor('L2', MATH_ID) === 1);
    session.subscribe('L2', MATH_ID, (e) => events.push(e));

    await expect(pending).rejects.toThrow(/no reply/);
    expect(events.map((e) => e.type)).toEqual(['started', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('no reply') });
    expect(session.subscribe('L2', MATH_ID, () => undefined)).toBeNull();
    expect(session.cancel('L2', MATH_ID)).toBe(false);
    expect(cacheEntry('L2', MATH_ID)).toBeNull();
  });

  it('replays the started event and only the most recent activity to a late subscriber', async () => {
    slowSession(100, { [`L2:${SCHEMA_ID}`]: l2Progress(45) });
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });

    const events: ProgressEvent[] = [];
    const pending = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    await waitFor(() => agent.callsFor('L2', SCHEMA_ID) === 1);
    session.subscribe('L2', SCHEMA_ID, (e) => events.push(e));

    expect(events[0]?.type).toBe('started');
    const activity = events.filter((e) => e.type === 'activity');
    expect(activity).toHaveLength(40);
    expect(activity[0]).toMatchObject({ detail: 'packages/core/src/file-5.ts' });
    expect(activity.at(-1)).toMatchObject({ detail: 'packages/core/src/file-44.ts' });
    await pending;
    expect(events.at(-1)?.type).toBe('done');
    // A listener that detached is not called again.
    const late: ProgressEvent[] = [];
    expect(session.subscribe('L2', SCHEMA_ID, (e) => late.push(e))).toBeNull();
    expect(late).toEqual([]);
  });

  it('does not emit a job for a cached view', async () => {
    slowSession(50);
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });
    await session.graph({ level: 'L2', scopeId: SCHEMA_ID });

    const pending = session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    expect(session.subscribe('L2', SCHEMA_ID, () => undefined)).toBeNull();
    expect((await pending).cached).toBe(true);
  });
});

describe('L2 prompt', () => {
  it('hands the agent the subsystem slice, the parent node, the sibling ids and the boundary rules', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });
    await session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    const request = agent.calls.at(-1)!;

    const { system, prompt } = buildPrompt(request);
    expect(system.length).toBeGreaterThan(0);
    // Scope and parent.
    expect(prompt).toContain(`scope: L2 ${SCHEMA_ID} (schema)`);
    expect(prompt).toContain('scope paths: packages/core/src/index.ts');
    expect(prompt).toContain('opened the L3 node "schema"');
    // The sibling list carries the exact ids the agent has to echo in subsystemId.
    expect(prompt).toContain(`id: ${MATH_ID}`);
    expect(prompt).toContain('title: arithmetic');
    expect(prompt).toContain('paths: packages/core/src/math.ts');
    // The index slice is the subsystem's files, not the repository.
    expect(prompt).toContain('- packages/core/src/index.ts');
    expect(prompt).toContain('files in scope: 1 (1 TS/JS)');
    expect(prompt).not.toContain('packages/ui/src/index.tsx');
    expect(prompt).not.toContain('src/server/');
    // SPEC 6.2, 5.1, 5.3 rules are spelled out.
    expect(prompt).toMatch(/Never describe or detail a neighbouring\s+subsystem/);
    expect(prompt).toContain('subsystemId');
    expect(prompt).toContain('memberOf');
    expect(prompt).toContain('"component-graph"');
    expect(prompt).toContain('"data-flow"');
    // Entities whose behaviour can be shown at L1 are openable now.
    expect(prompt).toContain('hasDetail=true');
    expect(prompt).not.toMatch(/entities are not opened further/);
  });

  it('still builds without a parent, saying no neighbours are known', () => {
    const index = session.index();
    const scope = { level: 'L2' as const, id: SCHEMA_ID, label: 'schema', paths: ['packages/core/src/index.ts'] };
    const { prompt } = buildPrompt({ repoPath: repo, index, scope });
    expect(prompt).toContain('(none known)');
    expect(prompt).not.toContain('opened the L3 node');
  });

  it('has a builder for every level, L1 included', () => {
    expect(generatableLevels()).toEqual(['L4', 'L3', 'L2', 'L1']);
    expect(supportsLevel('L1')).toBe(true);
  });
});

describe('lazy L1', () => {
  const openValidation = async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });
    await session.graph({ level: 'L2', scopeId: SCHEMA_ID });
    return session.graph({ level: 'L1', scopeId: VALIDATION_ID });
  };

  it('generates the L1 of the opened entity only, through the same pipeline as every other level', async () => {
    const l1 = await openValidation();

    expect(l1.cached).toBe(false);
    expect(l1.stale).toBe(false);
    expect(l1.view.scope).toEqual({ level: 'L1', id: VALIDATION_ID, label: 'validation', paths: [INDEX_FILE] });
    expect(l1.view.diagramKind).toBe('state-machine');
    expect(l1.view.behavior).toEqual({ supported: true, reason: '' });
    expect(l1.view.nodes.map((n) => [n.title, n.role])).toEqual([
      ['empty', 'initial'],
      ['parsed', 'state'],
      ['valid', 'final'],
    ]);
    expect(l1.view.edges.map((e) => [e.label, e.status])).toEqual([
      ['parse', 'confirmed'],
      ['ok', 'unverified'],
    ]);
    expect(l1.issues.map((i) => i.kind)).toEqual(['edge-unverified']);
    // The bottom: nothing opens from an L1 view.
    expect(l1.openable).toEqual([]);
    expect(l1.view.nodes.every((n) => n.childScope === null)).toBe(true);
    expect(agent.callsFor('L1', VALIDATION_ID)).toBe(1);
    expect(agent.callsFor('L1', SCHEMA_CONST_ID)).toBe(0);
    expect(agent.calls).toHaveLength(4);
  });

  it('hands the agent the opened L2 entity as the parent of the L1 scope', async () => {
    await openValidation();
    const request = agent.calls.at(-1)!;
    expect(request.scope.level).toBe('L1');
    expect(request.parent?.scope).toMatchObject({ level: 'L2', id: SCHEMA_ID });
    expect(request.parent?.node.title).toBe('validation');
    expect(request.parent?.node.childScope?.id).toBe(VALIDATION_ID);
  });

  it('serves the L1 from the cache afterwards, in this session and in a fresh one', async () => {
    await openValidation();
    const again = await session.graph({ level: 'L1', scopeId: VALIDATION_ID });
    expect(again.cached).toBe(true);
    expect(agent.calls).toHaveLength(4);

    const later = await newSession().graph({ level: 'L1', scopeId: VALIDATION_ID });
    expect(later.cached).toBe(true);
    expect(later.view.diagramKind).toBe('state-machine');
    expect(later.view.nodes[0]!.role).toBe('initial');
    expect(agent.calls).toHaveLength(4);
  });

  it('caches an unsupported reply too, so the user does not pay twice; Regenerate asks again', async () => {
    agent.set('L1', VALIDATION_ID, unsupportedL1Reply);
    const first = await openValidation();

    expect(first.cached).toBe(false);
    expect(first.view.diagramKind).toBe('unsupported');
    expect(first.view.nodes).toEqual([]);
    expect(first.view.behavior).toEqual({ supported: false, reason: unsupportedL1Reply.behavior.reason });
    expect(first.issues).toEqual([]);

    const second = await session.graph({ level: 'L1', scopeId: VALIDATION_ID });
    expect(second.cached).toBe(true);
    expect(second.view.behavior.supported).toBe(false);
    expect(agent.callsFor('L1', VALIDATION_ID)).toBe(1);

    agent.set('L1', VALIDATION_ID, validationL1Reply);
    const regenerated = await session.graph({ level: 'L1', scopeId: VALIDATION_ID, refresh: true });
    expect(regenerated.cached).toBe(false);
    expect(regenerated.view.diagramKind).toBe('state-machine');
    expect(agent.callsFor('L1', VALIDATION_ID)).toBe(2);
  });

  it('serves the previous L1 marked stale after a commit, and regenerates on request', async () => {
    const first = await openValidation();
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const eight = 8;\n');
    commitAll(repo, 'second');

    const later = newSession();
    const stale = await later.graph({ level: 'L1', scopeId: VALIDATION_ID });
    expect(stale.cached).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.view.snapshot.commit).toBe(first.view.snapshot.commit);
    expect(stale.view.diagramKind).toBe('state-machine');
    expect(agent.callsFor('L1', VALIDATION_ID)).toBe(1);

    const fresh = await later.graph({ level: 'L1', scopeId: VALIDATION_ID, refresh: true });
    expect(fresh.stale).toBe(false);
    expect(agent.callsFor('L1', VALIDATION_ID)).toBe(2);
  });

  it('cancels a running L1 generation through the job registry and caches nothing', async () => {
    agent = new FakeSchemaAgent({
      replies: {
        'L4:root': l4Reply,
        [`L3:${CORE_ID}`]: coreL3Reply,
        [`L2:${SCHEMA_ID}`]: schemaL2Reply,
        [`L1:${VALIDATION_ID}`]: validationL1Reply,
      },
      strict: true,
      delayMs: 200,
    });
    session = newSession();
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });
    await session.graph({ level: 'L2', scopeId: SCHEMA_ID });

    const events: ProgressEvent[] = [];
    const pending = session.graph({ level: 'L1', scopeId: VALIDATION_ID });
    await waitFor(() => agent.callsFor('L1', VALIDATION_ID) === 1);
    expect(session.subscribe('L1', VALIDATION_ID, (e) => events.push(e))).not.toBeNull();
    expect(session.cancel('L1', VALIDATION_ID)).toBe(true);

    await expect(pending).rejects.toThrow(GenerationCancelledError);
    expect(events.map((e) => e.type)).toEqual(['started', 'cancelled']);
    const stateId = session.liveSnapshot().stateId;
    expect(cache.get({ repoPath: repo, stateId, level: 'L1', scopeId: VALIDATION_ID, agent: 'fake' })).toBeNull();

    const retry = await session.graph({ level: 'L1', scopeId: VALIDATION_ID });
    expect(retry.cached).toBe(false);
    expect(agent.callsFor('L1', VALIDATION_ID)).toBe(2);
  });

  it('builds an L1 prompt that names the three kinds, the roles, the ordering and the unsupported answer', async () => {
    await openValidation();
    const request = agent.calls.at(-1)!;
    const { system, prompt } = buildPrompt(request);

    expect(system).toContain('EVIDENCE OR IT DOES NOT EXIST');
    expect(prompt).toContain(`scope: L1 ${VALIDATION_ID} (validation)`);
    expect(prompt).toContain(`scope paths: ${INDEX_FILE}`);
    expect(prompt).toContain('opened the L2 node "validation"');
    expect(prompt).toContain('"state-machine"');
    expect(prompt).toContain('"sequence"');
    expect(prompt).toContain('"flow"');
    expect(prompt).toContain('"initial"');
    expect(prompt).toContain('"final"');
    expect(prompt).toContain('"participant"');
    expect(prompt).toContain('"decision"');
    expect(prompt).toContain('order = 1, 2, 3');
    expect(prompt).toContain('"async"');
    expect(prompt).toContain('"return"');
    expect(prompt).toContain('behavior.supported=false');
    expect(prompt).toContain('boundary=true');
    expect(prompt).toMatch(/absent\s+from your diagram is not a claim that it does not exist/);
    expect(prompt).not.toContain('packages/ui/src/index.tsx');
  });
});

describe('agent activity shown to the user', () => {
  it('names the file for Read, the pattern for Grep and Glob, and falls back to the input', () => {
    expect(describeToolInput('Read', { file_path: 'src/x.ts' })).toBe('src/x.ts');
    expect(describeToolInput('Grep', { pattern: 'foo' })).toBe('foo');
    expect(describeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src');
    expect(describeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(describeToolInput('Other', { thing: 1 })).toBe('{"thing":1}');
    expect(describeToolInput('Read', undefined)).toBe('{}');
  });
});

/** Polls `condition` until it holds; the fake agent starts after a few awaited ticks. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('snapshot changes', () => {
  it('shows the previous schema marked stale after a commit, and regenerates on request', async () => {
    const first = await session.graph({ level: 'L4', scopeId: 'root' });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const two = 2;\n');
    commitAll(repo, 'second');

    // Navigating back to the scope must not spend a minute of agent time: the schema of
    // the previous commit is shown, flagged stale rather than presented as current.
    const afterCommit = await newSession().graph({ level: 'L4', scopeId: 'root' });

    expect(afterCommit.cached).toBe(true);
    expect(afterCommit.stale).toBe(true);
    expect(afterCommit.view.snapshot.commit).toBe(first.view.snapshot.commit);
    expect(agent.calls).toHaveLength(1);

    // Regenerate pins the schema to the new commit; the old entry stays cached.
    const fresh = await session.graph({ level: 'L4', scopeId: 'root', refresh: true });
    expect(fresh.stale).toBe(false);
    expect(fresh.view.snapshot.commit).not.toBe(first.view.snapshot.commit);
    expect(agent.calls).toHaveLength(2);
    expect(
      cache.get({ repoPath: repo, stateId: first.view.snapshot.stateId, level: 'L4', scopeId: 'root', agent: 'fake' }),
    ).not.toBeNull();
  });

  it('shows the previous schema marked stale after an uncommitted edit', async () => {
    const first = await session.graph({ level: 'L4', scopeId: 'root' });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const three = 3;\n');

    const dirty = await newSession().graph({ level: 'L4', scopeId: 'root' });

    expect(dirty.cached).toBe(true);
    expect(dirty.stale).toBe(true);
    expect(dirty.view.snapshot.stateId).toBe(first.view.snapshot.stateId);
    expect(agent.calls).toHaveLength(1);
  });

  it('reuses the schema of the same commit when only the branch label changed', async () => {
    const first = await session.graph({ level: 'L4', scopeId: 'root' });
    switchToNewBranch(repo, 'feature');

    const onFeature = await newSession().graph({ level: 'L4', scopeId: 'root' });

    // Same commit, same working tree: the code is identical, so this is not stale —
    // only the branch the snapshot reports changes.
    expect(onFeature.cached).toBe(true);
    expect(onFeature.stale).toBe(false);
    expect(onFeature.view.snapshot.branch).toBe('feature');
    expect(first.view.snapshot.branch).toBe('main');
    expect(agent.calls).toHaveLength(1);
  });

  it('serves a cached L3 marked stale under a stale L4, and lets each be regenerated on its own', async () => {
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: CORE_ID });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const four = 4;\n');
    commitAll(repo, 'second');

    // A deep link into the subsystem after the commit: both levels come from the cache.
    const later = newSession();
    const core = await later.graph({ level: 'L3', scopeId: CORE_ID });
    expect(core.cached).toBe(true);
    expect(core.stale).toBe(true);
    expect(core.view.nodes.map((n) => n.title)).toEqual(['arithmetic', 'schema']);
    expect(agent.calls).toHaveLength(2);

    // Regenerating the L3 pins it to the new commit; the L4 above it stays stale until
    // the user asks for it too — and neither regeneration touches the other scope.
    const freshCore = await later.graph({ level: 'L3', scopeId: CORE_ID, refresh: true });
    expect(freshCore.stale).toBe(false);
    expect(agent.callsFor('L3', CORE_ID)).toBe(2);
    expect(agent.callsFor('L4', 'root')).toBe(1);
    expect((await later.graph({ level: 'L4', scopeId: 'root' })).stale).toBe(true);
    expect((await later.graph({ level: 'L3', scopeId: CORE_ID })).stale).toBe(false);
    expect(agent.calls).toHaveLength(3);
  });

  it('falls back to the most recently generated schema when several commits are cached', async () => {
    const first = await session.graph({ level: 'L4', scopeId: 'root' });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const five = 5;\n');
    commitAll(repo, 'second');
    // storedAt has millisecond resolution; keep the two generations apart.
    await new Promise((r) => setTimeout(r, 5));
    const second = await newSession().graph({ level: 'L4', scopeId: 'root', refresh: true });
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const six = 6;\n');
    commitAll(repo, 'third');

    const third = await newSession().graph({ level: 'L4', scopeId: 'root' });
    expect(third.stale).toBe(true);
    expect(third.view.snapshot.commit).toBe(second.view.snapshot.commit);
    expect(third.view.snapshot.commit).not.toBe(first.view.snapshot.commit);
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
      { repoPath: repo, stateId: session.liveSnapshot().stateId, level: 'L4', scopeId: 'root', agent: 'fake' },
      { scope: { level: 'L4', id: 'root', label: 'sample-app', paths: ['.'] }, snapshot: session.liveSnapshot(), raw: stale },
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

  it('notices an edit and stops presenting the cached schema as current', async () => {
    const { dir, plainAgent, plainSession: s } = plainSession();
    const first = await s.graph({ level: 'L4', scopeId: 'root' });

    appendFileSync(join(dir, 'src/index.ts'), '\nexport const edited = 1;\n');

    expect(s.liveSnapshot().stateId).not.toBe(first.view.snapshot.stateId);
    const second = await s.graph({ level: 'L4', scopeId: 'root' });

    expect(second.stale).toBe(true);
    expect(plainAgent.calls).toHaveLength(1);
    expect((await s.graph({ level: 'L4', scopeId: 'root', refresh: true })).stale).toBe(false);
    expect(plainAgent.calls).toHaveLength(2);
  });

  it('reuses the index while the directory is untouched', () => {
    // `liveSnapshot` walks the tree on every call here, so the state id it produces has
    // to match the one the index was built with, or every request would re-index.
    const { plainSession: s } = plainSession();
    expect(s.index()).toBe(s.index());
  });

  it('notices a file that was added after the first index', async () => {
    const { dir, plainAgent, plainSession: s } = plainSession();
    const first = await s.graph({ level: 'L4', scopeId: 'root' });

    writeFileSync(join(dir, 'src/added.ts'), 'export const added = 1;\n');

    // SPEC 9.1/9.4: a new file is a new repository state, so the state id has to move,
    // the index has to be rebuilt and the schema may not be served as current.
    expect(s.liveSnapshot().stateId).not.toBe(first.view.snapshot.stateId);
    expect(s.index().files).toContain('src/added.ts');

    const second = await s.graph({ level: 'L4', scopeId: 'root' });
    expect(second.stale).toBe(true);

    // Regenerating sees the new file, which is what the stale index used to hide.
    await s.graph({ level: 'L4', scopeId: 'root', refresh: true });
    expect(plainAgent.calls).toHaveLength(2);
    expect(plainAgent.calls.at(-1)!.index.files).toContain('src/added.ts');
  });
});

describe('which cached schema may be reused', () => {
  it('never serves a schema that another agent produced', async () => {
    // SOFTSCOPE_FAKE_AGENT derives graphs from the index without reading any code, so
    // its replies must not surface in a session that talks to Claude, or the reverse.
    const fakeReply = agentGraph([
      { slug: 'app', title: 'from the fake', evidence: [{ file: 'package.json', startLine: 1, endLine: 1 }] },
    ]);
    await new RepoSession(repo, { agent: new FakeSchemaAgent({ replies: { 'L4:root': fakeReply } }), cache }).graph({
      level: 'L4',
      scopeId: 'root',
    });

    // Same repository, same state, same scope — but an agent under a different name.
    const scripted = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply } });
    const asClaude: SchemaAgent = { name: 'claude-agent-sdk', generate: (r) => scripted.generate(r) };
    const response = await new RepoSession(repo, { agent: asClaude, cache }).graph({ level: 'L4', scopeId: 'root' });

    expect(response.cached).toBe(false);
    expect(scripted.calls).toHaveLength(1);
    expect(response.view.nodes.map((n) => n.title)).not.toContain('from the fake');
  });

  it('falls back to the schema of the current commit rather than a newer one', async () => {
    const atFirstCommit = await session.graph({ level: 'L4', scopeId: 'root' });
    const firstCommit = atFirstCommit.view.snapshot.commit;

    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const four = 4;\n');
    commitAll(repo, 'second');
    const atSecondCommit = await session.graph({ level: 'L4', scopeId: 'root', refresh: true });
    expect(atSecondCommit.view.snapshot.commit).not.toBe(firstCommit);

    // Back on the first commit with an uncommitted edit: its own schema is the closest
    // description of the code on disk, even though the other one was generated later.
    gitCheckout(repo, firstCommit);
    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const five = 5;\n');

    const fallback = await newSession().graph({ level: 'L4', scopeId: 'root' });
    expect(fallback.cached).toBe(true);
    expect(fallback.stale).toBe(true);
    expect(fallback.view.snapshot.commit).toBe(firstCommit);
  });

  it('keeps each agent its own entry for the same state instead of overwriting', async () => {
    // Alternating a fake session (for UI work) and a real one at the same commit must
    // not cost a generation each time round: the two entries live side by side.
    const scripted = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply } });
    const asClaude: SchemaAgent = { name: 'claude-agent-sdk', generate: (r) => scripted.generate(r) };
    const fake = new FakeSchemaAgent({
      replies: {
        'L4:root': agentGraph([
          { slug: 'app', title: 'from the fake', evidence: [{ file: 'package.json', startLine: 1, endLine: 1 }] },
        ]),
      },
    });

    await new RepoSession(repo, { agent: asClaude, cache }).graph({ level: 'L4', scopeId: 'root' });
    await new RepoSession(repo, { agent: fake, cache }).graph({ level: 'L4', scopeId: 'root' });

    const backToClaude = await new RepoSession(repo, { agent: asClaude, cache }).graph({
      level: 'L4',
      scopeId: 'root',
    });
    expect(backToClaude.cached).toBe(true);
    expect(backToClaude.stale).toBe(false);
    expect(backToClaude.view.nodes.map((n) => n.title)).toContain('@sample/core');
    expect(scripted.calls).toHaveLength(1);

    const backToFake = await new RepoSession(repo, { agent: fake, cache }).graph({ level: 'L4', scopeId: 'root' });
    expect(backToFake.cached).toBe(true);
    expect(backToFake.view.nodes.map((n) => n.title)).toEqual(['from the fake']);
    expect(fake.calls).toHaveLength(1);
  });

  it('still falls back to its own earlier schema when another agent wrote a newer entry', async () => {
    // Claude generated at the first commit; the fake agent (SOFTSCOPE_FAKE_AGENT) at the
    // second; then a third commit. A Claude session has a schema of its own to show
    // marked stale — the fake agent's newer entry must not hide it and force a paid call.
    const scripted = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply } });
    const asClaude: SchemaAgent = { name: 'claude-agent-sdk', generate: (r) => scripted.generate(r) };
    const first = await new RepoSession(repo, { agent: asClaude, cache }).graph({ level: 'L4', scopeId: 'root' });
    expect(scripted.calls).toHaveLength(1);

    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const four = 4;\n');
    commitAll(repo, 'second');
    await new Promise((r) => setTimeout(r, 5));
    const fakeReply = agentGraph([
      { slug: 'app', title: 'from the fake', evidence: [{ file: 'package.json', startLine: 1, endLine: 1 }] },
    ]);
    await new RepoSession(repo, { agent: new FakeSchemaAgent({ replies: { 'L4:root': fakeReply } }), cache }).graph({
      level: 'L4',
      scopeId: 'root',
    });

    appendFileSync(join(repo, 'packages/core/src/math.ts'), '\nexport const five = 5;\n');
    commitAll(repo, 'third');

    const later = await new RepoSession(repo, { agent: asClaude, cache }).graph({ level: 'L4', scopeId: 'root' });
    expect(later.view.nodes.map((n) => n.title)).not.toContain('from the fake');
    expect(later.cached).toBe(true);
    expect(later.stale).toBe(true);
    expect(later.view.snapshot.commit).toBe(first.view.snapshot.commit);
    expect(scripted.calls).toHaveLength(1);
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

    // L3 → L2 → L1: every module group is openable, so the whole path can be clicked.
    const l2 = await uiSession.graph({ level: 'L2', scopeId: l3.openable[0]!.id });
    expect(l2.view.scope.level).toBe('L2');
    expect(l2.openable.length).toBeGreaterThan(0);
    const l1 = await uiSession.graph({ level: 'L1', scopeId: l2.openable[0]!.id });
    expect(l1.view.scope.level).toBe('L1');
    expect(['state-machine', 'sequence', 'flow', 'unsupported']).toContain(l1.view.diagramKind);
    expect(l1.openable).toEqual([]);
    // The core package's src has neither a state-machine-like file nor a server file.
    expect(l1.view.diagramKind).toBe('unsupported');
    expect(l1.view.behavior.reason).toContain('packages/core/src/index.ts');
  });

  it('answers L1 deterministically from the scope paths: state machine, sequence or unsupported', () => {
    const index = session.index();
    const l1 = (paths: string[]) =>
      indexDerivedReply({ repoPath: repo, index, scope: { level: 'L1', id: `L2:x/${paths.join('-')}`, label: 'entity', paths } });

    const machine = l1(['src/server']);
    expect(machine.diagramKind).toBe('state-machine');
    expect(machine.behavior.supported).toBe(true);
    expect(machine.nodes.map((n) => [n.slug, n.role])).toEqual([
      ['idle', 'initial'],
      ['connecting', 'state'],
      ['open', 'state'],
      ['failed', 'state'],
      ['closed', 'final'],
    ]);
    expect(machine.nodes.every((n) => n.evidence[0]!.file === 'src/server/connection.ts')).toBe(true);
    expect(machine.edges.map((e) => e.label)).toEqual(['connect', 'opened', 'error', 'close', 'retry']);
    expect(machine.edges.filter((e) => !e.confirmed).map((e) => e.label)).toEqual(['retry']);
    // The same decision for the file itself as the scope.
    expect(l1(['src/server/connection.ts']).diagramKind).toBe('state-machine');

    const sequence = l1(['src']);
    expect(sequence.diagramKind).toBe('sequence');
    expect(sequence.nodes.map((n) => [n.slug, n.role, n.boundary])).toEqual([
      ['caller', 'participant', true],
      ['handler', 'participant', false],
      ['collaborator', 'participant', false],
    ]);
    expect(sequence.edges.map((e) => [e.order, e.style])).toEqual([
      [1, 'sync'],
      [2, 'async'],
      [3, 'return'],
    ]);
    expect(sequence.nodes.every((n) => n.evidence[0]!.file === 'src/cli.ts')).toBe(true);

    const none = l1(['src/util']);
    expect(none.diagramKind).toBe('unsupported');
    expect(none.behavior.supported).toBe(false);
    expect(none.behavior.reason).toContain('src/util/log.ts');
    expect(none.nodes).toEqual([]);
  });

  it('validates the fake state machine against the fixture: every element survives, the retry is unverified', async () => {
    const machineAgent = new FakeSchemaAgent({ fallback: indexDerivedReply });
    const uiSession = new RepoSession(repo, { agent: machineAgent, cache: tempCache() });
    // A scripted L4 → L3 → L2 path that ends on the server directory, where connection.ts lives.
    machineAgent.set('L4', 'root', agentGraph([{ slug: 'app', paths: ['src'], hasDetail: true, evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }]));
    machineAgent.set('L3', 'L4:root/app', agentGraph([{ slug: 'server', paths: ['src/server'], hasDetail: true, evidence: [{ file: 'src/server/http.ts', startLine: 1, endLine: 1 }] }]));
    machineAgent.set(
      'L2',
      'L3:L4:root/app/server',
      agentGraph([{ slug: 'connection', kind: 'class', title: 'Connection', paths: ['src/server/connection.ts'], hasDetail: true, evidence: [{ file: 'src/server/connection.ts', startLine: 23, endLine: 30 }] }]),
    );
    await uiSession.graph({ level: 'L4', scopeId: 'root' });
    await uiSession.graph({ level: 'L3', scopeId: 'L4:root/app' });
    const l2 = await uiSession.graph({ level: 'L2', scopeId: 'L3:L4:root/app/server' });
    const l1 = await uiSession.graph({ level: 'L1', scopeId: l2.openable[0]!.id });

    expect(l1.view.diagramKind).toBe('state-machine');
    expect(l1.view.nodes).toHaveLength(5);
    expect(l1.view.edges.map((e) => [e.label, e.status])).toEqual([
      ['connect', 'confirmed'],
      ['opened', 'confirmed'],
      ['error', 'confirmed'],
      ['close', 'confirmed'],
      ['retry', 'unverified'],
    ]);
    expect(l1.issues.map((i) => i.kind)).toEqual(['edge-unverified']);
  });
});
