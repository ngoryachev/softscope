/**
 * The selection basket and the structured context built from it (SPEC §6.3, §8.4,
 * FR-07, FR-08, FR-12): what is selected across levels, how large the code behind it
 * is, which relations it has inside and outside, where a change may go, and against
 * which repository state all of that holds. Copy as Markdown or JSON hands it to an AI;
 * the instruction field and **Run** hand it to SoftZoom's own change agent (SPEC §6.4).
 *
 * The context is computed here with the same `buildSelectionContext` the server uses
 * for `POST /api/context`, over every view loaded since the repository was opened.
 */
import { useMemo, useRef, useState } from 'react';
import {
  buildSelectionContext,
  findNode,
  levelTitle,
  viewKey,
  viewKeyOfId,
  type ContextRelation,
  type Evidence,
  type ExpandDirection,
  type GraphView,
  type Level,
  type Snapshot,
} from '../../shared/graph';
import { formatRange, renderContextMarkdown } from '../../shared/context-markdown';
import type { Basket, SelectableRef } from './GraphCanvas';

export interface ContextPanelProps {
  /** Every view loaded for the open repository, the current one included. */
  views: GraphView[];
  currentView: GraphView | null;
  basket: Basket;
  live: Snapshot | null;
  onRemove: (item: SelectableRef) => void;
  onClear: () => void;
  onExpand: (direction: ExpandDirection) => void;
  onOpenEvidence: (evidence: Evidence) => void;
  /** Show the item in the inspector, navigating to its view when that is another one. */
  onFocus: (item: SelectableRef) => void;
  /** Why Run is disabled (no git, a change already open); null when it can run. Absent: no Run at all. */
  runDisabledReason?: string | null;
  /** Starts a change over the basket with this instruction (SPEC §6.4). */
  onRun?: (task: string) => void;
}

interface BasketItem extends SelectableRef {
  level: Level | null;
  scopeLabel: string;
  title: string;
  /** The kind of a node, or `from → to` of a relation. */
  detail: string;
  /** False when the owning view is not loaded or the item is gone from it. */
  resolved: boolean;
}

const COPIED_MS = 1500;

/** The view an id belongs to among the loaded ones: by the id's own naming, else by search. */
export function ownerView(views: GraphView[], item: SelectableRef): GraphView | undefined {
  const key = viewKeyOfId(item.id);
  if (key) return views.find((v) => viewKey(v.scope.level, v.scope.id) === viewKey(key.level, key.scopeId));
  return views.find((v) =>
    item.kind === 'node' ? v.nodes.some((n) => n.id === item.id) : v.edges.some((e) => e.id === item.id),
  );
}

function describeItem(views: GraphView[], item: SelectableRef): BasketItem {
  const view = ownerView(views, item);
  const key = viewKeyOfId(item.id);
  const level = view?.scope.level ?? key?.level ?? null;
  const scopeLabel = view?.scope.label ?? key?.scopeId ?? '';
  if (!view) return { ...item, level, scopeLabel, title: item.id, detail: 'not loaded', resolved: false };
  if (item.kind === 'node') {
    const node = findNode(view, item.id);
    return node
      ? { ...item, level, scopeLabel, title: node.title, detail: node.kind, resolved: true }
      : { ...item, level, scopeLabel, title: item.id, detail: 'no longer in this view', resolved: false };
  }
  const edge = view.edges.find((e) => e.id === item.id);
  if (!edge) return { ...item, level, scopeLabel, title: item.id, detail: 'no longer in this view', resolved: false };
  const from = findNode(view, edge.from)?.title ?? edge.from;
  const to = findNode(view, edge.to)?.title ?? edge.to;
  return { ...item, level, scopeLabel, title: edge.kind, detail: `${from} → ${to}`, resolved: true };
}

interface Group {
  level: Level | null;
  scopeLabel: string;
  items: BasketItem[];
}

function groupItems(items: BasketItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const group = groups.find((g) => g.level === item.level && g.scopeLabel === item.scopeLabel);
    if (group) group.items.push(item);
    else groups.push({ level: item.level, scopeLabel: item.scopeLabel, items: [item] });
  }
  const order = (l: Level | null) => (l ? ['L4', 'L3', 'L2', 'L1'].indexOf(l) : 9);
  return groups.sort((a, b) => order(a.level) - order(b.level) || a.scopeLabel.localeCompare(b.scopeLabel));
}

/** Relations arrive from `buildSelectionContext` already in reading order: a sequence's messages by `#order`. */
function RelationList({ relations }: { relations: ContextRelation[] }) {
  if (relations.length === 0) return <p className="sz-muted">None.</p>;
  return (
    <ul className="sz-relations">
      {relations.map((r) => (
        <li key={r.id}>
          {r.order !== undefined ? <span className="sz-muted">#{r.order} </span> : null}
          {r.from.title} → {r.to.title}
          <span className="sz-muted"> ({[r.kind, r.label, r.style].filter(Boolean).join(', ')})</span>{' '}
          {r.status === 'unverified' ? (
            <span className="sz-badge sz-badge-warn" title={r.reason}>
              unverified
            </span>
          ) : (
            <span className="sz-badge sz-badge-ok">confirmed</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ContextPanel({
  views,
  currentView,
  basket,
  live,
  onRemove,
  onClear,
  onExpand,
  onOpenEvidence,
  onFocus,
  runDisabledReason,
  onRun,
}: ContextPanelProps) {
  const [direction, setDirection] = useState<ExpandDirection>('both');
  const [copied, setCopied] = useState<'markdown' | 'json' | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [task, setTask] = useState('');

  const nodeIds = [...basket.nodeIds];
  const edgeIds = [...basket.edgeIds];
  // Keyed by content, not by identity: a new Set with the same ids, or the fresh snapshot
  // object every poll tick delivers, must not recompute the context.
  const nodeKey = nodeIds.join('\n');
  const edgeKey = edgeIds.join('\n');
  const liveKey = live ? `${live.stateId}@${live.branch}` : '';
  const liveRef = useRef(live);
  liveRef.current = live;
  const context = useMemo(
    () => {
      const current = liveRef.current;
      return buildSelectionContext(
        views,
        { nodeIds: nodeKey ? nodeKey.split('\n') : [], edgeIds: edgeKey ? edgeKey.split('\n') : [] },
        current ? { live: current } : {},
      );
    },
    // liveKey stands for the live snapshot: see above.
    [views, liveKey, nodeKey, edgeKey],
  );

  const items: BasketItem[] = [
    ...nodeIds.map((id) => describeItem(views, { kind: 'node', id })),
    ...edgeIds.map((id) => describeItem(views, { kind: 'edge', id })),
  ];
  const groups = groupItems(items);
  const count = items.length;
  const canExpand = currentView !== null && currentView.nodes.some((n) => basket.nodeIds.has(n.id));
  // Run needs something selected and a server that can make changes; the reason is shown.
  const runBlocked = count === 0 ? 'Select something first.' : runDisabledReason ?? null;
  const canRun = onRun !== undefined && runBlocked === null && task.trim().length > 0;

  const copy = (kind: 'markdown' | 'json') => {
    const text = kind === 'markdown' ? renderContextMarkdown(context) : JSON.stringify(context, null, 2);
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setFallback(text);
      return;
    }
    clipboard
      .writeText(text)
      .then(() => {
        setFallback(null);
        setCopied(kind);
        window.setTimeout(() => setCopied((c) => (c === kind ? null : c)), COPIED_MS);
      })
      .catch(() => setFallback(text));
  };

  return (
    <aside className="sz-context-panel">
      <header className="sz-context-head">
        <h2>
          Context <span className="sz-muted">({count} {count === 1 ? 'item' : 'items'})</span>
        </h2>
        <button type="button" className="sz-button" disabled={count === 0} onClick={onClear}>
          Clear
        </button>
      </header>

      {count === 0 ? (
        <p className="sz-muted">
          Nothing selected. Click a node or a relation; Shift/Ctrl+click adds, dragging a rectangle adds the nodes it
          covers. Items picked on other levels stay here while you navigate.
        </p>
      ) : null}

      <div className="sz-expand">
        <label>
          Expand with dependencies{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as ExpandDirection)}>
            <option value="in">incoming</option>
            <option value="out">outgoing</option>
            <option value="both">both</option>
          </select>
        </label>
        <button type="button" className="sz-button" disabled={!canExpand} onClick={() => onExpand(direction)}>
          Expand
        </button>
      </div>

      {context.warnings.length > 0 ? (
        <ul className="sz-context-warnings">
          {context.warnings.map((w) => (
            <li key={w} className="sz-warn">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {groups.map((g) => (
        <section key={`${g.level ?? '?'}:${g.scopeLabel}`}>
          <h3>
            {g.level ? `${g.level} · ${levelTitle(g.level)}` : 'Unknown level'}
            {g.scopeLabel ? <span className="sz-muted"> · {g.scopeLabel}</span> : null}
          </h3>
          <ul className="sz-basket">
            {g.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className={`sz-basket-item${item.resolved ? '' : ' sz-basket-unresolved'}`}>
                <button
                  type="button"
                  className="sz-link sz-basket-title"
                  disabled={!item.resolved}
                  title={item.resolved ? 'Show in its view' : undefined}
                  onClick={() => onFocus(item)}
                >
                  {item.title}
                </button>
                <span className="sz-muted sz-basket-detail">{item.detail}</span>
                <button
                  type="button"
                  className="sz-remove"
                  aria-label={`Remove ${item.title}`}
                  title="Remove from context"
                  onClick={() => onRemove(item)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {count > 0 ? (
        <>
          <section>
            <h3>Size</h3>
            <p>
              {context.size.files} {context.size.files === 1 ? 'file' : 'files'} · {context.size.lines}{' '}
              {context.size.lines === 1 ? 'line' : 'lines'}
            </p>
          </section>

          <section>
            <h3>Files</h3>
            {context.files.length === 0 ? (
              <p className="sz-muted">No code links.</p>
            ) : (
              <ul className="sz-evidence">
                {context.files.flatMap((f) =>
                  f.ranges.map((r) => (
                    <li key={formatRange(f.file, r)}>
                      <button
                        type="button"
                        className="sz-link"
                        onClick={() => onOpenEvidence({ file: f.file, startLine: r.startLine, endLine: r.endLine })}
                      >
                        {formatRange(f.file, r)}
                      </button>
                    </li>
                  )),
                )}
              </ul>
            )}
          </section>

          <section>
            <h3>Internal relations</h3>
            <RelationList relations={context.relations.internal} />
          </section>

          <section>
            <h3>External relations</h3>
            <RelationList relations={context.relations.external} />
          </section>

          {onRun ? (
            <section className="sz-run">
              <h3>Instruction</h3>
              <textarea
                className="sz-run-task"
                rows={3}
                placeholder="What should change in the selected area? e.g. add a request id to every log line"
                value={task}
                disabled={runBlocked !== null}
                onChange={(e) => setTask(e.target.value)}
              />
              <div className="sz-run-row">
                <button
                  type="button"
                  className="sz-button sz-button-primary"
                  disabled={!canRun}
                  title={runBlocked ?? (task.trim() ? undefined : 'Type an instruction first')}
                  onClick={() => {
                    const trimmed = task.trim();
                    if (!trimmed) return;
                    onRun(trimmed);
                    setTask('');
                  }}
                >
                  Run
                </button>
                {runBlocked ? (
                  <span className="sz-muted sz-run-reason">{runBlocked}</span>
                ) : (
                  <span className="sz-muted sz-run-reason">
                    The agent edits an isolated copy; you review the diff before anything touches your files.
                  </span>
                )}
              </div>
            </section>
          ) : null}

          <section>
            <h3>Change limits</h3>
            {context.limits.paths.length === 0 ? (
              <p className="sz-muted">No paths.</p>
            ) : (
              <ul className="sz-paths">
                {context.limits.paths.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="sz-copy">
            <button type="button" className="sz-button" onClick={() => copy('markdown')}>
              Copy as Markdown
            </button>
            <button type="button" className="sz-button" onClick={() => copy('json')}>
              Copy as JSON
            </button>
            {copied ? <span className="sz-copied">Copied</span> : null}
          </div>
          {fallback !== null ? (
            <div className="sz-copy-fallback">
              <p className="sz-warn">Clipboard unavailable — copy from the box.</p>
              <textarea readOnly value={fallback} rows={8} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="sz-link" onClick={() => setFallback(null)}>
                Hide
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
