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
import { AgentError, type GenerateRequest, type SchemaAgent } from './types';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task'];

export interface ClaudeSchemaAgentOptions {
  model?: string;
  maxTurns?: number;
  /** Hard ceiling per generation call, in USD, as reported by the SDK. */
  maxBudgetUsd?: number;
  onProgress?: (event: { tool: string; detail: string }) => void;
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
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const options: Options = {
      cwd: req.repoPath,
      permissionMode: 'dontAsk',
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: WRITE_TOOLS,
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
              this.opts.onProgress?.({ tool: block.name, detail: JSON.stringify(block.input).slice(0, 200) });
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
