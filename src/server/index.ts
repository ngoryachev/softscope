#!/usr/bin/env node
/**
 * `npm start -- <path to repository>`
 *
 * Starts the local SoftZoom server on 127.0.0.1 and opens the browser. The repository
 * path is optional; it can also be entered in the UI.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ClaudeSchemaAgent } from './agent/claude';
import { FakeSchemaAgent, indexDerivedReply } from './agent/fake';
import type { SchemaAgent } from './agent/types';
import { FileCache, defaultCacheRoot } from './cache/file-cache';
import { createApp, mountWebUi } from './http/app';
import { RepoSession } from './session';

const HOST = '127.0.0.1';
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser on this machine; the printed URL is enough.
  }
}

function buildAgent(): SchemaAgent {
  if (process.env.SOFTSCOPE_FAKE_AGENT === '1') {
    return new FakeSchemaAgent({ fallback: indexDerivedReply });
  }
  const model = process.env.SOFTSCOPE_MODEL;
  return new ClaudeSchemaAgent({
    ...(model ? { model } : {}),
    onProgress: ({ tool, detail }) => {
      process.stdout.write(`  agent ${tool} ${detail}\n`);
    },
  });
}

async function main(): Promise<void> {
  const [pathArg] = process.argv.slice(2);
  const port = Number(process.env.SOFTSCOPE_PORT ?? 4319);
  const agent = buildAgent();
  const cache = new FileCache();

  let session: RepoSession | undefined;
  if (pathArg) {
    try {
      session = new RepoSession(resolve(pathArg), { agent, cache });
    } catch (err) {
      process.stderr.write(`Cannot open ${pathArg}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  const { app } = createApp({ agent, cache, ...(session ? { session } : {}) });
  const distDir = join(projectRoot, 'dist', 'web');
  const hasUi = await mountWebUi(app, distDir);

  serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
    const url = `http://${HOST}:${info.port}`;
    process.stdout.write(
      [
        `SoftZoom on ${url}`,
        `  repository: ${session ? session.repoPath : '(enter a path in the UI)'}`,
        `  agent:      ${agent.name}`,
        `  cache:      ${defaultCacheRoot()}`,
        hasUi ? '' : `  UI:         not built — run "npm run build" (looked in ${distDir})`,
        '',
      ]
        .filter((line) => line !== '')
        .join('\n') + '\n',
    );
    if (hasUi && process.env.SOFTSCOPE_NO_OPEN !== '1') openBrowser(url);
  });
}

void main();
