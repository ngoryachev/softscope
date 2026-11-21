/**
 * The graph model SoftZoom shows, shared verbatim by server, UI and tests.
 *
 * Shape notes that later cycle steps (Zoom / Select / Change) depend on:
 *  - every level is generated per scope, never for the whole repository (SPEC §4.4);
 *  - membership is `memberOf: string[]`, not a parent pointer, so one entity can sit
 *    in several subsystems (SPEC §5.1);
 *  - boundary nodes are ordinary nodes with `boundary: true` (SPEC §4.4);
 *  - every node and edge carries `evidence`, and an edge that could not be confirmed
 *    stays in the graph as `unverified` rather than disappearing (SPEC §5.4).
 */

/** Semantic zoom levels of SPEC §5.1, from applications down to behaviour. */
export type Level = 'L4' | 'L3' | 'L2' | 'L1';

export const LEVELS: readonly Level[] = ['L4', 'L3', 'L2', 'L1'] as const;

const LEVEL_TITLES: Record<Level, string> = {
  L4: 'Applications',
  L3: 'Subsystems',
  L2: 'Entities',
  L1: 'Behavior',
};

export function levelTitle(level: Level): string {
  return LEVEL_TITLES[level];
}

/** The level one step deeper, or null at the bottom. */
export function nextLevel(level: Level): Level | null {
  const i = LEVELS.indexOf(level);
  return i < 0 || i === LEVELS.length - 1 ? null : LEVELS[i + 1]!;
}

/**
 * A pointer into the analyzed repository. `file` is always repository-relative and
 * POSIX-separated; lines are 1-based and inclusive.
 */
export interface Evidence {
  file: string;
  startLine: number;
  endLine: number;
  /** Why this range is the evidence; the agent fills it in, the UI shows it. */
  note?: string;
}

export interface GraphNode {
  id: string;
  level: Level;
  /** Agent-chosen, e.g. `application`, `package`, `subsystem`, `external-service`. */
  kind: string;
  title: string;
  /** One or two sentences: what this is, as implemented. */
  summary: string;
  evidence: Evidence[];
  /** A significant dependency or runtime boundary rather than code of this repository. */
  boundary: boolean;
  /** Ids of the nodes this one belongs to. Several entries are normal (SPEC §5.1). */
  memberOf: string[];
  /** Files and directories that make up the node; the scope of the next level down. */
  paths: string[];
  /** Set when the node can be opened one level deeper. */
  childScope: ScopeRef | null;
}

export type EdgeStatus = 'confirmed' | 'unverified';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Agent-chosen, e.g. `imports`, `calls`, `reads`, `emits`, `transitions-to`. */
  kind: string;
  label: string;
  evidence: Evidence[];
  /**
   * `unverified` means the relation is plausible but not backed by evidence that
   * survived validation. It is still drawn, visually distinct (SPEC §5.4).
   */
  status: EdgeStatus;
  /** Why the edge is unverified. Empty for confirmed edges. */
  reason: string;
}

/** The repository state a view was generated against (SPEC §9.4). */
export interface Snapshot {
  branch: string;
  commit: string;
  shortCommit: string;
  /** The working tree had uncommitted changes when the view was generated. */
  dirty: boolean;
  /** Identifies the exact state including uncommitted changes; used as a cache key. */
  stateId: string;
  generatedAt: string;
}

/** The area one generation call covers. A view is always scoped (SPEC §4.4). */
export interface ScopeRef {
  level: Level;
  /** `root` for the whole repository at L4, otherwise the parent node's id. */
  id: string;
  label: string;
  /** Repository-relative files and directories the agent may look at. */
  paths: string[];
}

export const ROOT_SCOPE_ID = 'root';

export interface GraphView {
  scope: ScopeRef;
  /** The representation the agent picked for this area (SPEC §5.3). */
  diagramKind: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** What the analysis could not establish — shown in the UI, never hidden (SPEC §5.4). */
  notes: string[];
  snapshot: Snapshot;
}

export function rootScope(repoName: string): ScopeRef {
  return { level: 'L4', id: ROOT_SCOPE_ID, label: repoName, paths: ['.'] };
}

/** A stable, URL-safe id for an agent-supplied slug inside one scope. */
export function nodeId(scope: ScopeRef, slug: string): string {
  const safe = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${scope.level}:${scope.id}/${safe || 'node'}`;
}

export function edgeId(scope: ScopeRef, from: string, to: string, kind: string): string {
  return `${scope.level}:${scope.id}|${from}->${to}|${kind}`;
}

/** The scope that opening `node` one level deeper would generate, or null. */
export function childScopeOf(node: GraphNode): ScopeRef | null {
  const level = nextLevel(node.level);
  if (!level || node.boundary || node.paths.length === 0) return null;
  return { level, id: node.id, label: node.title, paths: [...node.paths] };
}

export function findNode(view: GraphView, id: string): GraphNode | undefined {
  return view.nodes.find((n) => n.id === id);
}

/** The nodes `node` is a member of (SPEC §5.1: possibly more than one). */
export function subsystemsOf(view: GraphView, node: GraphNode): GraphNode[] {
  return node.memberOf.flatMap((id) => {
    const found = findNode(view, id);
    return found ? [found] : [];
  });
}

/** Nodes that declare `node` as one of their containers. */
export function membersOf(view: GraphView, node: GraphNode): GraphNode[] {
  return view.nodes.filter((n) => n.memberOf.includes(node.id));
}

export function edgesOf(view: GraphView, id: string): GraphEdge[] {
  return view.edges.filter((e) => e.from === id || e.to === id);
}

export interface SelectionInput {
  nodeIds: string[];
  edgeIds: string[];
  /** The user's instruction, when there already is one (SPEC §8.4). */
  task?: string;
  /** Pull in the direct neighbours of the selected nodes (SPEC §6.3). */
  expandDependencies?: boolean;
}

export interface SelectionContext {
  scope: ScopeRef;
  snapshot: Snapshot;
  task: string;
  nodes: Array<Pick<GraphNode, 'id' | 'level' | 'kind' | 'title' | 'summary' | 'memberOf' | 'boundary'>>;
  edges: Array<Pick<GraphEdge, 'id' | 'from' | 'to' | 'kind' | 'label' | 'status'>>;
  /** Every file the selection points at, de-duplicated, in a stable order. */
  files: string[];
  evidence: Evidence[];
  /** Selected relations that are not backed by evidence — the caller must not trust them. */
  unverified: Array<Pick<GraphEdge, 'id' | 'from' | 'to' | 'kind' | 'reason'>>;
  /** Boundaries of the change, so a later Change Agent knows where it may not go. */
  limits: { paths: string[]; note: string };
}

/**
 * Turns a visual selection into the structured context of SPEC §8.4. Used by the
 * inspector today and by the Change Agent in a later step of the product cycle, so it
 * lives in the shared model rather than in the UI.
 */
export function buildSelectionContext(view: GraphView, input: SelectionInput): SelectionContext {
  const selected = new Set(input.nodeIds);
  const edges = view.edges.filter((e) => input.edgeIds.includes(e.id));
  for (const e of edges) {
    selected.add(e.from);
    selected.add(e.to);
  }
  if (input.expandDependencies) {
    for (const e of view.edges) {
      if (input.nodeIds.includes(e.from)) selected.add(e.to);
      if (input.nodeIds.includes(e.to)) selected.add(e.from);
    }
  }
  const nodes = view.nodes.filter((n) => selected.has(n.id));
  // Relations fully inside the selection are part of the context even when not clicked.
  const relatedEdges = view.edges.filter(
    (e) => edges.includes(e) || (selected.has(e.from) && selected.has(e.to)),
  );
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const source of [...nodes, ...relatedEdges]) {
    for (const ev of source.evidence) {
      const key = `${ev.file}:${ev.startLine}-${ev.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(ev);
    }
  }
  const files = [...new Set(evidence.map((e) => e.file))].sort();
  return {
    scope: view.scope,
    snapshot: view.snapshot,
    task: input.task ?? '',
    nodes: nodes.map((n) => ({
      id: n.id,
      level: n.level,
      kind: n.kind,
      title: n.title,
      summary: n.summary,
      memberOf: n.memberOf,
      boundary: n.boundary,
    })),
    edges: relatedEdges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label,
      status: e.status,
    })),
    files,
    evidence,
    unverified: relatedEdges
      .filter((e) => e.status === 'unverified')
      .map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, reason: e.reason })),
    limits: {
      paths: [...new Set(nodes.flatMap((n) => n.paths))].sort(),
      note:
        'Only the files above were analyzed. A missing relation is not proof that none exists (SPEC §R5); ' +
        'going beyond these paths requires widening the scope explicitly.',
    },
  };
}
