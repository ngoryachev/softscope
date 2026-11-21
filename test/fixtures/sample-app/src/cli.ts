import { main } from './index';
// Bare, resolved through tsconfig baseUrl rather than an alias.
import { log } from 'src/util/log';

log('cli');
main();
