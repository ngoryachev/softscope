/**
 * Render smoke test for the UI: every screen must render, and the things the user has
 * to be able to trust — code links, the boundary marker and the unverified marker —
 * must actually reach the markup. Rendered with `react-dom/server`, so no DOM
 * environment and no browser are needed.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, UnsupportedBehavior } from '../src/web/App';
import { Breadcrumbs } from '../src/web/components/Breadcrumbs';
import { ChangePanel } from '../src/web/components/ChangePanel';
import { ContextPanel } from '../src/web/components/ContextPanel';
import { FileViewer } from '../src/web/components/FileViewer';
import { GenerationProgress, formatElapsed } from '../src/web/components/GenerationProgress';
import { GraphCanvas } from '../src/web/components/GraphCanvas';
import { Inspector } from '../src/web/components/Inspector';
import { RepoPicker } from '../src/web/components/RepoPicker';
import { SequenceCanvas } from '../src/web/components/SequenceCanvas';
import { SnapshotBar } from '../src/web/components/SnapshotBar';
import type { ChangeStatus, RepoState } from '../src/shared/api';
import type { GraphEdge, GraphNode, GraphView, Snapshot } from '../src/shared/graph';
import { SUPPORTED } from './helpers';

const snapshot: Snapshot = {
  branch: 'main',
  commit: 'a'.repeat(40),
  shortCommit: 'aaaaaaaa',
  dirty: true,
  stateId: `${'a'.repeat(40)}+beef`,
  generatedAt: new Date().toISOString(),
};

const l3Scope = { level: 'L3' as const, id: 'L4:root/server', label: 'server', paths: ['src'] };

const view: GraphView = {
  scope: { level: 'L4', id: 'root', label: 'demo', paths: ['.'] },
  diagramKind: 'component-graph',
  nodes: [
    {
      id: 'srv',
      level: 'L4',
      kind: 'application',
      title: 'server',
      summary: 'Serves HTTP on localhost.',
      evidence: [{ file: 'src/a.ts', startLine: 1, endLine: 3, note: 'entry point' }],
      boundary: false,
      subsystemId: '',
      memberOf: [],
      paths: ['src'],
      childScope: l3Scope,
    },
    {
      id: 'db',
      level: 'L4',
      kind: 'datastore',
      title: 'Postgres',
      summary: '',
      evidence: [{ file: 'src/a.ts', startLine: 2, endLine: 2 }],
      boundary: true,
      subsystemId: '',
      memberOf: ['srv'],
      paths: [],
      childScope: null,
    },
  ],
  edges: [
    {
      id: 'srv-db',
      from: 'srv',
      to: 'db',
      kind: 'reads',
      label: '',
      evidence: [],
      status: 'unverified',
      reason: 'the connection string comes from the environment',
    },
  ],
  notes: ['the scheduler was not read'],
  snapshot,
  behavior: SUPPORTED,
};

const state: RepoState = {
  repoPath: '/tmp/demo',
  repoName: 'demo',
  isGitRepo: true,
  snapshot,
  generatableLevels: ['L4', 'L3', 'L2', 'L1'],
  fakeAgent: true,
  changeAgent: 'fake',
  activeChangeId: null,
};

/** An L3 view of "server" with two subsystems, and the L2 of one of them. */
const l3View: GraphView = {
  scope: l3Scope,
  diagramKind: 'component-graph',
  nodes: [
    {
      id: 'L3:L4:root/server/http',
      level: 'L3',
      kind: 'subsystem',
      title: 'http',
      summary: 'Routes requests.',
      evidence: [{ file: 'src/http.ts', startLine: 1, endLine: 3 }],
      boundary: false,
      subsystemId: '',
      memberOf: [],
      paths: ['src/http.ts'],
      childScope: { level: 'L2', id: 'L3:L4:root/server/http', label: 'http', paths: ['src/http.ts'] },
    },
    {
      id: 'L3:L4:root/server/arithmetic',
      level: 'L3',
      kind: 'subsystem',
      title: 'arithmetic',
      summary: 'Adds numbers.',
      evidence: [{ file: 'src/math.ts', startLine: 1, endLine: 3 }],
      boundary: false,
      subsystemId: '',
      memberOf: [],
      paths: ['src/math.ts'],
      childScope: null,
    },
  ],
  edges: [],
  notes: [],
  snapshot,
  behavior: SUPPORTED,
};

const l2View: GraphView = {
  scope: { level: 'L2', id: 'L3:L4:root/server/http', label: 'http', paths: ['src/http.ts'] },
  diagramKind: 'data-flow',
  nodes: [
    {
      id: 'handler',
      level: 'L2',
      kind: 'function',
      title: 'handleRequest',
      summary: 'Parses the request and calls add.',
      evidence: [{ file: 'src/http.ts', startLine: 1, endLine: 3 }],
      boundary: false,
      subsystemId: '',
      memberOf: [],
      paths: ['src/http.ts'],
      childScope: null,
    },
    {
      id: 'add',
      level: 'L2',
      kind: 'function',
      title: 'add',
      summary: 'Lives in the arithmetic subsystem.',
      evidence: [{ file: 'src/math.ts', startLine: 1, endLine: 3 }],
      boundary: true,
      subsystemId: 'L3:L4:root/server/arithmetic',
      memberOf: [],
      paths: [],
      childScope: null,
    },
  ],
  edges: [
    {
      id: 'handler-add',
      from: 'handler',
      to: 'add',
      kind: 'calls',
      label: 'two parsed numbers',
      evidence: [{ file: 'src/http.ts', startLine: 2, endLine: 2 }],
      status: 'confirmed',
      reason: '',
    },
  ],
  notes: [],
  snapshot,
  behavior: SUPPORTED,
};

/* Behaviour views (L1) of the handler: a state machine, a sequence and an unsupported one. */
const l1Scope = { level: 'L1' as const, id: 'L2:L3:L4:root/server/http/handler', label: 'handleRequest', paths: ['src/http.ts'] };

const l1Node = (id: string, over: Partial<GraphNode>): GraphNode => ({
  id: `L1:${l1Scope.id}/${id}`,
  level: 'L1',
  kind: 'state',
  title: id,
  summary: `${id} summary`,
  evidence: [{ file: 'src/http.ts', startLine: 1, endLine: 1 }],
  boundary: false,
  subsystemId: '',
  memberOf: [],
  paths: [],
  childScope: null,
  ...over,
});
const l1Edge = (from: string, to: string, kind: string, over: Partial<GraphEdge>): GraphEdge => ({
  id: `L1:${l1Scope.id}|L1:${l1Scope.id}/${from}->L1:${l1Scope.id}/${to}|${kind}${over.order !== undefined ? `#${over.order}` : ''}`,
  from: `L1:${l1Scope.id}/${from}`,
  to: `L1:${l1Scope.id}/${to}`,
  kind,
  label: '',
  evidence: [{ file: 'src/http.ts', startLine: 2, endLine: 2 }],
  status: 'confirmed',
  reason: '',
  ...over,
});

const stateMachineView: GraphView = {
  scope: l1Scope,
  diagramKind: 'state-machine',
  nodes: [
    l1Node('idle', { role: 'initial' }),
    l1Node('parsing', { role: 'state' }),
    l1Node('answered', { role: 'final' }),
  ],
  edges: [
    l1Edge('idle', 'parsing', 'transitions-to', { label: 'request received' }),
    l1Edge('parsing', 'answered', 'transitions-to', { label: 'numbers valid', status: 'unverified', reason: 'the guard was not read', evidence: [] }),
  ],
  notes: [],
  snapshot,
  behavior: SUPPORTED,
};

const sequenceView: GraphView = {
  scope: l1Scope,
  diagramKind: 'sequence',
  nodes: [
    l1Node('client', { kind: 'caller', role: 'participant', boundary: true, title: 'HTTP client' }),
    l1Node('handler', { kind: 'function', role: 'participant', title: 'handleRequest', paths: ['src/http.ts'] }),
    l1Node('add', { kind: 'function', role: 'participant', title: 'add' }),
  ],
  edges: [
    l1Edge('client', 'handler', 'calls', { label: 'GET /add', order: 1, style: 'sync' }),
    l1Edge('handler', 'add', 'calls', { label: 'add(a, b)', order: 2, style: 'async', group: 'loop: for each pair' }),
    l1Edge('add', 'handler', 'returns', { label: 'sum', order: 3, style: 'return', group: 'loop: for each pair' }),
    l1Edge('handler', 'client', 'returns', { label: 'response', order: 4, style: 'return', status: 'unverified', reason: 'the response is built by the framework', evidence: [] }),
  ],
  notes: [],
  snapshot,
  behavior: SUPPORTED,
};

const unsupportedView: GraphView = {
  scope: l1Scope,
  diagramKind: 'unsupported',
  nodes: [],
  edges: [],
  notes: ['the router is configured at runtime'],
  snapshot,
  behavior: { supported: false, reason: 'the handler dispatches through a runtime table of routes' },
};

const noop = () => undefined;
const render = (element: ReactElement) => renderToStaticMarkup(element);

const emptyBasket = { nodeIds: new Set<string>(), edgeIds: new Set<string>() };

const inspector = (over: { selectedNodeId?: string | null; selectedEdgeId?: string | null } = {}) =>
  render(
    h(Inspector, {
      view,
      focused: over.selectedNodeId
        ? { kind: 'node', id: over.selectedNodeId }
        : over.selectedEdgeId
          ? { kind: 'edge', id: over.selectedEdgeId }
          : null,
      onOpenEvidence: noop,
      onOpenNode: noop,
      onSelectNode: noop,
    }),
  );

const canvas = (v: GraphView, focusedNodeId: string | null = null) =>
  render(
    h(GraphCanvas, {
      view: v,
      basket: focusedNodeId ? { nodeIds: new Set([focusedNodeId]), edgeIds: new Set<string>() } : emptyBasket,
      focused: focusedNodeId ? { kind: 'node', id: focusedNodeId } : null,
      onSelect: noop,
      onMarquee: noop,
      onClearFocus: noop,
      onOpenNode: noop,
    }),
  );

describe('screens render', () => {
  it('renders the repository picker as the first screen', () => {
    const html = render(h(App));
    expect(html).toContain('SoftZoom');
    expect(html).toContain('/path/to/repository');
  });

  it('renders the picker, breadcrumbs and the file viewer', () => {
    expect(render(h(RepoPicker, { busy: false, error: 'nope', onOpen: noop }))).toContain('nope');
    const crumbs = render(h(Breadcrumbs, { stack: [view.scope, l3Scope], onNavigate: noop }));
    expect(crumbs).toContain('demo');
    expect(crumbs).toContain('L3');
    expect(render(h(FileViewer, { evidence: { file: 'src/a.ts', startLine: 1, endLine: 2 }, onClose: noop }))).toContain(
      'src/a.ts',
    );
  });

  it('renders the graph canvas with a node and an edge', () => {
    const html = canvas(view, 'srv');
    expect(html).toContain('unverified relation'); // the legend explains the dashed edges
    expect(html).toContain('Shift/Ctrl+click'); // and how to select several
    expect(html.length).toBeGreaterThan(200);
  });
});

describe('generation progress', () => {
  it('shows the elapsed time, the recent agent activity and a cancel button', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    const html = render(
      h(GenerationProgress, {
        level: 'L2',
        scopeLabel: 'http',
        startedAt,
        activity: [
          { tool: 'Read', detail: 'src/http.ts', at: startedAt },
          { tool: 'Grep', detail: 'handleRequest', at: startedAt },
        ],
        cancelling: false,
        onCancel: noop,
      }),
    );

    expect(html).toContain('Analyzing L2 of http');
    expect(html).toMatch(/1:0[56] elapsed/);
    expect(html).toContain('src/http.ts');
    expect(html).toContain('handleRequest');
    expect(html).toContain('>Cancel<');
  });

  it('says it is starting until the server reports the job, and formats minutes', () => {
    const html = render(
      h(GenerationProgress, { level: 'L3', scopeLabel: 'server', startedAt: null, activity: [], cancelling: true, onCancel: noop }),
    );
    expect(html).toContain('starting');
    expect(html).toContain('Cancelling');
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(125_000)).toBe('2:05');
  });
});

describe('L2 view', () => {
  it('explains a data-flow legend and calls a boundary node outside this area', () => {
    const html = canvas(l2View);
    expect(html).toContain('arrow = data passed, label = what is passed');
    expect(html).toContain('boundary (outside this area)');
    expect(html).not.toContain('outside the repository');
  });

  it('offers to go to the subsystem a linked boundary node belongs to', () => {
    const html = render(
      h(Inspector, {
        view: l2View,
        parentView: l3View,
        focused: { kind: 'node', id: 'add' },
        onOpenEvidence: noop,
        onOpenNode: noop,
        onSelectNode: noop,
        onGoToSubsystem: noop,
      }),
    );
    expect(html).toContain('Go to subsystem arithmetic');
  });

  it('falls back to the id tail when the parent view is not at hand, and hides the button otherwise', () => {
    const without = (id: string) =>
      render(
        h(Inspector, {
          view: l2View,
          focused: { kind: 'node', id },
          onOpenEvidence: noop,
          onOpenNode: noop,
          onSelectNode: noop,
        }),
      );
    expect(without('add')).toContain('Go to subsystem arithmetic');
    expect(without('handler')).not.toContain('Go to subsystem');
  });
});

describe('L1 behaviour views', () => {
  it('lays a state machine out with initial and final markers, transition labels and its own legend', () => {
    const html = canvas(stateMachineView);
    expect(html).toContain('sz-node-initial');
    expect(html).toContain('sz-node-final');
    expect(html).not.toContain('sz-node-decision');
    expect(html).toContain(' initial state</span>');
    expect(html).toContain(' final state</span>');
    // React Flow renders the edge containers but not the edge paths and labels on the
    // server (they need measured nodes), so the transition labels are asserted through
    // the inspector below; here only that both transitions are part of the canvas.
    expect((html.match(/react-flow__edge/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain('arrow = transition, label = event or condition');
    expect(html).toContain('unverified transition');
    expect(html).not.toContain('double-click: open');
  });

  it('explains a flow with start, end and decision markers', () => {
    const flow: GraphView = {
      ...stateMachineView,
      diagramKind: 'flow',
      nodes: [l1Node('start', { role: 'start' }), l1Node('which', { role: 'decision' }), l1Node('end', { role: 'end' })],
      edges: [l1Edge('start', 'which', 'next', {}), l1Edge('which', 'end', 'next', { label: 'valid' })],
    };
    const html = canvas(flow);
    expect(html).toContain('sz-node-initial');
    expect(html).toContain('sz-node-decision');
    expect(html).toContain('sz-node-final');
    expect(html).toContain(' decision</span>');
    expect(html).toContain('arrow = next step, label = branch condition');
    expect(html).toContain('unverified step');
  });

  it('renders a sequence as participants, lifelines and messages in order, with the arrow kinds told apart', () => {
    const html = render(
      h(SequenceCanvas, {
        view: sequenceView,
        basket: { nodeIds: new Set([`L1:${l1Scope.id}/handler`]), edgeIds: new Set<string>() },
        focused: { kind: 'edge', id: sequenceView.edges[1]!.id },
        onSelect: noop,
        onClearFocus: noop,
      }),
    );
    expect(html).toContain('<svg');
    expect((html.match(/sz-seq-participant/g) ?? []).length).toBe(3);
    expect((html.match(/sz-seq-lifeline/g) ?? []).length).toBe(3);
    expect(html).toContain('HTTP client');
    expect(html).toContain('sz-seq-boundary');
    expect(html).toContain('stroke-dasharray="6 4"'); // the boundary participant's dashed box
    // Messages top to bottom in execution order.
    const positions = ['1. GET /add', '2. add(a, b)', '3. sum', '4. response (unverified)'].map((label) => html.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('sz-seq-sync');
    expect(html).toContain('sz-seq-async');
    expect(html).toContain('sz-seq-return');
    expect(html).toContain('sz-seq-unverified');
    expect(html).toContain('url(#sz-seq-head-filled)'); // sync: filled head
    expect(html).toContain('url(#sz-seq-head-open)'); // async and return: open head
    expect(html).toContain('url(#sz-seq-head-open-warn)'); // the unverified return in the warn colour
    expect(html).toContain('#b2893f');
    // The branch/loop band and its label, once for the two consecutive messages.
    expect((html.match(/sz-seq-group-label/g) ?? []).length).toBe(1);
    expect(html).toContain('loop: for each pair');
    // Basket and focus marks, and the legend.
    expect(html).toContain('sz-seq-selected');
    expect(html).toContain('sz-seq-focused');
    expect(html).toContain('boundary participant (outside this entity)');
    expect(html).toContain('async message (open head)');
    expect(html).toContain('the response is built by the framework');
  });

  it('renders a self-message and an empty sequence without browser APIs', () => {
    const selfView: GraphView = {
      ...sequenceView,
      nodes: [sequenceView.nodes[1]!],
      edges: [l1Edge('handler', 'handler', 'calls', { label: 'retry', order: 1 })],
    };
    expect(render(h(SequenceCanvas, { view: selfView, basket: emptyBasket, focused: null, onSelect: noop, onClearFocus: noop }))).toContain('1. retry');
    const empty: GraphView = { ...sequenceView, nodes: [], edges: [] };
    expect(render(h(SequenceCanvas, { view: empty, basket: emptyBasket, focused: null, onSelect: noop, onClearFocus: noop }))).toContain('<svg');
  });

  it('shows the reason instead of a diagram when the behaviour is unsupported', () => {
    const html = render(
      h(UnsupportedBehavior, {
        view: unsupportedView,
        parent: l2View.scope,
        busy: false,
        onRegenerate: noop,
        onBack: noop,
      }),
    );
    expect(html).toContain('Behaviour view not available for handleRequest');
    expect(html).toContain('the handler dispatches through a runtime table of routes');
    expect(html).toContain('>Regenerate<');
    expect(html).toContain('Back to L2 · http');
    expect(html).not.toContain('<svg');

    const inspectorHtml = render(h(Inspector, { view: unsupportedView, focused: null, onOpenEvidence: noop, onOpenNode: noop, onSelectNode: noop }));
    expect(inspectorHtml).toContain('handleRequest');
    expect(inspectorHtml).toContain('No behaviour view could be built: the handler dispatches');
    expect(inspectorHtml).toContain('the router is configured at runtime');
  });

  it('renders breadcrumbs with all four levels', () => {
    const html = render(h(Breadcrumbs, { stack: [view.scope, l3Scope, l2View.scope, l1Scope], onNavigate: noop }));
    for (const level of ['L4', 'L3', 'L2', 'L1']) expect(html).toContain(`>${level}</span>`);
    expect(html).toContain('handleRequest');
    expect(html).toContain('L1 — Behavior');
  });

  it('shows the role of a state and the position and style of a message in the inspector', () => {
    const state = render(
      h(Inspector, { view: stateMachineView, focused: { kind: 'node', id: `L1:${l1Scope.id}/idle` }, onOpenEvidence: noop, onOpenNode: noop, onSelectNode: noop }),
    );
    expect(state).toContain('>initial state<');
    expect(state).toContain('src/http.ts:1');
    expect(state).toContain('request received'); // the transition in the relations list
    expect(state).not.toContain('Open L');

    const transition = render(
      h(Inspector, { view: stateMachineView, focused: { kind: 'edge', id: stateMachineView.edges[1]!.id }, onOpenEvidence: noop, onOpenNode: noop, onSelectNode: noop }),
    );
    expect(transition).toContain('transition: numbers valid');
    expect(transition).toContain('the guard was not read');

    const message = render(
      h(Inspector, { view: sequenceView, focused: { kind: 'edge', id: sequenceView.edges[1]!.id }, onOpenEvidence: noop, onOpenNode: noop, onSelectNode: noop }),
    );
    expect(message).toContain('message #2 (async)');
    expect(message).toContain('add(a, b)');
    expect(message).toContain('in loop: for each pair');

    const participant = render(
      h(Inspector, { view: sequenceView, focused: { kind: 'node', id: `L1:${l1Scope.id}/handler` }, onOpenEvidence: noop, onOpenNode: noop, onSelectNode: noop }),
    );
    expect(participant).toContain('>participant<');
    // Its messages in execution order, numbered.
    const order = ['#1', '#2', '#3', '#4'].map((n) => participant.indexOf(`${n} `));
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('lists a sequence\'s messages in order in the context panel and the Markdown', () => {
    const html = render(
      h(ContextPanel, {
        views: [sequenceView],
        currentView: sequenceView,
        basket: { nodeIds: new Set([`L1:${l1Scope.id}/handler`]), edgeIds: new Set<string>() },
        live: snapshot,
        onRemove: noop,
        onClear: noop,
        onExpand: noop,
        onOpenEvidence: noop,
        onFocus: noop,
      }),
    );
    expect(html).toContain('L1 · Behavior');
    expect(html).toContain('(calls, GET /add, sync)');
    const positions = ['#1', '#2', '#3', '#4'].map((n) => html.indexOf(`${n} </span>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('snapshot bar', () => {
  it('shows the branch, the commit, the dirty tree and the stale badge', () => {
    const html = render(
      h(SnapshotBar, {
        state,
        viewSnapshot: snapshot,
        live: { ...snapshot, shortCommit: 'bbbbbbbb', stateId: 'other' },
        stale: true,
        cached: true,
        busy: false,
        onRegenerate: noop,
      }),
    );

    expect(html).toContain('main');
    expect(html).toContain('aaaaaaaa');
    expect(html).toContain('uncommitted changes');
    expect(html).toContain('stale');
    expect(html).toContain('from cache');
    expect(html).toContain('fake agent');
  });
});

describe('inspector', () => {
  it('shows the scope and the analysis gaps when nothing is selected', () => {
    const html = inspector();
    expect(html).toContain('demo');
    expect(html).toContain('the scheduler was not read');
  });

  it('shows a node with its description, code link and drill-in affordance', () => {
    const html = inspector({ selectedNodeId: 'srv' });
    expect(html).toContain('Serves HTTP on localhost.');
    expect(html).toContain('src/a.ts:1-3');
    expect(html).toContain('entry point');
    expect(html).toContain('Open L3 of server');
    expect(html).toContain('Postgres'); // listed under "Contains" via memberOf
  });

  it('marks a boundary node as a boundary', () => {
    expect(inspector({ selectedNodeId: 'db' })).toContain('boundary');
  });

  it('marks an unverified relation and gives the reason', () => {
    const html = inspector({ selectedEdgeId: 'srv-db' });
    expect(html).toContain('unverified');
    expect(html).toContain('the connection string comes from the environment');
  });

  it('no longer dumps the raw context: that moved to the context panel', () => {
    expect(inspector({ selectedNodeId: 'srv' })).not.toContain('context for an AI change');
  });
});

describe('context panel', () => {
  const panel = (basket: { nodeIds: Set<string>; edgeIds: Set<string> }, live: Snapshot | null = snapshot) =>
    render(
      h(ContextPanel, {
        views: [view, l3View],
        currentView: l3View,
        basket,
        live,
        onRemove: noop,
        onClear: noop,
        onExpand: noop,
        onOpenEvidence: noop,
        onFocus: noop,
      }),
    );

  it('lists the basket grouped by level with size, warnings, badges, files and copy buttons', () => {
    const html = panel(
      {
        nodeIds: new Set(['srv', 'L3:L4:root/server/http', 'L2:L3:L4:root/server/http/handler']),
        edgeIds: new Set(['srv-db']),
      },
      { ...snapshot, shortCommit: 'bbbbbbbb', stateId: 'other' },
    );

    expect(html).toContain('4 items');
    expect(html).toContain('L4 · Applications');
    expect(html).toContain('L3 · Subsystems');
    expect(html).toContain('>server<');
    expect(html).toContain('>http<');
    expect(html).toContain('server → Postgres'); // the selected relation, from → to
    expect(html).toContain('L2:L3:L4:root/server/http/handler'); // the unresolved id, still removable
    expect(html).toContain('not loaded');
    expect(html).toContain('Remove ');
    expect(html).toContain('>Clear<');
    expect(html).toContain('Expand with dependencies');
    expect(html).toContain('incoming');

    expect(html).toContain('2 files');
    expect(html).toContain('6 lines'); // src/a.ts 1-3 (2-2 merged in) and src/http.ts 1-3
    expect(html).toContain('src/a.ts:1-3');
    expect(html).toContain('src/http.ts:1-3');
    expect(html).toContain('unverified'); // the srv -> db relation badge
    expect(html).toContain('the repository is now at main@bbbbbbbb'); // stale warning
    expect(html).toContain('which is not loaded'); // unresolved warning
    expect(html).toContain('Change limits');
    expect(html).toContain('Copy as Markdown');
    expect(html).toContain('Copy as JSON');
  });

  it('explains how to select when the basket is empty', () => {
    const html = panel(emptyBasket);
    expect(html).toContain('0 items');
    expect(html).toContain('Nothing selected');
    expect(html).not.toContain('Copy as Markdown');
  });
});

describe('context panel — more', () => {
  const panel = (
    basket: { nodeIds: Set<string>; edgeIds: Set<string> },
    over: { currentView?: GraphView | null; views?: GraphView[]; live?: Snapshot | null } = {},
  ) =>
    render(
      h(ContextPanel, {
        views: over.views ?? [view, l3View, l2View],
        currentView: over.currentView === undefined ? l3View : over.currentView,
        basket,
        live: over.live === undefined ? snapshot : over.live,
        onRemove: noop,
        onClear: noop,
        onExpand: noop,
        onOpenEvidence: noop,
        onFocus: noop,
      }),
    );
  const expandButton = (html: string) => /<button[^>]*>Expand<\/button>/.exec(html)?.[0] ?? '';
  const clearButton = (html: string) => /<button[^>]*>Clear<\/button>/.exec(html)?.[0] ?? '';

  it('disables Expand unless a basket node is in the current view, and Clear when empty', () => {
    expect(clearButton(panel(emptyBasket))).toContain('disabled');
    expect(expandButton(panel(emptyBasket))).toContain('disabled');

    const l4Only = { nodeIds: new Set(['srv']), edgeIds: new Set<string>() };
    expect(clearButton(panel(l4Only))).not.toContain('disabled');
    expect(expandButton(panel(l4Only, { currentView: l3View }))).toContain('disabled');
    expect(expandButton(panel(l4Only, { currentView: view }))).not.toContain('disabled');
    expect(expandButton(panel(l4Only, { currentView: null }))).toContain('disabled');
    // A relation alone does not expand: only nodes have neighbours.
    const edgeOnly = { nodeIds: new Set<string>(), edgeIds: new Set(['srv-db']) };
    expect(expandButton(panel(edgeOnly, { currentView: view }))).toContain('disabled');
  });

  it('shows a confirmed internal relation, its label, merged files and fallback change limits', () => {
    const html = panel({ nodeIds: new Set<string>(), edgeIds: new Set(['handler-add']) }, { currentView: l2View });
    expect(html).toContain('1 item');
    expect(html).toContain('L2 · Entities');
    expect(html).toContain('>calls<'); // the relation's title in the basket is its kind
    expect(html).toContain('handleRequest → add');
    expect(html).toContain('Internal relations');
    expect(html).toContain('sz-badge-ok');
    expect(html).toContain('>confirmed<');
    expect(html).toContain('(calls, two parsed numbers)');
    expect(html).not.toContain('sz-badge-warn');
    expect(html).toContain('2 files');
    expect(html).toContain('6 lines');
    expect(html).toContain('src/http.ts:1-3'); // 1-3 of the node plus 2-2 of the edge, merged
    expect(html).toContain('src/math.ts:1-3');
    expect(html).toContain('<code>src/http.ts</code>');
    expect(html).toContain('<code>src/math.ts</code>'); // `add` has no paths: its evidence file stands in
    expect(html).not.toContain('sz-warn'); // same snapshot as live, everything resolved
    // The relation's endpoints are in the context but not in the basket: nothing to expand from.
    expect(expandButton(html)).toContain('disabled');
  });

  it('marks an item that is gone from its loaded view and warns about mixed snapshots', () => {
    const moved: GraphView = { ...l3View, snapshot: { ...snapshot, shortCommit: 'bbbbbbbb', stateId: 'other' } };
    const html = panel(
      { nodeIds: new Set(['srv', 'L3:L4:root/server/gone', 'L3:L4:root/server/http']), edgeIds: new Set<string>() },
      { views: [view, moved], live: null },
    );
    expect(html).toContain('no longer in this view');
    expect(html).toContain('sz-basket-unresolved');
    expect(html).toContain('no longer exists in view L3:L4:root/server');
    expect(html).toContain('different repository states');
    // No live snapshot was given: nothing can be called stale.
    expect(html).not.toContain('the repository is now at');
  });

  it('renders without a live snapshot and without any loaded view', () => {
    const html = panel({ nodeIds: new Set(['L4:root/x']), edgeIds: new Set<string>() }, { views: [], currentView: null, live: null });
    expect(html).toContain('1 item');
    expect(html).toContain('not loaded');
    expect(html).toContain('which is not loaded');
    expect(html).toContain('L4 · Applications');
    expect(html).toContain('0 files');
    expect(html).toContain('Copy as JSON');
  });
});

describe('context panel — Run', () => {
  const panel = (over: { runDisabledReason?: string | null; withRun?: boolean; empty?: boolean } = {}) =>
    render(
      h(ContextPanel, {
        views: [view, l3View],
        currentView: l3View,
        basket: over.empty ? emptyBasket : { nodeIds: new Set(['srv']), edgeIds: new Set<string>() },
        live: snapshot,
        onRemove: noop,
        onClear: noop,
        onExpand: noop,
        onOpenEvidence: noop,
        onFocus: noop,
        ...(over.withRun === false ? {} : { onRun: noop, runDisabledReason: over.runDisabledReason ?? null }),
      }),
    );
  const runButton = (html: string) => /<button[^>]*>Run<\/button>/.exec(html)?.[0] ?? '';

  it('offers an instruction field and a Run button that waits for an instruction', () => {
    const html = panel();
    expect(html).toContain('Instruction');
    expect(html).toContain('sz-run-task');
    // Rendered without a typed instruction: disabled, but not because of the repository.
    expect(runButton(html)).toContain('disabled');
    expect(html).toContain('isolated copy');
    expect(html).not.toContain('git repository');
  });

  it('explains why Run is disabled: no git repository, or a change already open', () => {
    const noGit = panel({ runDisabledReason: 'Changes need a git repository: this directory is not one.' });
    expect(runButton(noGit)).toContain('disabled');
    expect(noGit).toContain('Changes need a git repository');
    expect(panel({ runDisabledReason: 'A change is already open; apply or discard it first.' })).toContain('already open');
    expect(panel({ withRun: false })).not.toContain('>Run<');
    // With an empty basket the Run section is not shown at all (the panel shows how to select).
    expect(panel({ empty: true })).not.toContain('>Run<');
  });
});

describe('change panel', () => {
  const baseChange: ChangeStatus = {
    id: 'abc12345',
    status: 'done',
    task: 'add a request id to every log line',
    history: [{ task: 'add a request id to every log line', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result: null }],
    context: {
      task: 'add a request id to every log line',
      nodes: [],
      files: [],
      size: { files: 0, lines: 0 },
      relations: { internal: [], external: [] },
      snapshots: [],
      warnings: [],
      stale: false,
      limits: { paths: ['src/util'], note: '' },
    },
    startSnapshot: snapshot,
    workspaceDir: '/tmp/work/abc12345',
    result: {
      summary: 'Prefixed every log call with the request id.',
      changedFiles: ['src/util/log.ts', 'src/index.ts'],
      checks: [],
      scopeExpansion: { needed: true, reason: 'the HTTP handler must pass the id', suggestedPaths: ['src/server/http.ts'] },
    },
    files: [
      {
        path: 'src/util/log.ts',
        oldPath: 'src/util/log.ts',
        status: 'modified',
        binary: false,
        outsideLimits: false,
        hunks: [
          {
            header: '@@ -1,2 +1,3 @@',
            oldStart: 1,
            newStart: 1,
            lines: [
              { type: ' ', text: 'export function log(msg: string) {' },
              { type: '-', text: '  console.log(msg);' },
              { type: '+', text: '  console.log(`[${requestId()}] ${msg}`);' },
            ],
          },
        ],
      },
      { path: 'src/index.ts', oldPath: 'src/index.ts', status: 'modified', binary: false, outsideLimits: true, hunks: [] },
    ],
    affected: [
      { nodeId: 'srv', title: 'server', level: 'L4', scope: view.scope, files: ['src/util/log.ts'] },
      { nodeId: 'L3:L4:root/server/http', title: 'http', level: 'L3', scope: l3Scope, files: ['src/index.ts'] },
    ],
    affectedViews: [view.scope, l3Scope],
    checks: [
      { name: 'typecheck', command: 'npm run typecheck', ok: true, exitCode: 0, outputTail: 'typecheck ok', timedOut: false },
      { name: 'lint', command: 'npm run lint', ok: false, exitCode: 1, outputTail: 'lint failed: src/util/log.ts', timedOut: false },
    ],
    checkCommands: ['npm run typecheck', 'npm run lint'],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };

  const panel = (change: ChangeStatus, over: Partial<Parameters<typeof ChangePanel>[0]> = {}) =>
    render(
      h(ChangePanel, {
        change,
        activity: [],
        runStartedAt: null,
        busy: false,
        error: null,
        onCancel: noop,
        onRefine: noop,
        onApply: noop,
        onDiscard: noop,
        onOpenView: noop,
        onClose: noop,
        ...over,
      }),
    );

  it('shows the summary, the scope callout, the diff with highlighted lines, the outside badge, components and checks', () => {
    const html = panel(baseChange);
    expect(html).toContain('ready to review');
    expect(html).toContain('add a request id to every log line');
    expect(html).toContain('Prefixed every log call with the request id.');
    expect(html).toContain('Needs a wider scope');
    expect(html).toContain('the HTTP handler must pass the id');
    expect(html).toContain('<code>src/server/http.ts</code>');
    expect(html).toContain('sz-diff-line-add');
    expect(html).toContain('sz-diff-line-del');
    expect(html).toContain('console.log(msg);');
    expect(html).toContain('@@ -1,2 +1,3 @@');
    expect(html).toContain('outside selected area');
    expect(html).toContain('sz-diff-outside');
    expect(html).toContain('Applying asks for confirmation');
    expect(html).toContain('Affected components');
    expect(html).toContain('L4 · demo');
    expect(html).toContain('L3 · server');
    expect(html).toContain('<strong>server</strong>');
    expect(html).toContain('1 of 2 failed');
    expect(html).toContain('npm run lint');
    expect(html).toContain('lint failed: src/util/log.ts'); // failed output is open by default
    expect(html).toContain('>passed<');
    expect(html).toContain('Apply to working tree');
    expect(html).toContain('>Discard<');
    expect(html).toContain('>Refine<');
    expect(html).not.toContain('>Cancel<');
  });

  it('shows progress and a Cancel button while running, without diff or actions', () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const html = panel(
      { ...baseChange, status: 'running', result: null, files: [], checks: [], affected: [], affectedViews: [] },
      { runStartedAt: startedAt, activity: [{ tool: 'Edit', detail: 'src/util/log.ts', at: startedAt }] },
    );
    expect(html).toContain('>running<');
    expect(html).toContain('isolated copy');
    expect(html).toMatch(/0:3\d elapsed/);
    expect(html).toContain('>Edit</span> src/util/log.ts');
    expect(html).toContain('>Cancel<');
    expect(html).not.toContain('Apply to working tree');
    expect(html).not.toContain('>Refine<');
  });

  it('reports an applied change with a Close button, a failed one with its error, and a cancelled one', () => {
    const applied = panel({ ...baseChange, status: 'applied' });
    expect(applied).toContain('>applied<');
    expect(applied).toContain('Applied to your working tree');
    expect(applied).toContain('>Close<');
    expect(applied).not.toContain('Apply to working tree');

    const failed = panel({ ...baseChange, status: 'failed', error: 'the agent stopped: error_max_turns' });
    expect(failed).toContain('>failed<');
    expect(failed).toContain('error_max_turns');
    expect(failed).toContain('>Discard<');

    const cancelled = panel({ ...baseChange, status: 'cancelled', files: [], checks: [] });
    expect(cancelled).toContain('Cancelled.');
    expect(cancelled).toContain('No files changed.');
    expect(panel(baseChange, { error: 'The repository moved since the change started.' })).toContain('repository moved');
  });
});
