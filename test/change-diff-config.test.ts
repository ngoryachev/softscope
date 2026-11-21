/**
 * More of the user's `diff.*` settings the bookkeeping patches must survive: the worktree
 * shares the repository's config, so a setting that shapes `git diff` output shapes both
 * the patch that reproduces the uncommitted state and the patch Apply places back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPatch, createWorkspace, removeWorkspace, workspaceDiff } from '../src/server/change/workspace';
import { parseUnifiedDiff } from '../src/shared/diff';
import { cleanupTemps, copyFixtureAsGitRepo, gitOut, tempWorkDir } from './helpers';

afterAll(cleanupTemps);

function roundTrip(repo: string, id: string): void {
  // A tracked file edited in the user's tree must be reproduced in the worktree...
  const original = readFileSync(join(repo, 'src/cli.ts'), 'utf8');
  const dirty = original.replace(/\n/, ' // dirty\n');
  writeFileSync(join(repo, 'src/cli.ts'), dirty);

  const { dir } = createWorkspace({ repoPath: repo, id, workDir: tempWorkDir() });
  expect(readFileSync(join(dir, 'src/cli.ts'), 'utf8')).toBe(dirty);

  // ...and a one-line edit made there must come back as a patch the user's tree accepts.
  const log = readFileSync(join(dir, 'src/util/log.ts'), 'utf8');
  writeFileSync(join(dir, 'src/util/log.ts'), log.replace(/\n/, ' // changed\n'));
  const patch = workspaceDiff(dir);
  expect(parseUnifiedDiff(patch).map((f) => [f.path, f.status])).toEqual([['src/util/log.ts', 'modified']]);
  expect(checkPatch(repo, patch)).toBeNull();
  removeWorkspace(repo, dir);
}

describe('createWorkspace and the user’s diff.* settings', () => {
  it('reproduces the uncommitted state and applies the result with diff.context=0', () => {
    const repo = copyFixtureAsGitRepo();
    gitOut(repo, ['config', 'diff.context', '0']);
    roundTrip(repo, 'ctx0');
  });

  it('reproduces the uncommitted state and applies the result with diff.suppressBlankEmpty=true', () => {
    const repo = copyFixtureAsGitRepo();
    gitOut(repo, ['config', 'diff.suppressBlankEmpty', 'true']);
    roundTrip(repo, 'blank');
  });
});
