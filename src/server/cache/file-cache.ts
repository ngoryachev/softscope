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

/** Bump when the cached payload shape, the on-disk layout or the contract changes. */
export const CACHE_VERSION = 2;

export interface CacheKey {
  repoPath: string;
  /** `Snapshot.stateId`: the commit, plus a fingerprint when the tree is dirty. */
  stateId: string;
  level: Level;
  scopeId: string;
  /**
   * `SchemaAgent.name`. Part of the key, so each agent gets its own partition of the
   * cache: the fake agent derives graphs from the index without reading any code, and
   * its replies must neither be served to a session that talks to Claude nor overwrite
   * what Claude produced for the same state — in either direction.
   */
  agent: string;
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

/**
 * Orders fallback candidates. An entry for the preferred repository state wins over a
 * merely newer one: a dirty state id is `<commit>+<fingerprint>`, so an entry for the
 * same commit describes the code on disk far more closely than the schema of another
 * commit that happens to have been generated later.
 */
function isBetter(
  candidate: { stateId: string; storedAt: string },
  best: { stateId: string; storedAt: string },
  prefer?: { statePrefix: string },
): boolean {
  if (prefer) {
    const candidateMatches = candidate.stateId.startsWith(prefer.statePrefix);
    const bestMatches = best.stateId.startsWith(prefer.statePrefix);
    if (candidateMatches !== bestMatches) return candidateMatches;
  }
  // storedAt is an ISO timestamp, so a string comparison orders it correctly.
  return candidate.storedAt > best.storedAt;
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
      this.scopeDir(key),
      key.stateId.replace(/[^a-zA-Z0-9+_-]/g, '-'),
      `${key.level}-${slug(key.scopeId)}.json`,
    );
  }

  /** Everything cached for one repository and one agent, across every state. */
  private scopeDir(key: Omit<CacheKey, 'stateId' | 'level' | 'scopeId'>): string {
    return join(this.root, `v${CACHE_VERSION}`, short(resolve(key.repoPath), 12), slug(key.agent));
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
      k.agent !== key.agent ||
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
  latest<T>(
    key: Omit<CacheKey, 'stateId'>,
    prefer?: { statePrefix: string },
  ): { value: T; stateId: string; storedAt: string } | null {
    const dir = this.scopeDir(key);
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
        k.scopeId !== key.scopeId ||
        k.agent !== key.agent
      ) {
        continue;
      }
      const candidate = { value: envelope.value, stateId: k.stateId, storedAt: envelope.storedAt };
      if (!best || isBetter(candidate, best, prefer)) best = candidate;
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

  /** Everything cached for one repository: every agent, state and scope. */
  deleteRepo(repoPath: string): void {
    rmSync(join(this.root, `v${CACHE_VERSION}`, short(resolve(repoPath), 12)), {
      recursive: true,
      force: true,
    });
  }
}
