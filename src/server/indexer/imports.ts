/**
 * File-to-file import graph. Specifiers come from the TypeScript compiler's
 * `preProcessFile` scanner (no type checking, no program), and are resolved against the
 * indexed file list, tsconfig path aliases and workspace package names.
 *
 * This is cheap input for the agent — a set of potential relations, not a schema.
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import type { PackageIndex } from './packages';
import type { TsconfigIndex } from './tsconfig';

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_FILE_BYTES = 1_500_000;

export interface FileImports {
  file: string;
  /** Repository-relative files this file imports. */
  internal: string[];
  /** Package names this file imports from outside the repository. */
  external: string[];
  /** Specifiers that could not be resolved to either (dynamic or generated code). */
  unresolved: string[];
}

export interface ImportGraph {
  files: FileImports[];
  /** `file -> importers`, so the agent can see what depends on a module. */
  importedBy: Record<string, string[]>;
  /** External package names with how many files import them, most used first. */
  externals: Array<{ name: string; count: number }>;
}

function specifiers(root: string, file: string): string[] {
  let text: string;
  try {
    const abs = join(root, file);
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  if (text.length > MAX_FILE_BYTES) return [];
  const pre = ts.preProcessFile(text, true, true);
  return [...pre.importedFiles, ...pre.referencedFiles].map((f) => f.fileName);
}

/** Resolve one candidate module path against the indexed files. */
function resolveCandidate(known: Set<string>, candidate: string): string | null {
  const clean = posix.normalize(candidate);
  if (clean.startsWith('..')) return null;
  if (known.has(clean)) return clean;
  // An explicit .js specifier in TypeScript source points at the .ts file.
  const jsRewrite = clean.replace(/\.(js|jsx|mjs|cjs)$/, '');
  for (const base of clean === jsRewrite ? [clean] : [jsRewrite, clean]) {
    for (const ext of RESOLVE_EXTENSIONS) {
      if (known.has(`${base}${ext}`)) return `${base}${ext}`;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      if (known.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
  }
  return null;
}

function aliasTargets(tsconfigs: TsconfigIndex, specifier: string): string[] {
  const out: string[] = [];
  for (const config of tsconfigs.configs) {
    for (const [pattern, targets] of Object.entries(config.paths)) {
      if (pattern.includes('*')) {
        const [head = '', tail = ''] = pattern.split('*');
        if (!specifier.startsWith(head) || !specifier.endsWith(tail)) continue;
        const middle = specifier.slice(head.length, specifier.length - tail.length);
        out.push(...targets.map((t) => t.replace('*', middle)));
      } else if (pattern === specifier) {
        out.push(...targets);
      }
    }
  }
  return out;
}

/**
 * Candidates for a bare specifier that resolves against a tsconfig `baseUrl` — the
 * other way a repository imports its own code without a relative path or an alias.
 * Without this, such an import would be tallied as an external dependency, and L4 draws
 * significant external dependencies as boundary nodes.
 */
function baseUrlTargets(tsconfigs: TsconfigIndex, specifier: string): string[] {
  return tsconfigs.configs
    .flatMap((c) => (c.baseUrl === null ? [] : [posix.join(c.baseUrl === '.' ? '' : c.baseUrl, specifier)]))
    .filter((t) => !t.startsWith('..'));
}

export function externalPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0]!;
}

export function buildImportGraph(
  root: string,
  codeFiles: string[],
  allFiles: string[],
  packages: PackageIndex,
  tsconfigs: TsconfigIndex,
): ImportGraph {
  const known = new Set(allFiles);
  // Longest package name first, so `@scope/ui-core` wins over `@scope/ui`.
  const workspaces = packages.packages
    .filter((p) => p.dir !== '.')
    .sort((a, b) => b.name.length - a.name.length);

  const files: FileImports[] = [];
  const importedBy: Record<string, string[]> = {};
  const externalCounts = new Map<string, number>();

  for (const file of codeFiles) {
    const dir = posix.dirname(file);
    const internal = new Set<string>();
    const external = new Set<string>();
    const unresolved = new Set<string>();

    for (const specifier of specifiers(root, file)) {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) {
        external.add(specifier);
        continue;
      }
      if (specifier.startsWith('.')) {
        const hit = resolveCandidate(known, posix.join(dir, specifier));
        if (hit) internal.add(hit);
        else unresolved.add(specifier);
        continue;
      }
      const aliased = aliasTargets(tsconfigs, specifier)
        .map((t) => resolveCandidate(known, t))
        .find((t): t is string => t !== null);
      if (aliased) {
        internal.add(aliased);
        continue;
      }
      const pkg = workspaces.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
      if (pkg) {
        const subpath = specifier.slice(pkg.name.length).replace(/^\//, '');
        const candidates = subpath
          ? [posix.join(pkg.dir, subpath)]
          : [...pkg.entries.map((e) => posix.join(pkg.dir, e)), posix.join(pkg.dir, 'src'), pkg.dir];
        const hit = candidates
          .map((c) => resolveCandidate(known, c))
          .find((c): c is string => c !== null);
        if (hit) internal.add(hit);
        else unresolved.add(specifier);
        continue;
      }
      // Tried after the workspace packages: a package name is a stronger signal than a
      // directory that happens to sit under baseUrl with the same name.
      const fromBaseUrl = baseUrlTargets(tsconfigs, specifier)
        .map((t) => resolveCandidate(known, t))
        .find((t): t is string => t !== null);
      if (fromBaseUrl) {
        internal.add(fromBaseUrl);
        continue;
      }
      external.add(externalPackageName(specifier));
    }

    for (const target of internal) (importedBy[target] ??= []).push(file);
    for (const name of external) externalCounts.set(name, (externalCounts.get(name) ?? 0) + 1);
    files.push({
      file,
      internal: [...internal].sort(),
      external: [...external].sort(),
      unresolved: [...unresolved].sort(),
    });
  }

  for (const importers of Object.values(importedBy)) importers.sort();
  const externals = [...externalCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { files, importedBy, externals };
}
