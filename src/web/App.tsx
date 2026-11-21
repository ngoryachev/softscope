/**
 * Explore, Zoom and Select (SPEC §6.1–6.3): the L4 graph of the repository, drill into
 * an application to get its L3 and into a subsystem to get its L2 — each generated at
 * that moment, never before — and back out again through the breadcrumbs. While the
 * agent works the user sees how long it has been running and what it is reading, and
 * can cancel. Clicking a node shows its description and code links; a link opens the
 * file with the evidence lines highlighted.
 *
 * Selection is a basket that survives navigation between levels of one repository:
 * a plain click replaces this level's part of it, Shift/Ctrl/Cmd+click toggles, a
 * marquee adds. The ContextPanel turns the basket into the structured AI context.
 *
 * Prompt → Change → Verify (SPEC §6.4, §6.5): an instruction over the basket starts a
 * change on the server; the ChangePanel follows it, shows the diff, the affected
 * components and the checks, and applies or discards it. After Apply the open view is
 * regenerated when it is affected, and the other affected views get an Update button —
 * a stale schema is never presented as current (SPEC §9.4, FR-11).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeProgressEvent, ChangeStatus, GraphResponse, ProgressEvent, RepoState, ValidationIssue } from '../shared/api';
import {
  expandSelection,
  findNode,
  LEVELS,
  levelOfNodeId,
  nextLevel,
  scopeOwnerOf,
  viewKey,
  viewKeyOfId,
  type Evidence,
  type ExpandDirection,
  type GraphView,
  type Level,
  type ScopeRef,
  type Snapshot,
} from '../shared/graph';
import {
  applyChange,
  cancelChange,
  cancelGeneration,
  discardChange,
  GenerationCancelled,
  getChange,
  getGraph,
  getSnapshot,
  getState,
  openRepo,
  refineChange,
  startChange,
  subscribeChangeProgress,
  subscribeProgress,
} from './api';
import { Breadcrumbs } from './components/Breadcrumbs';
import { ChangePanel } from './components/ChangePanel';
import { FileViewer } from './components/FileViewer';
import { GenerationProgress, type ProgressActivity } from './components/GenerationProgress';
import { ContextPanel, ownerView } from './components/ContextPanel';
import { GraphCanvas, type Basket, type SelectableRef } from './components/GraphCanvas';
import { Inspector } from './components/Inspector';
import { RepoPicker } from './components/RepoPicker';
import { SnapshotBar } from './components/SnapshotBar';

const SNAPSHOT_POLL_MS = 5000;
/** How often to look again for the job when the server says nothing is running yet. */
const PROGRESS_RETRY_MS = 1000;
/** How often the status of a running change is re-read, next to its progress stream. */
const CHANGE_POLL_MS = 2000;
const KEPT_ACTIVITY = 40;

interface StackEntry {
  scope: ScopeRef;
  response: GraphResponse | null;
}

/** The load in flight, as the progress panel needs it. */
interface Loading {
  level: Level;
  scopeId: string;
  label: string;
  startedAt: string | null;
  activity: ProgressActivity[];
}

interface LoadOptions {
  refresh?: boolean;
  /** Select this node once the view is shown (used when jumping to a subsystem's own view). */
  selectNodeId?: string;
  /** Only focus this item once the view is shown; the basket is left alone. */
  focus?: SelectableRef;
}

const depthOf = (level: Level) => LEVELS.indexOf(level);

const sameScope = (a: ScopeRef, b: ScopeRef) => a.level === b.level && a.id === b.id;

/** The change still has a worktree: it is neither applied nor discarded. */
const isOpenChange = (change: ChangeStatus | null): boolean =>
  change !== null && change.status !== 'applied' && change.status !== 'discarded';

const EMPTY_BASKET: Basket = { nodeIds: new Set(), edgeIds: new Set() };

const hasItem = (view: GraphView, item: SelectableRef): boolean =>
  item.kind === 'node' ? findNode(view, item.id) !== undefined : view.edges.some((e) => e.id === item.id);

/** The level an item was picked on, from its id; `view` answers for ids in no known form. */
function levelOfItem(item: SelectableRef, view: GraphView | null): Level | null {
  const parsed = viewKeyOfId(item.id)?.level;
  if (parsed) return parsed;
  return view && hasItem(view, item) ? view.scope.level : null;
}

export function App() {
  const [state, setState] = useState<RepoState | null>(null);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [live, setLive] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState<Loading | null>(null);
  const [opening, setOpening] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [basket, setBasket] = useState<Basket>(EMPTY_BASKET);
  const [focused, setFocused] = useState<SelectableRef | null>(null);
  /** Every view loaded since the repository was opened, by `level:scope` — the context is built over these. */
  const [views, setViews] = useState<Map<string, GraphView>>(() => new Map());
  // A stable array, so an unrelated re-render does not hand the ContextPanel a new `views`.
  const loadedViews = useMemo(() => [...views.values()], [views]);
  const [viewing, setViewing] = useState<Evidence | null>(null);
  /** The change being made or reviewed (SPEC §6.4, §6.5); replaces the context panel while set. */
  const [change, setChange] = useState<ChangeStatus | null>(null);
  const [changeActivity, setChangeActivity] = useState<ProgressActivity[]>([]);
  const [changeRunStartedAt, setChangeRunStartedAt] = useState<string | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  /** Loaded views that describe code an applied change touched and were not regenerated yet (FR-11). */
  const [pendingUpdates, setPendingUpdates] = useState<ScopeRef[]>([]);
  const requestId = useRef(0);
  const basketRef = useRef(basket);
  basketRef.current = basket;
  /** The basket before the last click, so a double-click (open) can undo the click that preceded it. */
  const basketBeforeClick = useRef<Basket | null>(null);
  /** Cancel was pressed before the server had a job for the scope; apply it once it does. */
  const cancelWanted = useRef(false);

  const busy = loading !== null;
  const current = stack[stack.length - 1] ?? null;
  const response = current?.response ?? null;
  const currentView = response?.view ?? null;
  const parentEntry = stack.length >= 2 ? stack[stack.length - 2]! : null;

  /* Selection (SPEC §6.3). The basket keeps items of every level; only the focus is per view. */

  /** A plain click: this level's part of the basket becomes the item, which is focused. */
  const selectReplace = useCallback((item: SelectableRef, view: GraphView | null) => {
    const level = view?.scope.level ?? levelOfItem(item, view);
    basketBeforeClick.current = basketRef.current;
    setBasket((prev) => {
      const keep = (kind: SelectableRef['kind'], ids: ReadonlySet<string>) =>
        new Set([...ids].filter((id) => levelOfItem({ kind, id }, view) !== level));
      const nodeIds = keep('node', prev.nodeIds);
      const edgeIds = keep('edge', prev.edgeIds);
      (item.kind === 'node' ? nodeIds : edgeIds).add(item.id);
      return { nodeIds, edgeIds };
    });
    setFocused(item);
  }, []);

  /** Shift/Ctrl/Cmd+click: in or out of the basket; the focus follows what is left. */
  const selectToggle = (item: SelectableRef) => {
    const inBasket = (item.kind === 'node' ? basket.nodeIds : basket.edgeIds).has(item.id);
    const nodeIds = new Set(basket.nodeIds);
    const edgeIds = new Set(basket.edgeIds);
    const set = item.kind === 'node' ? nodeIds : edgeIds;
    if (inBasket) set.delete(item.id);
    else set.add(item.id);
    basketBeforeClick.current = basket;
    setBasket({ nodeIds, edgeIds });
    setFocused(inBasket ? (focused?.kind === item.kind && focused.id === item.id ? null : focused) : item);
  };

  const addNodes = useCallback((ids: string[]) => {
    setBasket((prev) => {
      const fresh = ids.filter((id) => !prev.nodeIds.has(id));
      if (fresh.length === 0) return prev;
      return { nodeIds: new Set([...prev.nodeIds, ...fresh]), edgeIds: prev.edgeIds };
    });
  }, []);

  const removeItem = (item: SelectableRef) => {
    setBasket((prev) => {
      const nodeIds = new Set(prev.nodeIds);
      const edgeIds = new Set(prev.edgeIds);
      (item.kind === 'node' ? nodeIds : edgeIds).delete(item.id);
      return { nodeIds, edgeIds };
    });
    setFocused((f) => (f && f.kind === item.kind && f.id === item.id ? null : f));
  };

  const clearBasket = () => {
    setBasket(EMPTY_BASKET);
    setFocused(null);
  };

  /** FR-12: the neighbours of this view's selected nodes over confirmed relations join the basket. */
  const expand = (direction: ExpandDirection) => {
    if (!currentView) return;
    const inView = currentView.nodes.filter((n) => basket.nodeIds.has(n.id)).map((n) => n.id);
    addNodes(expandSelection(currentView, inView, direction));
  };

  /** The change the server still holds open (a reload, another tab): show it instead of starting blind. */
  const pickUpOpenChange = (activeChangeId: string | null) => {
    if (!activeChangeId) return;
    getChange(activeChangeId)
      .then(setChange)
      .catch(() => undefined);
  };

  useEffect(() => {
    getState()
      .then((s) => {
        setState(s);
        pickUpOpenChange(s.activeChangeId);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    // Runs once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Loads one scope. Any in-flight load for an older request is discarded. */
  const load = useCallback(async (level: Level, scopeId: string, label: string, options: LoadOptions = {}) => {
    const id = ++requestId.current;
    // A second load of the scope that is already loading keeps what the progress
    // stream has reported: the stream is not re-created, so it would not be replayed.
    setLoading((prev) =>
      prev && prev.level === level && prev.scopeId === scopeId
        ? { ...prev, label }
        : { level, scopeId, label, startedAt: null, activity: [] },
    );
    cancelWanted.current = false;
    setCancelling(false);
    setError(null);
    setNotice(null);
    try {
      const next = await getGraph(level, scopeId, options.refresh ?? false);
      if (id !== requestId.current) return;
      setStack((prev) => {
        // The stack is one path down the levels: everything at this level or deeper is
        // replaced, so opening a sibling subsystem from an L2 keeps L4 / L3 / L2.
        const index = prev.findIndex((e) => depthOf(e.scope.level) >= depthOf(level));
        const entry: StackEntry = { scope: next.view.scope, response: next };
        return index >= 0 ? [...prev.slice(0, index), entry] : [...prev, entry];
      });
      setViews((prev) => new Map(prev).set(viewKey(next.view.scope.level, next.view.scope.id), next.view));
      // A regenerated view is current again: it leaves the list of schemas to update.
      if (options.refresh) setPendingUpdates((prev) => prev.filter((s) => !sameScope(s, next.view.scope)));
      if (options.selectNodeId && findNode(next.view, options.selectNodeId)) {
        selectReplace({ kind: 'node', id: options.selectNodeId }, next.view);
      } else if (options.focus && hasItem(next.view, options.focus)) {
        setFocused(options.focus);
      } else {
        setFocused(null);
      }
      setNotice(null);
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof GenerationCancelled) {
        // The previous view stays; only say what happened.
        setNotice(`Generation of ${level} for ${label} was cancelled. Showing the previous view.`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (id === requestId.current) {
        setLoading(null);
        setCancelling(false);
      }
    }
  }, [selectReplace]);

  // The first level is requested as soon as a repository is open.
  useEffect(() => {
    if (state?.repoPath && stack.length === 0) void load('L4', 'root', state.repoName);
  }, [state?.repoPath, state?.repoName, stack.length, load]);

  // Polling the live snapshot is what turns the stale badge on (SPEC 9.4).
  useEffect(() => {
    if (!state?.repoPath) return;
    const tick = () => {
      getSnapshot()
        .then(setLive)
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, SNAPSHOT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [state?.repoPath]);

  // While a load is in flight, follow the server's job for that scope. The job starts
  // only when the agent is actually called (a cached view never has one, and a deep
  // link generates the parent levels first), so an `idle` answer means "ask again".
  const loadingLevel = loading?.level ?? null;
  const loadingScopeId = loading?.scopeId ?? null;
  useEffect(() => {
    if (!loadingLevel || !loadingScopeId) return;
    let closed = false;
    let close: (() => void) | null = null;
    let retry: number | null = null;
    const onEvent = (event: ProgressEvent) => {
      if (closed) return;
      if (event.type === 'started') {
        setLoading((prev) => (prev ? { ...prev, startedAt: event.startedAt } : prev));
        // Cancel was pressed while nothing was running yet; the job exists now.
        if (cancelWanted.current) {
          setCancelling(true);
          void cancelGeneration(loadingLevel, loadingScopeId).catch(() => setCancelling(false));
        }
      } else if (event.type === 'activity') {
        const entry: ProgressActivity = { tool: event.tool, detail: event.detail, at: event.at };
        setLoading((prev) => (prev ? { ...prev, activity: [...prev.activity, entry].slice(-KEPT_ACTIVITY) } : prev));
      } else if (event.type === 'idle') {
        retry = window.setTimeout(connect, PROGRESS_RETRY_MS);
      }
    };
    // A dropped connection is retried like `idle`: the blocking view request is still
    // running, so the panel must not freeze on the last event it saw.
    const onDrop = () => {
      if (!closed) retry = window.setTimeout(connect, PROGRESS_RETRY_MS);
    };
    const connect = () => {
      if (closed) return;
      // Every connection replays the server's buffer, so a reconnect starts from scratch
      // rather than appending the replayed lines to the ones already shown.
      setLoading((prev) => (prev ? { ...prev, activity: [] } : prev));
      close = subscribeProgress(loadingLevel, loadingScopeId, onEvent, onDrop);
    };
    connect();
    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      close?.();
    };
  }, [loadingLevel, loadingScopeId]);

  /* Prompt → Change → Verify. */

  // While the change runs, follow its progress stream and re-read its status: the stream
  // says what the agent does, the status carries the result once it is through.
  const changeId = change?.id ?? null;
  const changeRunning = change?.status === 'running';
  useEffect(() => {
    if (!changeId || !changeRunning) return;
    let closed = false;
    let close: (() => void) | null = null;
    let retry: number | null = null;
    const refresh = () => {
      getChange(changeId)
        .then((status) => {
          if (!closed) setChange(status);
        })
        .catch((err: unknown) => {
          if (!closed) setChangeError(err instanceof Error ? err.message : String(err));
        });
    };
    const onEvent = (event: ChangeProgressEvent) => {
      if (closed) return;
      if (event.type === 'started') setChangeRunStartedAt(event.startedAt);
      else if (event.type === 'activity') {
        const entry: ProgressActivity = { tool: event.tool, detail: event.detail, at: event.at };
        setChangeActivity((prev) => [...prev, entry].slice(-KEPT_ACTIVITY));
      } else if (event.type === 'idle') {
        // The run is over but the status was not re-read yet, or has not started: ask again.
        refresh();
        retry = window.setTimeout(connect, PROGRESS_RETRY_MS);
      } else {
        refresh();
      }
    };
    const onDrop = () => {
      if (!closed) retry = window.setTimeout(connect, PROGRESS_RETRY_MS);
    };
    const connect = () => {
      if (closed) return;
      setChangeActivity([]);
      close = subscribeChangeProgress(changeId, onEvent, onDrop);
    };
    connect();
    const poll = window.setInterval(refresh, CHANGE_POLL_MS);
    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      window.clearInterval(poll);
      close?.();
    };
  }, [changeId, changeRunning]);

  const changeFailure = (err: unknown) => {
    setChangeBusy(false);
    setChangeError(err instanceof Error ? err.message : String(err));
  };

  /** Run: the basket plus the instruction become a change on the server (SPEC §6.4). */
  const handleRun = (task: string) => {
    setChangeError(null);
    setError(null);
    setChangeBusy(true);
    setChangeActivity([]);
    setChangeRunStartedAt(null);
    startChange({ nodeIds: [...basket.nodeIds], edgeIds: [...basket.edgeIds], task })
      .then(({ id }) => getChange(id))
      .then((status) => {
        setChange(status);
        setChangeBusy(false);
      })
      .catch((err: unknown) => {
        // No change exists: the context panel stays and the error is shown as a banner.
        setChangeBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleChangeCancel = () => {
    if (!change) return;
    setChangeBusy(true);
    cancelChange(change.id)
      .then(() => getChange(change.id))
      .then((status) => {
        setChange(status);
        setChangeBusy(false);
      })
      .catch(changeFailure);
  };

  const handleRefine = (task: string) => {
    if (!change) return;
    setChangeError(null);
    setChangeBusy(true);
    setChangeActivity([]);
    setChangeRunStartedAt(null);
    refineChange(change.id, task)
      .then((status) => {
        setChange(status);
        setChangeBusy(false);
      })
      .catch(changeFailure);
  };

  /**
   * Apply, then keep the schemas honest (FR-11): the live snapshot moves — the stale
   * banner follows — the open view is regenerated when the change touched it, and every
   * other affected loaded view is offered an Update button.
   */
  const handleApply = (confirmOutside: boolean) => {
    if (!change) return;
    setChangeError(null);
    setChangeBusy(true);
    applyChange(change.id, confirmOutside)
      .then(async (applied) => {
        setLive(applied.snapshot);
        setChange(await getChange(change.id));
        setChangeBusy(false);
        if (applied.movedSince) setNotice(applied.note);
        const loaded = applied.affectedViews.filter((scope) => views.has(viewKey(scope.level, scope.id)));
        const open = current ? loaded.find((scope) => sameScope(scope, current.scope)) : undefined;
        setPendingUpdates(loaded.filter((scope) => !open || !sameScope(scope, open)));
        if (open) void load(open.level, open.id, open.label, { refresh: true });
      })
      .catch(changeFailure);
  };

  const handleDiscard = () => {
    if (!change) return;
    setChangeError(null);
    setChangeBusy(true);
    discardChange(change.id)
      .then((status) => {
        setChange(status);
        setChangeBusy(false);
      })
      .catch(changeFailure);
  };

  const closeChange = () => {
    setChange(null);
    setChangeActivity([]);
    setChangeRunStartedAt(null);
    setChangeError(null);
  };

  const handleOpenRepo = async (path: string) => {
    setOpening(true);
    setError(null);
    try {
      const opened = await openRepo(path);
      setState(opened);
      setStack([]);
      // The basket is per repository: ids of one repository mean nothing in another.
      setBasket(EMPTY_BASKET);
      setFocused(null);
      setViews(new Map());
      closeChange();
      setPendingUpdates([]);
      pickUpOpenChange(opened.activeChangeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  const handleCancel = () => {
    if (!loading) return;
    const { level, scopeId, label } = loading;
    setCancelling(true);
    cancelWanted.current = true;
    cancelGeneration(level, scopeId)
      .then(({ cancelled }) => {
        if (cancelled) return;
        // No job for this scope yet: the server is still indexing, looking in the cache,
        // or generating a parent level for a deep link. The button must not stay stuck;
        // the intent is kept and applied when the job's `started` event arrives.
        setCancelling(false);
        setNotice(`Nothing is running for ${label} yet. Cancel will apply as soon as its generation starts.`);
      })
      .catch((err: unknown) => {
        setCancelling(false);
        cancelWanted.current = false;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  /**
   * Opens a node one level deeper. A double-click on the canvas arrives after its first
   * click has already applied the plain-click rule; `undoClick` puts the basket back, so
   * drilling down does not throw away what was selected on this level.
   */
  const openNode = (nodeId: string, options: { undoClick?: boolean } = {}) => {
    if (!response) return;
    const node = findNode(response.view, nodeId);
    if (!node?.childScope) return;
    if (options.undoClick && basketBeforeClick.current) {
      setBasket(basketBeforeClick.current);
      basketBeforeClick.current = null;
    }
    void load(node.childScope.level, node.childScope.id, node.childScope.label);
  };

  /** A basket item clicked in the ContextPanel: inspect it, in its own view when that is another one. */
  const focusItem = (item: SelectableRef) => {
    if (currentView && hasItem(currentView, item)) {
      setFocused(item);
      return;
    }
    const owner = ownerView(loadedViews, item);
    if (owner) void load(owner.scope.level, owner.scope.id, owner.scope.label, { focus: item });
  };

  /**
   * A boundary node named the subsystem it belongs to: a node of the parent view (an
   * L3 node for an L2 view). Open that subsystem's own next level when it can be opened
   * — from cache when there is one, generated otherwise, which is the user's explicit
   * choice here — else show the parent view with the node selected.
   */
  const goToSubsystem = (subsystemId: string) => {
    const ownerLevel = levelOfNodeId(subsystemId);
    const ownerScopeId = scopeOwnerOf(subsystemId);
    if (!ownerLevel || !ownerScopeId) return;
    const parentView = stack.find((e) => e.scope.level === ownerLevel && e.scope.id === ownerScopeId)?.response?.view;
    const target = parentView ? findNode(parentView, subsystemId) : undefined;
    if (target?.childScope) {
      void load(target.childScope.level, target.childScope.id, target.childScope.label);
      return;
    }
    const label = target?.title ?? parentView?.scope.label ?? ownerScopeId;
    void load(ownerLevel, ownerScopeId, label, { selectNodeId: subsystemId });
  };

  if (!state?.repoPath) {
    return <RepoPicker busy={opening} error={error} onOpen={handleOpenRepo} />;
  }

  const stale = response ? response.stale || (live !== null && live.stateId !== response.view.snapshot.stateId) : false;
  const deeper = current ? nextLevel(current.scope.level) : null;
  const deeperSupported = deeper !== null && state.generatableLevels.includes(deeper);
  const runDisabledReason = !state.isGitRepo
    ? 'Changes need a git repository: this directory is not one.'
    : state.changeAgent === null
      ? 'This server has no change agent configured.'
      : isOpenChange(change)
        ? 'A change is already open; apply or discard it first.'
        : changeBusy
          ? 'Starting…'
          : null;

  return (
    <div className="sz-app">
      <header className="sz-header">
        <SnapshotBar
          state={state}
          viewSnapshot={response?.view.snapshot ?? null}
          live={live}
          stale={stale}
          cached={response?.cached ?? false}
          busy={busy}
          onRegenerate={() => {
            if (current) void load(current.scope.level, current.scope.id, current.scope.label, { refresh: true });
          }}
        />
        <Breadcrumbs
          stack={stack.map((e) => e.scope)}
          onNavigate={(depth) => {
            const target = stack[depth];
            if (target) void load(target.scope.level, target.scope.id, target.scope.label);
          }}
        />
      </header>

      {loading ? (
        <GenerationProgress
          level={loading.level}
          scopeLabel={loading.label}
          startedAt={loading.startedAt}
          activity={loading.activity}
          cancelling={cancelling}
          onCancel={handleCancel}
        />
      ) : null}

      {stale ? (
        <div className="sz-stale-banner">
          This schema was generated against {response?.view.snapshot.shortCommit}
          {response?.view.snapshot.dirty ? ' with uncommitted changes' : ''}; the repository has moved since.
          Regenerate to see the current state.
        </div>
      ) : null}

      {pendingUpdates.length > 0 ? (
        <div className="sz-affected-banner">
          <span>Schemas describing code that just changed — regenerate to see the current state:</span>
          {pendingUpdates.map((scope) => (
            <span key={`${scope.level}:${scope.id}`} className="sz-affected-view">
              <button type="button" className="sz-link" onClick={() => void load(scope.level, scope.id, scope.label)}>
                {scope.level} · {scope.label}
              </button>
              <button
                type="button"
                className="sz-button sz-button-small"
                disabled={busy}
                onClick={() => void load(scope.level, scope.id, scope.label, { refresh: true })}
              >
                Update
              </button>
            </span>
          ))}
          <button type="button" className="sz-link" onClick={() => setPendingUpdates([])}>
            dismiss
          </button>
        </div>
      ) : null}

      {notice ? <div className="sz-notice-banner">{notice}</div> : null}
      {error ? <div className="sz-error-banner">{error}</div> : null}

      <main className="sz-main">
        {response ? (
          <>
            <GraphCanvas
              view={response.view}
              basket={basket}
              focused={focused}
              onSelect={(item, { toggle }) => (toggle ? selectToggle(item) : selectReplace(item, response.view))}
              onMarquee={addNodes}
              onClearFocus={() => setFocused(null)}
              onOpenNode={(id) => openNode(id, { undoClick: true })}
            />
            <div className="sz-side">
              <Inspector
                view={response.view}
                parentView={parentEntry?.response?.view ?? null}
                focused={focused}
                onOpenEvidence={setViewing}
                onOpenNode={openNode}
                onSelectNode={(id) => selectReplace({ kind: 'node', id }, response.view)}
                onGoToSubsystem={goToSubsystem}
              />
              {change ? (
                <ChangePanel
                  change={change}
                  activity={changeActivity}
                  runStartedAt={changeRunStartedAt}
                  busy={changeBusy}
                  error={changeError}
                  onCancel={handleChangeCancel}
                  onRefine={handleRefine}
                  onApply={handleApply}
                  onDiscard={handleDiscard}
                  onOpenView={(scope) => void load(scope.level, scope.id, scope.label)}
                  onClose={closeChange}
                />
              ) : (
                <ContextPanel
                  views={loadedViews}
                  currentView={response.view}
                  basket={basket}
                  live={live}
                  onRemove={removeItem}
                  onClear={clearBasket}
                  onExpand={expand}
                  onOpenEvidence={setViewing}
                  onFocus={focusItem}
                  runDisabledReason={runDisabledReason}
                  onRun={handleRun}
                />
              )}
            </div>
          </>
        ) : (
          <div className="sz-placeholder">
            {busy ? (
              <p>Analyzing {loading?.label ?? state.repoName}…</p>
            ) : (
              <p className="sz-muted">Nothing loaded.</p>
            )}
          </div>
        )}
      </main>

      <footer className="sz-footer">
        {response ? <Issues issues={response.issues} /> : null}
        {!deeperSupported && current ? (
          <span className="sz-muted">
            {deeper
              ? `${deeper} is not generated yet — this MVP covers ${state.generatableLevels.join(', ')}.`
              : 'Deepest level reached.'}
          </span>
        ) : null}
      </footer>

      {viewing ? <FileViewer evidence={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function Issues({ issues }: { issues: ValidationIssue[] }) {
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return <span className="sz-muted">All evidence checked out.</span>;
  return (
    <div className="sz-issues">
      <button type="button" className="sz-link" onClick={() => setOpen((v) => !v)}>
        {issues.length} evidence {issues.length === 1 ? 'issue' : 'issues'} found while validating this schema
      </button>
      {open ? (
        <ul>
          {issues.map((issue, i) => (
            <li key={`${issue.kind}-${i}`}>
              <span className="sz-issue-kind">{issue.kind}</span> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
