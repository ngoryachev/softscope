/**
 * The graph canvas: React Flow with a dagre layout.
 *
 * Two visual rules carry meaning rather than decoration:
 *  - a boundary node is dashed, because it is not code of this repository (SPEC §4.4);
 *  - an `unverified` edge is dashed, muted and labelled, because the relation is not
 *    backed by evidence and must not read as a fact (SPEC §5.4).
 *
 * Selection (SPEC §6.3, FR-07): a plain click replaces this level's selection and
 * focuses the item, Shift/Ctrl/Cmd+click toggles it, a left-drag on the pane draws a
 * marquee that adds the covered nodes. Items in the basket are tinted
 * (`sz-node-selected` / `sz-edge-selected`); the focused item — the one the inspector
 * shows — has the stronger outline (`sz-node-focused` / `sz-edge-focused`).
 *
 * React Flow only applies a marquee to nodes it owns, so the canvas keeps the laid-out
 * nodes and edges in local state, re-seeded when the view changes, and mirrors the
 * basket into their `selected` flags one way. The marquee is read from the `select`
 * changes React Flow dispatches between `onSelectionStart` and `onSelectionEnd`, and only
 * ever adds: React Flow's own deselects (a pane click, the start of a new rectangle) do
 * not empty the basket behind the user's back. `onSelectionChange` is deliberately not
 * used — it also reports the selection a click produces, and a click has its own
 * semantics (replace or toggle), so that path would re-add a node the user just
 * Shift+clicked out of the basket.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
  type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphView } from '../../shared/graph';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 64;

export type SelectableKind = 'node' | 'edge';

export interface SelectableRef {
  kind: SelectableKind;
  id: string;
}

/** The context basket: ids of every selected node and relation, across levels. */
export interface Basket {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}

export interface GraphCanvasProps {
  view: GraphView;
  basket: Basket;
  focused: SelectableRef | null;
  /** A click on a node or relation; `toggle` when Shift, Ctrl or Cmd was held. */
  onSelect: (item: SelectableRef, options: { toggle: boolean }) => void;
  /** The nodes a marquee covers; they are added to the basket. */
  onMarquee: (nodeIds: string[]) => void;
  /** A click on the empty pane. */
  onClearFocus: () => void;
  onOpenNode: (id: string) => void;
}

const nodeClass = (view: GraphView, id: string): string => {
  const node = view.nodes.find((n) => n.id === id);
  if (!node) return 'sz-node';
  return [
    'sz-node',
    node.boundary ? 'sz-node-boundary' : '',
    node.childScope ? 'sz-node-openable' : '',
    node.memberOf.length > 1 ? 'sz-node-shared' : '',
  ]
    .filter(Boolean)
    .join(' ');
};

function layout(view: GraphView): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of view.nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of view.edges) {
    if (edge.from !== edge.to) g.setEdge(edge.from, edge.to);
  }
  // Membership is drawn as a layout hint only: a node sits near the subsystems it
  // belongs to, without a visible edge, because memberOf is not a relation in the code.
  for (const node of view.nodes) {
    for (const owner of node.memberOf) {
      if (g.hasNode(owner)) g.setEdge(owner, node.id);
    }
  }
  dagre.layout(g);

  const nodes: Node[] = view.nodes.map((node) => {
    const position = g.node(node.id) as { x: number; y: number } | undefined;
    return {
      id: node.id,
      position: {
        x: (position?.x ?? 0) - NODE_WIDTH / 2,
        y: (position?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { label: node.title },
      type: 'default',
      className: nodeClass(view, node.id),
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
    };
  });

  const edges: Edge[] = view.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.label || edge.kind,
    className: edge.status === 'unverified' ? 'sz-edge sz-edge-unverified' : 'sz-edge',
    animated: false,
    style:
      edge.status === 'unverified'
        ? { stroke: '#b2893f', strokeDasharray: '6 4', strokeWidth: 1.5 }
        : { stroke: '#5b6b7f', strokeWidth: 1.5 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.status === 'unverified' ? '#b2893f' : '#5b6b7f',
      width: 16,
      height: 16,
    },
    labelStyle: { fontSize: 11, fill: edge.status === 'unverified' ? '#8a6a28' : '#44536a' },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.85 },
  }));

  return { nodes, edges };
}

/**
 * The legend reads differently per diagram kind (SPEC §5.3): in a data-flow an arrow is
 * data moving and its label says what moves. Below L4 a boundary node may well be code of
 * this repository that lives in another area, so the legend does not call it external.
 */
function Legend({ view }: { view: GraphView }) {
  const dataFlow = view.diagramKind === 'data-flow';
  const atTop = view.scope.level === 'L4';
  return (
    <div className="sz-legend">
      <span>
        <i className="sz-swatch sz-swatch-node" /> {atTop ? 'code of this repository' : 'code of this area'}
      </span>
      <span>
        <i className="sz-swatch sz-swatch-boundary" /> {atTop ? 'boundary (outside the repository)' : 'boundary (outside this area)'}
      </span>
      {dataFlow ? (
        <span>
          <i className="sz-swatch sz-swatch-confirmed" /> arrow = data passed, label = what is passed
        </span>
      ) : (
        <span>
          <i className="sz-swatch sz-swatch-confirmed" /> confirmed relation
        </span>
      )}
      <span>
        <i className="sz-swatch sz-swatch-unverified" /> {dataFlow ? 'unverified data flow' : 'unverified relation'}
      </span>
      <span className="sz-legend-hint">click: select · Shift/Ctrl+click: add · drag: marquee · double-click: open</span>
    </div>
  );
}

const isToggle = (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
  event.shiftKey || event.ctrlKey || event.metaKey;

/** The multi-selection keys React Flow honours, matching the toggle modifiers above. */
const MULTI_SELECT_KEYS = ['Shift', 'Control', 'Meta'];

export function GraphCanvas({ view, basket, focused, onSelect, onMarquee, onClearFocus, onOpenNode }: GraphCanvasProps) {
  const layouted = useMemo(() => layout(view), [view]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(layouted.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(layouted.edges);
  // The latest basket, for the re-seed: it must not re-run on every basket change, or a
  // node the user dragged would jump back to its laid-out position.
  const basketRef = useRef(basket);
  basketRef.current = basket;
  /** A selection rectangle is being drawn: `select` changes arriving now are the marquee. */
  const marquee = useRef(false);
  // The latest local nodes, for the reconciliation at the end of a marquee.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    const b = basketRef.current;
    setNodes(layouted.nodes.map((n) => ({ ...n, selected: b.nodeIds.has(n.id) })));
    setEdges(layouted.edges.map((e) => ({ ...e, selected: b.edgeIds.has(e.id) })));
  }, [layouted, setNodes, setEdges]);

  // One-way mirror of the basket into React Flow's own selection flags, so that a
  // Shift+click on a basket node reads as a deselect there too. Not while a rectangle is
  // being drawn: React Flow's selection is read at its end, and must stay its own until then.
  const mirror = useCallback(
    (b: Basket, extraNodeIds: ReadonlySet<string> = new Set()) => {
      setNodes((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          const selected = b.nodeIds.has(n.id) || extraNodeIds.has(n.id);
          if ((n.selected ?? false) === selected) return n;
          changed = true;
          return { ...n, selected };
        });
        return changed ? next : prev;
      });
      setEdges((prev) => {
        let changed = false;
        const next = prev.map((e) => {
          const selected = b.edgeIds.has(e.id);
          if ((e.selected ?? false) === selected) return e;
          changed = true;
          return { ...e, selected };
        });
        return changed ? next : prev;
      });
    },
    [setNodes, setEdges],
  );
  useEffect(() => {
    if (!marquee.current) mirror(basket);
  }, [basket, mirror]);

  const decorated = nodes.map((n) => {
    const inBasket = basket.nodeIds.has(n.id);
    const isFocused = focused?.kind === 'node' && focused.id === n.id;
    return {
      ...n,
      className: `${nodeClass(view, n.id)}${inBasket ? ' sz-node-selected' : ''}${isFocused ? ' sz-node-focused' : ''}`,
    };
  });
  const decoratedEdges = edges.map((e) => {
    const inBasket = basket.edgeIds.has(e.id);
    const isFocused = focused?.kind === 'edge' && focused.id === e.id;
    const base = e.className?.replace(/ sz-edge-(selected|focused)/g, '') ?? 'sz-edge';
    return {
      ...e,
      className: `${base}${inBasket ? ' sz-edge-selected' : ''}${isFocused ? ' sz-edge-focused' : ''}`,
      style: isFocused ? { ...e.style, strokeWidth: 3 } : inBasket ? { ...e.style, strokeWidth: 2.5 } : e.style,
    };
  });

  // A click of any kind means no rectangle is being drawn: a pointer cancel (touch, a
  // window losing focus) ends a marquee without `onSelectionEnd`, so the flag is also
  // cleared here rather than left on until the next rectangle.
  const handleNodeClick: NodeMouseHandler = (event, node) => {
    marquee.current = false;
    // The second click of a double-click: the first one already applied the click rule, and
    // the double-click itself (onNodeDoubleClick) undoes that rule and opens the node.
    if (event.detail > 1) return;
    onSelect({ kind: 'node', id: node.id }, { toggle: isToggle(event) });
  };
  const handleEdgeClick: EdgeMouseHandler = (event, edge) => {
    marquee.current = false;
    onSelect({ kind: 'edge', id: edge.id }, { toggle: isToggle(event) });
  };
  const handlePaneClick = () => {
    marquee.current = false;
    onClearFocus();
  };
  // Until React Flow has measured a node it treats it as inside any rectangle, so a marquee
  // drawn right after a view appears would take every node. Only measured nodes count.
  const measuredIn = (list: Node[]) => new Set(list.filter((n) => n.measured?.width).map((n) => n.id));
  // React Flow dispatches the rectangle's `select` changes synchronously while the pointer
  // moves, so every one of them arrives while `marquee` is set. Nodes only: the rectangle
  // also selects the edges between covered nodes, which is not what the user drew —
  // relations enter the basket by click. Deselects are ignored: the basket only grows here.
  const handleNodesChange: OnNodesChange<Node> = (changes) => {
    onNodesChange(changes);
    if (!marquee.current) return;
    const measured = measuredIn(nodes);
    const ids = changes.flatMap((c) =>
      c.type === 'select' && c.selected && measured.has(c.id) && !basket.nodeIds.has(c.id) ? [c.id] : [],
    );
    if (ids.length > 0) onMarquee(ids);
  };
  // A node measured only while the rectangle was already over it got its `select` change
  // before it counted; what React Flow holds selected at the end settles it.
  const handleSelectionEnd = () => {
    marquee.current = false;
    const measured = measuredIn(nodesRef.current);
    const ids = nodesRef.current
      .filter((n) => n.selected && measured.has(n.id) && !basket.nodeIds.has(n.id))
      .map((n) => n.id);
    if (ids.length > 0) onMarquee(ids);
    mirror(basket, new Set(ids));
  };

  return (
    <div className="sz-canvas">
      <ReactFlow
        nodes={decorated}
        edges={decoratedEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={(_event, node) => onOpenNode(node.id)}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onSelectionStart={() => {
          marquee.current = true;
        }}
        onSelectionEnd={handleSelectionEnd}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        selectNodesOnDrag={false}
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        fitView
        proOptions={{ hideAttribution: true }}
        // The canvas owns its node state now, so React Flow's Backspace/Delete handling
        // would really remove a selected node from the diagram. The schema is read-only.
        deleteKeyCode={null}
        nodesConnectable={false}
        nodesDraggable
        minZoom={0.2}
      >
        <Background gap={18} color="#e3e8ef" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <Legend view={view} />
    </div>
  );
}
