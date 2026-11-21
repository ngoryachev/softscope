import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CACHE_VERSION, FileCache, type CacheKey } from '../src/server/cache/file-cache';
import { agentGraph, cleanupTemps, copyFixture, tempCache } from './helpers';

afterAll(cleanupTemps);

const baseKey = (repo: string): CacheKey => ({
  repoPath: repo,
  stateId: 'abc123',
  level: 'L4',
  scopeId: 'root',
});

describe('cache hit and miss', () => {
  it('misses before the first write and hits afterwards', () => {
    const cache = tempCache();
    const key = baseKey('/tmp/repo-a');
    const value = agentGraph([{ slug: 'app' }]);

    expect(cache.get(key)).toBeNull();
    cache.set(key, value);
    expect(cache.get(key)).toEqual(value);
  });

  it('misses on a different commit, scope, level or repository', () => {
    const cache = tempCache();
    const key = baseKey('/tmp/repo-a');
    cache.set(key, { marker: 'original' });

    expect(cache.get({ ...key, stateId: 'def456' })).toBeNull();
    expect(cache.get({ ...key, scopeId: 'L4:root/other' })).toBeNull();
    expect(cache.get({ ...key, level: 'L3' })).toBeNull();
    expect(cache.get({ ...key, repoPath: '/tmp/repo-b' })).toBeNull();
    expect(cache.get(key)).toEqual({ marker: 'original' });
  });

  it('treats a dirty working tree as a different state', () => {
    const cache = tempCache();
    const clean = baseKey('/tmp/repo-a');
    const dirty = { ...clean, stateId: 'abc123+deadbeefdeadbeef' };
    cache.set(clean, { marker: 'committed' });

    expect(cache.get(dirty)).toBeNull();
    cache.set(dirty, { marker: 'edited' });
    expect(cache.get(clean)).toEqual({ marker: 'committed' });
    expect(cache.get(dirty)).toEqual({ marker: 'edited' });
  });

  it('ignores an entry written by an earlier cache version', () => {
    const cache = tempCache();
    const key = baseKey('/tmp/repo-a');
    cache.set(key, { marker: 'v1' });
    const file = cache.path(key);

    const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(envelope.version).toBe(CACHE_VERSION);
    writeFileSync(file, JSON.stringify({ ...envelope, version: CACHE_VERSION - 1 }), 'utf8');

    expect(cache.get(key)).toBeNull();
  });

  it('ignores an entry whose stored key does not match the lookup', () => {
    const cache = tempCache();
    const key = baseKey('/tmp/repo-a');
    cache.set(key, { marker: 'original' });
    const file = cache.path(key);

    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { key: CacheKey };
    writeFileSync(file, JSON.stringify({ ...envelope, key: { ...envelope.key, scopeId: 'someone-else' } }), 'utf8');

    expect(cache.get(key)).toBeNull();
  });
});

describe('cache location', () => {
  it('writes under the configured root and never inside the analyzed repository', () => {
    const repo = copyFixture();
    const cache = tempCache();
    const key = baseKey(repo);

    const file = cache.set(key, { marker: 'x' });

    expect(file.startsWith(`${cache.root}/`)).toBe(true);
    expect(file.startsWith(`${repo}/`)).toBe(false);
    expect(file).toContain(`/v${CACHE_VERSION}/`);
    expect(existsSync(file)).toBe(true);
  });

  it('honours SOFTSCOPE_CACHE_DIR for the default root', async () => {
    const previous = process.env.SOFTSCOPE_CACHE_DIR;
    process.env.SOFTSCOPE_CACHE_DIR = '/tmp/softscope-env-root';
    try {
      expect(new FileCache().root).toBe('/tmp/softscope-env-root');
    } finally {
      if (previous === undefined) delete process.env.SOFTSCOPE_CACHE_DIR;
      else process.env.SOFTSCOPE_CACHE_DIR = previous;
    }
  });

  it('separates two scopes whose ids differ only after sanitisation', () => {
    const cache = tempCache();
    const a = { ...baseKey('/tmp/repo-a'), scopeId: 'L4:root/web-ui' };
    const b = { ...baseKey('/tmp/repo-a'), scopeId: 'L4:root/web/ui' };

    cache.set(a, { marker: 'a' });
    cache.set(b, { marker: 'b' });

    expect(cache.path(a)).not.toBe(cache.path(b));
    expect(cache.get(a)).toEqual({ marker: 'a' });
    expect(cache.get(b)).toEqual({ marker: 'b' });
  });
});

describe('invalidation', () => {
  it('deletes one entry and a whole repository', () => {
    const cache = tempCache();
    const l4 = baseKey('/tmp/repo-a');
    const l3 = { ...l4, level: 'L3' as const, scopeId: 'L4:root/app' };
    cache.set(l4, { marker: 'l4' });
    cache.set(l3, { marker: 'l3' });

    cache.delete(l4);
    expect(cache.get(l4)).toBeNull();
    expect(cache.get(l3)).toEqual({ marker: 'l3' });

    cache.deleteRepo('/tmp/repo-a');
    expect(cache.get(l3)).toBeNull();
  });
});
