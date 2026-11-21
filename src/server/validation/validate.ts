/**
 * Server-side evidence validation (SPEC §5.4, risk R1).
 *
 * The agent's reply is a claim, not a result. Here every pointer into the code is
 * checked against the real repository:
 *  - the file must resolve inside the analyzed repository and exist;
 *  - the line range must lie inside that file;
 *  - a node left without a single valid pointer is dropped;
 *  - an edge to a dropped node is dropped with it;
 *  - an edge with no valid pointer (or one the agent itself did not confirm) stays,
 *    marked `unverified`, so a missing relation is never silently invented away.
 *
 * The same rules apply to a behaviour view (L1): a state, a participant or a step is a
 * node, a transition or a message is an edge. On top of them the behaviour fields are
 * checked: a `role` outside what the diagram kind allows is cleared, a message `style`
 * outside sync/async/return is cleared, the `order` of a sequence is made unique and
 * gap-free, and a reply whose `behavior.supported` disagrees with its content is
 * reported. An unsupported reply stays unsupported: the server never fills a diagram
 * in for it (R1/R5).
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { staysInsideRepo } from '../indexer/files';
import type { AgentEvidence, AgentGraph } from '../../shared/agent-schema';
import type { ValidationIssue } from '../../shared/api';
import {
  childScopeOf,
  edgeId,
  isBehaviorKind,
  MESSAGE_STYLES,
  NODE_ROLES_BY_KIND,
  nodeId,
  type BehaviorInfo,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphView,
  type MessageStyle,
  type NodeRole,
  type ScopeRef,
  type Snapshot,
} from '../../shared/graph';

export interface ValidateOptions {
  repoPath: string;
  scope: ScopeRef;
  snapshot: Snapshot;
  raw: AgentGraph;
  /**
   * Ids a boundary node may name as the subsystem it belongs to: the other nodes of the
   * parent view. Any other value is dropped — the agent must not invent a destination.
   */
  subsystemIds?: string[];
}

export interface ValidateResult {
  view: GraphView;
  issues: ValidationIssue[];
}

/** Counts lines the way an editor does: a trailing newline does not add a line. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

class FileFacts {
  private readonly lineCounts = new Map<string, number | null>();

  constructor(private readonly repoPath: string) {}

  /**
   * The repository-relative, POSIX path of `candidate`, or null if it escapes the repo.
   *
   * `allowRoot` separates the two kinds of path the agent sends. A scope path may be the
   * repository root — `rootScope()` uses `['.']` and `filesUnder()` reads it as "every
   * file", so an application that covers the whole repository says `.` — while a piece
   * of evidence may not: the root is a directory and has no line range.
   */
  normalize(candidate: string, allowRoot = false): string | null {
    const raw = candidate.trim();
    if (raw.length === 0 || isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
    const abs = resolve(this.repoPath, raw);
    const rel = relative(this.repoPath, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    // A symlink inside the repository can point outside it; the promise is that the
    // path really lives in the analyzed repository.
    if (!staysInsideRepo(this.repoPath, abs)) return null;
    if (rel === '') return allowRoot ? '.' : null;
    return sep === '/' ? rel : rel.split(sep).join('/');
  }

  /** Number of lines in the file, or null when it is missing or unreadable. */
  lines(rel: string): number | null {
    const cached = this.lineCounts.get(rel);
    if (cached !== undefined) return cached;
    let count: number | null = null;
    try {
      const abs = join(this.repoPath, rel);
      if (statSync(abs).isFile()) count = countLines(readFileSync(abs, 'utf8'));
    } catch {
      count = null;
    }
    this.lineCounts.set(rel, count);
    return count;
  }
}

function checkEvidence(
  facts: FileFacts,
  raw: AgentEvidence[],
  owner: { nodeId?: string; edgeId?: string },
  issues: ValidationIssue[],
): Evidence[] {
  const out: Evidence[] = [];
  for (const ev of raw) {
    const file = facts.normalize(ev.file);
    if (!file) {
      issues.push({
        kind: 'evidence-outside-repo',
        message: `Evidence path "${ev.file}" is not inside the analyzed repository.`,
        file: ev.file,
        ...owner,
      });
      continue;
    }
    const lines = facts.lines(file);
    if (lines === null) {
      issues.push({
        kind: 'evidence-missing-file',
        message: `Evidence file "${file}" does not exist.`,
        file,
        ...owner,
      });
      continue;
    }
    const start = Math.trunc(ev.startLine);
    const end = Math.trunc(ev.endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start || end > lines) {
      issues.push({
        kind: 'evidence-bad-range',
        message: `Evidence range ${start}-${end} is outside "${file}" (${lines} lines).`,
        file,
        ...owner,
      });
      continue;
    }
    out.push({ file, startLine: start, endLine: end, ...(ev.note ? { note: ev.note } : {}) });
  }
  return out;
}

/**
 * The subsystem a boundary node claims to belong to, kept only when it is one of the
 * known sibling ids and the node really is a boundary node. A wrong link would send the
 * user to a subsystem the code does not point at, so it is reported and cleared.
 */
function subsystemLink(
  node: AgentGraph['nodes'][number],
  id: string,
  known: Set<string>,
  issues: ValidationIssue[],
): string {
  const link = (node.subsystemId ?? '').trim();
  if (link.length === 0) return '';
  if (!node.boundary) {
    issues.push({
      kind: 'subsystem-link-dropped',
      message: `Node "${node.title}" is not a boundary node; its subsystem link "${link}" was dropped.`,
      nodeId: id,
    });
    return '';
  }
  if (!known.has(link)) {
    issues.push({
      kind: 'subsystem-link-dropped',
      message: `Boundary node "${node.title}" links to unknown subsystem "${link}"; the link was dropped.`,
      nodeId: id,
    });
    return '';
  }
  return link;
}

/**
 * The roles the reply's diagram kind allows. A role is meaningful only inside a behaviour
 * diagram; anywhere else it is cleared and reported, because the UI would draw it.
 */
function allowedRoles(diagramKind: string): readonly NodeRole[] {
  if (!isBehaviorKind(diagramKind) || diagramKind === 'unsupported') return [];
  return NODE_ROLES_BY_KIND[diagramKind];
}

function nodeRole(
  node: AgentGraph['nodes'][number],
  id: string,
  allowed: readonly NodeRole[],
  issues: ValidationIssue[],
): NodeRole | undefined {
  const role = (node.role ?? '').trim();
  if (role.length === 0) return undefined;
  if ((allowed as readonly string[]).includes(role)) return role as NodeRole;
  issues.push({
    kind: 'role-cleared',
    message: `Node "${node.title}" has role "${role}", which this diagram kind does not allow; the role was cleared.`,
    nodeId: id,
  });
  return undefined;
}

/**
 * The positions of a sequence's messages: the ones the agent numbered come first in the
 * order of their numbers (ties in order of appearance), the unnumbered ones follow, and
 * all are renumbered 1..n. `fixed` says whether that differs from what the agent sent —
 * a duplicate, a gap, a missing or a non-integer value.
 */
function sequenceOrders(edges: ReadonlyArray<AgentGraph['edges'][number]>): { assigned: number[]; fixed: boolean } {
  const given = edges.map((e) => (Number.isInteger(e.order) && (e.order ?? 0) > 0 ? (e.order as number) : null));
  const indexes = edges.map((_, i) => i);
  indexes.sort((a, b) => {
    const ga = given[a] ?? null;
    const gb = given[b] ?? null;
    if (ga === null && gb === null) return a - b;
    if (ga === null) return 1;
    if (gb === null) return -1;
    return ga - gb || a - b;
  });
  const assigned = new Array<number>(edges.length);
  indexes.forEach((edgeIndex, position) => {
    assigned[edgeIndex] = position + 1;
  });
  const fixed = given.some((g, i) => g !== assigned[i]);
  return { assigned, fixed };
}

/**
 * Whether the reply describes a behaviour at all. `supported=false` wins over any
 * content: nodes sent along with it are dropped and reported, never drawn. A reply that
 * says `unsupported` as its diagram kind while claiming support is treated as
 * unsupported too — the safe direction, since no diagram is invented either way.
 *
 * Only a behaviour view (L1) can be unsupported. An application or a subsystem reply
 * that says so is an agent mistake: it is reported and the flag ignored, so the user
 * gets the graph the agent did send rather than a "not available" panel for an area.
 */
function behaviorOutcome(raw: AgentGraph, scope: ScopeRef, issues: ValidationIssue[]): BehaviorInfo {
  const claimsUnsupportedKind = raw.diagramKind === 'unsupported';
  if (raw.behavior.supported && !claimsUnsupportedKind) return { supported: true, reason: '' };
  if (scope.level !== 'L1') {
    issues.push({
      kind: 'behavior-inconsistent',
      message:
        `The reply claims no behaviour view is possible (${claimsUnsupportedKind ? 'diagramKind "unsupported"' : 'behavior.supported=false'}), ` +
        `but only L1 has behaviour views; the claim was ignored for this ${scope.level} view.`,
    });
    return { supported: true, reason: '' };
  }
  if (raw.behavior.supported && claimsUnsupportedKind) {
    issues.push({
      kind: 'behavior-inconsistent',
      message: 'The reply has diagramKind "unsupported" but claims behavior.supported=true; it is treated as unsupported.',
    });
  }
  if (raw.nodes.length > 0 || raw.edges.length > 0) {
    issues.push({
      kind: 'behavior-inconsistent',
      message:
        `The agent reported that no behaviour view is possible, yet sent ${raw.nodes.length} node(s) and ` +
        `${raw.edges.length} edge(s); they were dropped rather than drawn.`,
    });
  }
  let reason = raw.behavior.reason.trim();
  if (reason.length === 0) {
    issues.push({
      kind: 'behavior-inconsistent',
      message: 'The agent reported that no behaviour view is possible but gave no reason.',
    });
    reason = 'The agent could not derive a behaviour view and gave no reason.';
  }
  return { supported: false, reason };
}

export function validateView({ repoPath, scope, snapshot, raw, subsystemIds = [] }: ValidateOptions): ValidateResult {
  const facts = new FileFacts(repoPath);
  const issues: ValidationIssue[] = [];
  const knownSubsystems = new Set(subsystemIds);
  const notes = raw.notes.filter((n) => n.trim().length > 0);

  const behavior = behaviorOutcome(raw, scope, issues);
  if (!behavior.supported) {
    return {
      view: { scope, diagramKind: 'unsupported', nodes: [], edges: [], notes, snapshot, behavior },
      issues,
    };
  }
  const roles = allowedRoles(raw.diagramKind);
  const isSequence = raw.diagramKind === 'sequence';
  const transitionLike = raw.diagramKind === 'state-machine' || raw.diagramKind === 'flow';
  if (scope.level === 'L1' && !isBehaviorKind(raw.diagramKind)) {
    issues.push({
      kind: 'behavior-inconsistent',
      message:
        `The agent answered with diagramKind "${raw.diagramKind || '(empty)'}" for a behaviour view instead of one of ` +
        'state-machine, sequence or flow; it is shown as a plain graph.',
    });
  }

  // Two different slugs can sanitise to the same id ("HTTP API" and "http-api"), and
  // they are two different nodes: giving them one id would drop the second and silently
  // re-point its edges at the first, inventing a relation between the wrong pair.
  const idBySlug = new Map<string, string>();
  const takenIds = new Set<string>();
  for (const node of raw.nodes) {
    if (idBySlug.has(node.slug)) continue;
    const base = nodeId(scope, node.slug);
    let id = base;
    for (let n = 2; takenIds.has(id); n += 1) id = `${base}-${n}`;
    takenIds.add(id);
    idBySlug.set(node.slug, id);
  }
  /** How an endpoint is named in an issue: the title the agent gave it, as elsewhere. */
  const nameOfSlug = (slug: string) =>
    raw.nodes.find((n) => n.slug === slug)?.title || idBySlug.get(slug) || slug;

  const nodes: GraphNode[] = [];
  const kept = new Set<string>();
  for (const node of raw.nodes) {
    const id = idBySlug.get(node.slug)!;
    if (kept.has(id)) {
      issues.push({ kind: 'node-dropped', message: `Duplicate node slug "${node.slug}".`, nodeId: id });
      continue;
    }
    const evidence = checkEvidence(facts, node.evidence, { nodeId: id }, issues);
    if (evidence.length === 0) {
      issues.push({
        kind: 'node-dropped',
        message: `Node "${node.title}" was dropped: no evidence pointed at real code.`,
        nodeId: id,
      });
      continue;
    }
    const paths = [
      ...new Set(node.paths.map((p) => facts.normalize(p, true)).filter((p): p is string => p !== null)),
    ];
    const graphNode: GraphNode = {
      id,
      level: scope.level,
      kind: node.kind,
      title: node.title,
      summary: node.summary,
      evidence,
      boundary: node.boundary,
      subsystemId: subsystemLink(node, id, knownSubsystems, issues),
      memberOf: [],
      paths: paths.length > 0 ? paths : [...new Set(evidence.map((e) => e.file))],
      childScope: null,
    };
    graphNode.childScope = node.hasDetail ? childScopeOf(graphNode) : null;
    const role = nodeRole(node, id, roles, issues);
    if (role) graphNode.role = role;
    nodes.push(graphNode);
    kept.add(id);
  }

  // memberOf is resolved after the drop pass, so a membership can never point at a
  // node that did not survive. Several memberships are expected (SPEC §5.1).
  for (const node of raw.nodes) {
    const id = idBySlug.get(node.slug)!;
    const target = nodes.find((n) => n.id === id);
    if (!target) continue;
    for (const slug of node.memberOf) {
      const memberId = idBySlug.get(slug);
      if (!memberId || !kept.has(memberId) || memberId === id) {
        issues.push({
          kind: 'member-dropped',
          message: `Node "${node.title}" claimed membership in unknown node "${slug}".`,
          nodeId: id,
        });
        continue;
      }
      if (!target.memberOf.includes(memberId)) target.memberOf.push(memberId);
    }
  }

  // Endpoints first: a sequence is renumbered over the messages that survive, so a
  // dropped message leaves no gap behind.
  const survivors: Array<{ edge: AgentGraph['edges'][number]; from: string; to: string }> = [];
  for (const edge of raw.edges) {
    const from = idBySlug.get(edge.from);
    const to = idBySlug.get(edge.to);
    if (!from || !to || !kept.has(from) || !kept.has(to)) {
      issues.push({
        kind: 'edge-dropped',
        message: `Edge "${nameOfSlug(edge.from)}" -> "${nameOfSlug(edge.to)}" (${edge.kind}) was dropped: endpoint missing from the validated graph.`,
      });
      continue;
    }
    survivors.push({ edge, from, to });
  }
  const orders = isSequence ? sequenceOrders(survivors.map((s) => s.edge)) : null;
  if (orders?.fixed) {
    issues.push({
      kind: 'sequence-order-fixed',
      message:
        'The message order of the sequence had duplicates, gaps or missing values; the messages were renumbered ' +
        'in the order given, unnumbered ones last.',
    });
  }

  const edges: GraphEdge[] = [];
  const byId = new Map<string, GraphEdge>();
  survivors.forEach(({ edge, from, to }, index) => {
    const order = orders?.assigned[index];
    // Outside a behaviour view the pair and the kind identify a relation, and a second
    // mention is merged into the first. In a behaviour view they do not: the same pair
    // can exchange the same kind of message several times in a sequence (the id carries
    // the position), and two transitions or branches between the same states can fire on
    // different events (the id carries the label), so neither may be merged away.
    const base = edgeId(scope, from, to, edge.kind);
    const id =
      order !== undefined ? `${base}#${order}` : transitionLike && edge.label.trim() ? `${base}#${labelKey(edge.label)}` : base;
    const evidence = checkEvidence(facts, edge.evidence, { edgeId: id }, issues);
    const confirmed = edge.confirmed && evidence.length > 0;
    const why = confirmed
      ? ''
      : edge.confirmed
        ? 'no evidence survived validation against the current code'
        : edge.reason || 'the agent could not confirm this relation';
    const style = messageStyle(edge, id, isSequence, issues);
    const group = isSequence ? (edge.group ?? '').trim() : '';
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        from,
        to,
        kind: edge.kind,
        label: edge.label,
        evidence,
        status: confirmed ? 'confirmed' : 'unverified',
        reason: why,
        ...(order !== undefined ? { order } : {}),
        ...(style ? { style } : {}),
        ...(group ? { group } : {}),
      });
      return;
    }
    // The agent cited the same relation twice. Keep both pieces of evidence rather than
    // dropping the second: the selection context is built from exactly this list.
    for (const ev of evidence) {
      const seen = existing.evidence.some(
        (e) => e.file === ev.file && e.startLine === ev.startLine && e.endLine === ev.endLine,
      );
      if (!seen) existing.evidence.push(ev);
    }
    if (confirmed && existing.status === 'unverified') {
      existing.status = 'confirmed';
      existing.reason = '';
    }
    if (edge.label && !existing.label) existing.label = edge.label;
  });
  // Reported once per surviving edge, after every mention of it has been merged: a
  // relation that any mention confirms is confirmed, and must not also be listed as
  // unverified in the panel the user reads next to the graph.
  for (const edge of byId.values()) {
    edges.push(edge);
    if (edge.status !== 'unverified') continue;
    issues.push({
      kind: 'edge-unverified',
      message: `Edge ${edge.kind} ${edge.from} -> ${edge.to} is unverified: ${edge.reason}.`,
      edgeId: edge.id,
    });
  }

  // A behaviour view with nothing in it is not a result: either the agent should have
  // said so (supported=false with a reason), or every element it sent failed validation.
  if (scope.level === 'L1' && nodes.length === 0) {
    issues.push({
      kind: 'behavior-inconsistent',
      message:
        'The agent reported a supported behaviour view, but no state, participant or step survived validation ' +
        'and no reason was given.',
    });
  }

  return {
    view: {
      scope,
      // A non-L1 reply that said "unsupported" was overruled above; it has no kind of its own.
      diagramKind: raw.diagramKind && raw.diagramKind !== 'unsupported' ? raw.diagramKind : 'component-graph',
      nodes,
      edges,
      notes,
      snapshot,
      behavior,
    },
    issues,
  };
}

/** The part of an edge id that tells two transitions on different events apart. */
function labelKey(label: string): string {
  const safe = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (safe || 'label').slice(0, 48);
}

/**
 * The style of a sequence message, kept only inside a sequence and only when it is one
 * of the known values; anything else would be drawn as something it is not.
 */
function messageStyle(
  edge: AgentGraph['edges'][number],
  id: string,
  isSequence: boolean,
  issues: ValidationIssue[],
): MessageStyle | undefined {
  const style = (edge.style ?? '').trim();
  if (style.length === 0) return undefined;
  if (isSequence && (MESSAGE_STYLES as readonly string[]).includes(style)) return style as MessageStyle;
  issues.push({
    kind: 'style-cleared',
    message: isSequence
      ? `Message style "${style}" is not one of ${MESSAGE_STYLES.join(', ')}; it was cleared.`
      : `Edge style "${style}" is only meaningful in a sequence; it was cleared.`,
    edgeId: id,
  });
  return undefined;
}
