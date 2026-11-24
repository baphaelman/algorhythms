/**
 * Video frames (PLAN.md §12 "Video export", revision 11): frames of a bundled composition drawn on
 * an OffscreenCanvas in the page, in each aspect. Non-empty, deterministic (frame k drawn twice is
 * the same pixels, whatever was drawn between), and one PNG per aspect attached for review.
 * Frame cost at 1080p with 24 voices is reported (annotation and log), not gated.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';

const ROOT = join(import.meta.dirname, '../..');
const PIECE = join(ROOT, 'examples/songs/tide-pools.algorhythms.json');
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
  voices?: number;
  /** EXPORT_LOOK with these changes. */
  exportLook?: Record<string, unknown>;
}
interface FramesResult {
  frames: { k: number; hash: string; inked: number }[];
  png: string;
  /** PNG data URL of each frame drawn at the `png` index. */
  pngs: string[];
  /** Frames drawn again: pixels that differ from the first draw, and their box [x0, y0, x1, y1]. */
  repeats: { k: number; n: number; box: number[] }[];
  duration: number;
  width: number;
  height: number;
}
interface BenchResult {
  median: number;
  p95: number;
  max: number;
  voices: number;
}
interface Hook {
  videoFrames(json: unknown, o: VideoOptions, frames: number[], png: number): Promise<FramesResult>;
  videoBench(json: unknown, o: VideoOptions, n: number): BenchResult;
}

const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] } as const;
const FPS = 30;

test.describe('video frames', () => {
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
        window: 24,
        dark: aspect === '9:16',
        thickness: true,
        fps: FPS,
      };
      // Frame 1500 (50 s) twice, with others between; then the first and a tail frame.
      const ks = [1500, 30, 3000, 1500, 0, 99999];
      const r = await page.evaluate(
        ({ json, o, ks }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoFrames(json, o, ks, 1500),
        { json, o, ks },
      );
      expect([r.width, r.height]).toEqual(SIZES[aspect]);
      const by = (i: number) => r.frames[i];
      for (const f of r.frames) expect(f.inked, `frame ${f.k}`).toBeGreaterThan(5000);
      if (by(3).hash !== by(0).hash) {
        // For the report: both draws of frame 1500 and where they differ.
        const a = `video-${aspect.replace(':', 'x')}-${browserName}`;
        for (const [i, u] of r.pngs.entries()) {
          await info.attach(`${a}-1500-${i}.png`, {
            body: Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'),
            contentType: 'image/png',
          });
        }
        await info.attach(`${a}-repeats.json`, {
          body: JSON.stringify(r.repeats),
          contentType: 'application/json',
        });
        console.log(
          `[${browserName}] ${aspect} repeated frames differ:`,
          JSON.stringify(r.repeats),
        );
      }
      expect(by(3).hash).toBe(by(0).hash); // same k, same pixels
      expect(by(1).hash).not.toBe(by(0).hash); // the frames move
      // Tail frames past the end show the piece's last frame.
      const end = Math.ceil(r.duration * FPS);
      const tail = await page.evaluate(
        ({ json, o, ks }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoFrames(json, o, ks, -1),
        { json, o, ks: [end, end + 90] },
      );
      expect(tail.frames[1].hash).toBe(tail.frames[0].hash);
      expect(tail.frames[1].hash).toBe(by(5).hash);

      expect(r.png.startsWith('data:image/png;base64,')).toBe(true);
      const png = Buffer.from(r.png.slice('data:image/png;base64,'.length), 'base64');
      const name = `video-${aspect.replace(':', 'x')}-${browserName}.png`;
      await info.attach(name, { body: png, contentType: 'image/png' });
      writeFileSync(info.outputPath(name), png);
    });
  }

  test('thickness off draws different, still non-empty frames', async ({ page }) => {
    const json = JSON.parse(readFileSync(PIECE, 'utf8')) as unknown;
    const base: VideoOptions = {
      aspect: '16:9',
      size: '720',
      camera: 'whole',
      window: 24,
      dark: false,
      thickness: true,
      fps: FPS,
    };
    const run = (o: VideoOptions) =>
      page.evaluate(
        ({ json, o }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoFrames(json, o, [1500], -1),
        { json, o },
      );
    const on = await run(base);
    const off = await run({ ...base, thickness: false });
    expect(off.frames[0].inked).toBeGreaterThan(5000);
    expect(off.frames[0].hash).not.toBe(on.frames[0].hash);
  });

  // The export Look (§12 "Export look"): EXPORT_LOOK with a HUD of chord, key, time, spread,
  // note names and gaps. $LOOK_OUT_DIR gets look-video.png for review.
  test('EXPORT_LOOK: non-empty, deterministic frames, unlike the player look', async ({
    page,
    browserName,
  }, info) => {
    test.setTimeout(60_000);
    const json = JSON.parse(readFileSync(PIECE, 'utf8')) as unknown;
    const base: VideoOptions = {
      aspect: '16:9',
      size: '1080',
      camera: 'follow',
      window: 24,
      dark: false,
      thickness: true,
      fps: FPS,
    };
    const look: VideoOptions = {
      ...base,
      exportLook: { hud: ['time', 'chord', 'key', 'spread', 'names', 'gaps'] },
    };
    const run = (o: VideoOptions, ks: number[], png: number) =>
      page.evaluate(
        ({ json, o, ks, png }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoFrames(json, o, ks, png),
        { json, o, ks, png },
      );
    const r = await run(look, [1500, 30, 3000, 1500], 1500);
    for (const f of r.frames) expect(f.inked, `frame ${f.k}`).toBeGreaterThan(5000);
    expect(r.frames[3].hash).toBe(r.frames[0].hash);
    expect(r.frames[1].hash).not.toBe(r.frames[0].hash);
    const player = await run(base, [1500], -1);
    expect(player.frames[0].hash).not.toBe(r.frames[0].hash);
    // Nothing ahead of the playhead: fewer inked pixels than the player's dimmed future.
    expect(r.frames[0].inked).toBeLessThan(player.frames[0].inked);
    const png = Buffer.from(r.png.slice('data:image/png;base64,'.length), 'base64');
    await info.attach(`look-video-${browserName}.png`, { body: png, contentType: 'image/png' });
    writeFileSync(info.outputPath(`look-video-${browserName}.png`), png);
    const dir = process.env.LOOK_OUT_DIR;
    if (dir && browserName === 'chromium') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'look-video.png'), png);
    }
  });

  test('frame cost at 1080p, 24 voices (reported)', async ({ page, browserName }, info) => {
    test.setTimeout(120_000);
    const json = JSON.parse(readFileSync(BENCH, 'utf8')) as unknown;
    const base: VideoOptions = {
      aspect: '16:9',
      size: '1080',
      camera: 'follow',
      window: 20,
      dark: false,
      thickness: true,
      fps: FPS,
      voices: 24,
    };
    const run = (o: VideoOptions) =>
      page.evaluate(
        ({ json, o }) =>
          (globalThis as unknown as { __render: Hook }).__render.videoBench(json, o, 120),
        { json, o },
      );
    const results: Record<string, BenchResult> = {
      'follow-16x9': await run(base),
      'follow-9x16': await run({ ...base, aspect: '9:16' }),
      'whole-16x9': await run({ ...base, camera: 'whole' }),
      'follow-16x9-thin': await run({ ...base, thickness: false }),
    };
    info.annotations.push({ type: 'video-frame-ms', description: JSON.stringify(results) });
    console.log(`[${browserName}] video frame cost (ms):`, JSON.stringify(results));
    for (const r of Object.values(results)) {
      expect(r.voices).toBe(24);
      expect(Number.isFinite(r.median)).toBe(true);
    }
  });
});
