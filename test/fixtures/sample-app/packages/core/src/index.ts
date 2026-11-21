import { z } from 'zod';
import { add } from './math';

export const schema = z.object({ value: z.number() });
export { add };
