/**
 * Change → Verify (SPEC §6.4, §6.5, FR-09, FR-10): what the change agent is doing, what it
 * changed — the diff per file, each file marked when it lies outside the selected area —
 * which components of the loaded schemas that touches, how the repository's own checks
 * went, and the two ways out: Apply to the working tree or Discard the worktree. A
 * refinement runs the agent again on the same draft.
 *
 * The diff is rendered here from the server's hunks; no diff library.
 */
import { useEffect, useState } from 'react';
import type { AffectedComponent, ChangeStatus, ChangedFile, CheckResult } from '../../shared/api';
import { countChanges } from '../../shared/diff';
import type { ScopeRef } from '../../shared/graph';
import { formatElapsed, type ProgressActivity } from './GenerationProgress';

export interface ChangePanelProps {
  change: ChangeStatus;
  /** Live progress of the running agent, from the SSE stream; ignored once the change settled. */
  activity: ProgressActivity[];
  /** `startedAt` of the running job as the server reported it; null until it did. */
  runStartedAt: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onRefine: (task: string) => void;
  /** `confirmOutside` is set when the user agreed to apply files outside the selected area. */
  onApply: (confirmOutside: boolean) => void;
  onDiscard: () => void;
  onOpenView: (scope: ScopeRef) => void;
  /** Close the panel after an applied or discarded change; the context panel returns. */
  onClose: () => void;
}

const SHOWN_ACTIVITY = 6;

const STATUS_LABEL: Record<ChangeStatus['status'], string> = {
  running: 'running',
  done: 'ready to review',
  failed: 'failed',
  cancelled: 'cancelled',
  applied: 'applied',
  discarded: 'discarded',
};

function statusOf(file: ChangedFile): string {
  switch (file.status) {
    case 'added':
      return 'new file';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return `renamed from ${file.oldPath}`;
    default:
      return 'modified';
  }
}

function FileDiffView({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(true);
  const { added, removed } = countChanges(file);
  return (
    <section className={`sz-diff-file${file.outsideLimits ? ' sz-diff-outside' : ''}`}>
      <header className="sz-diff-head">
        <button type="button" className="sz-link sz-diff-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} <code>{file.path}</code>
        </button>
        <span className="sz-muted sz-diff-status">{statusOf(file)}</span>
        <span className="sz-diff-counts">
          <span className="sz-diff-added">+{added}</span> <span className="sz-diff-removed">−{removed}</span>
        </span>
        {file.outsideLimits ? (
          <span className="sz-badge sz-badge-warn" title="This file is not under any of the selected paths">
            outside selected area
          </span>
        ) : null}
      </header>
      {open ? (
        file.binary ? (
          <p className="sz-muted">Binary file; no text diff.</p>
        ) : file.hunks.length === 0 ? (
          <p className="sz-muted">No text changes (mode or rename only).</p>
        ) : (
          <pre className="sz-diff">
            {file.hunks.map((hunk, hi) => (
              <div key={`${hunk.header}-${hi}`}>
                <div className="sz-diff-hunk">{hunk.header}</div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className={`sz-diff-line${line.type === '+' ? ' sz-diff-line-add' : line.type === '-' ? ' sz-diff-line-del' : ''}`}
                  >
                    <span className="sz-diff-sign">{line.type}</span>
                    <span className="sz-diff-text">{line.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </pre>
        )
      ) : null}
    </section>
  );
}

function CheckView({ check }: { check: CheckResult }) {
  const [open, setOpen] = useState(!check.ok);
  const label = check.timedOut ? 'timed out' : check.ok ? 'passed' : `failed (exit ${check.exitCode ?? '?'})`;
  return (
    <li className={`sz-check ${check.ok ? 'sz-check-ok' : 'sz-check-fail'}`}>
      <div className="sz-check-head">
        <span className={`sz-badge ${check.ok ? 'sz-badge-ok' : 'sz-badge-warn'}`}>{label}</span>
        <code>{check.command}</code>
        {check.outputTail ? (
          <button type="button" className="sz-link" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide output' : 'show output'}
          </button>
        ) : null}
      </div>
      {open && check.outputTail ? <pre className="sz-check-output">{check.outputTail}</pre> : null}
    </li>
  );
}

function groupAffected(affected: AffectedComponent[]): Array<{ scope: ScopeRef; items: AffectedComponent[] }> {
  const groups: Array<{ scope: ScopeRef; items: AffectedComponent[] }> = [];
  for (const a of affected) {
    const group = groups.find((g) => g.scope.level === a.scope.level && g.scope.id === a.scope.id);
    if (group) group.items.push(a);
    else groups.push({ scope: a.scope, items: [a] });
  }
  return groups;
}

export function ChangePanel({
  change,
  activity,
  runStartedAt,
  busy,
  error,
  onCancel,
  onRefine,
  onApply,
  onDiscard,
  onOpenView,
  onClose,
}: ChangePanelProps) {
  const [refineTask, setRefineTask] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const running = change.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const settled = change.status === 'applied' || change.status === 'discarded';
  const reviewable = change.status === 'done' || change.status === 'failed' || change.status === 'cancelled';
  const outside = change.files.filter((f) => f.outsideLimits).map((f) => f.path);
  const expansion = change.result?.scopeExpansion;
  const groups = groupAffected(change.affected);
  const elapsed = runStartedAt ? formatElapsed(now - new Date(runStartedAt).getTime()) : null;
  const recent = activity.slice(-SHOWN_ACTIVITY);
  const failedChecks = change.checks.filter((c) => !c.ok).length;

  const apply = () => {
    if (outside.length > 0) setConfirming(true);
    else onApply(false);
  };

  return (
    <aside className="sz-change-panel">
      <header className="sz-context-head">
        <h2>
          Change <span className={`sz-badge sz-change-status sz-change-status-${change.status}`}>{STATUS_LABEL[change.status]}</span>
        </h2>
        {settled ? (
          <button type="button" className="sz-button" onClick={onClose}>
            Close
          </button>
        ) : running ? (
          <button type="button" className="sz-button sz-button-cancel" onClick={onCancel} disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
      </header>

      <section>
        <h3>Instruction</h3>
        <p className="sz-change-task">{change.task}</p>
        {change.history.length > 1 ? (
          <p className="sz-muted">
            Refined {change.history.length - 1} {change.history.length === 2 ? 'time' : 'times'}; the first instruction was “
            {change.history[0]!.task}”.
          </p>
        ) : null}
      </section>

      {running ? (
        <section className="sz-change-progress" role="status" aria-live="polite">
          <p>
            <span className="sz-progress-title">The agent is working in an isolated copy…</span>{' '}
            <span className="sz-progress-elapsed">{elapsed ? `${elapsed} elapsed` : 'starting…'}</span>
          </p>
          {recent.length > 0 ? (
            <ul className="sz-progress-activity">
              {recent.map((a, i) => (
                <li key={`${a.at}-${i}`}>
                  <span className="sz-progress-tool">{a.tool}</span> {a.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sz-muted">
              Reading the selected code and its dependencies, editing, then running{' '}
              {change.checkCommands.length > 0 ? change.checkCommands.join(', ') : 'no checks (none detected)'}.
            </p>
          )}
        </section>
      ) : null}

      {error ? <p className="sz-warn sz-change-error">{error}</p> : null}
      {change.status === 'failed' && change.error ? <p className="sz-warn sz-change-error">The agent failed: {change.error}</p> : null}
      {change.status === 'cancelled' ? (
        <p className="sz-muted">Cancelled. Whatever the agent had already edited is shown below; discard it or apply what is useful.</p>
      ) : null}

      {change.result ? (
        <section>
          <h3>Summary</h3>
          <p className="sz-change-summary">{change.result.summary}</p>
        </section>
      ) : null}

      {expansion?.needed ? (
        <section className="sz-callout sz-callout-scope">
          <h3>Needs a wider scope</h3>
          <p>{expansion.reason}</p>
          {expansion.suggestedPaths.length > 0 ? (
            <>
              <p className="sz-muted">Add these paths to the selection and run again:</p>
              <ul className="sz-paths">
                {expansion.suggestedPaths.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {!running ? (
        <section>
          <h3>
            Diff <span className="sz-muted">({change.files.length} {change.files.length === 1 ? 'file' : 'files'})</span>
          </h3>
          {change.files.length === 0 ? (
            <p className="sz-muted">No files changed.</p>
          ) : (
            <>
              {outside.length > 0 ? (
                <p className="sz-warn">
                  {outside.length === 1 ? 'One file lies' : `${outside.length} files lie`} outside the selected area (
                  {change.context.limits.paths.join(', ') || 'nothing selected'}). Applying asks for confirmation.
                </p>
              ) : null}
              {change.files.map((f) => (
                <FileDiffView key={f.path} file={f} />
              ))}
            </>
          )}
        </section>
      ) : null}

      {!running && change.files.length > 0 ? (
        <section>
          <h3>Affected components</h3>
          {groups.length === 0 ? (
            <p className="sz-muted">None of the loaded schemas describes the changed files.</p>
          ) : (
            groups.map((g) => (
              <div key={`${g.scope.level}:${g.scope.id}`} className="sz-affected-group">
                <button type="button" className="sz-link" onClick={() => onOpenView(g.scope)} title="Open this schema">
                  {g.scope.level} · {g.scope.label}
                </button>
                <ul className="sz-affected">
                  {g.items.map((a) => (
                    <li key={a.nodeId}>
                      <strong>{a.title}</strong> <span className="sz-muted">— {a.files.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      ) : null}

      {!running && (change.checks.length > 0 || change.checkCommands.length > 0) ? (
        <section>
          <h3>
            Checks{' '}
            {change.checks.length > 0 ? (
              <span className={failedChecks > 0 ? 'sz-warn' : 'sz-muted'}>
                ({failedChecks > 0 ? `${failedChecks} of ${change.checks.length} failed` : 'all passed'})
              </span>
            ) : null}
          </h3>
          {change.checks.length === 0 ? (
            <p className="sz-muted">Not run ({change.checkCommands.join(', ')}).</p>
          ) : (
            <ul className="sz-checks">
              {change.checks.map((c) => (
                <CheckView key={c.command} check={c} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {!running && change.checkCommands.length === 0 ? (
        <p className="sz-muted">No checks: the root package.json has no typecheck, lint or test script.</p>
      ) : null}

      {reviewable ? (
        <>
          <section className="sz-refine">
            <h3>Refine</h3>
            <textarea
              rows={2}
              placeholder="Follow-up instruction for the same draft, e.g. also cover the error path"
              value={refineTask}
              disabled={busy}
              onChange={(e) => setRefineTask(e.target.value)}
            />
            <button
              type="button"
              className="sz-button"
              disabled={busy || refineTask.trim().length === 0}
              onClick={() => {
                onRefine(refineTask.trim());
                setRefineTask('');
              }}
            >
              Refine
            </button>
          </section>

          <div className="sz-change-actions">
            <button type="button" className="sz-button sz-button-primary" disabled={busy || change.files.length === 0} onClick={apply}>
              Apply to working tree
            </button>
            <button type="button" className="sz-button" disabled={busy} onClick={onDiscard}>
              Discard
            </button>
          </div>

          {confirming ? (
            <div className="sz-confirm" role="dialog" aria-label="Confirm applying files outside the selected area">
              <p className="sz-warn">
                {outside.length === 1 ? 'This file is' : 'These files are'} outside the selected area. Apply {outside.length === 1 ? 'it' : 'them'}{' '}
                anyway?
              </p>
              <ul className="sz-paths">
                {outside.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
              <div className="sz-change-actions">
                <button
                  type="button"
                  className="sz-button sz-button-primary"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    onApply(true);
                  }}
                >
                  Apply including these files
                </button>
                <button type="button" className="sz-button" onClick={() => setConfirming(false)}>
                  Back
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {change.status === 'applied' ? (
        <p className="sz-change-applied">
          Applied to your working tree (not committed). The schemas of the affected components are refreshed or marked for update
          above.
        </p>
      ) : null}
      {change.status === 'discarded' ? <p className="sz-muted">Discarded; the worktree was removed.</p> : null}
    </aside>
  );
}
