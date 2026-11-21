import { describe, expect, it } from 'vitest';
import {
  agentGraphJsonSchema,
  parseAgentGraph,
  type AgentGraph,
} from '../src/shared/agent-schema';
import { renderContextMarkdown } from '../src/shared/context-markdown';
import {
  buildSelectionContext,
  childScopeOf,
  edgeId,
  expandSelection,
  levelOfNodeId,
  membersOf,
  mergeRanges,
  nextLevel,
  nodeId,
  rootScope,
  scopeOwnerOf,
  subsystemsOf,
  viewKeyOfId,
  type GraphEdge,
  type GraphNode,
  type GraphView,
  type Snapshot,
} from '../src/shared/graph';
import { SUPPORTED } from './helpers';

const snapshot: Snapshot = {
  branch: 'main',
  commit: 'a'.repeat(40),
  shortCommit: 'aaaaaaaa',
  dirty: false,
  stateId: 'a'.repeat(40),
  generatedAt: '2026-01-01T00:00:00.000Z',
};

/** The part of a snapshot the context carries (no `generatedAt`). */
const pick = ({ branch, commit, shortCommit, dirty, stateId }: Snapshot) => ({ branch, commit, shortCommit, dirty, stateId });

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    level: 'L3',
    kind: 'subsystem',
    title: id,
    summary: '',
    evidence: [{ file: `${id}.ts`, startLine: 1, endLine: 2 }],
    boundary: false,
    subsystemId: '',
    memberOf: [],
    paths: [`${id}.ts`],
    childScope: null,
    ...over,
  };
}

function edge(from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: 'imports',
    label: '',
    evidence: [{ file: `${from}.ts`, startLine: 1, endLine: 1 }],
    status: 'confirmed',
    reason: '',
    ...over,
  };
}

const view: GraphView = {
  scope: { level: 'L3', id: 'L4:root/app', label: 'app', paths: ['src'] },
  diagramKind: 'component-graph',
  nodes: [
    node('http'),
    node('jobs'),
    node('logging', { memberOf: ['http', 'jobs'] }),
    node('db', { boundary: true, paths: [] }),
  ],
  edges: [
    edge('http', 'logging'),
    edge('jobs', 'logging'),
    edge('http', 'db', { status: 'unverified', reason: 'connection string comes from the environment', evidence: [] }),
  ],
  notes: [],
  snapshot,
  behavior: SUPPORTED,
};

describe('levels and ids', () => {
  it('walks down the levels and stops at the bottom', () => {
    expect(nextLevel('L4')).toBe('L3');
    expect(nextLevel('L2')).toBe('L1');
    expect(nextLevel('L1')).toBeNull();
  });

  it('namespaces a node id by scope and sanitises the agent slug', () => {
    expect(nodeId(rootScope('demo'), 'HTTP API!')).toBe('L4:root/http-api');
    expect(nodeId(rootScope('demo'), '***')).toBe('L4:root/node');
  });

  it('offers no child scope for a boundary node or at the deepest level', () => {
    expect(childScopeOf(node('http'))?.level).toBe('L2');
    expect(childScopeOf(node('db', { boundary: true }))).toBeNull();
    expect(childScopeOf(node('step', { level: 'L1' }))).toBeNull();
  });
});

describe('multi-subsystem membership', () => {
  it('resolves both subsystems a shared module belongs to', () => {
    const logging = view.nodes.find((n) => n.id === 'logging')!;
    expect(subsystemsOf(view, logging).map((n) => n.id)).toEqual(['http', 'jobs']);
    expect(membersOf(view, view.nodes[0]!).map((n) => n.id)).toEqual(['logging']);
  });

  it('survives a JSON round trip, so the cache and the HTTP API keep it', () => {
    const copy = JSON.parse(JSON.stringify(view)) as GraphView;
    expect(copy.nodes.find((n) => n.id === 'logging')!.memberOf).toEqual(['http', 'jobs']);
  });
});

describe('selection context (SPEC 8.4)', () => {
  it('collects the nodes, merged file ranges and the task of a selection', () => {
    const context = buildSelectionContext([view], { nodeIds: ['http', 'logging'], edgeIds: [], task: 'add a request id' });

    expect(context.nodes.map((n) => n.id)).toEqual(['http', 'logging']);
    expect(context.nodes[0]).toMatchObject({ level: 'L3', kind: 'subsystem', scope: { id: 'L4:root/app', label: 'app' } });
    // http.ts has the node's 1-2 and the internal edge's 1-1 → one range; jobs.ts comes
    // from the external relation jobs -> logging, whose evidence is part of the context too.
    expect(context.files).toEqual([
      { file: 'http.ts', ranges: [{ startLine: 1, endLine: 2 }] },
      { file: 'jobs.ts', ranges: [{ startLine: 1, endLine: 1 }] },
      { file: 'logging.ts', ranges: [{ startLine: 1, endLine: 2 }] },
    ]);
    expect(context.size).toEqual({ files: 3, lines: 5 });
    expect(context.task).toBe('add a request id');
    expect(context.snapshots).toEqual([
      { ...pick(snapshot), scopes: [view.scope] },
    ]);
    expect(context.warnings).toEqual([]);
    expect(context.stale).toBe(false);
  });

  it('merges duplicate, overlapping and adjacent ranges per file and sorts the files', () => {
    expect(
      mergeRanges([
        { startLine: 10, endLine: 20 },
        { startLine: 10, endLine: 20 },
        { startLine: 15, endLine: 25 },
        { startLine: 26, endLine: 30 },
        { startLine: 40, endLine: 42 },
        { startLine: 5, endLine: 6 },
      ]),
    ).toEqual([
      { startLine: 5, endLine: 6 },
      { startLine: 10, endLine: 30 },
      { startLine: 40, endLine: 42 },
    ]);

    const a = node('a', {
      evidence: [
        { file: 'src/b.ts', startLine: 1, endLine: 3 },
        { file: 'src/a.ts', startLine: 10, endLine: 20 },
        { file: 'src/a.ts', startLine: 21, endLine: 30 },
      ],
    });
    const b = node('b', {
      evidence: [
        { file: 'src/a.ts', startLine: 15, endLine: 18 },
        { file: 'src/a.ts', startLine: 50, endLine: 50 },
        { file: 'src/b.ts', startLine: 1, endLine: 3 },
      ],
    });
    const two: GraphView = { ...view, nodes: [a, b], edges: [] };
    const context = buildSelectionContext([two], { nodeIds: ['a', 'b'], edgeIds: [] });

    expect(context.files).toEqual([
      { file: 'src/a.ts', ranges: [{ startLine: 10, endLine: 30 }, { startLine: 50, endLine: 50 }] },
      { file: 'src/b.ts', ranges: [{ startLine: 1, endLine: 3 }] },
    ]);
    expect(context.size).toEqual({ files: 2, lines: 21 + 1 + 3 });
  });

  it('pulls in the endpoints of a selected edge, which is then internal', () => {
    const context = buildSelectionContext([view], { nodeIds: [], edgeIds: ['jobs->logging'] });
    expect(context.nodes.map((n) => n.id).sort()).toEqual(['jobs', 'logging']);
    expect(context.relations.internal.map((r) => r.id)).toEqual(['jobs->logging']);
  });

  it('splits relations into internal and external with their status and reason', () => {
    const context = buildSelectionContext([view], { nodeIds: ['http'], edgeIds: [] });

    expect(context.relations.internal).toEqual([]);
    expect(context.relations.external).toEqual([
      {
        id: 'http->logging',
        from: { id: 'http', title: 'http' },
        to: { id: 'logging', title: 'logging' },
        kind: 'imports',
        label: '',
        status: 'confirmed',
        reason: '',
      },
      {
        id: 'http->db',
        from: { id: 'http', title: 'http' },
        to: { id: 'db', title: 'db' },
        kind: 'imports',
        label: '',
        status: 'unverified',
        reason: 'connection string comes from the environment',
      },
    ]);

    const both = buildSelectionContext([view], { nodeIds: ['http', 'db'], edgeIds: [] });
    expect(both.relations.internal.map((r) => [r.id, r.status])).toEqual([['http->db', 'unverified']]);
    expect(both.relations.external.map((r) => r.id)).toEqual(['http->logging']);
    // A boundary node has no paths; its evidence files stand in for them.
    expect(both.limits.paths).toEqual(['db.ts', 'http.ts']);
    expect(both.limits.note).toContain('not proof');
  });

  const l4Scope = rootScope('demo');
  const appId = nodeId(l4Scope, 'app');
  const l3Scope = { level: 'L3' as const, id: appId, label: 'app', paths: ['src'] };
  const httpId = nodeId(l3Scope, 'http');
  const jobsId = nodeId(l3Scope, 'jobs');
  const l4View: GraphView = {
    scope: l4Scope,
    diagramKind: 'component-graph',
    nodes: [
      node(appId, { level: 'L4', kind: 'application', title: 'app', paths: ['src'], evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 5 }] }),
      node(nodeId(l4Scope, 'fs'), { level: 'L4', kind: 'runtime-boundary', title: 'filesystem', boundary: true, paths: [], evidence: [{ file: 'src/index.ts', startLine: 2, endLine: 2 }] }),
    ],
    edges: [
      edge(appId, nodeId(l4Scope, 'fs'), {
        id: edgeId(l4Scope, appId, nodeId(l4Scope, 'fs'), 'reads'),
        kind: 'reads',
        status: 'unverified',
        reason: 'path comes from a variable',
        evidence: [],
      }),
    ],
    notes: [],
    snapshot,
    behavior: SUPPORTED,
  };
  const l3View: GraphView = {
    scope: l3Scope,
    diagramKind: 'component-graph',
    nodes: [
      node(httpId, { title: 'http', paths: ['src/http'], evidence: [{ file: 'src/http/server.ts', startLine: 1, endLine: 10 }] }),
      node(jobsId, { title: 'jobs', paths: ['src/jobs'], evidence: [{ file: 'src/jobs/run.ts', startLine: 1, endLine: 4 }] }),
    ],
    edges: [edge(httpId, jobsId, { id: edgeId(l3Scope, httpId, jobsId, 'calls'), kind: 'calls', evidence: [{ file: 'src/http/server.ts', startLine: 5, endLine: 12 }] })],
    notes: [],
    snapshot,
    behavior: SUPPORTED,
  };

  it('reads the owning view out of node and edge ids', () => {
    expect(viewKeyOfId(httpId)).toEqual({ level: 'L3', scopeId: appId });
    expect(viewKeyOfId(appId)).toEqual({ level: 'L4', scopeId: 'root' });
    expect(viewKeyOfId(l3View.edges[0]!.id)).toEqual({ level: 'L3', scopeId: appId });
    expect(viewKeyOfId(l4View.edges[0]!.id)).toEqual({ level: 'L4', scopeId: 'root' });
    expect(viewKeyOfId('http')).toBeNull();
    expect(viewKeyOfId('nope|x->y|k')).toBeNull();
  });

  it('resolves a mixed-level selection against the views that own the ids', () => {
    const context = buildSelectionContext([l4View, l3View], { nodeIds: [appId, httpId], edgeIds: [] });

    expect(context.nodes.map((n) => [n.id, n.level, n.scope.label])).toEqual([
      [appId, 'L4', 'demo'],
      [httpId, 'L3', 'app'],
    ]);
    expect(context.relations.external.map((r) => r.id)).toEqual([l4View.edges[0]!.id, l3View.edges[0]!.id]);
    expect(context.files.map((f) => f.file)).toEqual(['src/http/server.ts', 'src/index.ts']);
    expect(context.files[0]!.ranges).toEqual([{ startLine: 1, endLine: 12 }]);
    expect(context.snapshots).toHaveLength(1);
    expect(context.snapshots[0]!.scopes).toEqual([l4Scope, l3Scope]);
    expect(context.limits.paths).toEqual(['src', 'src/http']);
    expect(context.warnings).toEqual([]);
  });

  it('warns when the items come from different snapshots and when a view is stale', () => {
    const other: Snapshot = { ...snapshot, commit: 'b'.repeat(40), shortCommit: 'bbbbbbbb', stateId: 'b'.repeat(40) };
    const movedL3 = { ...l3View, snapshot: other };
    const mixed = buildSelectionContext([l4View, movedL3], { nodeIds: [appId, httpId], edgeIds: [] });

    expect(mixed.snapshots.map((s) => s.shortCommit)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(mixed.warnings).toHaveLength(1);
    expect(mixed.warnings[0]).toMatch(/different repository states/);
    expect(mixed.stale).toBe(false);

    const live: Snapshot = { ...other, dirty: true, stateId: `${'b'.repeat(40)}+dirty` };
    const stale = buildSelectionContext([l4View], { nodeIds: [appId], edgeIds: [] }, { live });
    expect(stale.stale).toBe(true);
    expect(stale.warnings).toHaveLength(1);
    expect(stale.warnings[0]).toContain('aaaaaaaa');
    expect(stale.warnings[0]).toContain('bbbbbbbb');

    const current = buildSelectionContext([l4View], { nodeIds: [appId], edgeIds: [] }, { live: snapshot });
    expect(current.stale).toBe(false);
    expect(current.warnings).toEqual([]);
  });

  it('reports ids it cannot resolve as warnings and leaves them out', () => {
    const l2Id = nodeId({ level: 'L2', id: httpId, label: 'http', paths: [] }, 'handler');
    const context = buildSelectionContext([l4View, l3View], {
      nodeIds: [appId, l2Id, nodeId(l3Scope, 'gone'), 'mystery'],
      edgeIds: [edgeId(l3Scope, httpId, 'x', 'calls'), 'mystery-edge'],
    });

    expect(context.nodes.map((n) => n.id)).toEqual([appId]);
    expect(context.warnings).toEqual([
      expect.stringContaining(`${l2Id} belongs to view L2:${httpId}, which is not loaded`),
      expect.stringContaining(`${nodeId(l3Scope, 'gone')} no longer exists in view L3:${appId}`),
      expect.stringContaining('mystery was not found in any loaded view'),
      expect.stringContaining(`no longer exists in view L3:${appId}`),
      expect.stringContaining('mystery-edge was not found in any loaded view'),
    ]);
  });

  it('is plain JSON without file contents', () => {
    const context = buildSelectionContext([l4View], { nodeIds: [appId], edgeIds: [] });
    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
    expect(JSON.stringify(context)).not.toContain('export ');
  });
});

describe('expandSelection (FR-12)', () => {
  // http -> logging, jobs -> logging confirmed; http -> db unverified.
  it('follows confirmed relations in the asked direction and skips what is already selected', () => {
    expect(expandSelection(view, ['logging'], 'in')).toEqual(['http', 'jobs']);
    expect(expandSelection(view, ['logging'], 'out')).toEqual([]);
    expect(expandSelection(view, ['http'], 'out')).toEqual(['logging']);
    expect(expandSelection(view, ['http'], 'in')).toEqual([]);
    expect(expandSelection(view, ['http'], 'both')).toEqual(['logging']);
    expect(expandSelection(view, ['http', 'logging'], 'both')).toEqual(['jobs']);
  });

  it('never expands along an unverified relation', () => {
    expect(expandSelection(view, ['db'], 'both')).toEqual([]);
    expect(expandSelection(view, ['http'], 'out')).not.toContain('db');
  });
});

describe('renderContextMarkdown', () => {
  it('renders every section with ranges, statuses and the task', () => {
    const live: Snapshot = { ...snapshot, stateId: 'other', shortCommit: 'cccccccc' };
    const a = node('a', {
      title: 'A',
      summary: 'Does A.',
      evidence: [
        { file: 'src/a.ts', startLine: 10, endLine: 30 },
        { file: 'src/a.ts', startLine: 31, endLine: 42 },
        { file: 'src/b.ts', startLine: 7, endLine: 7 },
      ],
      paths: ['src/a.ts'],
    });
    const b = node('b', { title: 'B', paths: ['src/b.ts'], evidence: [] });
    const c = node('c', { title: 'C', paths: ['src/c.ts'], evidence: [] });
    const two: GraphView = {
      ...view,
      nodes: [a, b, c],
      edges: [edge('a', 'b', { evidence: [] }), edge('b', 'c', { status: 'unverified', reason: 'dynamic import', evidence: [] })],
    };
    const context = buildSelectionContext([two], { nodeIds: ['a', 'b'], edgeIds: [], task: 'rename A' }, { live });
    const md = renderContextMarkdown(context);

    for (const heading of ['## Task', '## Snapshot', '## Selected entities', '## Files', '## Relations', '### Internal', '### External', '## Change limits', '## Size']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('rename A');
    expect(md).toContain('- src/a.ts:10-42');
    expect(md).toContain('- src/b.ts:7');
    expect(md).toContain('**A** (L3, subsystem) — Does A.');
    expect(md).toContain('- A → B (imports) — confirmed');
    expect(md).toContain('- B → C (imports) — unverified: dynamic import');
    expect(md).toContain('⚠');
    expect(md).toContain('cccccccc');
    expect(md).toContain('- src/a.ts\n- src/b.ts');
    expect(md).toContain('2 files, 34 lines');
    expect(md).not.toContain('undefined');
  });
});

describe('node ids', () => {
  it('reads the owning scope and the level out of a nested node id', () => {
    // The UI finds the parent view of an L2 boundary node's subsystem from the id alone.
    expect(scopeOwnerOf('L3:L4:root/core/math')).toBe('L4:root/core');
    expect(scopeOwnerOf('L4:root/core')).toBe('root');
    expect(scopeOwnerOf('root')).toBeNull();
    expect(levelOfNodeId('L3:L4:root/core/math')).toBe('L3');
    expect(levelOfNodeId('L4:root/core')).toBe('L4');
    expect(levelOfNodeId('nope')).toBeNull();
  });
});

describe('agent reply contract', () => {
  const sample: AgentGraph = {
    diagramKind: 'component-graph',
    notes: ['the scheduler was not read'],
    nodes: [
      {
        slug: 'api',
        kind: 'application',
        title: 'API',
        summary: 'Serves HTTP.',
        evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 10, note: 'entry point' }],
        boundary: false,
        subsystemId: '',
        memberOf: [],
        paths: ['src'],
        hasDetail: true,
        role: '',
      },
    ],
    edges: [
      {
        from: 'api',
        to: 'api',
        kind: 'imports',
        label: '',
        evidence: [],
        confirmed: false,
        reason: 'placeholder',
        order: 0,
        style: '',
        group: '',
      },
    ],
    behavior: { supported: true, reason: '' },
  };

  it('parses a reply that matches the schema', () => {
    expect(parseAgentGraph(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
  });

  it('rejects a reply with a missing required field', () => {
    const broken = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>;
    delete (broken.nodes as Array<Record<string, unknown>>)[0]!.evidence;
    expect(() => parseAgentGraph(broken)).toThrow();
  });

  it('exposes a strict JSON Schema, as the SDK output format requires', () => {
    const walk = (schema: Record<string, unknown>): void => {
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        expect((schema.required as string[]).sort()).toEqual(Object.keys(properties).sort());
        for (const child of Object.values(properties)) walk(child);
      }
      if (schema.type === 'array' && schema.items) walk(schema.items as Record<string, unknown>);
    };
    walk(agentGraphJsonSchema);
  });
});

describe('selection context — edge cases', () => {
  const empty = buildSelectionContext([view], { nodeIds: [], edgeIds: [] });

  it('normalises reversed ranges and leaves a single range alone', () => {
    expect(mergeRanges([{ startLine: 20, endLine: 10 }])).toEqual([{ startLine: 10, endLine: 20 }]);
    expect(mergeRanges([{ startLine: 3, endLine: 3 }, { startLine: 1, endLine: 1 }])).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
    ]);
    expect(mergeRanges([])).toEqual([]);
  });

  it('is empty and quiet for an empty selection', () => {
    expect(empty.nodes).toEqual([]);
    expect(empty.files).toEqual([]);
    expect(empty.size).toEqual({ files: 0, lines: 0 });
    expect(empty.relations).toEqual({ internal: [], external: [] });
    expect(empty.snapshots).toEqual([]);
    expect(empty.warnings).toEqual([]);
    expect(empty.stale).toBe(false);
    expect(empty.task).toBe('');
    expect(empty.limits.paths).toEqual([]);
  });

  it('does not duplicate nodes, relations or paths when an id is given twice or as node and edge', () => {
    const context = buildSelectionContext([view], {
      nodeIds: ['http', 'http', 'logging'],
      edgeIds: ['http->logging', 'http->logging'],
    });
    expect(context.nodes.map((n) => n.id)).toEqual(['http', 'logging']);
    expect(context.relations.internal.map((r) => r.id)).toEqual(['http->logging']);
    expect(context.relations.external.map((r) => r.id).sort()).toEqual(['http->db', 'jobs->logging']);
    expect(context.limits.paths).toEqual(['http.ts', 'logging.ts']);
    expect(context.warnings).toEqual([]);
  });

  it('keeps the side of a selected edge whose other endpoint is gone and does not throw', () => {
    const broken: GraphView = {
      ...view,
      edges: [...view.edges, edge('http', 'ghost', { id: 'http->ghost', evidence: [] })],
    };
    const context = buildSelectionContext([broken], { nodeIds: [], edgeIds: ['http->ghost'] });
    expect(context.nodes.map((n) => n.id)).toEqual(['http']);
    expect(context.relations.external.map((r) => r.id)).toContain('http->ghost');
    expect(context.relations.external.find((r) => r.id === 'http->ghost')!.to).toEqual({ id: 'ghost', title: 'ghost' });
  });

  it('separates snapshots by branch even at the same state id, as the state comparison does', () => {
    const l4Scope = rootScope('demo');
    const appId = nodeId(l4Scope, 'app');
    const l3Scope = { level: 'L3' as const, id: appId, label: 'app', paths: ['src'] };
    const httpId = nodeId(l3Scope, 'http');
    const l4: GraphView = {
      scope: l4Scope,
      diagramKind: 'component-graph',
      nodes: [node(appId, { level: 'L4', paths: ['src'], evidence: [] })],
      edges: [],
      notes: [],
      snapshot,
      behavior: SUPPORTED,
    };
    const l3: GraphView = {
      scope: l3Scope,
      diagramKind: 'component-graph',
      nodes: [node(httpId, { paths: ['src/http'], evidence: [] })],
      edges: [],
      notes: [],
      snapshot: { ...snapshot, branch: 'feature' },
      behavior: SUPPORTED,
    };
    const context = buildSelectionContext([l4, l3], { nodeIds: [appId, httpId], edgeIds: [] }, { live: snapshot });
    expect(context.snapshots.map((s) => [s.branch, s.scopes.map((sc) => sc.level)])).toEqual([
      ['main', ['L4']],
      ['feature', ['L3']],
    ]);
    expect(context.warnings).toHaveLength(1);
    expect(context.warnings[0]).toMatch(/different repository states/);
    // Same state id as the live one on both: nothing is stale, whatever the branch name.
    expect(context.stale).toBe(false);
  });

  it('renders an empty context without crashing and without a Task section', () => {
    const md = renderContextMarkdown(empty);
    expect(md).not.toContain('## Task');
    expect(md).toContain('## Snapshots');
    expect(md).toContain('_No items resolved._');
    expect(md).toContain('## Files\n\n_None._');
    expect(md).toContain('### Internal\n\n_None._');
    expect(md).toContain('0 files, 0 lines');
    expect(md).not.toContain('undefined');
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('renders a boundary flag, a relation label and the dirty marker', () => {
    const live: Snapshot = { ...snapshot, dirty: true, stateId: 'dirty' };
    const dirtyView: GraphView = { ...view, snapshot: { ...snapshot, dirty: true } };
    const context = buildSelectionContext([dirtyView], { nodeIds: ['http', 'db'], edgeIds: [] }, { live });
    const md = renderContextMarkdown(context);
    expect(md).toContain('(uncommitted changes)');
    expect(md).toContain('**db** (L3, subsystem, boundary)');
    expect(md).toContain('http → db (imports) — unverified: connection string comes from the environment');
    expect(md).toContain('## Snapshot\n'); // one snapshot: singular heading
  });
});

describe('expandSelection — edge cases', () => {
  it('reports each neighbour once, in view order, and ignores ids the view does not know', () => {
    const fan: GraphView = {
      ...view,
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        edge('a', 'c', { id: 'a->c:imports', evidence: [] }),
        edge('a', 'c', { id: 'a->c:calls', kind: 'calls', evidence: [] }),
        edge('b', 'c', { id: 'b->c', evidence: [] }),
        edge('c', 'a', { id: 'c->a', evidence: [] }),
      ],
    };
    expect(expandSelection(fan, ['c'], 'in')).toEqual(['a', 'b']);
    expect(expandSelection(fan, ['c'], 'out')).toEqual(['a']);
    expect(expandSelection(fan, ['c'], 'both')).toEqual(['a', 'b']);
    expect(expandSelection(fan, ['nope'], 'both')).toEqual([]);
    expect(expandSelection(fan, [], 'both')).toEqual([]);
    expect(expandSelection(fan, new Set(['a', 'b', 'c']), 'both')).toEqual([]);
  });
});
