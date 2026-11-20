// Regenerates docs/file-format.md from the Zod schema: `pnpm docs:schema`.
// Uses Vite's module runner, so the TypeScript sources load without a build step.

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const { module } = await runnerImport(
  fileURLToPath(new URL('./file-format-doc.ts', import.meta.url)),
  {
    root,
    logLevel: 'error',
  },
);
const out = fileURLToPath(new URL('../docs/file-format.md', import.meta.url));
writeFileSync(out, module.renderFileFormatDoc());
process.stdout.write(`Wrote ${out}\n`);
