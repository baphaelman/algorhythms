/**
 * Play the poster (PLAN.md §15 M15 V1): video frames over the poster drawn on an OffscreenCanvas
 * in the page (the render bundle, as video-frames.spec). Non-empty and deterministic at every
 * aspect; a dimmed future lands where the full one does (the ghost layer composites at each
 * row's place); the end card is the poster as its PNG draws it; frame cost against One row is
 * reported, not gated.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';

const ROOT = join(import.meta.dirname, '../..');
const PIECE = join(ROOT, 'examples/songs/kite-day.algorhythms.json');
const BENCH = join(ROOT, 'examples/the-cartographers-rain.algorhythms.json');

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

interface VideoOptions {
  aspect: '16:9' | '9:16' | '1:1';
  size: '1080' | '720';
  camera: 'follow' | 'whole';
  window: number;
  dark: boolean;
  thickness: boolean;
  fps: number;
  exportLook?: Record<string, unknown>;
  poster?: {
    rows: number;
    size: { w: number; h: number };
    doc?: unknown;
    rowBreak?: 'pan' | 'scroll' | 'cut';
    playhead?: boolean;
    window?: number;
  };
}
interface FramesResult {
  frames: { k: number; hash: string; inked: number }[];
  pngs: string[];
  repeats: { k: number; n: number; box: number[] }[];
  width: number;
  height: number;
}
interface BenchResult {
  median: number;
  p95: number;
  max: number;
}
interface Hook {
  videoFrames(json: unknown, o: VideoOptions, frames: number[], png: number): Promise<FramesResult>;
  videoBench(json: unknown, o: VideoOptions, n: number): BenchResult;
  posterEndCard(
    json: unknown,
    o: VideoOptions,
  ): Promise<{ differ: number; mean: number; total: number; png: string; ref: string }>;
}

const FPS = 30;
const POSTERS = {
  '16:9': { w: 3840, h: 2160 },
  square: { w: 2160, h: 2160 },
  a4: { w: 2480, h: 3508 },
} as const;

const png = (u: string) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');

test.describe('video over the poster', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
    await page.goto('about:blank');
    await page.addScriptTag({ content: await renderBundle() });
  });

  for (const aspect of ['16:9', '9:16', '1:1'] as const) {
    test(`${aspect}: non-empty, deterministic frames`, async ({ page, browserName }, info) => {
      test.setTimeout(60_000);
      const json = JSON.parse(readFileSync(PIECE, 'utf8')) as unknown;
      const o: VideoOptions = {
        aspect,
        size: '1080',
        camera: 'follow',
        window: 20,
        dark: true,
        thickness: true,
        fps: FPS,
        exportLook: { future: 'dimmed', glow: 0.4, hud: ['time', 'chord'] },
        poster: { rows: 4, size: POSTERS.a4, doc: { texts: [] } },
      };
      const ks = [1500, 30, 2400, 1500, 0];
      const r = await page.evaluate(
        ({ json, o, ks }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoFrames(json, o, ks, 1500),
        { json, o, ks },
      );
      for (const f of r.frames) expect(f.inked, `frame ${f.k}`).toBeGreaterThan(5000);
      if (process.env.POSTER_OUT_DIR) {
        mkdirSync(process.env.POSTER_OUT_DIR, { recursive: true });
        writeFileSync(
          join(process.env.POSTER_OUT_DIR, `frame-${aspect.replace(':', 'x')}.png`),
          png(r.pngs[0]),
        );
      }
      expect(r.repeats[0].n, JSON.stringify(r.repeats[0])).toBe(0);
      await info.attach(`poster-${aspect.replace(':', 'x')}-${browserName}.png`, {
        body: png(r.pngs[0]),
        contentType: 'image/png',
      });
    });
  }

  test('a dimmed future lands where the full future is', async ({ page }) => {
    test.setTimeout(60_000);
    const json = JSON.parse(readFileSync(PIECE, 'utf8')) as unknown;
    const base: VideoOptions = {
      aspect: '16:9',
      size: '720',
      camera: 'follow',
      window: 20,
      dark: false,
      thickness: true,
      fps: FPS,
      poster: { rows: 3, size: POSTERS['16:9'], doc: { texts: [] }, playhead: false },
    };
    const k = 900;
    const run = (future: string) =>
      page.evaluate(
        ({ json, o, k }) => {
          const r = (globalThis as unknown as { __render: Hook }).__render;
          return r.videoFrames(json, o, [k], k);
        },
        { json, o: { ...base, exportLook: { future, hud: [] } }, k },
      );
    const [hidden, dimmed, full] = [await run('hidden'), await run('dimmed'), await run('full')];
    expect(hidden.frames[0].inked).toBeLessThan(dimmed.frames[0].inked);
    expect(dimmed.frames[0].hash).not.toBe(full.frames[0].hash);
    // Pixels where the full future differs from none: the dimmed future inks most of them too.
    const pix = await page.evaluate(
      async ({ urls }) => {
        const data = await Promise.all(
          urls.map(async (u) => {
            const bmp = await createImageBitmap(await (await fetch(u)).blob());
            const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
            c.drawImage(bmp, 0, 0);
            return c.getImageData(0, 0, bmp.width, bmp.height).data;
          }),
        );
        const [h, d, f] = data;
        let ahead = 0;
        let both = 0;
        for (let i = 0; i < h.length; i += 4) {
          const df =
            Math.abs(f[i] - h[i]) + Math.abs(f[i + 1] - h[i + 1]) + Math.abs(f[i + 2] - h[i + 2]);
          if (df < 60) continue;
          ahead++;
          const dd =
            Math.abs(d[i] - h[i]) + Math.abs(d[i + 1] - h[i + 1]) + Math.abs(d[i + 2] - h[i + 2]);
          if (dd > 6) both++;
        }
        return { ahead, both };
      },
      { urls: [hidden.pngs[0], dimmed.pngs[0], full.pngs[0]] },
    );
    expect(pix.ahead).toBeGreaterThan(500);
    expect(pix.both / pix.ahead, JSON.stringify(pix)).toBeGreaterThan(0.9);
  });

  for (const [name, size] of Object.entries(POSTERS)) {
    test(`the end card is the poster (${name})`, async ({ page, browserName }, info) => {
      test.setTimeout(60_000);
      const json = JSON.parse(readFileSync(PIECE, 'utf8')) as unknown;
      const o: VideoOptions = {
        aspect: '16:9',
        size: '1080',
        camera: 'follow',
        window: 20,
        dark: true,
        thickness: true,
        fps: FPS,
        exportLook: { hud: ['time', 'key'] },
        poster: { rows: 3, size },
      };
      const r = await page.evaluate(
        ({ json, o }) =>
          (globalThis as unknown as { __render: Hook }).__render.posterEndCard(json, o),
        { json, o },
      );
      await info.attach(`end-card-${name}-${browserName}.png`, {
        body: png(r.png),
        contentType: 'image/png',
      });
      const dir = process.env.POSTER_OUT_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `end-card-${name}.png`), png(r.png));
        writeFileSync(join(dir, `end-ref-${name}.png`), png(r.ref));
      }
      expect(r.total).toBeGreaterThan(100_000);
      expect(r.differ / r.total, JSON.stringify({ ...r, png: undefined })).toBeLessThan(0.005);
      expect(r.mean).toBeLessThan(2);
    });
  }

  test('frame cost at 1080p over the poster vs One row (reported)', async ({
    page,
    browserName,
  }, info) => {
    test.setTimeout(180_000);
    const json = JSON.parse(readFileSync(BENCH, 'utf8')) as unknown;
    const base: VideoOptions = {
      aspect: '16:9',
      size: '1080',
      camera: 'follow',
      window: 20,
      dark: false,
      thickness: true,
      fps: FPS,
      exportLook: { future: 'dimmed' },
    };
    const run = (o: VideoOptions) =>
      page.evaluate(
        ({ json, o }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoBench(json, o, 90),
        { json, o },
      );
    const poster = { rows: 4, size: POSTERS['16:9'] };
    const results: Record<string, BenchResult> = {
      'row-16x9': await run(base),
      'poster-16x9': await run({ ...base, poster }),
      'poster-9x16': await run({ ...base, aspect: '9:16', poster }),
      'poster-whole': await run({ ...base, camera: 'whole', poster }),
      'row-glow': await run({ ...base, exportLook: { future: 'dimmed', glow: 0.5 } }),
      'poster-glow': await run({ ...base, exportLook: { future: 'dimmed', glow: 0.5 }, poster }),
    };
    info.annotations.push({ type: 'poster-frame-ms', description: JSON.stringify(results) });
    console.log(`[${browserName}] poster video frame cost (ms):`, JSON.stringify(results));
    for (const r of Object.values(results)) expect(Number.isFinite(r.median)).toBe(true);
  });
});
