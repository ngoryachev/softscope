/**
 * The repository state a view belongs to, plus the stale badge of SPEC §9.4: a schema
 * generated against an older commit or a different working tree is never presented as
 * current.
 */
import type { RepoState } from '../../shared/api';
import type { Snapshot } from '../../shared/graph';

export interface SnapshotBarProps {
  state: RepoState;
  viewSnapshot: Snapshot | null;
  live: Snapshot | null;
  stale: boolean;
  cached: boolean;
  busy: boolean;
  onRegenerate: () => void;
}

function age(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function SnapshotBar({
  state,
  viewSnapshot,
  live,
  stale,
  cached,
  busy,
  onRegenerate,
}: SnapshotBarProps) {
  const shown = viewSnapshot ?? live ?? state.snapshot;
  return (
    <div className="sz-snapshot">
      <span className="sz-repo-name">{state.repoName}</span>
      {shown ? (
        <>
          <span className="sz-muted">{shown.branch}</span>
          <code>{shown.shortCommit}</code>
          {shown.dirty ? <span className="sz-badge sz-badge-warn">uncommitted changes</span> : null}
          {viewSnapshot ? <span className="sz-muted">generated {age(viewSnapshot.generatedAt)}</span> : null}
        </>
      ) : null}
      {cached ? <span className="sz-badge">from cache</span> : null}
      {state.fakeAgent ? <span className="sz-badge sz-badge-warn">fake agent</span> : null}
      {stale && live ? (
        <span className="sz-badge sz-badge-stale" title={`The repository is now at ${live.shortCommit}${live.dirty ? ' with uncommitted changes' : ''}.`}>
          stale
        </span>
      ) : null}
      <button type="button" className="sz-button" onClick={onRegenerate} disabled={busy}>
        {busy ? 'Generating…' : 'Regenerate'}
      </button>
    </div>
  );
}
