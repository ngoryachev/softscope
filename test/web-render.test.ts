/**
 * Render smoke test for the UI: every screen must render, and the things the user has
 * to be able to trust — code links, the boundary marker and the unverified marker —
 * must actually reach the markup. Rendered with `react-dom/server`, so no DOM
 * environment and no browser are needed.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/web/App';
import { Breadcrumbs } from '../src/web/components/Breadcrumbs';
import { FileViewer } from '../src/web/components/FileViewer';
import { GraphCanvas } from '../src/web/components/GraphCanvas';
import { Inspector } from '../src/web/components/Inspector';
import { RepoPicker } from '../src/web/components/RepoPicker';
import { SnapshotBar } from '../src/web/components/SnapshotBar';
import type { RepoState } from '../src/shared/api';
import type { GraphView, Snapshot } from '../src/shared/graph';

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
};

const state: RepoState = {
  repoPath: '/tmp/demo',
  repoName: 'demo',
  isGitRepo: true,
  snapshot,
  generatableLevels: ['L4', 'L3'],
  fakeAgent: true,
};

const noop = () => undefined;
const render = (element: ReactElement) => renderToStaticMarkup(element);

const inspector = (over: { selectedNodeId?: string | null; selectedEdgeId?: string | null } = {}) =>
  render(
    h(Inspector, {
      view,
      selectedNodeId: over.selectedNodeId ?? null,
      selectedEdgeId: over.selectedEdgeId ?? null,
      onOpenEvidence: noop,
      onOpenNode: noop,
      onSelectNode: noop,
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
    const html = render(
      h(GraphCanvas, {
        view,
        selectedNodeId: 'srv',
        selectedEdgeId: null,
        onSelectNode: noop,
        onSelectEdge: noop,
        onOpenNode: noop,
      }),
    );
    expect(html).toContain('unverified relation'); // the legend explains the dashed edges
    expect(html.length).toBeGreaterThan(200);
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
});
