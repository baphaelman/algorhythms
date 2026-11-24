// Loader for compose-links.ts, same approach as docs-schema.mjs (Vite's module runner).
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
await runnerImport(fileURLToPath(new URL('./compose-links.ts', import.meta.url)), {
  root,
  logLevel: 'error',
});
process.exitCode = 0;
