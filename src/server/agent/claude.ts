/**
 * `SchemaAgent` on top of `@anthropic-ai/claude-agent-sdk`.
 *
 * Runs on the user's local Claude Code login (subscription auth, no API key) — the SDK
 * picks the credentials up itself. The session is deliberately narrow:
 *  - cwd is the analyzed repository, and only Read/Grep/Glob are allowed, so the
 *    analysis cannot modify or execute anything;
 *  - `settingSources: []` keeps the analyzed repository's own CLAUDE.md, settings and
 *    MCP servers out of the session — they would steer the analysis;
 *  - the reply must match our JSON Schema, which the server then validates against the
 *    real files anyway.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentGraphJsonSchema, parseAgentGraph, type AgentGraph } from '../../shared/agent-schema';
import { buildPrompt } from './prompts';
import { AgentError, type AgentActivity, type GenerateRequest, type SchemaAgent } from './types';

/**
 * The only tools the analysis session has. Passed as `tools`, which sets the base set of
 * built-in tools, so nothing else is offered to the model in the first place — rather
 * than offered and denied at call time — and as `allowedTools`, so these three need no
 * permission prompt under `dontAsk`.
 */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export interface ClaudeSchemaAgentOptions {
  model?: string;
  maxTurns?: number;
  /** Hard ceiling per generation call, in USD, as reported by the SDK. */
  maxBudgetUsd?: number;
  /** Process-wide listener (the stdout log); per-request listeners come in through the request. */
  onProgress?: (event: AgentActivity) => void;
}

/** The target of a tool call in the words a user understands: a path, a pattern. */
export function describeToolInput(tool: string, input: unknown): string {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const known = (() => {
    switch (tool) {
      case 'Read':
        return str('file_path') || str('path');
      case 'Grep': {
        const pattern = str('pattern');
        const where = str('path');
        return pattern && where ? `${pattern} in ${where}` : pattern;
      }
      case 'Glob':
        return str('pattern');
      default:
        return str('file_path') || str('path') || str('pattern') || str('command');
    }
  })();
  return known || JSON.stringify(input ?? {}).slice(0, 200);
}

/** JSON object embedded in a text reply, as a fallback when structured output is absent. */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AgentError('The agent reply contained no JSON object.', text.slice(0, 400));
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

export class ClaudeSchemaAgent implements SchemaAgent {
  readonly name = 'claude-agent-sdk';

  constructor(private readonly opts: ClaudeSchemaAgentOptions = {}) {}

  async generate(req: GenerateRequest): Promise<AgentGraph> {
    const { system, prompt } = buildPrompt(req);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener('abort', onAbort, { once: true });

    const options: Options = {
      cwd: req.repoPath,
      permissionMode: 'dontAsk',
      tools: READ_ONLY_TOOLS,
      allowedTools: READ_ONLY_TOOLS,
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
      outputFormat: { type: 'json_schema', schema: agentGraphJsonSchema },
      maxTurns: this.opts.maxTurns ?? 60,
      abortController,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.opts.maxBudgetUsd } : {}),
    };

    let structured: unknown;
    let text = '';
    try {
      for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              const event: AgentActivity = { tool: block.name, detail: describeToolInput(block.name, block.input) };
              this.opts.onProgress?.(event);
              req.onProgress?.(event);
            }
          }
          continue;
        }
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new AgentError(`The analysis agent stopped: ${message.subtype}.`, message.subtype);
        }
        structured = message.structured_output;
        text = message.result;
      }
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }

    const payload = structured ?? (text ? extractJsonObject(text) : undefined);
    if (payload === undefined) {
      throw new AgentError('The analysis agent returned no schema.', 'empty result');
    }
    try {
      return parseAgentGraph(payload);
    } catch (err) {
      throw new AgentError(
        'The analysis agent returned a schema that does not match the contract.',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
