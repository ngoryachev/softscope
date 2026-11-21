/** Shared test plumbing: temporary copies of the fixture repository and a temp cache. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentGraph } from '../src/shared/agent-schema';
import { FileCache } from '../src/server/cache/file-cache';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = resolve(here, 'fixtures', 'sample-app');

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `softscope-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** Removes everything the tests created. `/tmp` lives on a small partition here. */
export function cleanupTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The fixture copied outside any git repository, so the filesystem walk is exercised. */
export function copyFixture(): string {
  const dir = join(temp('repo'), 'sample-app');
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** The fixture as a real git repository with one commit. */
export function copyFixtureAsGitRepo(): string {
  const dir = copyFixture();
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'SoftZoom Test']);
  git(dir, ['add', '-A', '-f']);
  git(dir, ['commit', '--quiet', '-m', 'fixture']);
  return dir;
}

/** Detached checkout of an earlier commit. */
export function gitCheckout(dir: string, ref: string): void {
  git(dir, ['checkout', '--quiet', '--force', ref]);
}

/** A new branch at the same commit: the code is unchanged, only the label moves. */
export function switchToNewBranch(dir: string, name: string): void {
  git(dir, ['checkout', '--quiet', '-b', name]);
}

export function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A', '-f']);
  git(dir, ['commit', '--quiet', '-m', message]);
}

export function tempCache(): FileCache {
  return new FileCache(temp('cache'));
}

export interface NodeSpec {
  slug: string;
  title?: string;
  kind?: string;
  evidence?: Array<{ file: string; startLine: number; endLine: number }>;
  boundary?: boolean;
  subsystemId?: string;
  memberOf?: string[];
  paths?: string[];
  hasDetail?: boolean;
}

export interface EdgeSpec {
  from: string;
  to: string;
  kind?: string;
  evidence?: Array<{ file: string; startLine: number; endLine: number }>;
  confirmed?: boolean;
  reason?: string;
}

/** Builds an agent reply without repeating every required field in each test. */
export function agentGraph(nodes: NodeSpec[], edges: EdgeSpec[] = [], extra?: Partial<AgentGraph>): AgentGraph {
  return {
    diagramKind: 'component-graph',
    notes: [],
    nodes: nodes.map((n) => ({
      slug: n.slug,
      kind: n.kind ?? 'subsystem',
      title: n.title ?? n.slug,
      summary: `${n.slug} summary`,
      evidence: (n.evidence ?? [{ file: 'package.json', startLine: 1, endLine: 1 }]).map((e) => ({
        ...e,
        note: '',
      })),
      boundary: n.boundary ?? false,
      subsystemId: n.subsystemId ?? '',
      memberOf: n.memberOf ?? [],
      paths: n.paths ?? [],
      hasDetail: n.hasDetail ?? false,
    })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind ?? 'imports',
      label: '',
      evidence: (e.evidence ?? [{ file: 'package.json', startLine: 1, endLine: 1 }]).map((ev) => ({
        ...ev,
        note: '',
      })),
      confirmed: e.confirmed ?? true,
      reason: e.reason ?? '',
    })),
    ...extra,
  };
}
