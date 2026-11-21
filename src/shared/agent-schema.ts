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
  memberOf: z.array(z.string()),
  paths: z.array(z.string()),
  hasDetail: z.boolean(),
});

const edge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(),
  evidence: z.array(evidence),
  confirmed: z.boolean(),
  reason: z.string(),
});

export const agentGraphSchema = z.object({
  diagramKind: z.string(),
  notes: z.array(z.string()),
  nodes: z.array(node),
  edges: z.array(edge),
});

export type AgentEvidence = z.infer<typeof evidence>;
export type AgentGraph = z.infer<typeof agentGraphSchema>;

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
      'The representation that best explains this area: component-graph, data-flow, sequence, state-machine, ... (SPEC 5.3).',
  },
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
          'true for something outside this repository that the code talks to: an external dependency, a database, a remote API, a runtime boundary.',
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
    }),
  },
});

export const emptyAgentGraph = (): AgentGraph => ({
  diagramKind: 'component-graph',
  notes: [],
  nodes: [],
  edges: [],
});
