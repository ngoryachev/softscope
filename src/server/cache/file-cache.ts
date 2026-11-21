/**
 * Disk cache of agent replies, keyed by (repository state, level, scope) — SPEC §9.1.
 *
 * It lives outside the analyzed repository (`~/.softscope/cache` by default) so
 * exploring a project never writes into it. Re-opening the same scope at the same
 * commit must not reach the agent.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Level } from '../../shared/graph';

/** Bump when the cached payload shape or the generation contract changes. */
export const CACHE_VERSION = 1;

export interface CacheKey {
  repoPath: string;
  /** `Snapshot.stateId`: the commit, plus a fingerprint when the tree is dirty. */
  stateId: string;
  level: Level;
  scopeId: string;
}

interface CacheEnvelope<T> {
  version: number;
  key: CacheKey;
  storedAt: string;
  value: T;
}

function short(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function defaultCacheRoot(): string {
  const configured = process.env.SOFTSCOPE_CACHE_DIR;
  return configured && configured.length > 0
    ? resolve(configured)
    : join(homedir(), '.softscope', 'cache');
}

/** Safe file name part for an id the agent chose. */
function slug(id: string): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe.slice(0, 40) || 'scope'}-${short(id, 12)}`;
}

export class FileCache {
  readonly root: string;

  constructor(root: string = defaultCacheRoot()) {
    this.root = resolve(root);
  }

  path(key: CacheKey): string {
    return join(
      this.root,
      `v${CACHE_VERSION}`,
      `${short(resolve(key.repoPath), 12)}`,
      key.stateId.replace(/[^a-zA-Z0-9+_-]/g, '-'),
      `${key.level}-${slug(key.scopeId)}.json`,
    );
  }

  get<T>(key: CacheKey): T | null {
    let envelope: CacheEnvelope<T>;
    try {
      envelope = JSON.parse(readFileSync(this.path(key), 'utf8')) as CacheEnvelope<T>;
    } catch {
      return null;
    }
    if (envelope.version !== CACHE_VERSION) return null;
    const k = envelope.key;
    // The path already encodes hashes of the key; re-check the plain values so a hash
    // collision or a hand-edited file cannot serve another scope's schema.
    if (
      !k ||
      resolve(k.repoPath) !== resolve(key.repoPath) ||
      k.stateId !== key.stateId ||
      k.level !== key.level ||
      k.scopeId !== key.scopeId
    ) {
      return null;
    }
    return envelope.value;
  }

  /**
   * The newest entry for this scope at any repository state, ignoring `stateId`.
   *
   * This is what lets the server keep showing the previous schema, marked stale, after
   * the working tree moves, instead of spending a minute of agent time on every edit
   * (SPEC §9.1: invalidate the affected parts, §9.4: never present a stale schema as
   * current).
   */
  latest<T>(key: Omit<CacheKey, 'stateId'>): { value: T; stateId: string; storedAt: string } | null {
    const dir = join(this.root, `v${CACHE_VERSION}`, short(resolve(key.repoPath), 12));
    let states: string[];
    try {
      states = readdirSync(dir);
    } catch {
      return null;
    }
    const file = `${key.level}-${slug(key.scopeId)}.json`;
    let best: { value: T; stateId: string; storedAt: string } | null = null;
    for (const state of states) {
      let envelope: CacheEnvelope<T>;
      try {
        envelope = JSON.parse(readFileSync(join(dir, state, file), 'utf8')) as CacheEnvelope<T>;
      } catch {
        continue;
      }
      const k = envelope.key;
      if (
        envelope.version !== CACHE_VERSION ||
        !k ||
        resolve(k.repoPath) !== resolve(key.repoPath) ||
        k.level !== key.level ||
        k.scopeId !== key.scopeId
      ) {
        continue;
      }
      // storedAt is an ISO timestamp, so a string comparison orders it correctly.
      if (!best || envelope.storedAt > best.storedAt) {
        best = { value: envelope.value, stateId: k.stateId, storedAt: envelope.storedAt };
      }
    }
    return best;
  }

  set<T>(key: CacheKey, value: T): string {
    const file = this.path(key);
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      key: { ...key, repoPath: resolve(key.repoPath) },
      storedAt: new Date().toISOString(),
      value,
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    return file;
  }

  delete(key: CacheKey): void {
    rmSync(this.path(key), { force: true });
  }

  /** Everything cached for one repository, across every commit and scope. */
  deleteRepo(repoPath: string): void {
    rmSync(join(this.root, `v${CACHE_VERSION}`, short(resolve(repoPath), 12)), {
      recursive: true,
      force: true,
    });
  }
}
