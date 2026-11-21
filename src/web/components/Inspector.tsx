/**
 * Details of the focused item — the node or relation clicked last: what it is, which
 * subsystems it belongs to, and the code links that back it up. The selection basket
 * and the structured context built from it live in the ContextPanel next door.
 */
import { edgesOf, findNode, membersOf, subsystemsOf, type Evidence, type GraphView } from '../../shared/graph';
import type { SelectableRef } from './GraphCanvas';

export interface InspectorProps {
  view: GraphView;
  /** The view this one was opened from, when there is one: names the linked subsystems. */
  parentView?: GraphView | null;
  /** The item clicked last; null shows the scope itself. */
  focused: SelectableRef | null;
  onOpenEvidence: (evidence: Evidence) => void;
  onOpenNode: (id: string) => void;
  onSelectNode: (id: string) => void;
  /** A boundary node names the subsystem it belongs to; this takes the user there. */
  onGoToSubsystem?: (subsystemId: string) => void;
}

/** The title of a sibling subsystem, or the readable tail of its id when the view is not at hand. */
function subsystemTitle(parentView: GraphView | null | undefined, id: string): string {
  const found = parentView ? findNode(parentView, id) : undefined;
  if (found) return found.title;
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
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
  parentView,
  focused,
  onOpenEvidence,
  onOpenNode,
  onSelectNode,
  onGoToSubsystem,
}: InspectorProps) {
  const node = focused?.kind === 'node' ? findNode(view, focused.id) : undefined;
  const edge = focused?.kind === 'edge' ? view.edges.find((e) => e.id === focused.id) : undefined;

  if (!node && !edge) {
    return (
      <aside className="sz-inspector">
        <h2>{view.scope.label}</h2>
        <p className="sz-muted">
          {view.scope.level} · {view.diagramKind} · {view.nodes.length} nodes, {view.edges.length} relations
        </p>
        <p className="sz-muted">
          Click a node or a relation to inspect it. Shift/Ctrl+click or drag a rectangle to select several for the
          context. Double-click a node to open it one level deeper.
        </p>
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

      {node!.boundary && node!.subsystemId ? (
        <button type="button" className="sz-button" onClick={() => onGoToSubsystem?.(node!.subsystemId)}>
          Go to subsystem {subsystemTitle(parentView, node!.subsystemId)}
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
    </aside>
  );
}
