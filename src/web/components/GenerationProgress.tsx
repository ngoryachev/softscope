/**
 * What the user sees while the agent works (SPEC §9.2, risk R4): how long it has been
 * running, what it is reading right now, and a way to stop paying for it. Elapsed time
 * is derived from the server's `startedAt`, so a reconnect does not reset it.
 */
import { useEffect, useState } from 'react';
import type { Level } from '../../shared/graph';

export interface ProgressActivity {
  tool: string;
  detail: string;
  at: string;
}

export interface GenerationProgressProps {
  level: Level;
  scopeLabel: string;
  /** Null until the server has reported the job; the panel then shows "starting". */
  startedAt: string | null;
  activity: ProgressActivity[];
  cancelling: boolean;
  onCancel: () => void;
}

const SHOWN_ACTIVITY = 8;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function GenerationProgress({
  level,
  scopeLabel,
  startedAt,
  activity,
  cancelling,
  onCancel,
}: GenerationProgressProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = startedAt ? formatElapsed(now - new Date(startedAt).getTime()) : null;
  const recent = activity.slice(-SHOWN_ACTIVITY);

  return (
    <div className="sz-progress" role="status" aria-live="polite">
      <div className="sz-progress-head">
        <span className="sz-progress-title">
          Analyzing {level} of {scopeLabel}…
        </span>
        <span className="sz-progress-elapsed">{elapsed ? `${elapsed} elapsed` : 'starting…'}</span>
        <button type="button" className="sz-button sz-button-cancel" onClick={onCancel} disabled={cancelling}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
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
          Claude is reading the code of this area. A first generation usually takes a minute.
        </p>
      )}
    </div>
  );
}
