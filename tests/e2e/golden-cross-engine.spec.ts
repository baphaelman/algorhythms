/**
 * Cross-engine golden test (PLAN.md §7.11, §14): every example piece compiles to the same score
 * in Chromium, Firefox and WebKit as in Node. The core (compiler, schema, canonical hash) is
 * bundled with Vite into an IIFE and injected into a blank page, so this does not depend on the
 * app. Node's hashes come from tests/golden/examples.golden.json (written by the Vitest golden
 * test); a hash covers the full canonical serialisation of the compiled score.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';

const ROOT = join(import.meta.dirname, '../..');
const EXAMPLES = join(ROOT, 'examples');
const golden = JSON.parse(
  readFileSync(join(ROOT, 'tests/golden/examples.golden.json'), 'utf8'),
) as Record<string, { hash: string }>;

let bundle: string | null = null;
async function coreBundle(): Promise<string> {
  if (bundle) return bundle;
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: join(ROOT, 'tests/golden/golden-entry.ts'),
        formats: ['iife'],
        name: 'algorhythmsGolden',
      },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  if (!('output' in result)) throw new Error('unexpected vite build result');
  bundle = result.output[0].code;
  return bundle;
}

test('examples compile identically to Node', async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
  test.setTimeout(120_000);
  await page.goto('about:blank');
  await page.addScriptTag({ content: await coreBundle() });
  const files = readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .sort();
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const f of files) {
    const json = JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')) as unknown;
    const hash = await page.evaluate(
      (piece) =>
        (
          globalThis as unknown as { __algorhythmsGolden: { goldenHash(p: unknown): string } }
        ).__algorhythmsGolden.goldenHash(piece),
      json,
    );
    expect(hash, `${f} in ${info.project.name}`).toBe(golden[f].hash);
  }
});
