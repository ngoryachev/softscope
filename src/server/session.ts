/**
 * One open repository: the index, the scope registry, and the
 * cache -> agent -> validation pipeline that produces a view.
 *
 * Generation is always lazy and scoped (SPEC §4.4): nothing is generated until the user
 * opens that scope, and opening one application never touches its neighbours.
 */
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { AgentGraph } from '../shared/agent-schema';
import type { GraphResponse, ProgressEvent, RepoState } from '../shared/api';
import {
  nextLevel,
  rootScope,
  ROOT_SCOPE_ID,
  scopeOwnerOf,
  type GraphNode,
  type GraphView,
  type Level,
  type ScopeRef,
  type Snapshot,
} from '../shared/graph';
import { generatableLevels, supportsLevel } from './agent/prompts';
import type { SchemaAgent, SiblingRef } from './agent/types';
import type { CacheKey, FileCache } from './cache/file-cache';
import { buildIndex, type RepoIndex } from './indexer/index';
import { isGitRepo, repoSnapshot, sameState } from './indexer/git';
import { listFiles } from './indexer/files';
import { validateView } from './validation/validate';

/** What the cache stores: the agent's raw reply plus the state it describes. */
interface CachedGeneration {
  scope: ScopeRef;
  snapshot: Snapshot;
  raw: AgentGraph;
}

interface ParentRef {
  scope: ScopeRef;
  node: GraphNode;
  siblings: SiblingRef[];
}

export class ScopeNotFoundError extends Error {
  constructor(level: Level, scopeId: string) {
    super(`No scope ${level}:${scopeId} is reachable from the generated views.`);
    this.name = 'ScopeNotFoundError';
  }
}

export class LevelNotSupportedError extends Error {
  constructor(level: Level) {
    super(`Level ${level} is not generated yet.`);
    this.name = 'LevelNotSupportedError';
  }
}

/** The generation was cancelled by the user; every request that joined it gets this. */
export class GenerationCancelledError extends Error {
  constructor(level: Level, scopeId: string) {
    super(`Generation of ${level}:${scopeId} was cancelled.`);
    this.name = 'GenerationCancelledError';
  }
}

/** Activity events kept for a subscriber that connects while the agent is already working. */
const PROGRESS_BUFFER = 40;

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * One running agent call. Shared by every request that joined the same scope, so
 * cancelling it affects all of them — this is a single-user local tool.
 */
interface GenerationJob {
  level: Level;
  scopeId: string;
  startedAt: string;
  controller: AbortController;
  /** `started` first, then the most recent activity; terminal events are not buffered. */
  events: ProgressEvent[];
  listeners: Set<ProgressListener>;
  finished: boolean;
}

export interface GraphRequest {
  level: Level;
  scopeId: string;
  /** Ignore the cache and call the agent again (the UI's Regenerate button). */
  refresh?: boolean;
  signal?: AbortSignal;
}

export class RepoSession {
  readonly repoPath: string;
  private readonly scopes = new Map<string, ScopeRef>();
  private readonly views = new Map<string, GraphView>();
  private readonly inFlight = new Map<string, Promise<GraphResponse>>();
  private readonly jobs = new Map<string, GenerationJob>();
  private cachedIndex: RepoIndex | null = null;

  constructor(
    repoPath: string,
    private readonly deps: { agent: SchemaAgent; cache: FileCache },
  ) {
    this.repoPath = resolve(repoPath);
    const st = statSync(this.repoPath);
    if (!st.isDirectory()) throw new Error(`${this.repoPath} is not a directory.`);
    if (this.deps.cache.root.startsWith(`${this.repoPath}/`)) {
      throw new Error('The cache directory must not live inside the analyzed repository.');
    }
  }

  /** The live repository state, re-read on every call: it is what `stale` compares to. */
  liveSnapshot(): Snapshot {
    if (isGitRepo(this.repoPath)) return repoSnapshot(this.repoPath);
    // Without git the state id is a fingerprint of the file list, so the list has to be
    // read now rather than taken from the last index: a file added after that index
    // would never move the state id, and the cached schema would be served as current
    // for the rest of the session (SPEC §9.1, §9.4).
    return repoSnapshot(this.repoPath, { files: listFiles(this.repoPath).files });
  }

  /** The index, rebuilt when the repository state changed. */
  index(): RepoIndex {
    const live = this.liveSnapshot();
    // Compared on the whole state, not just the state id: switching to another branch
    // that points at the same commit changes what the snapshot must report.
    if (this.cachedIndex && sameState(this.cachedIndex.snapshot, live)) return this.cachedIndex;
    const index = buildIndex(this.repoPath);
    this.cachedIndex = index;
    this.scopes.set(key('L4', ROOT_SCOPE_ID), rootScope(index.name));
    return index;
  }

  state(): RepoState {
    const index = this.index();
    return {
      repoPath: this.repoPath,
      repoName: index.name,
      isGitRepo: index.isGitRepo,
      snapshot: index.snapshot,
      generatableLevels: generatableLevels(),
      fakeAgent: this.deps.agent.name === 'fake',
    };
  }

  async graph(req: GraphRequest): Promise<GraphResponse> {
    if (!supportsLevel(req.level)) throw new LevelNotSupportedError(req.level);
    const id = key(req.level, req.scopeId);
    const pending = this.inFlight.get(id);
    // Two browser tabs opening the same scope must not run the agent twice.
    if (pending && !req.refresh) return pending;
    // Only the task that still owns the entry clears it: a refresh replaces the pending
    // entry, and the replaced task must not delete the replacement on its way out.
    const task: Promise<GraphResponse> = this.produce(req).finally(() => {
      if (this.inFlight.get(id) === task) this.inFlight.delete(id);
    });
    this.inFlight.set(id, task);
    return task;
  }

  private async produce(req: GraphRequest): Promise<GraphResponse> {
    const index = this.index();
    const scope = await this.resolveScope(req.level, req.scopeId, req.signal);
    const cacheKey: CacheKey = {
      repoPath: this.repoPath,
      stateId: index.snapshot.stateId,
      level: scope.level,
      scopeId: scope.id,
      agent: this.deps.agent.name,
    };

    const cached = req.refresh ? null : this.reusable(cacheKey, index.snapshot);
    // Computed before the cache branch: validation needs the sibling ids of the parent
    // view for a cached reply just as much as for a fresh one.
    const parent = this.parentOf(scope);

    const generation = cached ?? (await this.generate(scope, index, parent, req.signal, cacheKey));

    // Validation runs on every read, cached or not: evidence is re-checked against the
    // files that are on disk now, not against the ones that were there at generation.
    const { view, issues } = validateView({
      repoPath: this.repoPath,
      scope,
      snapshot: generation.snapshot,
      raw: generation.raw,
      subsystemIds: parent?.siblings.map((s) => s.id) ?? [],
    });
    // What the index could not establish belongs next to what the agent could not.
    view.notes = [...index.notes, ...view.notes];
    this.register(view);
    return {
      view,
      cached: cached !== null,
      // `index.snapshot` is the live state: `index()` above rebuilt unless it matched.
      stale: !sameState(view.snapshot, index.snapshot),
      issues,
      openable: this.openableFrom(view),
    };
  }

  /**
   * Runs the agent for `scope` inside a job the user can watch and cancel. Nothing is
   * cached when the job was cancelled, whatever the agent returned after the abort.
   */
  private async generate(
    scope: ScopeRef,
    index: RepoIndex,
    parent: ParentRef | undefined,
    requestSignal: AbortSignal | undefined,
    cacheKey: CacheKey,
  ): Promise<CachedGeneration> {
    const job = this.startJob(scope);
    const onRequestAbort = () => job.controller.abort();
    if (requestSignal?.aborted) onRequestAbort();
    else requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
    try {
      const raw = await this.deps.agent.generate({
        repoPath: this.repoPath,
        index,
        scope,
        ...(parent ? { parent } : {}),
        signal: job.controller.signal,
        onProgress: ({ tool, detail }) =>
          this.emit(job, { type: 'activity', tool, detail, at: new Date().toISOString() }),
      });
      if (job.controller.signal.aborted) throw new GenerationCancelledError(scope.level, scope.id);
      const fresh: CachedGeneration = {
        scope,
        // The agent's own finish time, not the moment the index was built: an L3
        // generated minutes after the L4 of the same state is not that old.
        snapshot: { ...index.snapshot, generatedAt: new Date().toISOString() },
        raw,
      };
      this.deps.cache.set(cacheKey, fresh);
      this.finishJob(job, { type: 'done', level: scope.level, scopeId: scope.id, at: new Date().toISOString() });
      return fresh;
    } catch (err) {
      const at = new Date().toISOString();
      if (job.controller.signal.aborted) {
        this.finishJob(job, { type: 'cancelled', level: scope.level, scopeId: scope.id, at });
        throw new GenerationCancelledError(scope.level, scope.id);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.finishJob(job, { type: 'error', level: scope.level, scopeId: scope.id, at, message });
      throw err;
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort);
    }
  }

  /** Aborts the running generation of a scope. False when nothing is running for it. */
  cancel(level: Level, scopeId: string): boolean {
    const job = this.jobs.get(key(level, scopeId));
    if (!job || job.finished) return false;
    job.controller.abort();
    return true;
  }

  /**
   * Attaches to the running generation of a scope: the buffered events are replayed,
   * then live ones follow until a terminal event. Null when nothing is running.
   */
  subscribe(level: Level, scopeId: string, listener: ProgressListener): (() => void) | null {
    const job = this.jobs.get(key(level, scopeId));
    if (!job || job.finished) return null;
    for (const event of job.events) listener(event);
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
    };
  }

  private startJob(scope: ScopeRef): GenerationJob {
    const startedAt = new Date().toISOString();
    const job: GenerationJob = {
      level: scope.level,
      scopeId: scope.id,
      startedAt,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      finished: false,
    };
    // A refresh replaces the job of the plain request it overlaps; `finishJob` only
    // removes the entry that still belongs to the finishing job.
    this.jobs.set(key(scope.level, scope.id), job);
    this.emit(job, { type: 'started', level: scope.level, scopeId: scope.id, startedAt });
    return job;
  }

  private emit(job: GenerationJob, event: ProgressEvent): void {
    if (job.finished) return;
    job.events.push(event);
    // Keep `started` and the most recent activity; a late subscriber does not need the
    // whole history, only enough to see what the agent is doing now.
    if (job.events.length > PROGRESS_BUFFER + 1) job.events.splice(1, job.events.length - PROGRESS_BUFFER - 1);
    for (const listener of job.listeners) listener(event);
  }

  private finishJob(job: GenerationJob, event: ProgressEvent): void {
    if (job.finished) return;
    for (const listener of job.listeners) listener(event);
    job.finished = true;
    job.listeners.clear();
    const id = key(job.level, job.scopeId);
    if (this.jobs.get(id) === job) this.jobs.delete(id);
  }

  /**
   * A generation that may be shown for this scope without calling the agent:
   *
   *  - the entry for the live state, which is current;
   *  - failing that, the newest earlier entry for the same scope, which is shown marked
   *    stale (SPEC §9.4). A working tree is dirty almost all the time and changes on
   *    every save, so regenerating on each navigation would make exploring a repository
   *    a sequence of minute-long, paid agent calls. The user decides when to pay for a
   *    fresh schema, through Regenerate (`refresh`).
   */
  private reusable(key: CacheKey, live: Snapshot): CachedGeneration | null {
    const exact = this.deps.cache.get<CachedGeneration>(key);
    if (exact) {
      // The key pins the commit and the working tree, so the code behind this entry is
      // the code on disk; only the branch label can differ, when a branch was created
      // or renamed at the same commit. Relabel it rather than regenerate.
      if (sameState(exact.snapshot, live)) return exact;
      return { ...exact, snapshot: { ...exact.snapshot, branch: live.branch } };
    }
    // Prefer a schema of the same commit over one of another commit that merely happens
    // to be newer: with a dirty tree it is the closest description of the code on disk.
    // `key` carries the agent, so only this agent's own schemas are candidates — another
    // agent's newer entry can neither be served nor hide this one.
    const previous = this.deps.cache.latest<CachedGeneration>(key, { statePrefix: live.commit });
    return previous?.value ?? null;
  }

  /**
   * Finds the scope for a request. The root L4 scope always exists; any deeper scope is
   * a node of an already generated view, so the parent level is generated first if the
   * user deep-linked straight into a subsystem.
   */
  private async resolveScope(level: Level, scopeId: string, signal?: AbortSignal): Promise<ScopeRef> {
    const direct = this.scopes.get(key(level, scopeId));
    if (direct) return direct;
    if (level === 'L4' && scopeId === ROOT_SCOPE_ID) return rootScope(this.index().name);

    const parentLevel = parentOfLevel(level);
    if (!parentLevel) throw new ScopeNotFoundError(level, scopeId);
    const parentScopeId = scopeOwnerOf(scopeId) ?? ROOT_SCOPE_ID;
    await this.graph({ level: parentLevel, scopeId: parentScopeId, ...(signal ? { signal } : {}) });
    const found = this.scopes.get(key(level, scopeId));
    if (!found) throw new ScopeNotFoundError(level, scopeId);
    return found;
  }

  /**
   * The node the user opened to reach `scope`, with the other non-boundary nodes of the
   * same view: the neighbouring subsystems an L2 boundary node may belong to.
   */
  private parentOf(scope: ScopeRef): ParentRef | undefined {
    for (const view of this.views.values()) {
      const node = view.nodes.find((n) => n.childScope?.id === scope.id && n.childScope.level === scope.level);
      if (!node) continue;
      const siblings: SiblingRef[] = view.nodes
        .filter((n) => n.id !== node.id && !n.boundary)
        .map((n) => ({ id: n.id, title: n.title, paths: [...n.paths] }));
      return { scope: view.scope, node, siblings };
    }
    return undefined;
  }

  /** Records a view and the scopes it makes reachable one level deeper. */
  private register(view: GraphView): void {
    this.views.set(key(view.scope.level, view.scope.id), view);
    for (const node of view.nodes) {
      if (node.childScope) this.scopes.set(key(node.childScope.level, node.childScope.id), node.childScope);
    }
  }

  private openableFrom(view: GraphView): ScopeRef[] {
    const deeper = nextLevel(view.scope.level);
    if (!deeper || !supportsLevel(deeper)) return [];
    return view.nodes.flatMap((n) => (n.childScope ? [n.childScope] : []));
  }
}

function key(level: Level, scopeId: string): string {
  return `${level}:${scopeId}`;
}

function parentOfLevel(level: Level): Level | null {
  const order: Level[] = ['L4', 'L3', 'L2', 'L1'];
  const i = order.indexOf(level);
  return i > 0 ? order[i - 1]! : null;
}
