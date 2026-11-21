/** package.json files, npm workspaces and declared dependencies. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageInfo {
  /** Directory relative to the repository root; `.` for the root package. */
  dir: string;
  name: string;
  version: string;
  private: boolean;
  /** Entry points declared in package.json: main/module/exports/bin/types. */
  entries: string[];
  dependencies: string[];
  devDependencies: string[];
  peerDependencies: string[];
  scripts: Record<string, string>;
  /** The package is listed in the root `workspaces` field. */
  workspace: boolean;
}

export interface PackageIndex {
  root: PackageInfo | null;
  packages: PackageInfo[];
  workspacePatterns: string[];
  /** Names of the repository's own packages, used to tell internal imports from external. */
  internalNames: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
}

function depNames(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

/** `packages/*` style patterns, matched against a directory path. Only `*` and `**`. */
function matchesPattern(dir: string, pattern: string): boolean {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const rx = new RegExp(
    `^${clean
      .split('/')
      .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
      .join('/')}$`,
  );
  return rx.test(dir);
}

function toInfo(dir: string, json: Record<string, unknown>, workspace: boolean): PackageInfo {
  return {
    dir,
    name: typeof json.name === 'string' ? json.name : dir === '.' ? 'root' : dir,
    version: typeof json.version === 'string' ? json.version : '',
    private: json.private === true,
    entries: [
      ...new Set(
        [...stringsOf(json.main), ...stringsOf(json.module), ...stringsOf(json.types), ...stringsOf(json.exports), ...stringsOf(json.bin)]
          .filter((e) => e.startsWith('.') || e.includes('/'))
          .map((e) => e.replace(/^\.\//, '')),
      ),
    ].sort(),
    dependencies: depNames(json.dependencies),
    devDependencies: depNames(json.devDependencies),
    peerDependencies: depNames(json.peerDependencies),
    scripts:
      json.scripts && typeof json.scripts === 'object' && !Array.isArray(json.scripts)
        ? (json.scripts as Record<string, string>)
        : {},
    workspace,
  };
}

export function indexPackages(root: string, files: string[]): PackageIndex {
  const manifests = files.filter((f) => f === 'package.json' || f.endsWith('/package.json'));
  const rootJson = manifests.includes('package.json') ? readJson(join(root, 'package.json')) : null;
  const workspacePatterns = rootJson
    ? (() => {
        const ws = rootJson.workspaces;
        if (Array.isArray(ws)) return ws.filter((w): w is string => typeof w === 'string');
        if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
          return ((ws as { packages: unknown[] }).packages).filter((w): w is string => typeof w === 'string');
        }
        return [];
      })()
    : [];

  const packages: PackageInfo[] = [];
  for (const manifest of manifests) {
    const dir = manifest === 'package.json' ? '.' : manifest.slice(0, -'/package.json'.length);
    const json = dir === '.' ? rootJson : readJson(join(root, manifest));
    if (!json) continue;
    const workspace = dir !== '.' && workspacePatterns.some((p) => matchesPattern(dir, p));
    packages.push(toInfo(dir, json, workspace));
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    root: packages.find((p) => p.dir === '.') ?? null,
    packages,
    workspacePatterns,
    internalNames: packages.filter((p) => p.dir !== '.').map((p) => p.name),
  };
}
