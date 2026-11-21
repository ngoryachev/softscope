/**
 * The contract between SoftZoom and the analysis agent.
 *
 * The agent answers with slugs, not final node ids: ids are namespaced per scope by the
 * server (`src/server/validation`), which also decides what survives evidence checking.
 * The JSON Schema is hand-written and strict (`additionalProperties: false`, every
 * property required) because that is what `claude-agent-sdk`'s `json_schema` output
 * format accepts; the zod schema below parses whatever comes back, including a reply
 * that arrived as plain JSON text instead of structured output.
 */
import { z } from 'zod';

const evidence = z.object({
  file: z.string().min(1),
  startLine: z.number().int(),
  endLine: z.number().int(),
  note: z.string(),
});

const node = z.object({
  slug: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  evidence: z.array(evidence),
  boundary: z.boolean(),
  // Added for L2; replies cached before it exist and must still parse.
  subsystemId: z.string().optional().default(''),
  memberOf: z.array(z.string()),
  paths: z.array(z.string()),
  hasDetail: z.boolean(),
  // Added for L1 (behaviour views); replies cached before it exist and must still parse.
  // The validator keeps only the roles that belong to the reply's diagram kind.
  role: z.string().optional().default(''),
});

const edge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(),
  evidence: z.array(evidence),
  confirmed: z.boolean(),
  reason: z.string(),
  // Added for L1. `order` 0 and `style`/`group` "" mean "absent": the strict JSON Schema
  // the SDK accepts requires every property, so the agent has no way to leave them out.
  // Not `.int()`: a bad value is reported by validation, not a reason to reject the reply.
  order: z.number().optional().default(0),
  style: z.string().optional().default(''),
  group: z.string().optional().default(''),
});

/**
 * Whether the agent could describe the behaviour of the entity at all (L1, SPEC §5.3,
 * R1/R5). `supported: false` comes with `diagramKind: 'unsupported'`, no nodes and a
 * concrete `reason`; the server never fills a diagram in for it.
 */
const behavior = z.object({
  supported: z.boolean(),
  reason: z.string(),
});

export const agentGraphSchema = z.object({
  diagramKind: z.string(),
  notes: z.array(z.string()),
  nodes: z.array(node),
  edges: z.array(edge),
  // Added for L1; older cached replies default to "supported, nothing to explain".
  behavior: behavior.optional().default({ supported: true, reason: '' }),
});

export type AgentEvidence = z.infer<typeof evidence>;
export type AgentGraph = z.infer<typeof agentGraphSchema>;
export type AgentBehavior = z.infer<typeof behavior>;

export function parseAgentGraph(value: unknown): AgentGraph {
  return agentGraphSchema.parse(value);
}

const strictObject = (
  properties: Record<string, unknown>,
  description?: string,
): Record<string, unknown> => ({
  type: 'object',
  ...(description ? { description } : {}),
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const evidenceJsonSchema = strictObject(
  {
    file: {
      type: 'string',
      description: 'Path relative to the repository root, POSIX separators, no leading "./".',
    },
    startLine: { type: 'integer', minimum: 1, description: 'First line of the range, 1-based.' },
    endLine: {
      type: 'integer',
      minimum: 1,
      description: 'Last line of the range, inclusive, >= startLine.',
    },
    note: { type: 'string', description: 'What this range shows. May be empty.' },
  },
  'A verifiable pointer into the code. The server checks that the file exists and the lines are inside it.',
);

/** The schema passed to the SDK as `outputFormat: { type: 'json_schema', schema }`. */
export const agentGraphJsonSchema: Record<string, unknown> = strictObject({
  diagramKind: {
    type: 'string',
    description:
      'The representation that best explains this area (SPEC 5.3). L4-L2: component-graph, data-flow, ... ' +
      'L1 (behaviour of one entity): exactly one of state-machine, sequence, flow — or unsupported when ' +
      'behavior.supported is false.',
  },
  behavior: strictObject(
    {
      supported: {
        type: 'boolean',
        description:
          'L1 only: true when the behaviour fits one of the supported kinds and could be derived from the code. ' +
          'false when it fits none, or cannot be derived reliably (dynamic dispatch, runtime configuration, too ' +
          'little code): then diagramKind is "unsupported", nodes and edges are empty, and reason says why. ' +
          'Always true at L4-L2.',
      },
      reason: {
        type: 'string',
        description: 'When supported is false: the concrete reason, for the user. Empty otherwise.',
      },
    },
    'Whether a behaviour view could be built at all. Never invent a diagram to avoid supported=false.',
  ),
  notes: {
    type: 'array',
    description:
      'What the analysis could not establish: areas not read, dynamic wiring, assumptions. Empty array if none.',
    items: { type: 'string' },
  },
  nodes: {
    type: 'array',
    items: strictObject({
      slug: {
        type: 'string',
        description: 'Short stable identifier of this node inside the reply, e.g. "http-api".',
      },
      kind: {
        type: 'string',
        description:
          'What the node is, as observed: application, package, subsystem, module, external-service, datastore, cli-entrypoint, ...',
      },
      title: { type: 'string', description: 'Human-readable name, as used in the code.' },
      summary: {
        type: 'string',
        description: 'One or two sentences on what it actually does. Describe, do not judge.',
      },
      evidence: {
        type: 'array',
        minItems: 1,
        description: 'At least one range of real code. A node without usable evidence is dropped.',
        items: evidenceJsonSchema,
      },
      boundary: {
        type: 'boolean',
        description:
          'true for something outside the analyzed area that the code talks to: an external dependency, a database, a remote API, a runtime boundary — or, below L4, code of this repository that belongs to another scope.',
      },
      subsystemId: {
        type: 'string',
        description:
          'Id of the L3 subsystem this boundary entity belongs to, taken verbatim from the sibling list in the task. Empty string if unknown or if this is not a boundary node.',
      },
      memberOf: {
        type: 'array',
        description:
          'Slugs of the nodes in this same reply that contain this one. May list several — one entity can belong to several subsystems. Empty array for top-level nodes.',
        items: { type: 'string' },
      },
      paths: {
        type: 'array',
        description:
          'Repository-relative files and directories this node is implemented in. Empty for boundary nodes.',
        items: { type: 'string' },
      },
      hasDetail: {
        type: 'boolean',
        description: 'true if this node has internal structure worth opening one level deeper.',
      },
      role: {
        type: 'string',
        description:
          'L1 only; "" elsewhere. state-machine: initial | final | state. sequence: participant. ' +
          'flow: start | end | step | decision.',
      },
    }),
  },
  edges: {
    type: 'array',
    items: strictObject({
      from: { type: 'string', description: 'Slug of the source node in this reply.' },
      to: { type: 'string', description: 'Slug of the target node in this reply.' },
      kind: {
        type: 'string',
        description: 'The observed relation: imports, calls, reads, writes, emits, spawns, ...',
      },
      label: { type: 'string', description: 'Short edge label for the diagram. May be empty.' },
      evidence: {
        type: 'array',
        description: 'Ranges of code where the relation is visible. May be empty for an unconfirmed relation.',
        items: evidenceJsonSchema,
      },
      confirmed: {
        type: 'boolean',
        description:
          'true only when the cited code really shows this relation. Set false for a relation you believe exists but could not confirm; it is shown as unverified, not hidden.',
      },
      reason: {
        type: 'string',
        description: 'When confirmed is false: why it could not be confirmed. Empty otherwise.',
      },
      order: {
        type: 'integer',
        minimum: 0,
        description:
          'L1 sequence only: 1-based position of this message in the sequence, unique per message. 0 elsewhere.',
      },
      style: {
        type: 'string',
        description: 'L1 sequence only: sync | async | return. "" elsewhere.',
      },
      group: {
        type: 'string',
        description:
          'L1 sequence only: the branch or loop this message belongs to, e.g. "loop: for each item" or ' +
          '"alt: valid". Consecutive messages with the same group are drawn as one band. "" when none.',
      },
    }),
  },
});

export const emptyAgentGraph = (): AgentGraph => ({
  diagramKind: 'component-graph',
  notes: [],
  nodes: [],
  edges: [],
  behavior: { supported: true, reason: '' },
});
