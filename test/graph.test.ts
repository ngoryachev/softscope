import { describe, expect, it } from 'vitest';
import {
  agentGraphJsonSchema,
  parseAgentGraph,
  type AgentGraph,
} from '../src/shared/agent-schema';
import {
  buildSelectionContext,
  childScopeOf,
  levelOfNodeId,
  membersOf,
  nextLevel,
  nodeId,
  rootScope,
  scopeOwnerOf,
  subsystemsOf,
  type GraphEdge,
  type GraphNode,
  type GraphView,
  type Snapshot,
} from '../src/shared/graph';

const snapshot: Snapshot = {
  branch: 'main',
  commit: 'a'.repeat(40),
  shortCommit: 'aaaaaaaa',
  dirty: false,
  stateId: 'a'.repeat(40),
  generatedAt: '2026-01-01T00:00:00.000Z',
};

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
  it('collects the files of the selected nodes and edges without duplicates', () => {
    const context = buildSelectionContext(view, { nodeIds: ['http', 'logging'], edgeIds: [], task: 'add a request id' });

    expect(context.nodes.map((n) => n.id)).toEqual(['http', 'logging']);
    expect(context.files).toEqual(['http.ts', 'logging.ts']);
    expect(context.evidence).toHaveLength(3); // two nodes plus the edge between them
    expect(context.task).toBe('add a request id');
    expect(context.scope.id).toBe('L4:root/app');
  });

  it('pulls in the endpoints of a selected edge', () => {
    const context = buildSelectionContext(view, { nodeIds: [], edgeIds: ['jobs->logging'] });
    expect(context.nodes.map((n) => n.id).sort()).toEqual(['jobs', 'logging']);
  });

  it('expands over dependencies on request', () => {
    const narrow = buildSelectionContext(view, { nodeIds: ['logging'], edgeIds: [] });
    expect(narrow.nodes.map((n) => n.id)).toEqual(['logging']);

    const wide = buildSelectionContext(view, { nodeIds: ['logging'], edgeIds: [], expandDependencies: true });
    expect(wide.nodes.map((n) => n.id)).toEqual(['http', 'jobs', 'logging']);
  });

  it('reports unverified relations and the limits of the selection', () => {
    const context = buildSelectionContext(view, { nodeIds: ['http', 'db'], edgeIds: [] });

    expect(context.unverified).toEqual([
      { id: 'http->db', from: 'http', to: 'db', kind: 'imports', reason: 'connection string comes from the environment' },
    ]);
    expect(context.limits.paths).toEqual(['http.ts']);
    expect(context.limits.note).toContain('not proof');
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
      },
    ],
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
