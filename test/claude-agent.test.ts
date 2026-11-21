/**
 * `ClaudeSchemaAgent` against a mocked `@anthropic-ai/claude-agent-sdk`: no real Claude.
 * Checks what the session relies on — cancellation reaches the SDK (also when the request
 * signal is already aborted before the call) and tool calls are reported as progress.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSchemaAgent } from '../src/server/agent/claude';
import { AgentError, type AgentActivity, type GenerateRequest } from '../src/server/agent/types';
import { buildIndex } from '../src/server/indexer/index';
import { rootScope } from '../src/shared/graph';
import { agentGraph, cleanupTemps, copyFixture } from './helpers';

interface QueryCall {
  prompt: string;
  options: { abortController: AbortController };
}

const calls: QueryCall[] = [];
let script: () => AsyncGenerator<unknown>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: QueryCall) => {
    calls.push(args);
    return script();
  },
}));

afterAll(cleanupTemps);

let repo: string;
let request: () => GenerateRequest;

beforeAll(() => {
  repo = copyFixture();
  const index = buildIndex(repo);
  request = () => ({ repoPath: repo, index, scope: rootScope('sample-app') });
});

beforeEach(() => {
  calls.length = 0;
});

const reply = agentGraph([{ slug: 'core', paths: ['src/core'], evidence: [{ file: 'src/core/math.ts', startLine: 1, endLine: 1 }] }]);

const successScript = (): (() => AsyncGenerator<unknown>) =>
  async function* () {
    yield {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking around.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/core/math.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'add', path: 'src' } },
        ],
      },
    };
    yield { type: 'result', subtype: 'success', structured_output: reply, result: '' };
  };

describe('ClaudeSchemaAgent', () => {
  it('forwards every tool call to the process-wide and the per-request progress listeners', async () => {
    script = successScript();
    const global: AgentActivity[] = [];
    const perRequest: AgentActivity[] = [];
    const agent = new ClaudeSchemaAgent({ onProgress: (e) => global.push(e) });

    const graph = await agent.generate({ ...request(), onProgress: (e) => perRequest.push(e) });

    expect(graph.nodes.map((n) => n.slug)).toEqual(['core']);
    const expected = [
      { tool: 'Read', detail: 'src/core/math.ts' },
      { tool: 'Grep', detail: 'add in src' },
    ];
    expect(global).toEqual(expected);
    expect(perRequest).toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  it('aborts the SDK call when the request signal is aborted during the run', async () => {
    const controller = new AbortController();
    let sawAbort = false;
    script = async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } }] } };
      // Cancel arrives while the agent is still working.
      controller.abort();
      sawAbort = calls[0]!.options.abortController.signal.aborted;
      throw new Error('aborted by the SDK');
    };
    const agent = new ClaudeSchemaAgent();

    await expect(agent.generate({ ...request(), signal: controller.signal })).rejects.toThrow('aborted by the SDK');
    expect(sawAbort).toBe(true);
    // The listener is detached afterwards: aborting again touches nothing.
    expect(controller.signal.aborted).toBe(true);
  });

  it('hands the SDK an already-aborted controller when the request signal was aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort();
    let abortedAtStart: boolean | null = null;
    script = async function* () {
      abortedAtStart = calls[0]!.options.abortController.signal.aborted;
      if (abortedAtStart) throw new Error('aborted by the SDK');
      yield { type: 'result', subtype: 'success', structured_output: reply, result: '' };
    };
    const agent = new ClaudeSchemaAgent();

    await expect(agent.generate({ ...request(), signal: controller.signal })).rejects.toThrow('aborted by the SDK');
    expect(abortedAtStart).toBe(true);
  });

  it('turns a non-success result into an AgentError', async () => {
    script = async function* () {
      yield { type: 'result', subtype: 'error_max_turns', result: '' };
    };
    const agent = new ClaudeSchemaAgent();
    await expect(agent.generate(request())).rejects.toBeInstanceOf(AgentError);
  });
});
