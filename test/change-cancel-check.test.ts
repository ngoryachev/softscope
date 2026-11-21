/**
 * Cancelling or discarding a change while the server runs a check must stop the check
 * itself, not only the `npm run` wrapper: the change otherwise stays "running" until the
 * script ends on its own, and discard removes the worktree under a live process that can
 * write into it again.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createApp } from '../src/server/http/app';
import { FakeSchemaAgent } from '../src/server/agent/fake';
import type { ChangeAgent, ChangeRunRequest } from '../src/server/agent/types';
import { detectChecks, runCheck } from '../src/server/change/checks';
import { RepoSession } from '../src/server/session';
import type { ChangeStatus } from '../src/shared/api';
import { agentGraph, cleanupTemps, copyFixtureAsGitRepo, gitOut, tempCache, tempWorkDir, waitFor } from './helpers';

afterAll(cleanupTemps);

const APP_ID = 'L4:root/app';
const LOGGING_ID = `L3:${APP_ID}/logging`;
const LOG_FILE = 'src/util/log.ts';

const l4Reply = agentGraph([
  { slug: 'app', kind: 'application', title: 'sample-app', paths: ['src'], hasDetail: true, evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 5 }] },
]);
const l3Reply = agentGraph([
  { slug: 'logging', title: 'logging', paths: ['src/util'], hasDetail: true, evidence: [{ file: LOG_FILE, startLine: 1, endLine: 3 }] },
]);

let repo: string;
let workDir: string;
type App = ReturnType<typeof createApp>['app'];

beforeEach(() => {
  repo = copyFixtureAsGitRepo();
  workDir = tempWorkDir();
});

/** Replaces the fixture's scripts with one slow `typecheck` that writes `marker` after `writeAfterMs` and exits after `lifeMs`. */
function slowTypecheck(marker: string, writeAfterMs: number, lifeMs: number): void {
  const pkgPath = join(repo, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
  const script =
    `console.log('${marker}');` +
    `setTimeout(() => require('fs').writeFileSync('late-output.txt', 'written by the check'), ${writeAfterMs});` +
    `setTimeout(() => {}, ${lifeMs})`;
  pkg.scripts = { typecheck: `node -e "${script}"` };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

/** The script processes carrying `marker`; pgrep's own `sh -c pgrep … marker` wrapper is not one of them. */
const alive = (marker: string) =>
  execSync(`pgrep -af -- "${marker}" || true`, { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes('node -e'))
    .join('\n')
    .trim();

function build(changeAgent: ChangeAgent): App {
  const schemaAgent = new FakeSchemaAgent({ replies: { 'L4:root': l4Reply, [`L3:${APP_ID}`]: l3Reply }, strict: true });
  const deps = { agent: schemaAgent, cache: tempCache(), changeAgent, workDir };
  const session = new RepoSession(repo, deps);
  return createApp({ ...deps, session }).app;
}

const post = (app: App, url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const status = async (app: App, id: string) => (await app.request(`/api/change/${id}`)).json() as Promise<ChangeStatus>;
const worktrees = (dir: string) => gitOut(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));

/** Starts a change whose agent edits instantly, and returns once the server runs the slow check. */
async function changeInCheckPhase(app: App, marker: string): Promise<ChangeStatus> {
  await app.request('/api/graph?level=L4&scope=root');
  await app.request(`/api/graph?level=L3&scope=${encodeURIComponent(APP_ID)}`);
  const res = await post(app, '/api/change', { nodeIds: [LOGGING_ID], edgeIds: [], task: 'change the logger' });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  // The script has printed its marker: the check process itself is running, not only npm.
  await waitFor(() => alive(marker).split('\n').some((l) => l.includes('node -e')), 10_000);
  return status(app, id);
}

const instantAgent: ChangeAgent = {
  name: 'instant',
  async run(req: ChangeRunRequest) {
    writeFileSync(join(req.workspaceDir, LOG_FILE), 'export function log() { return "changed"; }\n');
    return { summary: 'instant', changedFiles: [LOG_FILE], checks: [], scopeExpansion: null };
  },
};

describe('stopping a running check', () => {
  it('runCheck settles shortly after abort and the script process is gone', async () => {
    const marker = `softscope-abort-${process.pid}-a`;
    slowTypecheck(marker, 3000, 12_000);
    const check = detectChecks(repo)[0]!;
    expect(check.command).toBe('npm run typecheck');
    const controller = new AbortController();
    const started = Date.now();
    const pending = runCheck(check, repo, { signal: controller.signal });
    await waitFor(() => alive(marker).includes('node -e'), 10_000);
    controller.abort();
    const result = await pending;
    const settledAfter = Date.now() - started;
    expect(result.ok).toBe(false);
    // The script itself must be gone, not only the `npm run` wrapper around it.
    expect(alive(marker)).not.toContain('node -e');
    // SIGTERM, then SIGKILL after 2 s: anything beyond that means the script outlived the abort.
    expect(settledAfter).toBeLessThan(4000);
  }, 30_000);

  it('cancel during a check ends the change promptly instead of waiting for the script', async () => {
    const marker = `softscope-abort-${process.pid}-b`;
    slowTypecheck(marker, 2000, 20_000);
    const app = build(instantAgent);
    const running = await changeInCheckPhase(app, marker);
    expect(running.status).toBe('running');

    const started = Date.now();
    expect(await (await post(app, `/api/change/${running.id}/cancel`)).json()).toEqual({ cancelled: true });
    await waitFor(() => alive(marker) === '' || Date.now() - started > 6000, 10_000);
    let last: ChangeStatus | null = null;
    await waitFor(() => {
      void status(app, running.id).then((s) => (last = s));
      return last !== null && (last as ChangeStatus).status !== 'running';
    }, 8000).catch(() => {});
    expect(last && (last as ChangeStatus).status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(6000);
    expect(alive(marker)).toBe('');
  }, 30_000);

  it('discard during a check stops the script and does not wait out its grace period', async () => {
    const marker = `softscope-abort-${process.pid}-c`;
    slowTypecheck(marker, 7000, 9000);
    const app = build(instantAgent);
    const running = await changeInCheckPhase(app, marker);

    const started = Date.now();
    const res = await post(app, `/api/change/${running.id}/discard`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChangeStatus).status).toBe('discarded');
    const took = Date.now() - started;
    expect(existsSync(running.workspaceDir)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    // The worktree is gone, so nothing may still be running inside it.
    expect(alive(marker)).toBe('');
    // And discard should not have had to wait out its 5 s grace period for that.
    expect(took).toBeLessThan(4000);
  }, 40_000);
});
