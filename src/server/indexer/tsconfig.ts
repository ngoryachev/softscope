/** `tsconfig.json` facts the import resolver needs: baseUrl, path aliases, references. */
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

export interface TsconfigInfo {
  /** The config file, repository-relative. */
  file: string;
  /** Repository-relative baseUrl, if set. */
  baseUrl: string | null;
  /** Alias patterns mapped to repository-relative targets. */
  paths: Record<string, string[]>;
  /** Project references, repository-relative. */
  references: string[];
}

/** JSON with comments and trailing commas — tsconfig files routinely have both. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      // Drop a trailing comma, which tsconfig files routinely carry. Done inside the
      // string-aware scan, so a comma in a string value is never touched.
      let end = out.length;
      while (end > 0 && /\s/.test(out[end - 1]!)) end -= 1;
      if (end > 0 && out[end - 1] === ',') out = out.slice(0, end - 1);
      out += c;
      continue;
    }
    out += c;
  }
  return JSON.parse(out) as unknown;
}

function relJoin(dir: string, target: string): string {
  const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, target.replace(/^\.\//, '')));
  return joined === '' ? '.' : joined.replace(/\/+$/, '');
}

/**
 * Reads one tsconfig and follows `extends` one level at a time. Only the fields the
 * resolver uses are kept — this is an index, not a TypeScript configuration parser.
 */
export function readTsconfig(root: string, file: string, depth = 0): TsconfigInfo | null {
  let json: unknown;
  try {
    json = parseJsonc(readFileSync(join(root, file), 'utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const dir = dirname(file) === '.' ? '.' : dirname(file);
  const co = (obj.compilerOptions ?? {}) as Record<string, unknown>;

  let baseUrl = typeof co.baseUrl === 'string' ? relJoin(dir, co.baseUrl) : null;
  const paths: Record<string, string[]> = {};
  if (co.paths && typeof co.paths === 'object') {
    const base = baseUrl ?? dir;
    for (const [pattern, targets] of Object.entries(co.paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      paths[pattern] = targets
        .filter((t): t is string => typeof t === 'string')
        .map((t) => relJoin(base, t));
    }
  }

  if (typeof obj.extends === 'string' && depth < 4 && obj.extends.startsWith('.')) {
    const parent = readTsconfig(root, relJoin(dir, obj.extends), depth + 1);
    if (parent) {
      baseUrl ??= parent.baseUrl;
      for (const [k, v] of Object.entries(parent.paths)) paths[k] ??= v;
    }
  }

  const references = Array.isArray(obj.references)
    ? obj.references
        .map((r) => (r && typeof r === 'object' ? (r as { path?: unknown }).path : null))
        .filter((p): p is string => typeof p === 'string')
        .map((p) => relJoin(dir, p))
    : [];

  return { file, baseUrl, paths, references };
}

export interface TsconfigIndex {
  root: TsconfigInfo | null;
  configs: TsconfigInfo[];
}

export function indexTsconfigs(root: string, files: string[]): TsconfigIndex {
  const candidates = files.filter(
    (f) => f === 'tsconfig.json' || (f.endsWith('/tsconfig.json') && f.split('/').length <= 4),
  );
  const configs = candidates.flatMap((f) => {
    const info = readTsconfig(root, f);
    return info ? [info] : [];
  });
  return { root: configs.find((c) => c.file === 'tsconfig.json') ?? null, configs };
}
