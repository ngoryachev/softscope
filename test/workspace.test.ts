/**
 * The worktree isolation and the check runner on their own, below the HTTP layer: the
 * refusals the endpoint tests do not reach, deletions in the diff, runner detection, the
 * output tail and the per-check timeout.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { detectChecks, detectRunner, runCheck, tailOf } from '../src/server/change/checks';
import { createWorkspace, removeWorkspace, workspaceDiff, WorkspaceRefusedError } from '../src/server/change/workspace';
import { parseUnifiedDiff } from '../src/shared/diff';
import { cleanupTemps, copyFixture, copyFixtureAsGitRepo, gitOut, tempWorkDir } from './helpers';

afterAll(cleanupTemps);

describe('createWorkspace', () => {
  it('refuses a subdirectory of a repository and a repository without a commit', () => {
    const repo = copyFixtureAsGitRepo();
    expect(() => createWorkspace({ repoPath: join(repo, 'src'), id: 'sub', workDir: tempWorkDir() })).toThrow(
      /subdirectory of the repository/,
    );

    const empty = copyFixture();
    spawnSync('git', ['init', '--quiet'], { cwd: empty });
    expect(() => createWorkspace({ repoPath: empty, id: 'unborn', workDir: tempWorkDir() })).toThrow(/no commit yet/);
    expect(() => createWorkspace({ repoPath: empty, id: 'unborn', workDir: tempWorkDir() })).toThrow(WorkspaceRefusedError);
    expect(() => createWorkspace({ repoPath: copyFixture(), id: 'plain', workDir: tempWorkDir() })).toThrow(/not a git repository/);
  });

  it('refuses a work directory inside the repository', () => {
    const repo = copyFixtureAsGitRepo();
    expect(() => createWorkspace({ repoPath: repo, id: 'in', workDir: join(repo, '.changes') })).toThrow(/must not live inside/);
    expect(gitOut(repo, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('reports a deleted and a new file in the diff against the recorded base, then removes cleanly', () => {
    const repo = copyFixtureAsGitRepo();
    const { dir, startSnapshot } = createWorkspace({ repoPath: repo, id: 'del', workDir: tempWorkDir() });
    expect(startSnapshot.dirty).toBe(false);
    expect(workspaceDiff(dir)).toBe('');

    rmSync(join(dir, 'src/cli.ts'));
    mkdirSync(join(dir, 'src/new'), { recursive: true });
    writeFileSync(join(dir, 'src/new/thing.ts'), 'export const thing = 1;\n');
    const files = parseUnifiedDiff(workspaceDiff(dir));
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/cli.ts', 'deleted'],
      ['src/new/thing.ts', 'added'],
    ]);
    // The user's tree saw none of it.
    expect(existsSync(join(repo, 'src/cli.ts'))).toBe(true);
    expect(existsSync(join(repo, 'src/new'))).toBe(false);

    removeWorkspace(repo, dir);
    expect(existsSync(dir)).toBe(false);
    expect(gitOut(repo, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('forgets a file that was created and removed again between two diffs, and never touches the user branch', () => {
    const repo = copyFixtureAsGitRepo();
    const head = gitOut(repo, ['rev-parse', 'HEAD']).trim();
    const { dir } = createWorkspace({ repoPath: repo, id: 'tmpfile', workDir: tempWorkDir() });

    writeFileSync(join(dir, 'src/util/created.ts'), 'export const c = 1;\n');
    expect(parseUnifiedDiff(workspaceDiff(dir)).map((f) => f.path)).toEqual(['src/util/created.ts']);
    rmSync(join(dir, 'src/util/created.ts'));
    writeFileSync(join(dir, 'src/util/log.ts'), 'export function log() {}\n');
    // Only the edit is left: no stale "deleted" entry for the file that never reached the base.
    expect(parseUnifiedDiff(workspaceDiff(dir)).map((f) => [f.path, f.status])).toEqual([['src/util/log.ts', 'modified']]);

    expect(gitOut(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
    removeWorkspace(repo, dir);
  });

  it('skips an untracked nested repository instead of failing on it', () => {
    const repo = copyFixtureAsGitRepo();
    mkdirSync(join(repo, 'vendor-clone'));
    spawnSync('git', ['init', '--quiet'], { cwd: join(repo, 'vendor-clone') });
    writeFileSync(join(repo, 'vendor-clone/readme.txt'), 'not part of this repository\n');
    writeFileSync(join(repo, 'src/extra.ts'), 'export const extra = 1;\n');
    expect(gitOut(repo, ['ls-files', '--others', '--exclude-standard'])).toContain('vendor-clone/');

    const { dir } = createWorkspace({ repoPath: repo, id: 'nested', workDir: tempWorkDir() });
    expect(existsSync(join(dir, 'src/extra.ts'))).toBe(true);
    expect(existsSync(join(dir, 'vendor-clone'))).toBe(false);
    expect(workspaceDiff(dir)).toBe('');
    removeWorkspace(repo, dir);
  });
});

describe('checks', () => {
  it('detects the scripts and the runner from the lockfile', () => {
    const dir = copyFixture();
    expect(detectRunner(dir)).toBe('npm');
    expect(detectChecks(dir).map((c) => c.command)).toEqual(['npm run typecheck', 'npm run lint', 'npm run test']);

    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectChecks(dir)[0]!.argv).toEqual(['yarn', 'run', 'typecheck']);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectRunner(dir)).toBe('pnpm');

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: '' } }));
    expect(detectChecks(dir)).toEqual([]);
    rmSync(join(dir, 'package.json'));
    expect(detectChecks(dir)).toEqual([]);
  });

  it('keeps only the tail of the output and stops a check that exceeds its timeout', async () => {
    expect(tailOf('a\nb\nc\n', 2)).toBe('b\nc');
    expect(tailOf('a\r\nb\r\n', 5)).toBe('a\nb');

    const dir = copyFixture();
    const node = process.execPath;
    const slow = await runCheck(
      { name: 'test', command: 'node slow', argv: [node, '-e', 'console.log("started"); setTimeout(() => {}, 60000)'] },
      dir,
      { timeoutMs: 300, tailLines: 50 },
    );
    expect(slow).toMatchObject({ name: 'test', ok: false, timedOut: true });
    expect(slow.outputTail).toContain('started');
    expect(slow.outputTail).toContain('was stopped');

    const noisy = await runCheck(
      { name: 'lint', command: 'node noisy', argv: [node, '-e', 'for (let i = 0; i < 500; i++) console.log("line " + i); process.exit(3)'] },
      dir,
      { tailLines: 10 },
    );
    expect(noisy).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect(noisy.outputTail.split('\n')).toHaveLength(10);
    expect(noisy.outputTail).toContain('line 499');
    expect(noisy.outputTail).not.toContain('line 0\n');

    const missing = await runCheck({ name: 'x', command: 'nope', argv: ['definitely-not-a-command-xyz'] }, dir, {});
    expect(missing.ok).toBe(false);
    expect(missing.outputTail).toContain('could not run');
  });
});
