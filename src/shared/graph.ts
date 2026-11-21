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
  /**
   * Something outside this area that the code talks to: at L4 a dependency or runtime
   * boundary, at L3/L2 possibly code of this repository that lives in another scope.
   */
  boundary: boolean;
  /**
   * For a boundary node at L2: the id of the L3 subsystem (a sibling of the opened one)
   * this entity belongs to, so the UI can jump there. Empty when unknown or not a
   * boundary node.
   */
  subsystemId: string;
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

/**
 * A node id is `<level>:<scope>/<slug>`, so the scope that owns a node — and therefore
 * the view that has to be generated to reach it — is readable from the id itself.
 *
 * The slug is after the LAST slash: a deeper scope id embeds its own parent, so
 * `L3:L4:root/app/sub` is owned by `L4:root/app`, not by `L4:root`.
 */
export function scopeOwnerOf(nodeIdValue: string): string | null {
  const colon = nodeIdValue.indexOf(':');
  const slash = nodeIdValue.lastIndexOf('/');
  return colon > 0 && slash > colon ? nodeIdValue.slice(colon + 1, slash) : null;
}

/** The level encoded at the front of a node id (`L3:...`), or null for a malformed id. */
export function levelOfNodeId(nodeIdValue: string): Level | null {
  const colon = nodeIdValue.indexOf(':');
  const prefix = colon > 0 ? nodeIdValue.slice(0, colon) : '';
  return (LEVELS as readonly string[]).includes(prefix) ? (prefix as Level) : null;
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

/* ------------------------------------------------------------------------------------ */
/* Selection and the structured AI context (SPEC §6.3, §8.4)                            */
/* ------------------------------------------------------------------------------------ */

/**
 * The view an id belongs to. A node id is `<level>:<scope>/<slug>`; an edge id is
 * `<level>:<scope>|<from>-><to>|<kind>`. Slugs never contain `|`, and a scope id (itself
 * a node id or `root`) may contain `:` but never `|`, so the first `|` separates the
 * owning view from the rest of an edge id. Null for an id in neither form.
 */
export function viewKeyOfId(id: string): { level: Level; scopeId: string } | null {
  const bar = id.indexOf('|');
  if (bar >= 0) {
    const head = id.slice(0, bar);
    const colon = head.indexOf(':');
    if (colon <= 0) return null;
    const level = head.slice(0, colon);
    const scopeId = head.slice(colon + 1);
    if (!(LEVELS as readonly string[]).includes(level) || scopeId.length === 0) return null;
    return { level: level as Level, scopeId };
  }
  const level = levelOfNodeId(id);
  const scopeId = scopeOwnerOf(id);
  return level && scopeId ? { level, scopeId } : null;
}

export function viewKey(level: Level, scopeId: string): string {
  return `${level}:${scopeId}`;
}

export interface SelectionInput {
  nodeIds: string[];
  edgeIds: string[];
  /** The user's instruction, when there already is one (SPEC §8.4). */
  task?: string;
}

export interface SelectionOptions {
  /** The repository state right now; a view generated against another state is stale. */
  live?: Snapshot;
}

export interface SelectedNode extends Pick<GraphNode, 'id' | 'level' | 'kind' | 'title' | 'summary' | 'memberOf' | 'boundary'> {
  /** The view the node was taken from. */
  scope: { id: string; label: string };
}

/** 1-based, inclusive, like `Evidence`. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface ContextFile {
  file: string;
  /** Merged: no duplicates, no overlapping or adjacent ranges, sorted by start line. */
  ranges: LineRange[];
}

export interface ContextEndpoint {
  id: string;
  title: string;
}

export interface ContextRelation {
  id: string;
  from: ContextEndpoint;
  to: ContextEndpoint;
  kind: string;
  label: string;
  status: EdgeStatus;
  /** Why the relation is unverified. Empty for confirmed relations. */
  reason: string;
}

/** The repository state a group of selected items was generated against. */
export interface ContextSnapshot extends Pick<Snapshot, 'branch' | 'commit' | 'shortCommit' | 'dirty' | 'stateId'> {
  /** The views (scopes) of this state the items come from. */
  scopes: ScopeRef[];
}

/**
 * The structured context of SPEC §8.4: what is selected, where it lives in the code,
 * how it relates to the rest, and against which repository state all of that holds.
 * Plain JSON — no file contents, only paths and line ranges.
 */
export interface SelectionContext {
  task: string;
  nodes: SelectedNode[];
  files: ContextFile[];
  /** `lines` is the total covered by the merged ranges. */
  size: { files: number; lines: number };
  relations: {
    /** Both endpoints are selected. */
    internal: ContextRelation[];
    /** One endpoint is selected, the other is not: what the selection depends on or serves. */
    external: ContextRelation[];
  };
  snapshots: ContextSnapshot[];
  /** Mixed or stale snapshots, ids that could not be resolved. Never hidden (SPEC §5.4). */
  warnings: string[];
  /** Some items come from a view generated against a state other than the live one. */
  stale: boolean;
  /** Boundaries of the change, so a later Change Agent knows where it may not go. */
  limits: { paths: string[]; note: string };
}

export const LIMITS_NOTE =
  'Only the files above were analyzed. A missing relation is not proof that none exists (SPEC §R5); ' +
  'going beyond these paths requires widening the scope explicitly.';

/** Collapses duplicates, overlaps and adjacent ranges (`10-20` + `21-30` = `10-30`). */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges
    .map((r) => ({ startLine: Math.min(r.startLine, r.endLine), endLine: Math.max(r.startLine, r.endLine) }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Evidence grouped by file, every file's ranges merged, files sorted by name. */
export function groupEvidence(evidence: Evidence[]): ContextFile[] {
  const byFile = new Map<string, LineRange[]>();
  for (const ev of evidence) {
    const list = byFile.get(ev.file);
    const range = { startLine: ev.startLine, endLine: ev.endLine };
    if (list) list.push(range);
    else byFile.set(ev.file, [range]);
  }
  return [...byFile.keys()].sort().map((file) => ({ file, ranges: mergeRanges(byFile.get(file)!) }));
}

interface ResolvedNode {
  node: GraphNode;
  view: GraphView;
}

/**
 * Turns a visual selection into the structured context of SPEC §8.4.
 *
 * The selection may span several views (an L4 application together with two of its L3
 * subsystems, say): every id is resolved against the view that owns it, which the id
 * itself names. Ids of views that are not loaded, and ids whose node or edge no longer
 * exists in its view, become warnings and are left out — the context never guesses.
 *
 * Shared by the UI panel and `POST /api/context`, so it lives in the shared model.
 */
export function buildSelectionContext(
  views: GraphView[],
  input: SelectionInput,
  options: SelectionOptions = {},
): SelectionContext {
  const byKey = new Map<string, GraphView>();
  for (const view of views) byKey.set(viewKey(view.scope.level, view.scope.id), view);
  const warnings: string[] = [];

  /** The view an id belongs to, or null with a warning pushed. */
  const ownerOf = (id: string, what: 'Node' | 'Edge'): GraphView | null => {
    const key = viewKeyOfId(id);
    if (key) {
      const view = byKey.get(viewKey(key.level, key.scopeId));
      if (view) return view;
      warnings.push(`${what} ${id} belongs to view ${key.level}:${key.scopeId}, which is not loaded; it was left out.`);
      return null;
    }
    // An id in neither form (older or hand-made): the only place to look is everywhere.
    const found = views.find((v) =>
      what === 'Node' ? v.nodes.some((n) => n.id === id) : v.edges.some((e) => e.id === id),
    );
    if (!found) warnings.push(`${what} ${id} was not found in any loaded view; it was left out.`);
    return found ?? null;
  };

  const resolved = new Map<string, ResolvedNode>();
  const addNode = (view: GraphView, id: string): boolean => {
    const node = findNode(view, id);
    if (!node) return false;
    if (!resolved.has(id)) resolved.set(id, { node, view });
    return true;
  };

  for (const id of input.nodeIds) {
    const view = ownerOf(id, 'Node');
    if (view && !addNode(view, id)) {
      warnings.push(`Node ${id} no longer exists in view ${view.scope.level}:${view.scope.id}; it was left out.`);
    }
  }
  // A selected relation brings its endpoints along: a relation without them is nothing.
  for (const id of input.edgeIds) {
    const view = ownerOf(id, 'Edge');
    if (!view) continue;
    const edge = view.edges.find((e) => e.id === id);
    if (!edge) {
      warnings.push(`Edge ${id} no longer exists in view ${view.scope.level}:${view.scope.id}; it was left out.`);
      continue;
    }
    addNode(view, edge.from);
    addNode(view, edge.to);
  }

  // Views in the given order, nodes in view order: the output is stable.
  const touched = new Set([...resolved.values()].map((r) => r.view));
  const usedViews = views.filter((v) => touched.has(v));
  const nodes: GraphNode[] = usedViews.flatMap((v) => v.nodes.filter((n) => resolved.has(n.id)));

  const relation = (view: GraphView, e: GraphEdge): ContextRelation => ({
    id: e.id,
    from: { id: e.from, title: findNode(view, e.from)?.title ?? e.from },
    to: { id: e.to, title: findNode(view, e.to)?.title ?? e.to },
    kind: e.kind,
    label: e.label,
    status: e.status,
    reason: e.reason,
  });
  const internal: ContextRelation[] = [];
  const external: ContextRelation[] = [];
  const evidence: Evidence[] = nodes.flatMap((n) => n.evidence);
  for (const view of usedViews) {
    for (const e of view.edges) {
      const fromIn = resolved.has(e.from);
      const toIn = resolved.has(e.to);
      if (!fromIn && !toIn) continue;
      (fromIn && toIn ? internal : external).push(relation(view, e));
      evidence.push(...e.evidence);
    }
  }

  const files = groupEvidence(evidence);
  const lines = files.reduce(
    (sum, f) => sum + f.ranges.reduce((acc, r) => acc + (r.endLine - r.startLine + 1), 0),
    0,
  );

  const snapshots: ContextSnapshot[] = [];
  for (const view of usedViews) {
    const s = view.snapshot;
    const same = snapshots.find((c) => c.stateId === s.stateId && c.branch === s.branch);
    if (same) same.scopes.push(view.scope);
    else {
      snapshots.push({
        branch: s.branch,
        commit: s.commit,
        shortCommit: s.shortCommit,
        dirty: s.dirty,
        stateId: s.stateId,
        scopes: [view.scope],
      });
    }
  }
  const describe = (s: ContextSnapshot) => `${s.branch}@${s.shortCommit}${s.dirty ? ' (dirty)' : ''}`;
  if (snapshots.length > 1) {
    warnings.push(
      `The selection mixes views generated against different repository states: ${snapshots
        .map((s) => `${describe(s)} for ${s.scopes.map((sc) => `${sc.level}:${sc.id}`).join(', ')}`)
        .join('; ')}.`,
    );
  }
  let stale = false;
  if (options.live) {
    const live = options.live;
    for (const s of snapshots) {
      if (s.stateId === live.stateId) continue;
      stale = true;
      warnings.push(
        `${s.scopes.map((sc) => `${sc.level}:${sc.id}`).join(', ')} ${s.scopes.length === 1 ? 'was' : 'were'} generated against ${describe(s)}, ` +
          `but the repository is now at ${live.branch}@${live.shortCommit}${live.dirty ? ' (dirty)' : ''}. The lines may have moved.`,
      );
    }
  }

  const limitPaths = new Set<string>();
  for (const n of nodes) {
    // A boundary node has no paths of its own; its evidence still says where it shows up.
    for (const p of n.paths.length > 0 ? n.paths : n.evidence.map((e) => e.file)) limitPaths.add(p);
  }

  return {
    task: input.task ?? '',
    nodes: nodes.map((n) => {
      const view = resolved.get(n.id)!.view;
      return {
        id: n.id,
        level: n.level,
        kind: n.kind,
        title: n.title,
        summary: n.summary,
        memberOf: n.memberOf,
        boundary: n.boundary,
        scope: { id: view.scope.id, label: view.scope.label },
      };
    }),
    files,
    size: { files: files.length, lines },
    relations: { internal, external },
    snapshots,
    warnings,
    stale,
    limits: { paths: [...limitPaths].sort(), note: LIMITS_NOTE },
  };
}

export type ExpandDirection = 'in' | 'out' | 'both';

/**
 * The direct neighbours of `nodeIds` in `view` over confirmed relations only (FR-12):
 * `out` follows relations leaving the selection, `in` the ones arriving at it. An
 * unverified relation is not a fact to expand along (SPEC §5.4). Returns only ids that
 * are not already selected, de-duplicated, in the order the view lists its nodes.
 */
export function expandSelection(view: GraphView, nodeIds: Iterable<string>, direction: ExpandDirection): string[] {
  const selected = new Set(nodeIds);
  const found = new Set<string>();
  for (const e of view.edges) {
    if (e.status !== 'confirmed') continue;
    if (direction !== 'in' && selected.has(e.from) && !selected.has(e.to)) found.add(e.to);
    if (direction !== 'out' && selected.has(e.to) && !selected.has(e.from)) found.add(e.from);
  }
  return view.nodes.filter((n) => found.has(n.id)).map((n) => n.id);
}
