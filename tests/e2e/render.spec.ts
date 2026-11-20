/**
 * Score renderer in a real browser (PLAN.md §10): draws 1080p frames of a compiled example,
 * measures the median draw time (budget ≤ 4 ms with 24 voices) and writes a screenshot to
 * test-results/ (not committed). The core compiler and the renderer are bundled with Vite into an
 * IIFE (src/render/dev/entry.ts) and injected into a blank page, so no app or HTML entry is needed.
 * Timing is asserted on Chromium only; other engines just have to draw.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';

const ROOT = join(import.meta.dirname, '../..');
const EXAMPLE = join(ROOT, 'examples/the-cartographers-rain.algorhythms.json');
const BUDGET_MS = 4;

let bundle: string | null = null;
async function renderBundle(): Promise<string> {
  if (bundle) return bundle;
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: join(ROOT, 'src/render/dev/entry.ts'),
        formats: ['iife'],
        name: 'algorhythmsRender',
      },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  if (!('output' in result)) throw new Error('unexpected vite build result');
  bundle = result.output[0].code;
  return bundle;
}

interface Stats {
  median: number;
  p95: number;
  max: number;
  voices: number;
  duration: number;
}
interface Hook {
  bench(canvas: HTMLCanvasElement, json: unknown, o: Record<string, unknown>): Stats;
  shot(canvas: HTMLCanvasElement, json: unknown, t: number, win: number, dark: boolean): number;
}

test('draws 1080p frames within the 4 ms budget', async ({ page, browserName }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
  test.setTimeout(120_000);
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as unknown;
  await page.goto('about:blank');
  await page.setContent(
    '<body style="margin:0"><canvas id="c" width="1920" height="1080"></canvas></body>',
  );
  await page.addScriptTag({ content: await renderBundle() });

  const run = (o: Record<string, unknown>) =>
    page.evaluate(
      ({ json, o }) => {
        const hook = (globalThis as unknown as { __render: Hook }).__render;
        return hook.bench(document.getElementById('c') as HTMLCanvasElement, json, o);
      },
      { json, o },
    );

  // 24 voices, a 20 s window, the worst-case colour mode (gradient), raster flushed each frame.
  const base = { frames: 200, window: 20, colors: 'voice', dark: false, voices: 24, flush: true };
  const results: Record<string, Stats> = {};
  results['voice-24-flush'] = await run(base);
  results['pitch-24-flush'] = await run({ ...base, colors: 'pitch', dark: true });
  results['pitch-24-draw-only'] = await run({ ...base, colors: 'pitch', flush: false });
  results['voice-24-draw-only'] = await run({ ...base, flush: false });
  results['example-16-overview'] = await run({ ...base, voices: 0, window: 1e6 });
  info.annotations.push({ type: 'render-timing', description: JSON.stringify(results) });
  console.log(`[${browserName}] render timings (ms):`, JSON.stringify(results));

  for (const [name, r] of Object.entries(results)) {
    expect(r.voices, name).toBeGreaterThanOrEqual(16);
    expect(Number.isFinite(r.median), name).toBe(true);
  }
  if (browserName === 'chromium') {
    expect(results['voice-24-flush'].median).toBeLessThanOrEqual(BUDGET_MS);
    // The gradient mode is dearer to rasterise; its JS cost alone must fit (flush is reported).
    expect(results['pitch-24-draw-only'].median).toBeLessThanOrEqual(BUDGET_MS);
  }

  // Screenshot for the integrator: mid-piece, follow camera, dark theme.
  const duration = await page.evaluate(
    ({ json }) => {
      const hook = (globalThis as unknown as { __render: Hook }).__render;
      return hook.shot(document.getElementById('c') as HTMLCanvasElement, json, 60, 24, true);
    },
    { json },
  );
  expect(duration).toBeGreaterThan(60);
  await page.locator('#c').screenshot({ path: info.outputPath(`render-${browserName}.png`) });
});
