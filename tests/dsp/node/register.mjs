/** `node --import ./register.mjs`: installs the extensionless-TypeScript resolver. */
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
