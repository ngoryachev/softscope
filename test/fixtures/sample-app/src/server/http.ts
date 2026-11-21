import { log } from '../util/log';
import { missing } from './generated/routes';

export function createHttp(seed: number, config: string): { seed: number; config: string } {
  log(`http ${seed} ${missing()}`);
  return { seed, config };
}
