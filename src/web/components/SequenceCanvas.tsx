/**
 * The sequence canvas of a behaviour view (L1, SPEC §5.3): participants as boxes across
 * the top, a lifeline under each, and the messages top to bottom in their `order`.
 *
 * Plain SVG, no React Flow: lifelines are not a graph layout, and the geometry is a
 * function of the counts alone, so the canvas renders on the server as well as in the
 * browser (no measuring, no DOM at render time).
 *
 * What the marks mean:
 *  - a dashed participant box is a boundary — code outside this entity (SPEC §4.4);
 *  - a solid line with a filled head is a synchronous call, an open head an asynchronous
 *    one, a dashed line a return;
 *  - an `unverified` message is dotted in the warn colour: not backed by evidence that
 *    survived validation (SPEC §5.4);
 *  - a labelled band spanning consecutive messages is a branch or loop (`group`).
 *
 * Selection follows the graph canvas: a click selects (replace), Shift/Ctrl/Cmd+click
 * toggles; there is no marquee here.
 */
import type { MouseEvent } from 'react';
import { findNode, sequenceOrdered, type GraphEdge, type GraphView } from '../../shared/graph';
import type { Basket, SelectableRef } from './GraphCanvas';

export interface SequenceCanvasProps {
  view: GraphView;
  basket: Basket;
  focused: SelectableRef | null;
  onSelect: (item: SelectableRef, options: { toggle: boolean }) => void;
  /** A click on the empty background. */
  onClearFocus: () => void;
}

const COLUMN = 190;
const LEFT = 30;
const BOX_WIDTH = 150;
const BOX_HEIGHT = 44;
const BOX_TOP = 16;
const FIRST_MESSAGE_Y = BOX_TOP + BOX_HEIGHT + 44;
const ROW = 46;
const GROUP_HEAD = 22;
const GROUP_TAIL = 12;
const SELF_LOOP = 44;
const BOTTOM = 40;

const CONFIRMED = '#5b6b7f';
const UNVERIFIED = '#b2893f';

const isToggle = (event: MouseEvent) => event.shiftKey || event.ctrlKey || event.metaKey;

interface Placed {
  edge: GraphEdge;
  y: number;
}

interface Band {
  label: string;
  top: number;
  bottom: number;
}

/** Messages with their y position, and the bands of consecutive messages sharing a group. */
function place(view: GraphView): { messages: Placed[]; bands: Band[]; height: number } {
  const messages: Placed[] = [];
  const bands: Band[] = [];
  let y = FIRST_MESSAGE_Y;
  let open: Band | null = null;
  for (const edge of sequenceOrdered(view)) {
    const group = edge.group ?? '';
    if (open && open.label !== group) {
      open.bottom = y - ROW / 2 + GROUP_TAIL / 2;
      y += GROUP_TAIL;
      open = null;
    }
    if (group && !open) {
      open = { label: group, top: y - ROW / 2 + 6, bottom: 0 };
      bands.push(open);
      y += GROUP_HEAD;
    }
    messages.push({ edge, y });
    y += edge.from === edge.to ? ROW + SELF_LOOP / 2 : ROW;
  }
  if (open) {
    open.bottom = y - ROW / 2 + GROUP_TAIL / 2;
    y += GROUP_TAIL;
  }
  return { messages, bands, height: y + BOTTOM };
}

export function SequenceCanvas({ view, basket, focused, onSelect, onClearFocus }: SequenceCanvasProps) {
  const columns = new Map<string, number>();
  view.nodes.forEach((node, i) => columns.set(node.id, LEFT + i * COLUMN + BOX_WIDTH / 2));
  const { messages, bands, height } = place(view);
  const width = Math.max(LEFT * 2 + Math.max(view.nodes.length, 1) * COLUMN, 320);

  const select = (event: MouseEvent, item: SelectableRef) => {
    event.stopPropagation();
    onSelect(item, { toggle: isToggle(event) });
  };
  const stateClasses = (item: SelectableRef) => {
    const inBasket = (item.kind === 'node' ? basket.nodeIds : basket.edgeIds).has(item.id);
    const isFocused = focused?.kind === item.kind && focused.id === item.id;
    return `${inBasket ? ' sz-seq-selected' : ''}${isFocused ? ' sz-seq-focused' : ''}`;
  };

  return (
    <div className="sz-canvas sz-sequence">
      <svg
        className="sz-seq-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Sequence diagram of ${view.scope.label}`}
        onClick={onClearFocus}
      >
        <defs>
          <marker id="sz-seq-head-filled" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={CONFIRMED} />
          </marker>
          <marker id="sz-seq-head-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke={CONFIRMED} strokeWidth="1.5" />
          </marker>
          <marker id="sz-seq-head-filled-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={UNVERIFIED} />
          </marker>
          <marker id="sz-seq-head-open-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke={UNVERIFIED} strokeWidth="1.5" />
          </marker>
        </defs>

        {bands.map((band) => (
          <g key={`${band.label}@${band.top}`} className="sz-seq-group">
            <rect x={LEFT - 12} y={band.top} width={width - LEFT * 2 + 24} height={band.bottom - band.top} rx={4} />
            <text x={LEFT - 4} y={band.top + 14} className="sz-seq-group-label">
              {band.label}
            </text>
          </g>
        ))}

        {view.nodes.map((node) => {
          const x = columns.get(node.id)!;
          const item: SelectableRef = { kind: 'node', id: node.id };
          return (
            <g
              key={node.id}
              className={`sz-seq-participant${node.boundary ? ' sz-seq-boundary' : ''}${stateClasses(item)}`}
              onClick={(e) => select(e, item)}
            >
              <line className="sz-seq-lifeline" x1={x} y1={BOX_TOP + BOX_HEIGHT} x2={x} y2={height - BOTTOM / 2} />
              <rect
                className="sz-seq-box"
                x={x - BOX_WIDTH / 2}
                y={BOX_TOP}
                width={BOX_WIDTH}
                height={BOX_HEIGHT}
                rx={7}
                strokeDasharray={node.boundary ? '6 4' : undefined}
              />
              <text x={x} y={BOX_TOP + BOX_HEIGHT / 2 + 4} textAnchor="middle" className="sz-seq-title">
                {node.title}
              </text>
              <title>{`${node.title}${node.boundary ? ' (boundary)' : ''}: ${node.summary}`}</title>
            </g>
          );
        })}

        {messages.map(({ edge, y }) => {
          const x1 = columns.get(edge.from) ?? LEFT;
          const x2 = columns.get(edge.to) ?? LEFT;
          const unverified = edge.status === 'unverified';
          const style = edge.style ?? 'sync';
          const colour = unverified ? UNVERIFIED : CONFIRMED;
          const head = `url(#sz-seq-head-${style === 'sync' ? 'filled' : 'open'}${unverified ? '-warn' : ''})`;
          const dash = unverified ? '2 4' : style === 'return' ? '8 4' : undefined;
          const item: SelectableRef = { kind: 'edge', id: edge.id };
          const label = `${edge.order !== undefined ? `${edge.order}. ` : ''}${edge.label || edge.kind}${unverified ? ' (unverified)' : ''}`;
          const self = edge.from === edge.to;
          const direction = x2 >= x1 ? 1 : -1;
          // The head sits at the target lifeline; the line stops just short of it.
          const xEnd = self ? x1 : x2 - direction * 3;
          const path = self
            ? `M ${x1} ${y} H ${x1 + SELF_LOOP} V ${y + SELF_LOOP / 2} H ${x1 + 3}`
            : `M ${x1} ${y} H ${xEnd}`;
          const labelX = self ? x1 + 8 : (x1 + x2) / 2;
          const labelAnchor = self ? 'start' : 'middle';
          return (
            <g
              key={edge.id}
              className={`sz-seq-message sz-seq-${style}${unverified ? ' sz-seq-unverified' : ''}${stateClasses(item)}`}
              onClick={(e) => select(e, item)}
            >
              <path className="sz-seq-hit" d={path} fill="none" stroke="transparent" strokeWidth={14} />
              <path className="sz-seq-line" d={path} fill="none" stroke={colour} strokeWidth={1.5} strokeDasharray={dash} markerEnd={head} />
              <text x={labelX} y={y - 6} textAnchor={labelAnchor} className="sz-seq-label" fill={unverified ? '#8a6a28' : '#44536a'}>
                {label}
              </text>
              <title>{unverified ? `${label}: ${edge.reason}` : label}</title>
            </g>
          );
        })}
      </svg>
      <div className="sz-legend">
        <span>
          <i className="sz-swatch sz-swatch-node" /> participant
        </span>
        <span>
          <i className="sz-swatch sz-swatch-boundary" /> boundary participant (outside this entity)
        </span>
        <span>
          <i className="sz-swatch sz-swatch-confirmed" /> sync call (filled head)
        </span>
        <span>
          <i className="sz-swatch sz-swatch-async" /> async message (open head)
        </span>
        <span>
          <i className="sz-swatch sz-swatch-return" /> return
        </span>
        <span>
          <i className="sz-swatch sz-swatch-unverified" /> unverified message
        </span>
        <span className="sz-legend-hint">messages top to bottom in execution order · click: select · Shift/Ctrl+click: add</span>
      </div>
    </div>
  );
}
