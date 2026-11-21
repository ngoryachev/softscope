/**
 * The file list of the analyzed repository. `git ls-files` when there is a git repo,
 * a filesystem walk with ignore rules otherwise. No LLM involved (SPEC §4.4).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isGitRepo } from './git';

/** Directories a walk never descends into. Generated output and vendored code. */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
  '.idea',
  '.vscode',
  '.gradle',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const MAX_FILES = 20_000;

export function isCodeFile(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  const dot = path.lastIndexOf('.');
  return dot >= 0 && CODE_EXTENSIONS.has(path.slice(dot));
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function gitFiles(root: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\0')
    .filter((p) => p.length > 0)
    // `git ls-files -o` still lists files inside an ignored-by-us directory when the
    // repository does not .gitignore it (a committed fixture, for instance).
    .filter((p) => !p.split('/').some((part) => IGNORED_DIRS.has(part)));
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(toPosix(relative(root, full)));
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

export interface FileList {
  /** Repository-relative POSIX paths. */
  files: string[];
  /** The subset that is TypeScript/JavaScript source. */
  codeFiles: string[];
  source: 'git' | 'walk';
  /** The listing hit MAX_FILES and is incomplete. */
  truncated: boolean;
  /**
   * The directory sits inside a git repository that excludes it, so git listed nothing
   * and the walk took over. Worth saying out loud: otherwise the user just sees an
   * empty graph with no explanation.
   */
  ignoredByGit: boolean;
}

export function listFiles(root: string): FileList {
  const fromGit = isGitRepo(root) ? gitFiles(root) : null;
  // git lists nothing for a directory its repository ignores. Fall back to the walk
  // instead of reporting an empty project.
  const walked = fromGit === null || fromGit.length === 0 ? walk(root) : null;
  const files = (walked ?? fromGit ?? []).sort();
  const capped = files.slice(0, MAX_FILES);
  return {
    files: capped,
    codeFiles: capped.filter(isCodeFile),
    source: walked === null ? 'git' : 'walk',
    truncated: files.length > capped.length,
    ignoredByGit: fromGit !== null && fromGit.length === 0 && files.length > 0,
  };
}

/** The path with every symlink resolved, or null when it does not exist. */
function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * True when `abs` really lives inside `root`, symlinks followed — a link committed in the
 * repository can point outside it, which a lexical path check cannot see.
 *
 * A path that does not exist is accepted here: whether it is missing is a separate
 * question from whether it escapes, and the callers report the two differently.
 */
export function staysInsideRepo(root: string, abs: string): boolean {
  const realRoot = realPathOf(root);
  const real = realPathOf(abs);
  if (realRoot === null || real === null) return true;
  const rel = relative(realRoot, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Files under any of `paths`; a path that is a file matches itself (scope filtering). */
export function filesUnder(files: string[], paths: string[]): string[] {
  if (paths.length === 0 || paths.includes('.')) return files;
  const prefixes = paths.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
  return files.filter((f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`)));
}
