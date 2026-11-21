/**
 * The analysis agent behind one interface, so the server never depends on Claude being
 * reachable and tests never spend tokens.
 *
 * `generate` takes a scope and nothing else level-specific: adding L2 or L1 later means
 * registering a prompt builder in `prompts.ts`, not changing this interface.
 */
import type { AgentGraph } from '../../shared/agent-schema';
import type { ChangeResult } from '../../shared/change-schema';
import type { GraphNode, ScopeRef, SelectionContext } from '../../shared/graph';
import type { RepoIndex } from '../indexer/index';

/** A tool call the agent made while analyzing, as far as the UI wants to show it. */
export interface AgentActivity {
  tool: string;
  /** Human-readable target: the file for Read, the pattern for Grep/Glob. */
  detail: string;
}

/** One of the other non-boundary nodes of the parent view, so the agent can name them. */
export interface SiblingRef {
  id: string;
  title: string;
  paths: string[];
}

export interface GenerateRequest {
  repoPath: string;
  index: RepoIndex;
  /** The area to analyze. Only this area is analyzed (SPEC §4.4). */
  scope: ScopeRef;
  /**
   * The node the user opened, the view it came from, and that view's other
   * non-boundary nodes — the neighbouring subsystems an L2 boundary node may belong to.
   */
  parent?: { scope: ScopeRef; node: GraphNode; siblings?: SiblingRef[] };
  signal?: AbortSignal;
  /** Called for every tool call the agent makes, so the UI can show what it is doing. */
  onProgress?: (event: AgentActivity) => void;
}

export interface SchemaAgent {
  /** Name shown in the UI and logs, e.g. `claude-agent-sdk` or `fake`. */
  readonly name: string;
  generate(req: GenerateRequest): Promise<AgentGraph>;
}

/* ------------------------------------------------------------------------------------ */
/* The change agent (SPEC §8.5)                                                         */
/* ------------------------------------------------------------------------------------ */

/** A check script of the worktree's root package.json, as the runner would invoke it. */
export interface CheckCommand {
  /** `typecheck`, `lint` or `test`. */
  name: string;
  /** Human-readable, e.g. `npm run typecheck`. */
  command: string;
  /** What is actually spawned, e.g. `['npm', 'run', 'typecheck']`. */
  argv: string[];
}

export interface ChangeRunRequest {
  /** The isolated worktree the agent edits; never the user's repository. */
  workspaceDir: string;
  /** The selection the user made (SPEC §8.4), with `limits.paths` as the editable area. */
  context: SelectionContext;
  /** The instruction for this run: the original task or a refinement. */
  task: string;
  /** On a refinement: what the previous run reported, so the agent continues from it. */
  previous?: ChangeResult;
  /** The check commands the agent may run itself; the server re-runs them afterwards anyway. */
  checks: CheckCommand[];
  signal?: AbortSignal;
  onProgress?: (event: AgentActivity) => void;
}

export interface ChangeAgent {
  /** Name shown in the UI and logs, e.g. `claude-agent-sdk` or `fake`. */
  readonly name: string;
  run(req: ChangeRunRequest): Promise<ChangeResult>;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
