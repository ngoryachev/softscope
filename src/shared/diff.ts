/**
 * A unified diff (`git diff --binary`) parsed into per-file hunks, so the UI can render
 * it with its own highlighting and the server can tell which files a change touched.
 * Shared: the server parses, the UI only displays, but the shape is one.
 */

export type DiffLineType = '+' | '-' | ' ';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ heading` line as written. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileDiff {
  /** The path after the change (the old one for a deletion). */
  path: string;
  /** The path before a rename; equals `path` otherwise. */
  oldPath: string;
  status: FileStatus;
  /** A binary change has no hunks to show. */
  binary: boolean;
  hunks: DiffHunk[];
}

/** `a/x` → `x`; a quoted path is unquoted; `/dev/null` → null. */
function stripPrefix(raw: string): string | null {
  let value = raw.trim();
  // `--- a/path\t(timestamp)` is possible in non-git diffs; git never writes it, but be safe.
  const tab = value.indexOf('\t');
  if (tab >= 0) value = value.slice(0, tab);
  if (value === '/dev/null') return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value.replace(/^[ab]\//, '');
}

/** The two paths of a `diff --git a/x b/y` header. Ambiguous with spaces; `---`/`+++` win. */
function headerPaths(header: string): { a: string; b: string } | null {
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
    return m ? { a: stripPrefix(m[1]!) ?? '', b: stripPrefix(m[2]!) ?? '' } : null;
  }
  // Same path on both sides is the common case: split in the middle.
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return { a: left.slice(2), b: right.slice(2) };
    }
  }
  const split = rest.indexOf(' b/');
  if (split < 0) return null;
  return { a: rest.slice(0, split).replace(/^a\//, ''), b: rest.slice(split + 1).replace(/^b\//, '') };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldFromMarker: string | null | undefined;
  let newFromMarker: string | null | undefined;

  const finishFile = () => {
    if (!current) return;
    // The `---`/`+++` lines know the paths better than the header does.
    if (newFromMarker !== undefined || oldFromMarker !== undefined) {
      const oldPath = oldFromMarker ?? null;
      const newPath = newFromMarker ?? null;
      if (oldPath && newPath) {
        current.oldPath = oldPath;
        current.path = newPath;
      } else if (newPath) {
        current.path = newPath;
        current.oldPath = newPath;
        current.status = 'added';
      } else if (oldPath) {
        current.path = oldPath;
        current.oldPath = oldPath;
        current.status = 'deleted';
      }
    }
    if (current.status === 'modified' && current.oldPath !== current.path) current.status = 'renamed';
    files.push(current);
    current = null;
    hunk = null;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finishFile();
      const paths = headerPaths(line) ?? { a: '', b: '' };
      current = { path: paths.b, oldPath: paths.a, status: 'modified', binary: false, hunks: [] };
      oldFromMarker = undefined;
      newFromMarker = undefined;
      continue;
    }
    if (!current) continue;
    if (hunk) {
      const type = line[0];
      if (type === '+' || type === '-' || type === ' ') {
        hunk.lines.push({ type, text: line.slice(1) });
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (line === '') continue; // the trailing newline of the patch
      hunk = null;
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      hunk = { header: line, oldStart: Number(hunkMatch[1]), newStart: Number(hunkMatch[2]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      current.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      current.status = 'renamed';
    } else if (line.startsWith('--- ')) oldFromMarker = stripPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) newFromMarker = stripPrefix(line.slice(4));
    else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) current.binary = true;
  }
  finishFile();
  return files;
}

/** True when `file` is one of `paths` or lies under one of them (`.` covers everything). */
export function isUnderPaths(file: string, paths: string[]): boolean {
  if (paths.includes('.')) return true;
  const clean = file.replace(/^\.\//, '');
  return paths.some((p) => {
    const prefix = p.replace(/^\.\//, '').replace(/\/+$/, '');
    return prefix.length > 0 && (clean === prefix || clean.startsWith(`${prefix}/`));
  });
}

/** Added and removed line counts of a file diff, for a compact summary line. */
export function countChanges(diff: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.type === '+') added += 1;
      else if (l.type === '-') removed += 1;
    }
  }
  return { added, removed };
}
