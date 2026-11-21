import { serve } from 'hono';
import { readFileSync } from 'node:fs';
import { createHttp } from './server/http';
import { log } from '@app/util/log';
import { add } from '@sample/core';

export function main(): void {
  log('starting');
  const config = readFileSync('config.json', 'utf8');
  serve(createHttp(add(1, 2), config));
}
