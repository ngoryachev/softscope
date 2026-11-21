/** Everything SoftZoom needs from git: the snapshot a view is pinned to (SPEC §9.4). */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../../shared/graph';

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { ok: false, out: '' };
  return { ok: true, out: r.stdout };
}

export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
}

function hash(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}

/**
 * Fingerprint of the uncommitted changes. Part of the cache key, so editing a file
 * invalidates the schemas generated before the edit instead of serving them as current.
 *
 * `git status` reports paths relative to the top of the work tree, which is not `root`
 * when the analyzed path is a subdirectory of a repository — the size and mtime have to
 * be read from there, or a second edit to an already-modified file would not change the
 * fingerprint and the schema would be served as current.
 */
function dirtyFingerprint(root: string, porcelain: string): string {
  const top = git(root, ['rev-parse', '--show-toplevel']).out.trim() || root;
  const parts: string[] = [porcelain];
  for (const line of porcelain.split('\n')) {
    // Each line is "XY <path>": the two status columns and a space. The raw output is
    // parsed, never a trimmed copy, or the first line would lose a path character.
    const rel = line.length > 3 ? line.slice(3).trim() : '';
    if (!rel) continue;
    // Renames are reported as "old -> new"; the new path is the one on disk.
    const path = rel.includes(' -> ') ? rel.split(' -> ')[1]! : rel;
    try {
      const st = statSync(join(top, path.replace(/^"|"$/g, '')));
      parts.push(`${path}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      parts.push(`${path}:gone`);
    }
  }
  return hash(parts).slice(0, 16);
}

/**
 * A repository without git still needs something to key the cache on, so the file list
 * with sizes and mtimes stands in for a commit. Best effort by design.
 */
function syntheticStateId(root: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files.slice(0, 5000)) {
    try {
      const st = statSync(join(root, f));
      parts.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      parts.push(`${f}:gone`);
    }
  }
  return hash(parts).slice(0, 16);
}

export interface SnapshotOptions {
  /** Used for the synthetic state id of a directory that is not a git repository. */
  files?: string[];
}

export function repoSnapshot(root: string, opts: SnapshotOptions = {}): Snapshot {
  const generatedAt = new Date().toISOString();
  if (!isGitRepo(root)) {
    const state = syntheticStateId(root, opts.files ?? []);
    return {
      branch: '(no git)',
      commit: `nogit-${state}`,
      shortCommit: `nogit-${state.slice(0, 7)}`,
      dirty: false,
      stateId: `nogit-${state}`,
      generatedAt,
    };
  }
  const commit = git(root, ['rev-parse', 'HEAD']).out.trim() || 'unborn';
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'HEAD';
  const porcelain = git(root, ['status', '--porcelain']).out;
  const dirty = porcelain.trim().length > 0;
  return {
    branch,
    commit,
    shortCommit: commit.slice(0, 8),
    dirty,
    stateId: dirty ? `${commit}+${dirtyFingerprint(root, porcelain)}` : commit,
    generatedAt,
  };
}

/** True when the two snapshots describe the same repository state. */
export function sameState(a: Snapshot, b: Snapshot): boolean {
  return a.stateId === b.stateId && a.branch === b.branch;
}
