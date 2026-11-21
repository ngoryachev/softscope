/**
 * The isolated copy a change is made in (SPEC §6.4, §8.5): a detached `git worktree` of
 * the user's repository at HEAD, outside the repository, with the user's uncommitted
 * state reproduced on top — the tracked changes as a patch, the untracked files copied.
 * The agent and the checks work there; the user's files are untouched until Apply.
 *
 * After the state is reproduced everything is staged (`git add -A`), so the worktree's
 * index is the recorded base and `git diff` against it is exactly what the agent did.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Snapshot } from '../../shared/graph';
import { repoSnapshot } from '../indexer/git';

/** The change cannot be started from this repository state; the message says what to do. */
export class WorkspaceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRefusedError';
  }
}

export interface Workspace {
  dir: string;
  /** The live repository state the worktree reproduces; Apply requires it unchanged. */
  startSnapshot: Snapshot;
}

export interface CreateWorkspaceOptions {
  repoPath: string;
  id: string;
  /** Parent directory of the worktrees; must not be inside the repository. */
  workDir: string;
  /** Repository-relative package directories whose `node_modules` should be linked in. */
  packageDirs?: string[];
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  if (r.error) return { ok: false, stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

/** `SOFTSCOPE_WORK_DIR`, else `~/.softscope/changes`. */
export function defaultWorkDir(): string {
  const fromEnv = process.env.SOFTSCOPE_WORK_DIR;
  return fromEnv && fromEnv.trim().length > 0 ? resolve(fromEnv) : join(homedir(), '.softscope', 'changes');
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Untracked, not ignored files, as git lists them (NUL-separated). */
function untrackedFiles(repoPath: string): string[] {
  const r = git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!r.ok) return [];
  return r.stdout
    .split('\0')
    .filter((p) => p.length > 0)
    // Dependencies are linked, not copied, whatever the repository's ignore rules say.
    .filter((p) => !p.split('/').includes('node_modules'));
}

/**
 * Creates the worktree and reproduces the user's working tree in it. Refuses — with a
 * message that tells the user what to do — when the repository is mid-merge, has no
 * commit yet, is analyzed from a subdirectory, or when the uncommitted changes cannot be
 * replayed onto HEAD.
 */
export function createWorkspace(opts: CreateWorkspaceOptions): Workspace {
  const repoPath = resolve(opts.repoPath);
  const top = git(repoPath, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new WorkspaceRefusedError(`${repoPath} is not a git repository; changes need git.`);
  if (realOrSelf(top.stdout.trim()) !== realOrSelf(repoPath)) {
    throw new WorkspaceRefusedError(
      `${repoPath} is a subdirectory of the repository at ${top.stdout.trim()}. Open the repository root to make changes.`,
    );
  }
  if (!git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    throw new WorkspaceRefusedError('The repository has no commit yet. Commit first, then run the change again.');
  }
  const unmerged = git(repoPath, ['ls-files', '-u']);
  if (unmerged.stdout.trim().length > 0) {
    throw new WorkspaceRefusedError(
      'The repository has unmerged paths (a merge or rebase is in progress). Finish or abort it, or commit or stash first.',
    );
  }
  const workDir = resolve(opts.workDir);
  if (realOrSelf(workDir).startsWith(`${realOrSelf(repoPath)}/`)) {
    throw new WorkspaceRefusedError('The change work directory must not live inside the analyzed repository.');
  }

  // Taken before the worktree is created: `git worktree add` itself does not change the
  // user's working tree, but the snapshot must describe the state that is reproduced.
  const startSnapshot = repoSnapshot(repoPath);

  mkdirSync(workDir, { recursive: true });
  const dir = join(workDir, opts.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const added = git(repoPath, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
  if (!added.ok) throw new WorkspaceRefusedError(`Could not create a worktree: ${added.stderr.trim()}`);

  try {
    const patch = git(repoPath, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff']);
    if (!patch.ok) throw new WorkspaceRefusedError(`Could not read the uncommitted changes: ${patch.stderr.trim()}`);
    if (patch.stdout.length > 0) {
      const applied = git(dir, ['apply', '--binary', '--whitespace=nowarn', '--index', '-'], patch.stdout);
      if (!applied.ok) {
        throw new WorkspaceRefusedError(
          `The uncommitted changes could not be reproduced in the worktree (${applied.stderr.trim()}). Commit or stash first.`,
        );
      }
    }
    for (const rel of untrackedFiles(repoPath)) {
      const src = join(repoPath, rel);
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { dereference: false });
    }
    // The reproduced state becomes the base: what the agent changes is `git diff`.
    const staged = git(dir, ['add', '-A']);
    if (!staged.ok) throw new WorkspaceRefusedError(`Could not record the base state: ${staged.stderr.trim()}`);

    linkNodeModules(repoPath, dir, ['.', ...(opts.packageDirs ?? [])]);
  } catch (err) {
    removeWorkspace(repoPath, dir);
    throw err;
  }
  return { dir, startSnapshot };
}

/** Symlinks each existing `node_modules` of the user's tree into the worktree. */
function linkNodeModules(repoPath: string, dir: string, packageDirs: string[]): void {
  for (const pkgDir of new Set(packageDirs)) {
    const source = join(repoPath, pkgDir, 'node_modules');
    const target = join(dir, pkgDir, 'node_modules');
    if (!existsSync(source)) continue;
    try {
      lstatSync(target);
      continue; // committed or copied: leave it alone
    } catch {
      // absent: link it
    }
    mkdirSync(dirname(target), { recursive: true });
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      // Dependencies are a convenience for the checks; a failed link is not fatal.
    }
  }
}

/**
 * The patch of what the agent did: the worktree against its recorded base. New files
 * are made known with `git add -N` first so they appear as additions.
 */
export function workspaceDiff(dir: string): string {
  const fresh = untrackedFiles(dir);
  for (let i = 0; i < fresh.length; i += 200) {
    git(dir, ['add', '-N', '--', ...fresh.slice(i, i + 200)]);
  }
  const r = git(dir, ['diff', '--binary', '--no-color', '--no-ext-diff']);
  return r.ok ? r.stdout : '';
}

/** `git worktree remove --force` plus prune; the directory is deleted whatever git says. */
export function removeWorkspace(repoPath: string, dir: string): void {
  git(repoPath, ['worktree', 'remove', '--force', dir]);
  rmSync(dir, { recursive: true, force: true });
  git(repoPath, ['worktree', 'prune']);
}

/** `git apply --check` of `patch` against the user's tree: null when it applies, else why not. */
export function checkPatch(repoPath: string, patch: string): string | null {
  const r = git(repoPath, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], patch);
  return r.ok ? null : r.stderr.trim() || 'the patch does not apply';
}

/** Applies `patch` to the user's working tree (no commit, no staging). Null on success. */
export function applyPatch(repoPath: string, patch: string): string | null {
  const r = git(repoPath, ['apply', '--binary', '--whitespace=nowarn', '-'], patch);
  return r.ok ? null : r.stderr.trim() || 'the patch does not apply';
}
