/**
 * The lightweight, LLM-free repository index (SPEC §4.4, §8.1) and the compact digest
 * handed to the analysis agent as a starting point.
 */
import { basename } from 'node:path';
import type { ScopeRef, Snapshot } from '../../shared/graph';
import { filesUnder, isCodeFile, listFiles } from './files';
import { isGitRepo, repoSnapshot } from './git';
import { buildImportGraph, type ImportGraph } from './imports';
import { indexPackages, type PackageIndex } from './packages';
import { indexTsconfigs, type TsconfigIndex } from './tsconfig';

export interface RepoIndex {
  root: string;
  name: string;
  isGitRepo: boolean;
  snapshot: Snapshot;
  files: string[];
  codeFiles: string[];
  fileSource: 'git' | 'walk';
  truncated: boolean;
  packages: PackageIndex;
  tsconfigs: TsconfigIndex;
  imports: ImportGraph;
  /** Files that look like a process entry point: bin scripts, index/main/server modules. */
  entryPoints: string[];
  /** What the index itself could not establish; shown in the view next to the agent's notes. */
  notes: string[];
}

const ENTRY_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.mjs',
  'main.ts',
  'main.tsx',
  'main.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.tsx',
  'cli.ts',
  'cli.js',
]);

function findEntryPoints(index: Pick<RepoIndex, 'codeFiles' | 'packages' | 'imports'>): string[] {
  const out = new Set<string>();
  for (const pkg of index.packages.packages) {
    for (const entry of pkg.entries) {
      const path = pkg.dir === '.' ? entry : `${pkg.dir}/${entry}`;
      if (isCodeFile(path)) out.add(path);
    }
  }
  const imported = new Set(Object.keys(index.imports.importedBy));
  for (const file of index.codeFiles) {
    const base = basename(file);
    if (!ENTRY_BASENAMES.has(base)) continue;
    // An index module nobody imports is a plausible process entry rather than a barrel.
    if (!imported.has(file) || base.startsWith('main') || base.startsWith('server') || base.startsWith('cli')) {
      out.add(file);
    }
  }
  return [...out].sort();
}

export function buildIndex(root: string): RepoIndex {
  const { files, codeFiles, source, truncated, ignoredByGit } = listFiles(root);
  const packages = indexPackages(root, files);
  const tsconfigs = indexTsconfigs(root, files);
  const imports = buildImportGraph(root, codeFiles, files, packages, tsconfigs);
  const index: RepoIndex = {
    root,
    name: packages.root?.name || basename(root) || 'repository',
    isGitRepo: isGitRepo(root),
    snapshot: repoSnapshot(root, { files }),
    files,
    codeFiles,
    fileSource: source,
    truncated,
    packages,
    tsconfigs,
    imports,
    entryPoints: [],
    notes: [],
  };
  index.entryPoints = findEntryPoints(index);
  if (ignoredByGit) {
    index.notes.push(
      'This directory lies inside a git repository that excludes it, so git tracks none ' +
        'of its files. The file list comes from a filesystem walk instead, and the branch ' +
        'and commit shown are the enclosing repository\'s.',
    );
  }
  if (truncated) {
    index.notes.push(`Only the first ${files.length} files were indexed; the listing is incomplete.`);
  }
  return index;
}

const DIGEST_BUDGET = 60_000;

function section(title: string, lines: string[]): string {
  return lines.length === 0 ? '' : `## ${title}\n${lines.join('\n')}\n`;
}

function cap<T>(items: T[], limit: number, render: (item: T) => string): string[] {
  const out = items.slice(0, limit).map(render);
  if (items.length > limit) out.push(`... and ${items.length - limit} more`);
  return out;
}

/**
 * A size-capped, human-readable digest of the index for the prompt. Capped on purpose:
 * a very large repository is described partially rather than blowing the context, and
 * the agent is told so explicitly so it reports the gap instead of inventing structure.
 */
export function summarizeForAgent(index: RepoIndex, scope: ScopeRef): string {
  const scoped = filesUnder(index.files, scope.paths);
  const scopedCode = scoped.filter(isCodeFile);
  const scopedSet = new Set(scoped);
  const inScope = (f: string) => scopedSet.has(f);

  const blocks: string[] = [];
  blocks.push(
    [
      `# Repository index: ${index.name}`,
      `scope: ${scope.level} ${scope.id} (${scope.label})`,
      `scope paths: ${scope.paths.join(', ')}`,
      `branch: ${index.snapshot.branch}, commit: ${index.snapshot.shortCommit}${index.snapshot.dirty ? ' (uncommitted changes present)' : ''}`,
      `files in scope: ${scoped.length} (${scopedCode.length} TS/JS), file list from: ${index.fileSource}`,
      index.truncated ? 'NOTE: the file listing was truncated; the index is incomplete.' : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );

  const pkgs = index.packages.packages.filter((p) => p.dir === '.' || inScope(`${p.dir}/package.json`));
  blocks.push(
    section(
      'Packages',
      pkgs.map((p) =>
        [
          `- ${p.name} at ${p.dir}${p.workspace ? ' (workspace)' : ''}${p.private ? ' private' : ''}`,
          p.entries.length ? `  entries: ${p.entries.join(', ')}` : '',
          p.dependencies.length ? `  dependencies: ${p.dependencies.join(', ')}` : '',
          Object.keys(p.scripts).length ? `  scripts: ${Object.keys(p.scripts).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ),
  );

  if (index.packages.workspacePatterns.length > 0) {
    blocks.push(section('Workspace patterns', [index.packages.workspacePatterns.join(', ')]));
  }

  const aliasLines = index.tsconfigs.configs.flatMap((c) => [
    ...(c.baseUrl === null ? [] : [`- baseUrl: ${c.baseUrl} (${c.file})`]),
    ...Object.entries(c.paths).map(([k, v]) => `- ${k} -> ${v.join(', ')} (${c.file})`),
  ]);
  blocks.push(section('TypeScript module resolution', aliasLines));

  blocks.push(
    section(
      'Entry points',
      cap(
        index.entryPoints.filter(inScope),
        40,
        (f) => `- ${f}`,
      ),
    ),
  );

  blocks.push(
    section(
      'Most used external dependencies',
      cap(index.imports.externals, 40, (e) => `- ${e.name} (imported by ${e.count} files)`),
    ),
  );

  blocks.push(
    section(
      'Files in scope',
      cap(scoped, 600, (f) => `- ${f}`),
    ),
  );

  const edges = index.imports.files
    .filter((f) => inScope(f.file))
    .filter((f) => f.internal.length > 0 || f.external.length > 0);
  blocks.push(
    section(
      'Import graph (file -> imports)',
      cap(edges, 500, (f) =>
        [
          `- ${f.file}`,
          f.internal.length ? `  -> ${f.internal.join(', ')}` : '',
          f.external.length ? `  -> external: ${f.external.join(', ')}` : '',
          f.unresolved.length ? `  -> unresolved: ${f.unresolved.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ),
  );

  const digest = blocks.filter(Boolean).join('\n');
  return digest.length <= DIGEST_BUDGET
    ? digest
    : `${digest.slice(0, DIGEST_BUDGET)}\n\n[index digest truncated at ${DIGEST_BUDGET} characters — read the files you need with Read/Grep/Glob]`;
}
