/**
 * Explore (SPEC §6.1–6.2): the L4 graph of the repository, drill into an application to
 * get its L3 — generated at that moment, never before — and back out again through the
 * breadcrumbs. Clicking a node shows its description and code links; a link opens the
 * file with the evidence lines highlighted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphResponse, RepoState, ValidationIssue } from '../shared/api';
import { findNode, nextLevel, type Evidence, type Level, type ScopeRef, type Snapshot } from '../shared/graph';
import { getGraph, getSnapshot, getState, openRepo } from './api';
import { Breadcrumbs } from './components/Breadcrumbs';
import { FileViewer } from './components/FileViewer';
import { GraphCanvas } from './components/GraphCanvas';
import { Inspector } from './components/Inspector';
import { RepoPicker } from './components/RepoPicker';
import { SnapshotBar } from './components/SnapshotBar';

const SNAPSHOT_POLL_MS = 5000;

interface StackEntry {
  scope: ScopeRef;
  response: GraphResponse | null;
}

export function App() {
  const [state, setState] = useState<RepoState | null>(null);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [live, setLive] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Evidence | null>(null);
  const requestId = useRef(0);

  const current = stack[stack.length - 1] ?? null;
  const response = current?.response ?? null;

  useEffect(() => {
    getState()
      .then(setState)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  /** Loads one scope. Any in-flight load for an older request is discarded. */
  const load = useCallback(async (level: Level, scopeId: string, refresh = false) => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const next = await getGraph(level, scopeId, refresh);
      if (id !== requestId.current) return;
      setStack((prev) => {
        const index = prev.findIndex((e) => e.scope.level === level && e.scope.id === scopeId);
        const entry: StackEntry = { scope: next.view.scope, response: next };
        if (index >= 0) return [...prev.slice(0, index), entry];
        return [...prev, entry];
      });
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  // The first level is requested as soon as a repository is open.
  useEffect(() => {
    if (state?.repoPath && stack.length === 0) void load('L4', 'root');
  }, [state?.repoPath, stack.length, load]);

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

  const handleOpenRepo = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      setState(await openRepo(path));
      setStack([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openNode = (nodeId: string) => {
    if (!response) return;
    const node = findNode(response.view, nodeId);
    if (!node?.childScope) return;
    void load(node.childScope.level, node.childScope.id);
  };

  if (!state?.repoPath) {
    return <RepoPicker busy={busy} error={error} onOpen={handleOpenRepo} />;
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
            if (current) void load(current.scope.level, current.scope.id, true);
          }}
        />
        <Breadcrumbs
          stack={stack.map((e) => e.scope)}
          onNavigate={(depth) => {
            const target = stack[depth];
            if (target) void load(target.scope.level, target.scope.id);
          }}
        />
      </header>

      {stale ? (
        <div className="sz-stale-banner">
          This schema was generated against {response?.view.snapshot.shortCommit}
          {response?.view.snapshot.dirty ? ' with uncommitted changes' : ''}; the repository has moved since.
          Regenerate to see the current state.
        </div>
      ) : null}

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
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onOpenEvidence={setViewing}
              onOpenNode={openNode}
              onSelectNode={(id) => {
                setSelectedEdgeId(null);
                setSelectedNodeId(id);
              }}
            />
          </>
        ) : (
          <div className="sz-placeholder">
            {busy ? (
              <>
                <p>Analyzing {current?.scope.label ?? state.repoName}…</p>
                <p className="sz-muted">
                  Claude is reading the code of this area. A first generation usually takes a minute.
                </p>
              </>
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
              ? `${deeper} is not generated yet — this MVP covers L4 and L3.`
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
