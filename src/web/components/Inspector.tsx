/**
 * Details of the current selection: what it is, which subsystems it belongs to, and the
 * code links that back it up. The structured context it shows is the same
 * `buildSelectionContext` output a later Change Agent will consume (SPEC §8.4).
 */
import { useMemo, useState } from 'react';
import {
  buildSelectionContext,
  edgesOf,
  findNode,
  membersOf,
  subsystemsOf,
  type Evidence,
  type GraphView,
} from '../../shared/graph';

export interface InspectorProps {
  view: GraphView;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onOpenEvidence: (evidence: Evidence) => void;
  onOpenNode: (id: string) => void;
  onSelectNode: (id: string) => void;
}

function EvidenceList({
  evidence,
  onOpen,
}: {
  evidence: Evidence[];
  onOpen: (e: Evidence) => void;
}) {
  if (evidence.length === 0) return <p className="sz-muted">No code links.</p>;
  return (
    <ul className="sz-evidence">
      {evidence.map((e) => (
        <li key={`${e.file}:${e.startLine}-${e.endLine}`}>
          <button type="button" className="sz-link" onClick={() => onOpen(e)}>
            {e.file}:{e.startLine}
            {e.endLine !== e.startLine ? `-${e.endLine}` : ''}
          </button>
          {e.note ? <span className="sz-muted"> — {e.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function Inspector({
  view,
  selectedNodeId,
  selectedEdgeId,
  onOpenEvidence,
  onOpenNode,
  onSelectNode,
}: InspectorProps) {
  const [showContext, setShowContext] = useState(false);
  const node = selectedNodeId ? findNode(view, selectedNodeId) : undefined;
  const edge = selectedEdgeId ? view.edges.find((e) => e.id === selectedEdgeId) : undefined;

  const context = useMemo(
    () =>
      buildSelectionContext(view, {
        nodeIds: selectedNodeId ? [selectedNodeId] : [],
        edgeIds: selectedEdgeId ? [selectedEdgeId] : [],
      }),
    [view, selectedNodeId, selectedEdgeId],
  );

  if (!node && !edge) {
    return (
      <aside className="sz-inspector">
        <h2>{view.scope.label}</h2>
        <p className="sz-muted">
          {view.scope.level} · {view.diagramKind} · {view.nodes.length} nodes, {view.edges.length} relations
        </p>
        <p className="sz-muted">Click a node or a relation. Double-click a node to open it one level deeper.</p>
        {view.notes.length > 0 ? (
          <section>
            <h3>What the analysis could not establish</h3>
            <ul className="sz-notes">
              {view.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    );
  }

  if (edge) {
    return (
      <aside className="sz-inspector">
        <h2>
          {edge.kind}
          {edge.status === 'unverified' ? <span className="sz-badge sz-badge-warn">unverified</span> : null}
        </h2>
        <p className="sz-muted">
          {findNode(view, edge.from)?.title ?? edge.from} → {findNode(view, edge.to)?.title ?? edge.to}
        </p>
        {edge.status === 'unverified' ? <p className="sz-warn">{edge.reason}</p> : null}
        <section>
          <h3>Code</h3>
          <EvidenceList evidence={edge.evidence} onOpen={onOpenEvidence} />
        </section>
      </aside>
    );
  }

  const owners = subsystemsOf(view, node!);
  const children = membersOf(view, node!);
  const related = edgesOf(view, node!.id);

  return (
    <aside className="sz-inspector">
      <h2>
        {node!.title}
        {node!.boundary ? <span className="sz-badge">boundary</span> : null}
      </h2>
      <p className="sz-muted">{node!.kind}</p>
      <p>{node!.summary || <span className="sz-muted">No description.</span>}</p>

      {node!.childScope ? (
        <button type="button" className="sz-button" onClick={() => onOpenNode(node!.id)}>
          Open {node!.childScope.level} of {node!.title}
        </button>
      ) : null}

      {owners.length > 0 ? (
        <section>
          <h3>Belongs to</h3>
          <div className="sz-chips">
            {owners.map((o) => (
              <button key={o.id} type="button" className="sz-chip" onClick={() => onSelectNode(o.id)}>
                {o.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {children.length > 0 ? (
        <section>
          <h3>Contains</h3>
          <div className="sz-chips">
            {children.map((c) => (
              <button key={c.id} type="button" className="sz-chip" onClick={() => onSelectNode(c.id)}>
                {c.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3>Code</h3>
        <EvidenceList evidence={node!.evidence} onOpen={onOpenEvidence} />
      </section>

      {related.length > 0 ? (
        <section>
          <h3>Relations</h3>
          <ul className="sz-relations">
            {related.map((e) => (
              <li key={e.id}>
                {e.from === node!.id ? '→ ' : '← '}
                {findNode(view, e.from === node!.id ? e.to : e.from)?.title}
                <span className="sz-muted"> ({e.kind})</span>
                {e.status === 'unverified' ? <span className="sz-badge sz-badge-warn">unverified</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <button type="button" className="sz-link" onClick={() => setShowContext((v) => !v)}>
          {showContext ? 'Hide' : 'Show'} context for an AI change ({context.files.length} files)
        </button>
        {showContext ? <pre className="sz-context">{JSON.stringify(context, null, 2)}</pre> : null}
      </section>
    </aside>
  );
}
