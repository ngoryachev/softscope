/**
 * The selection context as Markdown: what the user copies into a chat, and what
 * `POST /api/context?format=markdown` returns. A pure string function, shared by the UI
 * and the server, so both render the same text.
 */
import type { ContextRelation, LineRange, SelectionContext } from './graph';

/** `src/a.ts:10-42`, or `src/a.ts:10` for a single line. */
export function formatRange(file: string, range: LineRange): string {
  return range.startLine === range.endLine
    ? `${file}:${range.startLine}`
    : `${file}:${range.startLine}-${range.endLine}`;
}

function relationLine(r: ContextRelation): string {
  const detail = [r.kind, r.label].filter(Boolean).join(', ');
  const status = r.status === 'unverified' && r.reason ? `unverified: ${r.reason}` : r.status;
  return `- ${r.from.title} → ${r.to.title} (${detail}) — ${status}`;
}

export function renderContextMarkdown(context: SelectionContext): string {
  const out: string[] = [];
  const section = (title: string, body: string[]) => {
    out.push(`## ${title}`, '', ...body, '');
  };

  if (context.task.trim()) section('Task', [context.task.trim()]);

  const snapshotLines =
    context.snapshots.length === 0
      ? ['_No items resolved._']
      : context.snapshots.map((s) => {
          const scopes = s.scopes.map((sc) => `${sc.level} ${sc.label}`).join(', ');
          return `- ${s.branch} @ ${s.shortCommit}${s.dirty ? ' (uncommitted changes)' : ''} — ${scopes}`;
        });
  for (const w of context.warnings) snapshotLines.push(`- ⚠ ${w}`);
  section(context.snapshots.length === 1 ? 'Snapshot' : 'Snapshots', snapshotLines);

  section(
    'Selected entities',
    context.nodes.length === 0
      ? ['_None._']
      : context.nodes.map((n) => {
          const flags = [n.level, n.kind, n.boundary ? 'boundary' : ''].filter(Boolean).join(', ');
          return `- **${n.title}** (${flags})${n.summary ? ` — ${n.summary}` : ''}`;
        }),
  );

  section(
    'Files',
    context.files.length === 0
      ? ['_None._']
      : context.files.flatMap((f) => f.ranges.map((r) => `- ${formatRange(f.file, r)}`)),
  );

  const relations: string[] = ['### Internal', ''];
  relations.push(...(context.relations.internal.length ? context.relations.internal.map(relationLine) : ['_None._']));
  relations.push('', '### External', '');
  relations.push(...(context.relations.external.length ? context.relations.external.map(relationLine) : ['_None._']));
  section('Relations', relations);

  section('Change limits', [...context.limits.paths.map((p) => `- ${p}`), '', context.limits.note]);

  section('Size', [`${context.size.files} files, ${context.size.lines} lines`]);

  return out.join('\n').replace(/\n+$/, '\n');
}
