/**
 * The analysis agent behind one interface, so the server never depends on Claude being
 * reachable and tests never spend tokens.
 *
 * `generate` takes a scope and nothing else level-specific: adding L2 or L1 later means
 * registering a prompt builder in `prompts.ts`, not changing this interface.
 */
import type { AgentGraph } from '../../shared/agent-schema';
import type { GraphNode, ScopeRef } from '../../shared/graph';
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

export class AgentError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
