/** The path through the levels the user drilled down (SPEC §4.3, §6.2). */
import { levelTitle, type ScopeRef } from '../../shared/graph';

export interface BreadcrumbsProps {
  stack: ScopeRef[];
  onNavigate: (depth: number) => void;
}

export function Breadcrumbs({ stack, onNavigate }: BreadcrumbsProps) {
  return (
    <nav className="sz-breadcrumbs" aria-label="Zoom level">
      {stack.map((scope, depth) => (
        <span key={`${scope.level}:${scope.id}`}>
          {depth > 0 ? <span className="sz-crumb-sep">/</span> : null}
          <button
            type="button"
            className={depth === stack.length - 1 ? 'sz-crumb sz-crumb-current' : 'sz-crumb'}
            onClick={() => onNavigate(depth)}
            disabled={depth === stack.length - 1}
            title={`${scope.level} — ${levelTitle(scope.level)}`}
          >
            <span className="sz-crumb-level">{scope.level}</span> {scope.label}
          </button>
        </span>
      ))}
    </nav>
  );
}
