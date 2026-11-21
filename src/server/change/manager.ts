/**
 * Prompt → Change → Verify for one open repository (SPEC §6.4, §6.5, §8.5).
 *
 * A change is: the selection context, an isolated worktree that mirrors the user's tree,
 * one or more agent runs in it (the task, then refinements), the server's own run of the
 * repository's checks, and the diff against the recorded base — every file flagged when
 * it lies outside the selected area, and mapped back to the components of the loaded
 * views it touches. The user applies the patch to their tree or discards the worktree.
 *
 * One change at a time per session: the worktree is the user's draft, and two drafts of
 * the same tree would conflict on apply.
 */
import { randomUUID } from 'node:crypto';
import type {
  AffectedComponent,
  ApplyResponse,
  ChangeHistoryEntry,
  ChangeProgressEvent,
  ChangeState,
  ChangeStatus,
  ChangedFile,
  CheckResult,
} from '../../shared/api';
import type { ChangeResult } from '../../shared/change-schema';
import { isUnderPaths, parseUnifiedDiff } from '../../shared/diff';
import type { GraphView, ScopeRef, SelectionContext, SelectionInput, Snapshot } from '../../shared/graph';
import { AgentError, type ChangeAgent, type CheckCommand } from '../agent/types';
import { sameState } from '../indexer/git';
import { JobRegistry } from '../jobs';
import { detectChecks, runChecks } from './checks';
import {
  applyPatch,
  checkPatch,
  createWorkspace,
  pruneLeftoverWorkspaces,
  removeWorkspace,
  workspaceDiff,
  WorkspaceRefusedError,
} from './workspace';

/** What the manager needs from the session; `RepoSession` satisfies it. */
export interface ChangeHost {
  readonly repoPath: string;
  isGitRepo(): boolean;
  liveSnapshot(): Snapshot;
  loadedViews(): GraphView[];
  selectionContext(input: SelectionInput): SelectionContext;
  /** Repository-relative package directories (for linking their `node_modules`). */
  packageDirs(): string[];
}

export interface ChangeManagerOptions {
  agent?: ChangeAgent;
  workDir: string;
  /** Per check, in milliseconds. */
  checkTimeoutMs?: number;
}

/* ---- Errors the HTTP layer maps to status codes ------------------------------------- */

export class NoRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoRepoError';
  }
}

export class ChangeUnavailableError extends Error {
  constructor() {
    super('No change agent is configured on this server.');
    this.name = 'ChangeUnavailableError';
  }
}

export class ChangeActiveError extends Error {
  constructor(readonly activeId: string) {
    super(`Change ${activeId} is still open. Apply or discard it before starting another one.`);
    this.name = 'ChangeActiveError';
  }
}

export class ChangeNotFoundError extends Error {
  constructor(id: string) {
    super(`No change ${id}.`);
    this.name = 'ChangeNotFoundError';
  }
}

/** The change is not in a state that allows the requested action. */
export class ChangeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeStateError';
  }
}

/** Files outside the selected area need an explicit confirmation to be applied. */
export class OutsideLimitsError extends Error {
  constructor(readonly files: string[]) {
    super(
      `${files.length === 1 ? 'A changed file lies' : `${files.length} changed files lie`} outside the selected area: ${files.join(', ')}. Confirm to apply anyway.`,
    );
    this.name = 'OutsideLimitsError';
  }
}

/** The patch cannot land: `git apply --check` failed against the user's tree. Nothing was applied. */
export class ApplyConflictError extends Error {
  constructor(
    message: string,
    readonly files: string[] = [],
  ) {
    super(message);
    this.name = 'ApplyConflictError';
  }
}

export { WorkspaceRefusedError };

/* ---- The change record -------------------------------------------------------------- */

interface ChangeRecord {
  id: string;
  status: ChangeState;
  input: SelectionInput;
  context: SelectionContext;
  startSnapshot: Snapshot;
  workspaceDir: string;
  checkCommands: CheckCommand[];
  history: ChangeHistoryEntry[];
  result: ChangeResult | null;
  files: ChangedFile[];
  affected: AffectedComponent[];
  affectedViews: ScopeRef[];
  checks: CheckResult[];
  error?: string;
  startedAt: string;
  finishedAt: string | null;
  /** The agent run in progress, so discard can wait for it to stop before removing the worktree. */
  run: Promise<void> | null;
}

const OPEN_STATES: ReadonlySet<ChangeState> = new Set(['running', 'done', 'failed', 'cancelled']);

/** How long discard waits for an aborted agent to stop before removing its worktree anyway. */
const DISCARD_GRACE_MS = 5000;

export class ChangeManager {
  private readonly changes = new Map<string, ChangeRecord>();
  private readonly jobs = new JobRegistry<ChangeProgressEvent>();

  constructor(
    private readonly host: ChangeHost,
    private readonly opts: ChangeManagerOptions,
  ) {}

  /** The one change that is neither applied nor discarded, if any. */
  active(): ChangeStatus | null {
    for (const record of this.changes.values()) {
      if (OPEN_STATES.has(record.status)) return this.toStatus(record);
    }
    return null;
  }

  /**
   * Starts a change: builds the context, creates the worktree synchronously (so the
   * refusals surface as the response) and runs the agent in the background.
   */
  start(input: SelectionInput): { id: string } {
    if (!this.opts.agent) throw new ChangeUnavailableError();
    if (!this.host.isGitRepo()) {
      throw new NoRepoError('Changes need a git repository: the change is made in a git worktree and applied as a patch.');
    }
    const open = this.active();
    if (open) throw new ChangeActiveError(open.id);
    const task = (input.task ?? '').trim();
    if (task.length === 0) throw new ChangeStateError('An instruction is required.');

    const context = this.host.selectionContext({ ...input, task });
    if (context.nodes.length === 0) {
      throw new ChangeStateError(
        `The selection resolves to nothing in the loaded views${context.warnings.length ? ` (${context.warnings.join(' ')})` : ''}. Select something first.`,
      );
    }
    const id = randomUUID().slice(0, 8);
    const workspace = createWorkspace({
      repoPath: this.host.repoPath,
      id,
      workDir: this.opts.workDir,
      packageDirs: this.host.packageDirs(),
    });
    const now = new Date().toISOString();
    const record: ChangeRecord = {
      id,
      status: 'running',
      input: { ...input, task },
      context,
      startSnapshot: workspace.startSnapshot,
      workspaceDir: workspace.dir,
      checkCommands: detectChecks(workspace.dir),
      history: [],
      result: null,
      files: [],
      affected: [],
      affectedViews: [],
      checks: [],
      startedAt: now,
      finishedAt: null,
      run: null,
    };
    this.changes.set(id, record);
    record.run = this.runAgent(record, task);
    return { id };
  }

  status(id: string): ChangeStatus {
    return this.toStatus(this.get(id));
  }

  subscribe(id: string, listener: (event: ChangeProgressEvent) => void): (() => void) | null {
    this.get(id);
    return this.jobs.subscribe(id, listener);
  }

  /** Aborts the running agent; the worktree is kept so the user can look at it or discard it. */
  cancel(id: string): boolean {
    this.get(id);
    return this.jobs.cancel(id);
  }

  /** Runs the agent again in the same worktree with a new instruction, then re-verifies. */
  refine(id: string, task: string): void {
    const record = this.get(id);
    const trimmed = task.trim();
    if (trimmed.length === 0) throw new ChangeStateError('An instruction is required.');
    if (record.status === 'running') throw new ChangeStateError('The change is still running; wait for it or cancel it first.');
    if (!OPEN_STATES.has(record.status)) throw new ChangeStateError(`The change was already ${record.status}.`);
    record.status = 'running';
    delete record.error;
    record.finishedAt = null;
    record.run = this.runAgent(record, trimmed);
  }

  /**
   * Lands the patch in the user's tree. The user keeps working while the agent runs, so a
   * repository that moved since the change started is normal: `git apply --check` is the
   * one conflict guard. Refused — with nothing applied — when that check fails (the
   * conflicting files are named) or when a file lies outside the selected area and the
   * user did not confirm.
   */
  apply(id: string, confirmOutside = false): ApplyResponse {
    const record = this.get(id);
    if (record.status === 'running') throw new ChangeStateError('The change is still running; wait for it or cancel it first.');
    if (!OPEN_STATES.has(record.status)) throw new ChangeStateError(`The change was already ${record.status}.`);

    const patch = this.verify(record);
    if (patch.length === 0) throw new ChangeStateError('The change produced no diff; there is nothing to apply.');

    const outside = record.files.filter((f) => f.outsideLimits).map((f) => f.path);
    if (outside.length > 0 && !confirmOutside) throw new OutsideLimitsError(outside);

    const live = this.host.liveSnapshot();
    const movedSince = !sameState(live, record.startSnapshot);
    const moved = describeMove(record.startSnapshot, live);
    const conflict = checkPatch(this.host.repoPath, patch);
    if (conflict) {
      const where = conflict.files.length > 0 ? conflict.files.join(', ') : 'the working tree';
      throw new ApplyConflictError(
        `The patch no longer fits ${where}: ${movedSince ? `${moved}, and the ` : 'the '}lines the change touches differ ` +
          `(${conflict.detail.split('\n')[0]}). Nothing was applied. Revert your edits to ${conflict.files.length === 1 ? 'that file' : 'those files'} ` +
          'and apply again, or discard the change and run it on the current state.',
        conflict.files,
      );
    }
    const applyFailure = applyPatch(this.host.repoPath, patch);
    if (applyFailure) throw new ApplyConflictError(`git apply failed: ${applyFailure}.`);

    removeWorkspace(this.host.repoPath, record.workspaceDir);
    record.status = 'applied';
    record.finishedAt = new Date().toISOString();
    return {
      applied: record.files.map((f) => f.path),
      snapshot: this.host.liveSnapshot(),
      affectedViews: record.affectedViews,
      movedSince,
      note: movedSince ? `Applied on top of a repository that moved since the change started: ${moved}.` : '',
    };
  }

  /**
   * Removes the worktrees a previous server run left under the work directory for this
   * repository: nothing in memory knows them, so nobody could apply or discard them.
   */
  pruneLeftovers(): string[] {
    if (!this.host.isGitRepo()) return [];
    const known = [...this.changes.values()].filter((r) => OPEN_STATES.has(r.status)).map((r) => r.workspaceDir);
    return pruneLeftoverWorkspaces(this.host.repoPath, this.opts.workDir, known);
  }

  /**
   * Removes the worktree; a running agent is aborted first and given a moment to stop, so
   * an in-flight edit cannot recreate the directory after it was removed. No trace is left.
   */
  async discard(id: string): Promise<void> {
    const record = this.get(id);
    if (!OPEN_STATES.has(record.status)) throw new ChangeStateError(`The change was already ${record.status}.`);
    if (this.jobs.cancel(id) && record.run) {
      await Promise.race([record.run, new Promise<void>((resolve) => setTimeout(resolve, DISCARD_GRACE_MS))]);
    }
    removeWorkspace(this.host.repoPath, record.workspaceDir);
    record.status = 'discarded';
    record.finishedAt = new Date().toISOString();
  }

  /* ---- internals ------------------------------------------------------------------- */

  private get(id: string): ChangeRecord {
    const record = this.changes.get(id);
    if (!record) throw new ChangeNotFoundError(id);
    return record;
  }

  private async runAgent(record: ChangeRecord, task: string): Promise<void> {
    const agent = this.opts.agent!;
    const job = this.jobs.start(record.id, (startedAt) => ({ type: 'started', changeId: record.id, startedAt }));
    const entry: ChangeHistoryEntry = { task, startedAt: job.startedAt, finishedAt: null, result: null };
    record.history.push(entry);
    const previous = record.result;
    // The previous run's results describe an older diff; they are not shown next to the new one.
    record.checks = [];
    const at = () => new Date().toISOString();
    const activity = (tool: string, detail: string) => this.jobs.emit(job, { type: 'activity', tool, detail, at: at() });

    try {
      const result = await agent.run({
        workspaceDir: record.workspaceDir,
        context: record.context,
        task,
        ...(previous ? { previous } : {}),
        checks: record.checkCommands,
        signal: job.controller.signal,
        onProgress: ({ tool, detail }) => activity(tool, detail),
      });
      if (job.controller.signal.aborted) throw new AgentError('The change was cancelled.', 'cancelled');
      record.result = result;
      entry.result = result;

      const timeoutMs = this.opts.checkTimeoutMs;
      record.checks = await runChecks(record.checkCommands, record.workspaceDir, {
        signal: job.controller.signal,
        onStart: (check) => activity('check', check.command),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (job.controller.signal.aborted) throw new AgentError('The change was cancelled.', 'cancelled');
      this.verify(record);

      record.status = 'done';
      entry.finishedAt = at();
      record.finishedAt = entry.finishedAt;
      this.jobs.finish(job, { type: 'done', changeId: record.id, at: entry.finishedAt });
    } catch (err) {
      entry.finishedAt = at();
      record.finishedAt = entry.finishedAt;
      // Whatever happened, the worktree may hold partial edits worth seeing (or discarding).
      try {
        this.verify(record);
      } catch {
        // The worktree is gone (discarded while running): nothing to show.
      }
      if (job.controller.signal.aborted) {
        if (record.status !== 'discarded') record.status = 'cancelled';
        this.jobs.finish(job, { type: 'cancelled', changeId: record.id, at: entry.finishedAt });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const detail = err instanceof AgentError && err.detail ? ` (${err.detail})` : '';
      record.status = 'failed';
      record.error = `${message}${detail}`;
      entry.error = record.error;
      this.jobs.finish(job, { type: 'error', changeId: record.id, at: entry.finishedAt, message: record.error });
    }
  }

  /** Recomputes the diff, the limits flags and the affected components. Returns the patch. */
  private verify(record: ChangeRecord): string {
    const patch = workspaceDiff(record.workspaceDir);
    const limits = record.context.limits.paths;
    record.files = parseUnifiedDiff(patch).map((f) => ({
      ...f,
      outsideLimits: !isUnderPaths(f.path, limits) && !(f.status === 'renamed' && isUnderPaths(f.oldPath, limits)),
    }));
    const changed = new Set<string>();
    for (const f of record.files) {
      changed.add(f.path);
      changed.add(f.oldPath);
    }
    const { affected, views } = affectedComponents(this.host.loadedViews(), [...changed]);
    record.affected = affected;
    record.affectedViews = views;
    return patch;
  }

  private toStatus(record: ChangeRecord): ChangeStatus {
    const last = record.history[record.history.length - 1];
    return {
      id: record.id,
      status: record.status,
      task: last?.task ?? record.input.task ?? '',
      history: record.history,
      context: record.context,
      startSnapshot: record.startSnapshot,
      workspaceDir: record.workspaceDir,
      result: record.result,
      files: record.files,
      affected: record.affected,
      affectedViews: record.affectedViews,
      checks: record.checks,
      checkCommands: record.checkCommands.map((c) => c.command),
      ...(record.error ? { error: record.error } : {}),
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }
}

/** What moved between the state a change started from and the live one, in the user's words. */
function describeMove(start: Snapshot, live: Snapshot): string {
  const label = (s: Snapshot) => `${s.branch}@${s.shortCommit}${s.dirty ? ' with uncommitted changes' : ''}`;
  if (start.commit !== live.commit || start.branch !== live.branch) return `${label(start)} → ${label(live)}`;
  if (start.dirty && live.dirty) return `the uncommitted changes differ from the ones the change was built on (${label(live)})`;
  return live.dirty ? `uncommitted changes appeared since (${label(live)})` : `the uncommitted changes went away since (${label(live)})`;
}

/**
 * The nodes of the loaded views whose evidence files or `paths` intersect the changed
 * files (SPEC §6.5), and the distinct views they belong to — the schemas that describe
 * code that just changed (FR-11).
 */
export function affectedComponents(
  views: GraphView[],
  changedFiles: string[],
): { affected: AffectedComponent[]; views: ScopeRef[] } {
  const affected: AffectedComponent[] = [];
  const scopes: ScopeRef[] = [];
  for (const view of views) {
    let hit = false;
    for (const node of view.nodes) {
      const files = changedFiles.filter(
        (file) => node.evidence.some((e) => e.file === file) || (node.paths.length > 0 && isUnderPaths(file, node.paths)),
      );
      if (files.length === 0) continue;
      hit = true;
      affected.push({ nodeId: node.id, title: node.title, level: node.level, scope: view.scope, files: [...new Set(files)].sort() });
    }
    if (hit) scopes.push(view.scope);
  }
  return { affected, views: scopes };
}
