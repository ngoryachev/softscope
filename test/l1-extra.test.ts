/**
 * Extra checks of the L1 step around the seams the main suites do not reach: deep-linking
 * straight into an L1 scope with nothing loaded, the fake agent's whole L4 → L1 path
 * ending in a cached `unsupported`, odd `order` values, and the real-path session.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { FakeSchemaAgent, indexDerivedReply } from '../src/server/agent/fake';
import { FileCache } from '../src/server/cache/file-cache';
import { RepoSession } from '../src/server/session';
import { validateView } from '../src/server/validation/validate';
import type { ScopeRef } from '../src/shared/graph';
import { agentGraph, cleanupTemps, copyFixture, l1Graph, tempCache } from './helpers';

afterAll(cleanupTemps);

const HTTP = 'src/server/http.ts';
const at = (startLine: number, endLine = startLine) => [{ file: HTTP, startLine, endLine }];

const APP_ID = 'L4:root/app';
const SERVER_ID = `L3:${APP_ID}/server`;
const CONNECTION_ID = `L2:${SERVER_ID}/connection`;
const UTIL_ID = `L2:${SERVER_ID}/util`;

/**
 * The fixture is a workspace, so the fake agent's own L4 never reaches `src/`; the levels
 * above L1 are scripted to end on `src/server` and `src/util`, and L1 falls back to the
 * fake agent's deterministic behaviour reply.
 */
function scriptedAgent(): FakeSchemaAgent {
  return new FakeSchemaAgent({
    fallback: indexDerivedReply,
    replies: {
      'L4:root': agentGraph([{ slug: 'app', paths: ['src'], hasDetail: true, evidence: [{ file: 'package.json', startLine: 1, endLine: 1 }] }]),
      [`L3:${APP_ID}`]: agentGraph([{ slug: 'server', paths: ['src/server'], hasDetail: true, evidence: at(1) }]),
      [`L2:${SERVER_ID}`]: agentGraph([
        { slug: 'connection', kind: 'class', paths: ['src/server'], hasDetail: true, evidence: [{ file: 'src/server/connection.ts', startLine: 23, endLine: 30 }] },
        { slug: 'util', kind: 'module', paths: ['src/util'], hasDetail: true, evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
      ]),
    },
  });
}

describe('L1 extra', () => {
  it('deep-links into an L1 scope of a fresh session with an empty cache by generating every level above it once', async () => {
    const repo = copyFixture();
    const agent = scriptedAgent();
    const fresh = new RepoSession(repo, { agent, cache: tempCache() });
    const l1 = await fresh.graph({ level: 'L1', scopeId: CONNECTION_ID });

    expect(l1.view.scope).toEqual({ level: 'L1', id: CONNECTION_ID, label: 'connection', paths: ['src/server'] });
    expect(l1.view.diagramKind).toBe('state-machine');
    expect(agent.calls.map((c) => c.scope.level)).toEqual(['L4', 'L3', 'L2', 'L1']);
    // The L2 entity reached the agent as the parent even though nobody clicked it.
    expect(agent.calls.at(-1)!.parent?.node.childScope?.id).toBe(CONNECTION_ID);
    expect(agent.calls.at(-1)!.parent?.scope.id).toBe(SERVER_ID);
    expect(l1.view.nodes.map((n) => n.role)).toEqual(['initial', 'state', 'state', 'state', 'final']);
    expect(l1.view.edges.filter((e) => e.status === 'unverified').map((e) => e.label)).toEqual(['retry']);
  });

  it('ends the fake L4 → L1 path on an unsupported view for a plain module and serves it from the cache afterwards', async () => {
    const repo = copyFixture();
    const agent = scriptedAgent();
    const cache = tempCache();
    const session = new RepoSession(repo, { agent, cache });
    await session.graph({ level: 'L4', scopeId: 'root' });
    await session.graph({ level: 'L3', scopeId: APP_ID });
    const l2 = await session.graph({ level: 'L2', scopeId: SERVER_ID });
    expect(l2.openable.map((s) => s.id)).toEqual([CONNECTION_ID, UTIL_ID]);

    const first = await session.graph({ level: 'L1', scopeId: UTIL_ID });
    expect(first.cached).toBe(false);
    expect(first.view.diagramKind).toBe('unsupported');
    expect(first.view.behavior.supported).toBe(false);
    expect(first.view.behavior.reason).toContain('src/util/log.ts');
    expect(first.view.nodes).toEqual([]);
    expect(first.view.edges).toEqual([]);
    expect(first.openable).toEqual([]);
    expect(first.issues).toEqual([]);

    const calls = agent.calls.length;
    const again = await new RepoSession(repo, { agent, cache }).graph({ level: 'L1', scopeId: UTIL_ID });
    expect(again.cached).toBe(true);
    expect(again.view.diagramKind).toBe('unsupported');
    expect(again.view.behavior.reason).toBe(first.view.behavior.reason);
    expect(agent.calls.length).toBe(calls);

    const regenerated = await session.graph({ level: 'L1', scopeId: UTIL_ID, refresh: true });
    expect(regenerated.cached).toBe(false);
    expect(agent.calls.length).toBe(calls + 1);
  });

  it('treats a non-integer or negative message order as missing: such messages go last and the sequence is reported as fixed', () => {
    const repo = copyFixture();
    const scope: ScopeRef = { level: 'L1', id: 'L2:x/handler', label: 'handler', paths: [HTTP] };
    const snapshot = { commit: 'c', branch: 'main', dirty: false, stateId: 'c' } as never;
    const raw = l1Graph(
      'sequence',
      [
        { slug: 'a', role: 'participant', evidence: at(1) },
        { slug: 'b', role: 'participant', evidence: at(1) },
      ],
      [
        { from: 'a', to: 'b', kind: 'calls', label: 'first-by-appearance', order: 1.5, evidence: at(1) },
        { from: 'b', to: 'a', kind: 'returns', label: 'negative', order: -2, evidence: at(1) },
        { from: 'a', to: 'b', kind: 'calls', label: 'seven', order: 7, evidence: at(1) },
        { from: 'a', to: 'b', kind: 'calls', label: 'three', order: 3, evidence: at(1) },
      ],
    );
    const { view, issues } = validateView({ repoPath: repo, scope, snapshot, raw });

    expect(view.edges.map((e) => [e.label, e.order])).toEqual([
      ['first-by-appearance', 3],
      ['negative', 4],
      ['seven', 2],
      ['three', 1],
    ]);
    // Same pair, same kind, several messages: each keeps its own id.
    expect(new Set(view.edges.map((e) => e.id)).size).toBe(4);
    expect(view.edges.every((e) => e.id.endsWith(`#${e.order}`))).toBe(true);
    expect(issues.map((i) => i.kind)).toEqual(['sequence-order-fixed']);

    // Validating the same cached reply again yields the same ids and numbers.
    const second = validateView({ repoPath: repo, scope, snapshot, raw });
    expect(second.view.edges.map((e) => [e.id, e.order])).toEqual(view.edges.map((e) => [e.id, e.order]));
  });

  it('still refuses a cache directory inside the repository when the repository is opened through a symlink', () => {
    const repo = copyFixture();
    const link = join(mkdtempSync(join(tmpdir(), 'softscope-link-')), 'repo-link');
    symlinkSync(repo, link);
    const inside = join(link, '.softscope-cache');

    // Spelled directly: rejected, as before this change.
    expect(() => new RepoSession(repo, { agent: new FakeSchemaAgent(), cache: new FileCache(join(repo, '.softscope-cache')) })).toThrow(
      /must not live inside/,
    );
    // Spelled through the symlink: `repoPath` is now the real path while `cache.root` is
    // not, so the guard must compare like with like.
    expect(() => new RepoSession(link, { agent: new FakeSchemaAgent(), cache: new FileCache(inside) })).toThrow(/must not live inside/);
  });
});
