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
import { cleanupTemps, commitAll, copyFixtureAsGitRepo, gitOut, tempWorkDir } from './helpers';

afterAll(cleanupTemps);

/**
 * Dirty the user's tree, create the workspace, edit one more file there and check that the
 * resulting patch is accepted by the user's tree. `exactCopy` compares the reproduced dirty
 * file byte for byte; `core.autocrlf=true` legitimately checks the worktree out with CRLF,
 * so that test only asks for the dirty line to be present.
 */
function roundTrip(repo: string, id: string, exactCopy = true): void {
  const original = readFileSync(join(repo, 'src/cli.ts'), 'utf8');
  const dirty = original.replace(/\n/, ' // dirty\n');
  writeFileSync(join(repo, 'src/cli.ts'), dirty);

  const { dir } = createWorkspace({ repoPath: repo, id, workDir: tempWorkDir() });
  const reproduced = readFileSync(join(dir, 'src/cli.ts'), 'utf8');
  if (exactCopy) expect(reproduced).toBe(dirty);
  else expect(reproduced).toContain('// dirty');

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

  // Settings that shape `git diff` or `git apply` output and are covered either by an
  // explicit flag or by the GIT_OVERRIDES list.
  const settings: [string, string][] = [
    ['diff.algorithm', 'patience'],
    ['diff.algorithm', 'histogram'],
    ['diff.renames', 'copies'],
    ['diff.interHunkContext', '50'],
    ['diff.context', '10'],
    ['diff.indentHeuristic', 'false'],
    ['diff.srcPrefix', 'x/'],
    ['diff.dstPrefix', 'y/'],
    ['diff.mnemonicPrefix', 'true'],
    ['diff.relative', 'true'],
    ['diff.external', 'nonexistent-differ'],
    ['diff.colorMoved', 'zebra'],
    ['color.ui', 'always'],
    ['color.diff', 'always'],
    ['apply.whitespace', 'error-all'],
    ['apply.ignoreWhitespace', 'change'],
    ['core.whitespace', 'trailing-space,space-before-tab,indent-with-non-tab'],
    ['core.autocrlf', 'input'],
    ['core.quotePath', 'false'],
    ['core.abbrev', '4'],
  ];
  for (const [key, value] of settings) {
    it(`round-trips with ${key}=${value}`, () => {
      const repo = copyFixtureAsGitRepo();
      gitOut(repo, ['config', key, value]);
      roundTrip(repo, key.replace(/\./g, '-'));
    });
  }

  it('round-trips with core.autocrlf=true (the worktree is checked out with CRLF, the patch is LF)', () => {
    const repo = copyFixtureAsGitRepo();
    gitOut(repo, ['config', 'core.autocrlf', 'true']);
    roundTrip(repo, 'crlf', false);
  });

  it('round-trips with GIT_EXTERNAL_DIFF set in the environment', () => {
    const repo = copyFixtureAsGitRepo();
    process.env.GIT_EXTERNAL_DIFF = '/nonexistent/differ';
    try {
      roundTrip(repo, 'ext-env');
    } finally {
      delete process.env.GIT_EXTERNAL_DIFF;
    }
  });

  // A `diff=<driver>` attribute with `diff.<driver>.textconv` (e.g. `*.pdf diff=pdf` with
  // pdftotext) makes `git diff` emit the converted text instead of the file contents; such a
  // patch cannot be applied. `--no-textconv` restores the real diff.
  it('reproduces the uncommitted state and applies the result with a textconv diff driver', () => {
    const repo = copyFixtureAsGitRepo();
    writeFileSync(join(repo, '.gitattributes'), '*.ts diff=upper\n');
    commitAll(repo, 'diff driver');
    gitOut(repo, ['config', 'diff.upper.textconv', 'tr a-z A-Z <']);
    roundTrip(repo, 'textconv');
  });
});
