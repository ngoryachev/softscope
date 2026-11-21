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
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { staysInsideRepo } from '../indexer/files';
import type { AgentEvidence, AgentGraph } from '../../shared/agent-schema';
import type { ValidationIssue } from '../../shared/api';
import {
  childScopeOf,
  edgeId,
  nodeId,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphView,
  type ScopeRef,
  type Snapshot,
} from '../../shared/graph';

export interface ValidateOptions {
  repoPath: string;
  scope: ScopeRef;
  snapshot: Snapshot;
  raw: AgentGraph;
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

export function validateView({ repoPath, scope, snapshot, raw }: ValidateOptions): ValidateResult {
  const facts = new FileFacts(repoPath);
  const issues: ValidationIssue[] = [];

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
      memberOf: [],
      paths: paths.length > 0 ? paths : [...new Set(evidence.map((e) => e.file))],
      childScope: null,
    };
    graphNode.childScope = node.hasDetail ? childScopeOf(graphNode) : null;
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

  const edges: GraphEdge[] = [];
  const byId = new Map<string, GraphEdge>();
  for (const edge of raw.edges) {
    const from = idBySlug.get(edge.from);
    const to = idBySlug.get(edge.to);
    if (!from || !to || !kept.has(from) || !kept.has(to)) {
      issues.push({
        kind: 'edge-dropped',
        message: `Edge ${edge.from} -> ${edge.to} (${edge.kind}) was dropped: endpoint missing from the validated graph.`,
      });
      continue;
    }
    const id = edgeId(scope, from, to, edge.kind);
    const evidence = checkEvidence(facts, edge.evidence, { edgeId: id }, issues);
    const confirmed = edge.confirmed && evidence.length > 0;
    const why = confirmed
      ? ''
      : edge.confirmed
        ? 'no evidence survived validation against the current code'
        : edge.reason || 'the agent could not confirm this relation';
    if (!confirmed) {
      issues.push({
        kind: 'edge-unverified',
        message: `Edge ${edge.kind} ${from} -> ${to} is unverified: ${why}.`,
        edgeId: id,
      });
    }
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
      });
      continue;
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
  }
  edges.push(...byId.values());

  return {
    view: {
      scope,
      diagramKind: raw.diagramKind || 'component-graph',
      nodes,
      edges,
      notes: raw.notes.filter((n) => n.trim().length > 0),
      snapshot,
    },
    issues,
  };
}
