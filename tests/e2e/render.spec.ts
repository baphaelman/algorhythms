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
// 4 ms is the PLAN §10 budget. Shared CI runners (software raster) get a loose guard unless strict.
const BUDGET_MS = process.env.CI && !process.env.ALGORHYTHMS_PERF_STRICT ? 12 : 4;

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
interface FrameView {
  start: number;
  pps: number;
  pLo: number;
  pHi: number;
  padT: number;
  padB: number;
}
interface Hook {
  bench(canvas: HTMLCanvasElement, json: unknown, o: Record<string, unknown>): Stats;
  shot(canvas: HTMLCanvasElement, json: unknown, t: number, win: number, dark: boolean): number;
  frame(canvas: HTMLCanvasElement, json: unknown, o: Record<string, unknown>): FrameView;
}

test(
  'draws 1080p frames within the 4 ms budget',
  { tag: '@perf' },
  async ({ page, browserName }, info) => {
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

    // 24 voices, a 20 s window, raster flushed each frame. 'pitch' (the default) paints a
    // gradient, the worst case; 'ink' is the solid-colour baseline.
    const base = { frames: 200, window: 20, colors: 'pitch', dark: false, voices: 24, flush: true };
    const results: Record<string, Stats> = {};
    results['ink-24-flush'] = await run({ ...base, colors: 'ink' });
    results['pitch-24-flush'] = await run({ ...base, dark: true });
    results['pitch-24-draw-only'] = await run({ ...base, flush: false });
    results['ink-24-draw-only'] = await run({ ...base, colors: 'ink', flush: false });
    results['example-16-overview'] = await run({ ...base, voices: 0, window: 1e6 });
    info.annotations.push({ type: 'render-timing', description: JSON.stringify(results) });
    console.log(`[${browserName}] render timings (ms):`, JSON.stringify(results));

    for (const [name, r] of Object.entries(results)) {
      expect(r.voices, name).toBeGreaterThanOrEqual(16);
      expect(Number.isFinite(r.median), name).toBe(true);
    }
    if (browserName === 'chromium') {
      expect(results['ink-24-flush'].median).toBeLessThanOrEqual(BUDGET_MS);
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
  },
);

/**
 * Owner report (2026-11-21): a knot in front of the playhead where lines split. The ghost (future
 * lines at 35 %) must look like one line wherever lines overlap: eight lines merge into a unison
 * at 4 s and split from it at 8 s, all ahead of the playhead. No pixel at the merge or the split
 * may be darker than a lone ghost line or the ghost rope.
 */
test('ghost lines do not stack where strands overlap at a merge or a split', async ({
  page,
}, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
  const json = JSON.parse(
    readFileSync(join(ROOT, 'examples/tidewater-hymn.algorhythms.json'), 'utf8'),
  ) as Record<string, unknown>;
  const notes = { kind: 'pitches', pitches: [48, 52, 55, 60, 64, 67, 72, 76] };
  const glide = { length: 3, stagger: 0, jitter: 0, ease: 'smootherstep' };
  json.moments = [
    { id: 'start0', type: 'chord', at: 0, notes, voicing: 'even', assign: 'ordered' },
    { id: 'u', type: 'unison', at: 1, pitch: 60, octaves: false, glide },
    { id: 'c', type: 'chord', at: 8, notes, voicing: 'even', assign: 'ordered', glide },
  ];
  json.key = { tonic: 'C', scale: 'major' };
  json.end = { at: 14, fade: 1 };
  await page.goto('about:blank');
  await page.setContent(
    '<body style="margin:0"><canvas id="c" width="1400" height="700"></canvas></body>',
  );
  await page.addScriptTag({ content: await renderBundle() });
  const dark = await page.evaluate(
    ({ json }) => {
      const hook = (globalThis as unknown as { __render: Hook }).__render;
      const c = document.getElementById('c') as HTMLCanvasElement;
      const o = { t: 0.5, start: 0, window: 14, ghost: 0.35, colors: 'ink' };
      const v = hook.frame(c, json, o);
      const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
      const paper = [0xee, 0xf1, 0xf4];
      const y = (p: number) =>
        v.padT + ((v.pHi - p) / (v.pHi - v.pLo)) * (c.height - v.padT - v.padB);
      // Rows of the A grid lines are skipped: a ghost line over a rule is darker than over paper.
      const grid = [33, 45, 57, 69, 81, 93].map(y);
      const y0 = Math.ceil(Math.max(y(80), v.padT));
      const y1 = Math.floor(Math.min(y(44), c.height - v.padB));
      /** Darkest pixel (largest channel difference from the paper) over the times [a, b]. */
      const darkest = (a: number, b: number): number => {
        let m = 0;
        for (let x = Math.ceil((a - v.start) * v.pps); x <= (b - v.start) * v.pps; x++) {
          for (let r = y0; r <= y1; r++) {
            if (grid.some((gy) => Math.abs(r - gy) < 2)) continue;
            const i = (r * c.width + x) * 4;
            for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(data[i + k] - paper[k]));
          }
        }
        return m;
      };
      return {
        merge: darkest(2, 4.5),
        rope: darkest(5, 7.5),
        split: darkest(7.5, 10),
        lines: darkest(11, 12.5),
      };
    },
    { json },
  );
  console.log('ghost darkness:', JSON.stringify(dark));
  // Sanity: the lines are drawn as a ghost (ink on paper differs by about 217 per channel).
  expect(dark.lines).toBeGreaterThan(50);
  expect(dark.lines).toBeLessThan(100);
  const one = Math.max(dark.lines, dark.rope);
  expect(dark.merge).toBeLessThanOrEqual(one + 3);
  expect(dark.split).toBeLessThanOrEqual(one + 3);
});
