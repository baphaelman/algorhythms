/** `node --import ./register.mjs`: installs the extensionless-TypeScript resolver (in-thread). */
import { registerHooks } from 'node:module';
import { resolve } from './resolve-ts.mjs';

registerHooks({ resolve });
