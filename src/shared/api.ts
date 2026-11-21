/** Request and response shapes of the local HTTP API, shared by server and UI. */
import type { ChangeResult } from './change-schema';
import type { FileDiff } from './diff';
import type { GraphView, Level, ScopeRef, SelectionContext, Snapshot } from './graph';

export interface RepoState {
  repoPath: string | null;
  repoName: string;
  isGitRepo: boolean;
  snapshot: Snapshot | null;
  /** Levels a schema can be generated for; the UI disables drill-in beyond them. */
  generatableLevels: Level[];
  /** The agent is faked (SOFTSCOPE_FAKE_AGENT) — no Claude call, no token spend. */
  fakeAgent: boolean;
  /** Name of the change agent, or null when the server cannot make changes. */
  changeAgent: string | null;
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
    | 'member-dropped'
    | 'subsystem-link-dropped';
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

/**
 * What a running generation reports while the user waits (served as SSE from
 * `/api/graph/progress`). Elapsed time is computed by the UI from `startedAt`.
 */
export type ProgressEvent =
  | { type: 'started'; level: Level; scopeId: string; startedAt: string }
  | { type: 'activity'; tool: string; detail: string; at: string }
  | { type: 'done'; level: Level; scopeId: string; at: string }
  | { type: 'error'; level: Level; scopeId: string; at: string; message: string }
  | { type: 'cancelled'; level: Level; scopeId: string; at: string }
  /** No generation is running for that scope. */
  | { type: 'idle'; level: Level; scopeId: string };

export interface CancelRequest {
  level: Level;
  scopeId: string;
}

/**
 * `POST /api/context`: the structured context of a selection (SPEC §8.4), built from the
 * views the session already holds. Never triggers a generation.
 */
export interface ContextRequest {
  nodeIds: string[];
  edgeIds: string[];
  task?: string;
}

export type ContextResponse = SelectionContext;

export interface FileResponse {
  path: string;
  lines: string[];
  truncated: boolean;
}

/* ------------------------------------------------------------------------------------ */
/* Prompt → Change → Verify (SPEC §6.4, §6.5, FR-09..FR-11)                              */
/* ------------------------------------------------------------------------------------ */

/** `POST /api/change`: the selection plus the instruction; the server builds the context. */
export interface ChangeRequest {
  nodeIds: string[];
  edgeIds: string[];
  task: string;
}

export interface ChangeStartResponse {
  id: string;
}

export type ChangeState = 'running' | 'done' | 'failed' | 'cancelled' | 'applied' | 'discarded';

/** One agent run inside a change: the first task, then every refinement. */
export interface ChangeHistoryEntry {
  task: string;
  startedAt: string;
  finishedAt: string | null;
  result: ChangeResult | null;
  error?: string;
}

/** A file of the diff, flagged when it lies outside the selected area (`limits.paths`). */
export interface ChangedFile extends FileDiff {
  outsideLimits: boolean;
}

/** A node of a loaded view whose files the change touched (SPEC §6.5). */
export interface AffectedComponent {
  nodeId: string;
  title: string;
  level: Level;
  /** The view the node belongs to — the schema that may need regenerating (FR-11). */
  scope: ScopeRef;
  /** The changed files that hit this node. */
  files: string[];
}

/** One check command the server ran in the worktree after the agent finished. */
export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** The last lines of stdout+stderr combined. */
  outputTail: string;
  timedOut: boolean;
}

export interface ChangeStatus {
  id: string;
  status: ChangeState;
  /** The most recent instruction (the last refinement, or the original task). */
  task: string;
  history: ChangeHistoryEntry[];
  context: SelectionContext;
  /** The live repository state the worktree was created from; Apply requires it unchanged. */
  startSnapshot: Snapshot;
  workspaceDir: string;
  /** The agent's own report; informational — files and checks below are the server's. */
  result: ChangeResult | null;
  files: ChangedFile[];
  affected: AffectedComponent[];
  /** Distinct views with at least one affected component. */
  affectedViews: ScopeRef[];
  checks: CheckResult[];
  /** The detected check commands, so the UI can say what will run. */
  checkCommands: string[];
  error?: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface RefineRequest {
  task: string;
}

export interface ApplyRequest {
  /** Required when a changed file lies outside `limits.paths`. */
  confirmOutside?: boolean;
}

export interface ApplyResponse {
  applied: string[];
  /** The live repository state after the patch landed. */
  snapshot: Snapshot;
  affectedViews: ScopeRef[];
}

/** `GET /api/change/:id/progress`: same shapes as `ProgressEvent`, keyed by the change. */
export type ChangeProgressEvent =
  | { type: 'started'; changeId: string; startedAt: string }
  | { type: 'activity'; tool: string; detail: string; at: string }
  | { type: 'done'; changeId: string; at: string }
  | { type: 'error'; changeId: string; at: string; message: string }
  | { type: 'cancelled'; changeId: string; at: string }
  /** No agent run is in progress for that change. */
  | { type: 'idle'; changeId: string };

export interface ApiError {
  error: string;
  /** Extra context for a failure that has some, e.g. the agent's own error text. */
  detail?: string;
  /** `POST /api/change/:id/apply` without `confirmOutside`: the files outside the selected area. */
  outsideFiles?: string[];
}
