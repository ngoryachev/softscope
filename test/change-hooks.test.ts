/**
 * The worktree bookkeeping must not depend on the user's git configuration: commit hooks
 * (husky-style `core.hooksPath`, including the ones `--no-verify` does not bypass), a
 * signing requirement without a key, `user.useConfigOnly` without an identity, and
 * `diff.noprefix`, which strips the `a/` `b/` prefixes `git apply -p1` relies on.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPatch, createWorkspace, removeWorkspace, workspaceDiff } from '../src/server/change/workspace';
import { parseUnifiedDiff } from '../src/shared/diff';
import { cleanupTemps, copyFixtureAsGitRepo, gitOut, tempWorkDir } from './helpers';

afterAll(cleanupTemps);

function installHooks(repo: string, log: string): void {
  const hooks = join(repo, '.githooks');
  mkdirSync(hooks, { recursive: true });
  // Not bypassed by --no-verify: a failing prepare-commit-msg (commitizen-style prompts fail without a TTY).
  writeFileSync(join(hooks, 'prepare-commit-msg'), `#!/bin/sh\necho prepare-commit-msg >> "${log}"\nexit 1\n`);
  writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\necho post-commit >> "${log}"\n`);
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho post-checkout >> "${log}"\n`);
  for (const h of ['prepare-commit-msg', 'post-commit', 'post-checkout']) chmodSync(join(hooks, h), 0o755);
  gitOut(repo, ['config', 'core.hooksPath', '.githooks']);
}

describe('createWorkspace and the user’s commit setup', () => {
  it('records the base state even when the repository’s hooks would fail or have side effects', () => {
    const repo = copyFixtureAsGitRepo();
    const workDir = tempWorkDir();
    const log = join(workDir, 'hooks.log');
    installHooks(repo, log);
    writeFileSync(join(repo, 'src/util/log.ts'), 'export function log() { return "dirty"; }\n');

    const { dir } = createWorkspace({ repoPath: repo, id: 'hooks', workDir });
    expect(existsSync(dir)).toBe(true);
    expect(workspaceDiff(dir)).toBe('');
    writeFileSync(join(dir, 'src/util/log.ts'), 'export function log() { return "changed"; }\n');
    expect(parseUnifiedDiff(workspaceDiff(dir)).map((f) => [f.path, f.status])).toEqual([['src/util/log.ts', 'modified']]);
    // The user's hooks are theirs: the server's bookkeeping commit must not trigger them.
    const ran = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    expect(ran.filter((h) => h !== 'post-checkout')).toEqual([]);
    removeWorkspace(repo, dir);
  });

  it('records the base state when commits must be signed and no identity is configured', () => {
    const repo = copyFixtureAsGitRepo();
    gitOut(repo, ['config', 'commit.gpgsign', 'true']);
    gitOut(repo, ['config', 'user.signingkey', 'DEADBEEF00000000']);
    gitOut(repo, ['config', 'user.useConfigOnly', 'true']);
    gitOut(repo, ['config', '--unset', 'user.name']);
    gitOut(repo, ['config', '--unset', 'user.email']);
    const head = gitOut(repo, ['rev-parse', 'HEAD']).trim();

    const { dir } = createWorkspace({ repoPath: repo, id: 'signed', workDir: tempWorkDir() });
    expect(workspaceDiff(dir)).toBe('');
    expect(gitOut(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    removeWorkspace(repo, dir);
  });
});

describe('createWorkspace and the user’s diff setup', () => {
  it('reproduces the uncommitted state and applies the result with diff.noprefix=true', () => {
    const repo = copyFixtureAsGitRepo();
    gitOut(repo, ['config', 'diff.noprefix', 'true']);
    writeFileSync(join(repo, 'src/cli.ts'), 'export const cli = "dirty";\n');

    const { dir } = createWorkspace({ repoPath: repo, id: 'noprefix', workDir: tempWorkDir() });
    expect(readFileSync(join(dir, 'src/cli.ts'), 'utf8')).toBe('export const cli = "dirty";\n');
    writeFileSync(join(dir, 'src/util/log.ts'), 'export function log() { return "changed"; }\n');
    const patch = workspaceDiff(dir);
    expect(parseUnifiedDiff(patch).map((f) => [f.path, f.status])).toEqual([['src/util/log.ts', 'modified']]);
    expect(checkPatch(repo, patch)).toBeNull();
    removeWorkspace(repo, dir);
  });
});
