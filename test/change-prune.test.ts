/**
 * Startup cleanup of leftover change worktrees (`pruneLeftoverWorkspaces`, run by every
 * new `RepoSession`): it must only ever remove drafts SoftZoom made, never the user's
 * repository or the worktrees the user created themselves — even when the work
 * directory (`SOFTSCOPE_WORK_DIR`) happens to contain the repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FakeSchemaAgent } from '../src/server/agent/fake';
import { FakeChangeAgent } from '../src/server/agent/fake-change';
import { pruneLeftoverWorkspaces } from '../src/server/change/workspace';
import { RepoSession } from '../src/server/session';
import { cleanupTemps, copyFixtureAsGitRepo, gitOut, tempCache } from './helpers';

afterEach(cleanupTemps);

const worktrees = (dir: string) => gitOut(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));

describe('pruneLeftoverWorkspaces with the repository under the work directory', () => {
  it('never removes the main worktree (the user repository itself)', () => {
    const repo = copyFixtureAsGitRepo();
    // SOFTSCOPE_WORK_DIR set to a directory that also contains the repository.
    const workDir = dirname(repo);

    pruneLeftoverWorkspaces(repo, workDir, []);

    expect(existsSync(join(repo, 'package.json'))).toBe(true);
    expect(gitOut(repo, ['status', '--porcelain']).trim()).toBe('');
  });

  it('leaves a worktree the user created under the work directory alone', () => {
    const repo = copyFixtureAsGitRepo();
    const workDir = dirname(repo);
    const own = join(workDir, 'my-feature');
    gitOut(repo, ['worktree', 'add', '--detach', own, 'HEAD']);
    expect(worktrees(repo)).toHaveLength(2);

    pruneLeftoverWorkspaces(repo, workDir, []);

    expect(existsSync(join(own, 'package.json'))).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);
  });

  it('opening a session over such a work directory keeps the repository intact', () => {
    const repo = copyFixtureAsGitRepo();
    const workDir = dirname(repo);

    new RepoSession(repo, { agent: new FakeSchemaAgent(), cache: tempCache(), changeAgent: new FakeChangeAgent(), workDir });

    expect(existsSync(join(repo, 'package.json'))).toBe(true);
    expect(existsSync(join(repo, '.git'))).toBe(true);
  });
});
