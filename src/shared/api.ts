/** Request and response shapes of the local HTTP API, shared by server and UI. */
import type { GraphView, Level, ScopeRef, Snapshot } from './graph';

export interface RepoState {
  repoPath: string | null;
  repoName: string;
  isGitRepo: boolean;
  snapshot: Snapshot | null;
  /** Levels a schema can be generated for; the UI disables drill-in beyond them. */
  generatableLevels: Level[];
  /** The agent is faked (SOFTSCOPE_FAKE_AGENT) — no Claude call, no token spend. */
  fakeAgent: boolean;
}

export interface OpenRepoRequest {
  path: string;
}

export interface ValidationIssue {
  kind:
    | 'evidence-missing-file'
    | 'evidence-outside-repo'
    | 'evidence-bad-range'
    | 'node-dropped'
    | 'edge-dropped'
    | 'edge-unverified'
    | 'member-dropped';
  message: string;
  nodeId?: string;
  edgeId?: string;
  file?: string;
}

export interface GraphResponse {
  view: GraphView;
  /** The view came from the on-disk cache; the agent was not called. */
  cached: boolean;
  /** The repository moved since the view was generated (SPEC §9.4). */
  stale: boolean;
  /** What evidence validation dropped or demoted (SPEC §5.4). */
  issues: ValidationIssue[];
  /** Scopes reachable from this view, so the UI knows what can be opened. */
  openable: ScopeRef[];
}

export interface FileResponse {
  path: string;
  lines: string[];
  truncated: boolean;
}

export interface ApiError {
  error: string;
  /** Extra context for a failure that has some, e.g. the agent's own error text. */
  detail?: string;
}
