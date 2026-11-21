import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, utimesSync } from 'node:fs';
import { buildIndex } from '../src/server/indexer/index';
import { listFiles } from '../src/server/indexer/files';
import { parseJsonc } from '../src/server/indexer/tsconfig';
import { repoSnapshot } from '../src/server/indexer/git';
import { rootScope } from '../src/shared/graph';
import { summarizeForAgent } from '../src/server/indexer/index';
import { cleanupTemps, copyFixture, copyFixtureAsGitRepo } from './helpers';

afterAll(cleanupTemps);

describe('file listing', () => {
  it('walks a directory that is not a git repository and skips generated trees', () => {
    const repo = copyFixture();
    const { files, codeFiles, source } = listFiles(repo);

    expect(source).toBe('walk');
    expect(files).toContain('src/index.ts');
    expect(files).toContain('packages/core/src/math.ts');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
    expect(codeFiles).not.toContain('README.md');
    expect(codeFiles).toContain('packages/ui/src/index.tsx');
  });

  it('uses git ls-files inside a git repository', () => {
    const repo = copyFixtureAsGitRepo();
    const { files, source } = listFiles(repo);

    expect(source).toBe('git');
    expect(files).toContain('src/util/log.ts');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('a subdirectory of a repository', () => {
  it('indexes only that subdirectory, with paths relative to it', () => {
    const outer = copyFixtureAsGitRepo();
    const index = buildIndex(`${outer}/packages/core`);

    expect(index.fileSource).toBe('git');
    expect(index.name).toBe('@sample/core');
    expect(index.files).toContain('src/math.ts');
    expect(index.files.some((f) => f.startsWith('packages/'))).toBe(false);
    expect(index.imports.files.find((f) => f.file === 'src/index.ts')?.internal).toEqual(['src/math.ts']);
  });
});

describe('packages', () => {
  it('reads the root manifest, the workspace patterns and the per-package dependencies', () => {
    const index = buildIndex(copyFixture());
    const { packages } = index;

    expect(index.name).toBe('sample-app');
    expect(packages.workspacePatterns).toEqual(['packages/*']);
    expect(packages.root?.dependencies).toEqual(['hono']);
    expect(packages.root?.devDependencies).toEqual(['typescript']);

    const core = packages.packages.find((p) => p.name === '@sample/core');
    expect(core).toMatchObject({ dir: 'packages/core', workspace: true, dependencies: ['zod'] });

    const ui = packages.packages.find((p) => p.name === '@sample/ui');
    expect(ui?.workspace).toBe(true);
    expect(packages.internalNames.sort()).toEqual(['@sample/core', '@sample/ui']);
  });
});

describe('tsconfig', () => {
  it('reads the baseUrl and the path aliases through comments and trailing commas', () => {
    const index = buildIndex(copyFixture());
    expect(index.tsconfigs.root?.baseUrl).toBe('.');
    expect(index.tsconfigs.root?.paths).toEqual({ '@app/*': ['src/*'] });
  });
});

describe('tsconfig parsing', () => {
  it('strips comments and trailing commas without editing string values', () => {
    expect(
      parseJsonc('{\n  // a line comment\n  /* and a block */\n  "a": [1, 2, ],\n  "b": { "c": 1, },\n}'),
    ).toEqual({ a: [1, 2], b: { c: 1 } });
    // The trailing-comma strip used to run over the whole document, including strings.
    expect(parseJsonc('{"glob": "src/**/*.ts, }"}')).toEqual({ glob: 'src/**/*.ts, }' });
  });
});

describe('import graph', () => {
  const index = buildIndex(copyFixture());
  const importsOf = (file: string) => index.imports.files.find((f) => f.file === file);

  it('resolves relative, aliased and workspace specifiers to files', () => {
    const entry = importsOf('src/index.ts');
    expect(entry?.internal).toEqual([
      'packages/core/src/index.ts', // workspace package name -> its main entry
      'src/server/http.ts', // relative
      'src/util/log.ts', // tsconfig path alias @app/*
    ]);
  });

  it('resolves a bare specifier through tsconfig baseUrl instead of calling it external', () => {
    const cli = importsOf('src/cli.ts');
    expect(cli?.internal).toEqual(['src/index.ts', 'src/util/log.ts']);
    expect(cli?.external).toEqual([]);
    expect(index.imports.externals.map((e) => e.name)).not.toContain('src');
  });

  it('records external packages and node builtins separately', () => {
    expect(importsOf('src/index.ts')?.external).toEqual(['hono', 'node:fs']);
    expect(importsOf('packages/core/src/index.ts')?.external).toEqual(['zod']);
    expect(index.imports.externals.map((e) => e.name)).toContain('react');
  });

  it('reports a specifier it cannot resolve instead of guessing', () => {
    expect(importsOf('src/server/http.ts')?.unresolved).toEqual(['./generated/routes']);
  });

  it('builds the reverse edges and finds entry points', () => {
    expect(index.imports.importedBy['src/util/log.ts']).toEqual([
      'src/cli.ts',
      'src/index.ts',
      'src/server/http.ts',
    ]);
    expect(index.entryPoints).toContain('src/index.ts');
    expect(index.entryPoints).toContain('src/cli.ts');
  });
});

describe('snapshot', () => {
  it('reports branch, commit and a clean tree, then dirty after an edit', () => {
    const repo = copyFixtureAsGitRepo();
    const clean = repoSnapshot(repo);

    expect(clean.branch).toBe('main');
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirty).toBe(false);
    expect(clean.stateId).toBe(clean.commit);

    appendFileSync(`${repo}/src/util/log.ts`, '\nexport const extra = 1;\n');
    const dirty = repoSnapshot(repo);

    expect(dirty.commit).toBe(clean.commit);
    expect(dirty.dirty).toBe(true);
    expect(dirty.stateId).not.toBe(clean.stateId);

    // A further edit to the same file keeps `git status` identical, so the state id has
    // to follow the file's own size and mtime.
    appendFileSync(`${repo}/src/util/log.ts`, 'export const more = 2;\n');
    expect(repoSnapshot(repo).stateId).not.toBe(dirty.stateId);
  });

  it('keeps tracking edits when the analyzed path is a subdirectory of a repository', () => {
    const outer = copyFixtureAsGitRepo();
    const inner = `${outer}/packages/core`;
    const file = `${inner}/src/math.ts`;

    expect(repoSnapshot(inner).dirty).toBe(false);

    appendFileSync(file, '\nexport const one = 1;\n');
    const firstEdit = repoSnapshot(inner);
    expect(firstEdit.dirty).toBe(true);

    // A second edit to the same file leaves `git status` output unchanged, so the
    // fingerprint has to come from the file itself or the stale schema would be served.
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    appendFileSync(file, 'export const two = 2;\n');
    expect(repoSnapshot(inner).stateId).not.toBe(firstEdit.stateId);
  });

  it('derives a synthetic state id for a directory without git', () => {
    const repo = copyFixture();
    const { files } = listFiles(repo);
    const snapshot = repoSnapshot(repo, { files });

    expect(snapshot.branch).toBe('(no git)');
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.stateId).toMatch(/^nogit-[0-9a-f]{16}$/);
    expect(repoSnapshot(repo, { files }).stateId).toBe(snapshot.stateId);
  });
});

describe('agent digest', () => {
  it('describes the whole repository at L4 and only the scope at L3', () => {
    const repo = copyFixture();
    const index = buildIndex(repo);

    const l4 = summarizeForAgent(index, rootScope(index.name));
    expect(l4).toContain('@sample/core at packages/core (workspace)');
    expect(l4).toContain('src/index.ts');
    expect(l4).toContain('@app/* -> src/*');

    const l3 = summarizeForAgent(index, {
      level: 'L3',
      id: 'L4:root/core',
      label: '@sample/core',
      paths: ['packages/core'],
    });
    expect(l3).toContain('packages/core/src/math.ts');
    expect(l3).not.toContain('- src/util/log.ts');
  });
});
