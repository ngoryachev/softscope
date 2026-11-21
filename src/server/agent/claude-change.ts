/**
 * `ChangeAgent` on top of `@anthropic-ai/claude-agent-sdk`.
 *
 * Same login and the same narrow session as the schema agent (`claude.ts`), with the
 * tools a change needs:
 *  - cwd is the isolated worktree, never the user's repository;
 *  - Read/Grep/Glob to explore, Edit/Write/MultiEdit to change files;
 *  - Bash only for the detected check commands, allowed by prefix (`Bash(npm run test:*)`);
 *    anything else the model tries to run is denied under `dontAsk`;
 *  - `settingSources: []` keeps the repository's own CLAUDE.md, settings and MCP servers
 *    out of the session;
 *  - the reply must match the change-result JSON Schema.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { changeResultJsonSchema, parseChangeResult, type ChangeResult } from '../../shared/change-schema';
import { buildChangePrompt } from './change-prompts';
import { describeToolInput, extractJsonObject } from './claude';
import { AgentError, type AgentActivity, type ChangeAgent, type ChangeRunRequest, type CheckCommand } from './types';

const EXPLORE_TOOLS = ['Read', 'Grep', 'Glob'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];

export interface ClaudeChangeAgentOptions {
  model?: string;
  maxTurns?: number;
  /** Hard ceiling per run, in USD, as reported by the SDK. */
  maxBudgetUsd?: number;
  /** Process-wide listener (the stdout log); per-request listeners come in through the request. */
  onProgress?: (event: AgentActivity) => void;
}

/**
 * The `allowedTools` entries that let the model run exactly the check commands: the
 * command itself and the command with any arguments appended.
 */
export function bashRulesFor(checks: CheckCommand[]): string[] {
  return checks.flatMap((c) => [`Bash(${c.command})`, `Bash(${c.command}:*)`]);
}

export class ClaudeChangeAgent implements ChangeAgent {
  readonly name = 'claude-agent-sdk';

  constructor(private readonly opts: ClaudeChangeAgentOptions = {}) {}

  async run(req: ChangeRunRequest): Promise<ChangeResult> {
    const { system, prompt } = buildChangePrompt(req);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener('abort', onAbort, { once: true });

    const tools = [...EXPLORE_TOOLS, ...EDIT_TOOLS, ...(req.checks.length > 0 ? ['Bash'] : [])];
    const options: Options = {
      cwd: req.workspaceDir,
      permissionMode: 'dontAsk',
      tools,
      allowedTools: [...EXPLORE_TOOLS, ...EDIT_TOOLS, ...bashRulesFor(req.checks)],
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
      outputFormat: { type: 'json_schema', schema: changeResultJsonSchema },
      maxTurns: this.opts.maxTurns ?? 120,
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
              const event: AgentActivity = {
                tool: block.name,
                detail: describeToolInput(block.name, block.input, req.workspaceDir),
              };
              this.opts.onProgress?.(event);
              req.onProgress?.(event);
            }
          }
          continue;
        }
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new AgentError(`The change agent stopped: ${message.subtype}.`, message.subtype);
        }
        structured = message.structured_output;
        text = message.result;
      }
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }

    const payload = structured ?? (text ? extractJsonObject(text) : undefined);
    if (payload === undefined) throw new AgentError('The change agent returned no report.', 'empty result');
    try {
      return parseChangeResult(payload);
    } catch (err) {
      throw new AgentError(
        'The change agent returned a report that does not match the contract.',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
