/** Shared test plumbing: temporary copies of the fixture repository and a temp cache. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentBehavior, AgentGraph } from '../src/shared/agent-schema';
import type { BehaviorInfo } from '../src/shared/graph';
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

/** A parent directory for change worktrees, outside every fixture copy. */
export function tempWorkDir(): string {
  return temp('work');
}

/** `git <args>` in `cwd`; stdout, or a thrown error. */
export function gitOut(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Polls `condition` until it holds; the agent is reached only after a few awaited ticks. */
export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The JSON payloads of an SSE body. */
export const sseEvents = (body: string) =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; [k: string]: unknown });

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
  /** L1: initial | final | state, participant, start | end | step | decision. */
  role?: string;
}

export interface EdgeSpec {
  from: string;
  to: string;
  kind?: string;
  label?: string;
  evidence?: Array<{ file: string; startLine: number; endLine: number }>;
  confirmed?: boolean;
  reason?: string;
  /** L1 sequence: 1-based message position. */
  order?: number;
  /** L1 sequence: sync | async | return. */
  style?: string;
  /** L1 sequence: branch or loop label. */
  group?: string;
}

/** What every L4–L2 view and every supported L1 view carries. */
export const SUPPORTED: BehaviorInfo = { supported: true, reason: '' };

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
      role: n.role ?? '',
    })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind ?? 'imports',
      label: e.label ?? '',
      evidence: (e.evidence ?? [{ file: 'package.json', startLine: 1, endLine: 1 }]).map((ev) => ({
        ...ev,
        note: '',
      })),
      confirmed: e.confirmed ?? true,
      reason: e.reason ?? '',
      order: e.order ?? 0,
      style: e.style ?? '',
      group: e.group ?? '',
    })),
    behavior: { supported: true, reason: '' },
    ...extra,
  };
}

/** An L1 reply: a behaviour kind with its states/participants/steps, or `unsupported` with a reason. */
export function l1Graph(
  kind: 'state-machine' | 'sequence' | 'flow' | 'unsupported',
  nodes: NodeSpec[],
  edges: EdgeSpec[] = [],
  behavior: AgentBehavior = kind === 'unsupported' ? { supported: false, reason: 'no reason given' } : { supported: true, reason: '' },
): AgentGraph {
  return agentGraph(nodes, edges, { diagramKind: kind, behavior });
}
