/**
 * Explore and Zoom (SPEC §6.1–6.2): the L4 graph of the repository, drill into an
 * application to get its L3 and into a subsystem to get its L2 — each generated at that
 * moment, never before — and back out again through the breadcrumbs. While the agent
 * works the user sees how long it has been running and what it is reading, and can
 * cancel. Clicking a node shows its description and code links; a link opens the file
 * with the evidence lines highlighted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphResponse, ProgressEvent, RepoState, ValidationIssue } from '../shared/api';
import {
  findNode,
  LEVELS,
  levelOfNodeId,
  nextLevel,
  scopeOwnerOf,
  type Evidence,
  type Level,
  type ScopeRef,
  type Snapshot,
} from '../shared/graph';
import { cancelGeneration, GenerationCancelled, getGraph, getSnapshot, getState, openRepo, subscribeProgress } from './api';
import { Breadcrumbs } from './components/Breadcrumbs';
import { FileViewer } from './components/FileViewer';
import { GenerationProgress, type ProgressActivity } from './components/GenerationProgress';
import { GraphCanvas } from './components/GraphCanvas';
import { Inspector } from './components/Inspector';
import { RepoPicker } from './components/RepoPicker';
import { SnapshotBar } from './components/SnapshotBar';

const SNAPSHOT_POLL_MS = 5000;
/** How often to look again for the job when the server says nothing is running yet. */
const PROGRESS_RETRY_MS = 1000;
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
}

const depthOf = (level: Level) => LEVELS.indexOf(level);

export function App() {
  const [state, setState] = useState<RepoState | null>(null);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [live, setLive] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState<Loading | null>(null);
  const [opening, setOpening] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Evidence | null>(null);
  const requestId = useRef(0);
  /** Cancel was pressed before the server had a job for the scope; apply it once it does. */
  const cancelWanted = useRef(false);

  const busy = loading !== null;
  const current = stack[stack.length - 1] ?? null;
  const response = current?.response ?? null;
  const parentEntry = stack.length >= 2 ? stack[stack.length - 2]! : null;

  useEffect(() => {
    getState()
      .then(setState)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
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
      setSelectedEdgeId(null);
      setSelectedNodeId(options.selectNodeId && findNode(next.view, options.selectNodeId) ? options.selectNodeId : null);
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
  }, []);

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

  const handleOpenRepo = async (path: string) => {
    setOpening(true);
    setError(null);
    try {
      setState(await openRepo(path));
      setStack([]);
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

  const openNode = (nodeId: string) => {
    if (!response) return;
    const node = findNode(response.view, nodeId);
    if (!node?.childScope) return;
    void load(node.childScope.level, node.childScope.id, node.childScope.label);
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

      {notice ? <div className="sz-notice-banner">{notice}</div> : null}
      {error ? <div className="sz-error-banner">{error}</div> : null}

      <main className="sz-main">
        {response ? (
          <>
            <GraphCanvas
              view={response.view}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={setSelectedNodeId}
              onSelectEdge={setSelectedEdgeId}
              onOpenNode={openNode}
            />
            <Inspector
              view={response.view}
              parentView={parentEntry?.response?.view ?? null}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onOpenEvidence={setViewing}
              onOpenNode={openNode}
              onSelectNode={(id) => {
                setSelectedEdgeId(null);
                setSelectedNodeId(id);
              }}
              onGoToSubsystem={goToSubsystem}
            />
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
