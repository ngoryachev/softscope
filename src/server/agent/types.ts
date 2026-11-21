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

export interface GenerateRequest {
  repoPath: string;
  index: RepoIndex;
  /** The area to analyze. Only this area is analyzed (SPEC §4.4). */
  scope: ScopeRef;
  /** The node the user opened, and the view it came from, when drilling in. */
  parent?: { scope: ScopeRef; node: GraphNode };
  signal?: AbortSignal;
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
