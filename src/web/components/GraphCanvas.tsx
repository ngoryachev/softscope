/**
 * The graph canvas: React Flow with a dagre layout.
 *
 * Two visual rules carry meaning rather than decoration:
 *  - a boundary node is dashed, because it is not code of this repository (SPEC §4.4);
 *  - an `unverified` edge is dashed, muted and labelled, because the relation is not
 *    backed by evidence and must not read as a fact (SPEC §5.4).
 */
import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphView } from '../../shared/graph';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 64;

export interface GraphCanvasProps {
  view: GraphView;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onOpenNode: (id: string) => void;
}

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
      className: [
        'sz-node',
        node.boundary ? 'sz-node-boundary' : '',
        node.childScope ? 'sz-node-openable' : '',
        node.memberOf.length > 1 ? 'sz-node-shared' : '',
      ]
        .filter(Boolean)
        .join(' '),
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

export function GraphCanvas({
  view,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onOpenNode,
}: GraphCanvasProps) {
  const { nodes, edges } = useMemo(() => layout(view), [view]);

  const decorated = nodes.map((n) => ({
    ...n,
    className: `${n.className ?? ''}${n.id === selectedNodeId ? ' sz-node-selected' : ''}`,
  }));
  const decoratedEdges = edges.map((e) => ({
    ...e,
    className: `${e.className ?? ''}${e.id === selectedEdgeId ? ' sz-edge-selected' : ''}`,
    style: e.id === selectedEdgeId ? { ...e.style, strokeWidth: 3 } : e.style,
  }));

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    onSelectEdge(null);
    onSelectNode(node.id);
  };

  return (
    <div className="sz-canvas">
      <ReactFlow
        nodes={decorated}
        edges={decoratedEdges}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={(_event, node) => onOpenNode(node.id)}
        onEdgeClick={(_event, edge) => {
          onSelectNode(null);
          onSelectEdge(edge.id);
        }}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesDraggable
        minZoom={0.2}
      >
        <Background gap={18} color="#e3e8ef" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="sz-legend">
        <span>
          <i className="sz-swatch sz-swatch-node" /> code of this repository
        </span>
        <span>
          <i className="sz-swatch sz-swatch-boundary" /> boundary (outside the repository)
        </span>
        <span>
          <i className="sz-swatch sz-swatch-confirmed" /> confirmed relation
        </span>
        <span>
          <i className="sz-swatch sz-swatch-unverified" /> unverified relation
        </span>
      </div>
    </div>
  );
}
