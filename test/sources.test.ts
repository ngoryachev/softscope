/**
 * Repository hygiene with a product reason: the analysis agent searches code with Grep
 * and Glob, and both skip a file they consider binary. A stray control character in a
 * source file would silently hide that file from SoftZoom's own analysis.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listFiles } from '../src/server/indexer/files';

const repoRoot = resolve(import.meta.dirname, '..');

describe('source files stay searchable', () => {
  it('contains no NUL bytes in its own TypeScript sources', () => {
    const sources = listFiles(repoRoot).files.filter(
      (f) => (f.startsWith('src/') || f.startsWith('test/')) && /\.(ts|tsx)$/.test(f),
    );

    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.filter((f) => readFileSync(resolve(repoRoot, f)).includes(0));
    expect(offenders).toEqual([]);
  });
});
