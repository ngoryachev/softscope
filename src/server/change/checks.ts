/**
 * The repository's own checks (SPEC §6.5): the `typecheck`, `lint` and `test` scripts of
 * the root package.json, run by the server in the worktree after the agent finished.
 * The agent's own report of what it ran is informational; this is what the user sees.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '../../shared/api';
import type { CheckCommand } from '../agent/types';

export const CHECK_SCRIPTS = ['typecheck', 'lint', 'test'] as const;

export type Runner = 'npm' | 'pnpm' | 'yarn';

/** The package manager the lockfile points at; npm when there is none. */
export function detectRunner(dir: string): Runner {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function detectChecks(dir: string): CheckCommand[] {
  let scripts: Record<string, unknown> = {};
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    if (json.scripts && typeof json.scripts === 'object' && !Array.isArray(json.scripts)) {
      scripts = json.scripts as Record<string, unknown>;
    }
  } catch {
    return [];
  }
  const runner = detectRunner(dir);
  return CHECK_SCRIPTS.filter((name) => typeof scripts[name] === 'string' && (scripts[name] as string).trim().length > 0).map(
    (name) => ({
      name,
      command: `${runner} run ${name}`,
      argv: [runner, 'run', name],
    }),
  );
}

export interface RunChecksOptions {
  /** Per check. */
  timeoutMs?: number;
  tailLines?: number;
  signal?: AbortSignal;
  /** Called before each check starts, so the UI can show which one is running. */
  onStart?: (check: CheckCommand) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TAIL_LINES = 200;
/** Output kept in memory while a check runs; the tail is cut from this. */
const KEEP_BYTES = 512 * 1024;

export function tailOf(output: string, lines: number): string {
  const all = output.replace(/\r\n?/g, '\n').split('\n');
  if (all[all.length - 1] === '') all.pop();
  return all.slice(-lines).join('\n');
}

export function runCheck(check: CheckCommand, dir: string, opts: RunChecksOptions = {}): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;
  return new Promise((resolve) => {
    const [cmd, ...args] = check.argv;
    let output = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd!, args, {
      cwd: dir,
      // CI=1 keeps test runners out of watch mode (a bare `vitest`/`jest` would never exit);
      // no colour keeps the output tail readable in the UI.
      env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > KEEP_BYTES) output = output.slice(-KEEP_BYTES);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const finish = (exitCode: number | null, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (extra) output += `\n${extra}\n`;
      resolve({
        name: check.name,
        command: check.command,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        outputTail: tailOf(output, tailLines),
        timedOut,
      });
    };
    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      output += `\n[softscope] ${check.command} exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.\n`;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      output += `\n[softscope] ${check.command} was cancelled.\n`;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => finish(null, `[softscope] could not run ${check.command}: ${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

/** Runs the checks one after another; a cancelled run stops at the current one. */
export async function runChecks(checks: CheckCommand[], dir: string, opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (opts.signal?.aborted) break;
    opts.onStart?.(check);
    results.push(await runCheck(check, dir, opts));
  }
  return results;
}
