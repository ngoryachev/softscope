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
import type { GraphResponse, RepoState } from '../shared/api';
import {
  nextLevel,
  rootScope,
  ROOT_SCOPE_ID,
  type GraphNode,
  type GraphView,
  type Level,
  type ScopeRef,
  type Snapshot,
} from '../shared/graph';
import { generatableLevels, supportsLevel } from './agent/prompts';
import type { SchemaAgent } from './agent/types';
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

    const generation =
      cached ??
      (await (async (): Promise<CachedGeneration> => {
        const parent = this.parentOf(scope);
        const raw = await this.deps.agent.generate({
          repoPath: this.repoPath,
          index,
          scope,
          ...(parent ? { parent } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        const fresh: CachedGeneration = {
          scope,
          // The agent's own finish time, not the moment the index was built: an L3
          // generated minutes after the L4 of the same state is not that old.
          snapshot: { ...index.snapshot, generatedAt: new Date().toISOString() },
          raw,
        };
        this.deps.cache.set(cacheKey, fresh);
        return fresh;
      })());

    // Validation runs on every read, cached or not: evidence is re-checked against the
    // files that are on disk now, not against the ones that were there at generation.
    const { view, issues } = validateView({
      repoPath: this.repoPath,
      scope,
      snapshot: generation.snapshot,
      raw: generation.raw,
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

  private parentOf(scope: ScopeRef): { scope: ScopeRef; node: GraphNode } | undefined {
    for (const view of this.views.values()) {
      const node = view.nodes.find((n) => n.childScope?.id === scope.id && n.childScope.level === scope.level);
      if (node) return { scope: view.scope, node };
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

/**
 * A node id is `<level>:<scope>/<slug>`, so the scope that owns a node — and therefore
 * the view that has to be generated to reach it — is readable from the id itself.
 *
 * The slug is after the LAST slash: a deeper scope id embeds its own parent, so
 * `L3:L4:root/app/sub` is owned by `L4:root/app`, not by `L4:root`.
 */
function scopeOwnerOf(nodeIdValue: string): string | null {
  const colon = nodeIdValue.indexOf(':');
  const slash = nodeIdValue.lastIndexOf('/');
  return colon > 0 && slash > colon ? nodeIdValue.slice(colon + 1, slash) : null;
}

