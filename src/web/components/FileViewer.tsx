/** The file behind a code link, with the evidence lines highlighted (SPEC §5.4). */
import { useEffect, useRef, useState } from 'react';
import { getFile } from '../api';
import type { Evidence } from '../../shared/graph';

export interface FileViewerProps {
  evidence: Evidence;
  onClose: () => void;
}

export function FileViewer({ evidence, onClose }: FileViewerProps) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstHighlighted = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setError(null);
    getFile(evidence.file)
      .then((res) => {
        if (cancelled) return;
        setLines(res.lines);
        setTruncated(res.truncated);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [evidence.file]);

  useEffect(() => {
    firstHighlighted.current?.scrollIntoView({ block: 'center' });
  }, [lines, evidence.startLine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sz-overlay" role="dialog" aria-label={evidence.file}>
      <div className="sz-viewer">
        <header>
          <strong>{evidence.file}</strong>
          <span className="sz-muted">
            lines {evidence.startLine}–{evidence.endLine}
          </span>
          <button type="button" className="sz-button" onClick={onClose}>
            Close
          </button>
        </header>
        {evidence.note ? <p className="sz-muted sz-viewer-note">{evidence.note}</p> : null}
        {error ? <p className="sz-warn">{error}</p> : null}
        {lines === null && !error ? <p className="sz-muted">Loading…</p> : null}
        {lines !== null ? (
          <div className="sz-code">
            {lines.map((text, i) => {
              const lineNumber = i + 1;
              const highlighted = lineNumber >= evidence.startLine && lineNumber <= evidence.endLine;
              return (
                <div
                  key={lineNumber}
                  className={highlighted ? 'sz-code-line sz-code-line-hit' : 'sz-code-line'}
                  ref={highlighted && lineNumber === evidence.startLine ? firstHighlighted : undefined}
                >
                  <span className="sz-code-no">{lineNumber}</span>
                  <code>{text || ' '}</code>
                </div>
              );
            })}
            {truncated ? <p className="sz-muted">File truncated for display.</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
