/**
 * `ChangeAgent` without Claude: a deterministic edit plus a call log.
 *
 * Appends one comment line carrying the task text to the first file of the selection
 * context, so the diff, the limits check, the affected components and the apply path
 * can be exercised without tokens. Used by the tests and by `SOFTSCOPE_FAKE_AGENT=1`.
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { ChangeResult, ScopeExpansion } from '../../shared/change-schema';
import { listFiles } from '../indexer/files';
import { AgentError, type ChangeAgent, type ChangeRunRequest } from './types';

export interface FakeChangeAgentOptions {
  /** Artificial delay before editing, abortable — for cancel tests. */
  delayMs?: number;
  /** A second file (relative to the worktree) to append to as well, e.g. one outside the limits. */
  alsoEdit?: string;
  /** Returned instead of `null`, to exercise the "needs wider scope" path. */
  scopeExpansion?: ScopeExpansion;
  /** Throw like a broken agent would. */
  fail?: boolean;
  /** Edit this file (relative to the worktree) instead of the first context file. */
  target?: string;
  /** Scripted tool activity reported through `onProgress` before the edit. */
  progress?: Array<{ tool: string; detail: string }>;
}

const COMMENT_PREFIX: Record<string, string> = {
  '.ts': '// ',
  '.tsx': '// ',
  '.mts': '// ',
  '.cts': '// ',
  '.js': '// ',
  '.jsx': '// ',
  '.mjs': '// ',
  '.cjs': '// ',
  '.css': '/* ',
  '.md': '<!-- ',
  '.html': '<!-- ',
  '.sh': '# ',
  '.py': '# ',
  '.yml': '# ',
  '.yaml': '# ',
};

const COMMENT_SUFFIX: Record<string, string> = {
  '.css': ' */',
  '.md': ' -->',
  '.html': ' -->',
};

/** The one line the fake appends: a comment in the file's own syntax carrying the task. */
export function fakeChangeLine(file: string, task: string): string {
  const ext = extname(file);
  const prefix = COMMENT_PREFIX[ext] ?? '// ';
  const suffix = COMMENT_SUFFIX[ext] ?? '';
  return `${prefix}softscope: ${task.trim().replace(/\s+/g, ' ')}${suffix}\n`;
}

export class FakeChangeAgent implements ChangeAgent {
  readonly name = 'fake';
  /** Every request, in order. */
  readonly calls: ChangeRunRequest[] = [];

  constructor(private readonly opts: FakeChangeAgentOptions = {}) {}

  async run(req: ChangeRunRequest): Promise<ChangeResult> {
    this.calls.push(req);
    if (req.signal?.aborted) throw new AgentError('The change was cancelled.', 'cancelled');
    for (const event of this.opts.progress ?? []) req.onProgress?.(event);
    if (this.opts.delayMs) await abortableDelay(this.opts.delayMs, req.signal);
    if (this.opts.fail) throw new AgentError('FakeChangeAgent was told to fail.', 'scripted failure');

    const target = this.opts.target ?? pickTarget(req);
    if (!target) {
      throw new AgentError('FakeChangeAgent found no file to edit.', 'the selection has no files and no limit paths');
    }
    const edited = [target];
    append(req.workspaceDir, target, fakeChangeLine(target, req.task));
    req.onProgress?.({ tool: 'Edit', detail: target });
    if (this.opts.alsoEdit) {
      append(req.workspaceDir, this.opts.alsoEdit, fakeChangeLine(this.opts.alsoEdit, req.task));
      req.onProgress?.({ tool: 'Edit', detail: this.opts.alsoEdit });
      edited.push(this.opts.alsoEdit);
    }
    return {
      summary: `Appended a comment carrying the task to ${edited.join(' and ')}. No code was analyzed (fake agent).`,
      changedFiles: edited,
      checks: [],
      scopeExpansion: this.opts.scopeExpansion ?? null,
    };
  }
}

/**
 * The first context file that exists in the worktree — preferring one whose comment
 * syntax is known, so a `package.json` in the evidence is not broken — else the first
 * file under the limits.
 */
function pickTarget(req: ChangeRunRequest): string | null {
  const present = req.context.files.filter((f) => isFile(join(req.workspaceDir, f.file)));
  const commentable = present.find((f) => COMMENT_PREFIX[extname(f.file)] !== undefined);
  if (commentable) return commentable.file;
  if (present[0]) return present[0].file;
  for (const p of req.context.limits.paths) {
    const abs = join(req.workspaceDir, p);
    if (isFile(abs)) return p;
    if (existsSync(abs)) {
      const inside = listFiles(req.workspaceDir).codeFiles.find((f) => f === p || f.startsWith(`${p.replace(/\/+$/, '')}/`));
      if (inside) return inside;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function append(root: string, rel: string, line: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  appendFileSync(abs, line, 'utf8');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentError('The change was cancelled.', 'cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
