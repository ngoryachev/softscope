/**
 * The contract between SoftZoom and the change agent (SPEC §8.5).
 *
 * The agent edits files in an isolated worktree and answers with this object. What it
 * reports is informational: the server computes the real diff from the worktree, runs
 * the checks itself and decides what is inside the selected area. Only `scopeExpansion`
 * carries something the server cannot see — that a safe change needs to leave the
 * selection (SPEC §6.4) — so the UI shows it prominently.
 *
 * Hand-written strict JSON Schema for the SDK's `json_schema` output format, zod for
 * parsing whatever comes back, like `agent-schema.ts`.
 */
import { z } from 'zod';

const scopeExpansion = z.object({
  needed: z.boolean(),
  reason: z.string(),
  suggestedPaths: z.array(z.string()),
});

const reportedCheck = z.object({
  command: z.string(),
  ok: z.boolean(),
  note: z.string().optional().default(''),
});

export const changeResultSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  checks: z.array(reportedCheck),
  scopeExpansion: scopeExpansion.nullable(),
});

export type ScopeExpansion = z.infer<typeof scopeExpansion>;
export type ReportedCheck = z.infer<typeof reportedCheck>;
export type ChangeResult = z.infer<typeof changeResultSchema>;

export function parseChangeResult(value: unknown): ChangeResult {
  return changeResultSchema.parse(value);
}

const strictObject = (properties: Record<string, unknown>, description?: string): Record<string, unknown> => ({
  type: 'object',
  ...(description ? { description } : {}),
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** The schema passed to the SDK as `outputFormat: { type: 'json_schema', schema }`. */
export const changeResultJsonSchema: Record<string, unknown> = strictObject({
  summary: {
    type: 'string',
    description: 'What was changed and why, in a few sentences a reviewer can read before the diff.',
  },
  changedFiles: {
    type: 'array',
    description: 'Paths relative to the working directory of every file you created, edited or deleted.',
    items: { type: 'string' },
  },
  checks: {
    type: 'array',
    description: 'The check commands you ran yourself and how they went. Empty array if you ran none.',
    items: strictObject({
      command: { type: 'string', description: 'The command exactly as run.' },
      ok: { type: 'boolean', description: 'true when it exited successfully.' },
      note: { type: 'string', description: 'What failed or what you did about it. May be empty.' },
    }),
  },
  scopeExpansion: {
    description:
      'null when the change fits inside the selected area. Otherwise: why a safe change has to touch code outside it and which paths — then report instead of editing there.',
    anyOf: [
      strictObject({
        needed: { type: 'boolean', description: 'true when the selected area is not enough for a safe change.' },
        reason: { type: 'string', description: 'What outside the area has to change, and why.' },
        suggestedPaths: {
          type: 'array',
          description: 'Repository-relative paths that would have to be added to the selection.',
          items: { type: 'string' },
        },
      }),
      { type: 'null' },
    ],
  },
});
