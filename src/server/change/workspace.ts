/**
 * The isolated copy a change is made in (SPEC §6.4, §8.5): a detached `git worktree` of
 * the user's repository at HEAD, outside the repository, with the user's uncommitted
 * state reproduced on top — the tracked changes as a patch, the untracked files copied.
 * The agent and the checks work there; the user's files are untouched until Apply.
 *
 * After the state is reproduced it is committed onto the worktree's detached HEAD (the
 * user's branches are not touched), so the base is a real tree object: the agent's work
 * is `git add` plus `git diff --cached HEAD`, which reports additions, deletions and
 * modifications alike and forgets a file the agent created and later removed again.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/**
 * The user's git configuration must not steer the bookkeeping: their hooks are theirs
 * (a husky `prepare-commit-msg` would refuse the base commit, a `post-checkout` would run
 * in the worktree), and `diff.*`/`apply.*` settings would produce patches `git apply`
 * cannot place. A hooks path that does not exist disables hooks; it lives under the
 * user's home, not in a world-writable temp directory, so nobody else can fill it.
 */
const GIT_OVERRIDES = [
  `core.hooksPath=${join(homedir(), '.softscope', 'no-hooks')}`,
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
  'apply.ignoreWhitespace=no',
  'commit.gpgsign=false',
].flatMap((kv) => ['-c', kv]);

function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync('git', [...GIT_OVERRIDES, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  if (r.error) return { ok: false, stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * A patch `git apply` can place whatever the user's diff settings: explicit `a/` `b/`
 * prefixes for `-p1`, three context lines (`diff.context=0` would yield hunks that
 * `git apply` rejects without `--unidiff-zero`), no external diff driver, no textconv
 * (a `.gitattributes` `diff=<driver>` with `textconv` would emit converted text instead
 * of the file's bytes), no colour.
 */
const DIFF_FLAGS = ['--binary', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--src-prefix=a/', '--dst-prefix=b/'];

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
    // A nested repository (a clone dropped into the tree, not added) is listed as
    // `dir/`: it is not part of this repository and cannot travel in a patch; skip it.
    .filter((p) => !p.endsWith('/'))
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
    const patch = git(repoPath, ['diff', 'HEAD', ...DIFF_FLAGS]);
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
    // The reproduced state becomes the base commit of the detached worktree HEAD. Only
    // that HEAD points at it; after the worktree is removed the commit is garbage.
    const staged = git(dir, ['add', '-A']);
    if (!staged.ok) throw new WorkspaceRefusedError(`Could not record the base state: ${staged.stderr.trim()}`);
    const committed = git(dir, [
      '-c',
      'user.name=SoftZoom',
      '-c',
      'user.email=softscope@localhost',
      'commit',
      '--quiet',
      '--allow-empty',
      '--no-verify',
      '-m',
      'softscope: base state of the change',
    ]);
    if (!committed.ok) throw new WorkspaceRefusedError(`Could not record the base state: ${committed.stderr.trim()}`);

    linkNodeModules(repoPath, dir, ['.', ...(opts.packageDirs ?? [])]);
    // Next to the worktree, not inside it (it would show up in the diff): which server
    // process owns this draft, so another instance's startup cleanup leaves it alone.
    writeFileSync(ownerFile(dir), `${process.pid}\n`, 'utf8');
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
 * The patch of what the agent did: the worktree against the recorded base commit. The
 * index is a scratch area here — tracked changes and deletions are staged with `add -u`,
 * new files explicitly (the linked `node_modules` never are) — and the diff is taken
 * between HEAD and that index, so nothing stale survives from an earlier call.
 */
export function workspaceDiff(dir: string): string {
  git(dir, ['add', '-u']);
  const fresh = untrackedFiles(dir);
  for (let i = 0; i < fresh.length; i += 200) {
    git(dir, ['add', '--', ...fresh.slice(i, i + 200)]);
  }
  const r = git(dir, ['diff', '--cached', ...DIFF_FLAGS, 'HEAD']);
  return r.ok ? r.stdout : '';
}

/** `git worktree remove --force` plus prune; the directory is deleted whatever git says. */
export function removeWorkspace(repoPath: string, dir: string): void {
  git(repoPath, ['worktree', 'remove', '--force', dir]);
  // The fallback deletion is for a linked worktree git could not remove on its own. A
  // main working tree (`.git` is a directory, not a file) is never one of ours: leave it.
  if (isLinkedWorktreeDir(dir)) rmSync(dir, { recursive: true, force: true });
  rmSync(ownerFile(dir), { force: true });
  git(repoPath, ['worktree', 'prune']);
}

/** True for a directory that is a linked worktree (its `.git` is a file pointing at the repository). */
function isLinkedWorktreeDir(dir: string): boolean {
  try {
    return lstatSync(join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** `<workDir>/<id>.owner`: the pid of the server process that created the worktree `<workDir>/<id>`. */
export function ownerFile(dir: string): string {
  return `${dir.replace(/\/+$/, '')}.owner`;
}

/** The pid recorded for a worktree, or null when there is none. */
export function workspaceOwner(dir: string): number | null {
  try {
    const pid = Number(readFileSync(ownerFile(dir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True when a process with this pid exists (EPERM means it does, just not ours to signal). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface PatchConflict {
  /** The files `git apply` could not place, as far as its messages name them. */
  files: string[];
  detail: string;
}

/** The paths named in `git apply` error lines (`patch failed: x:1`, `x: patch does not apply`, ...). */
export function conflictingFiles(stderr: string): string[] {
  const files = new Set<string>();
  for (const line of stderr.split('\n')) {
    const failed = /^error: patch failed: (.+):\d+$/.exec(line);
    if (failed) {
      files.add(failed[1]!);
      continue;
    }
    const named = /^error: (.+?): (?:patch does not apply|already exists in (?:working directory|index)|No such file or directory|does not exist in index|does not match index)/.exec(line);
    if (named) files.add(named[1]!);
  }
  return [...files].sort();
}

/** `git apply --check` of `patch` against the user's tree: null when it applies, else the conflict. */
export function checkPatch(repoPath: string, patch: string): PatchConflict | null {
  const r = git(repoPath, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], patch);
  if (r.ok) return null;
  const detail = r.stderr.trim() || 'the patch does not apply';
  return { files: conflictingFiles(r.stderr), detail };
}

/**
 * Removes the drafts a previous server run left behind for `repoPath`: linked worktrees
 * that are direct children of `workDir`, carry SoftZoom's `<id>.owner` file, are not in
 * `keep`, and whose owning server process is gone. Everything else under `workDir` —
 * the repository itself when it happens to live there, worktrees the user made — is not
 * SoftZoom's and is left alone, as is a draft another running instance still owns.
 * Returns the directories removed.
 */
export function pruneLeftoverWorkspaces(repoPath: string, workDir: string, keep: Iterable<string> = []): string[] {
  const list = git(repoPath, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return [];
  const realWorkDir = realOrSelf(workDir);
  const mainTree = realOrSelf(repoPath);
  const kept = new Set([...keep].map((d) => realOrSelf(d)));
  const removed: string[] = [];
  for (const line of list.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length);
    const real = realOrSelf(dir);
    if (real === mainTree || dirname(real) !== realWorkDir || kept.has(real)) continue;
    const owner = workspaceOwner(dir);
    if (owner === null) continue; // not created by SoftZoom
    if (isProcessAlive(owner)) continue; // another live instance's draft
    if (!isLinkedWorktreeDir(dir)) continue;
    removeWorkspace(repoPath, dir);
    removed.push(dir);
  }
  if (removed.length === 0) git(repoPath, ['worktree', 'prune']);
  return removed;
}

/** Applies `patch` to the user's working tree (no commit, no staging). Null on success. */
export function applyPatch(repoPath: string, patch: string): string | null {
  const r = git(repoPath, ['apply', '--binary', '--whitespace=nowarn', '-'], patch);
  return r.ok ? null : r.stderr.trim() || 'the patch does not apply';
}
