/**
 * Ready for YouTube, video (PLAN.md §12, §15 M11): 1440p and 4K exports of a dense piece (Night
 * Sleeper, a section), read back with the muxer tests' box reader: pixel size, fps, key frames
 * every half second, the average video bitrate against the target (logged; see the build log
 * "M11 Y3": no encoder spends YouTube's rates on line art, so it is not gated), a decoded frame
 * against `drawVideoFrame` (PSNR), and AAC wherever the browser can encode it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type * as VideoExport from '../../src/app/video-export';
import { tracks } from '../unit/video/boxes';

const ROOT = join(import.meta.dirname, '../..');
const PIECE = JSON.parse(
  readFileSync(join(ROOT, 'examples/experiments/night-sleeper.algorhythms.json'), 'utf8'),
) as unknown;
/**
 * §15 M11: at least 40 dB decoded. Measured 42–48 dB at 1080p–4K on all three engines; the frame
 * 0.5 s away ~30 dB.
 */
const MIN_PSNR = 40;

interface HookWindow {
  __algorhythms: {
    parsePiece(j: unknown): { piece: Parameters<typeof VideoExport.exportVideo>[0] };
    videoExport(): Promise<typeof VideoExport>;
  };
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'once per engine');
  await page.goto('./');
  await page.waitForFunction(() => '__algorhythms' in window);
});

test('size classes and codecs: 1440p and 4K where the encoder takes them', async ({
  page,
  browserName,
}) => {
  const r = await page.evaluate(async () => {
    const m = await (window as unknown as HookWindow).__algorhythms.videoExport();
    const out: Record<string, string> = {};
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      for (const fps of [30, 60] as const) {
        const sizes = await m.videoSizes({ aspect, fps });
        const big = await Promise.all(
          sizes
            .filter((s) => s === '1440' || s === '2160')
            .map(async (size) => {
              const s = await m.videoSupport({ aspect, size, fps });
              return s.ok ? `${size}:${s.video}+${s.audio}` : size;
            }),
        );
        out[`${aspect}@${fps}`] = [sizes.join(','), ...big].join(' ');
      }
    }
    return out;
  });
  console.log(`video sizes ${browserName}: ${JSON.stringify(r)}`);
  for (const v of Object.values(r)) expect(v.startsWith('720,1080')).toBe(true);
});

for (const [size, fps, seconds] of [
  ['1440', 30, 3],
  ['2160', 60, 2],
] as const) {
  test(`${size}p${fps}: size, fps, key frames, bitrate and a decoded frame`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(300_000);
    const opts: VideoExport.VideoOptions = {
      aspect: '16:9',
      size,
      fps,
      camera: 'follow',
      window: 12,
      theme: 'dark',
      hud: true,
      thickness: true,
      section: { start: 42, end: 42 + seconds },
    };
    const r = await page.evaluate(
      async ({ json, opts }) => {
        const h = (window as unknown as HookWindow).__algorhythms;
        const m = await h.videoExport();
        const support = await m.videoSupport(opts);
        if (!support.ok) return { skip: support.reason };
        const piece = h.parsePiece(json).piece;
        const sink = m.blobSink();
        const etas: number[] = [];
        const t0 = performance.now();
        const res = await m.exportVideo(piece, opts, sink, {
          onProgress: (_f, _p, eta) => eta !== undefined && etas.push(eta),
        });
        const wall = (performance.now() - t0) / 1000;
        const blob = sink.blob();
        const el = document.createElement('video');
        el.muted = true;
        el.preload = 'auto';
        const once = (type: string) =>
          new Promise<void>((resolve, reject) => {
            el.addEventListener(type, () => resolve(), { once: true });
            el.addEventListener('error', () => reject(new Error(el.error?.message ?? 'error')), {
              once: true,
            });
          });
        const url = URL.createObjectURL(blob);
        const loaded = once('loadeddata');
        el.src = url;
        document.body.append(el);
        await loaded;
        const W = el.videoWidth;
        const H = el.videoHeight;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let se = 0;
          for (let i = 0; i < a.length; i += 4) {
            for (let j = 0; j < 3; j++) se += (a[i + j] - b[i + j]) ** 2;
          }
          return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
        };
        // Mid-GOP: the hardest frame for the encoder's budget.
        const k = Math.round(res.frames / 2) + Math.round(opts.fps / 4);
        const seeked = once('seeked');
        el.currentTime = (k + 0.5) / opts.fps;
        await seeked;
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
        g.drawImage(el, 0, 0, W, H);
        const got = g.getImageData(0, 0, W, H).data;
        const ref = psnr(got, m.referenceFrame(piece, opts, k).data);
        const control = psnr(got, m.referenceFrame(piece, opts, k - opts.fps / 2).data);
        el.remove();
        URL.revokeObjectURL(url);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return {
          aac: support.aac,
          codecs: `${res.video} + ${res.audio}`,
          frames: res.frames,
          delivered: res.videoBitrate,
          target: res.targetBitrate,
          wall,
          etas: etas.length,
          psnr: ref,
          control,
          element: `${W}x${H}`,
          file: btoa(bin),
        };
      },
      { json: PIECE, opts },
    );
    test.skip('skip' in r, (r as { skip?: string }).skip);
    if ('skip' in r) return;
    const { file, ...shown } = r;
    const file8 = new Uint8Array(Buffer.from(file, 'base64'));
    const [v] = tracks(file8).filter((t) => t.handler === 'vide');
    const [a] = tracks(file8).filter((t) => t.handler === 'soun');
    const keys = v.samples.filter((s) => s.key).length;
    const muxed = (v.samples.reduce((n, s) => n + s.size, 0) * 8) / (v.mediaDuration / v.timescale);
    const pct = (100 * muxed) / r.target;
    console.log(
      `video youtube ${browserName} ${size}p${fps}: ${JSON.stringify(shown)} muxed ${(muxed / 1e6).toFixed(2)} Mb/s = ${pct.toFixed(0)} % of target, ${keys} key frames, ${a.entry.type}`,
    );

    const px = size === '1440' ? [2560, 1440] : [3840, 2160];
    expect([v.width, v.height]).toEqual(px);
    expect(r.element).toBe(`${px[0]}x${px[1]}`);
    expect(v.samples.length).toBe(r.frames);
    expect(v.samples.length / (v.mediaDuration / v.timescale)).toBeCloseTo(fps, 0);
    // A key frame every half second.
    expect(keys).toBeGreaterThanOrEqual(Math.ceil(r.frames / (fps / 2)));
    // The muxed size is what the export reports.
    expect(Math.abs(muxed / r.delivered - 1)).toBeLessThan(0.02);
    expect(r.psnr).toBeGreaterThanOrEqual(MIN_PSNR);
    expect(r.control).toBeLessThan(r.psnr - 4);
    expect(r.etas).toBeGreaterThan(0);
    expect(a.entry.type).toBe(r.aac ? 'mp4a' : 'Opus');
  });
}

/**
 * §15 M11, logged rather than gated (about 7 min per engine): the whole of Night Sleeper (a dense
 * 2-minute piece) as the YouTube preset exports it, 4K60 with a title card and a 10 s end card,
 * played back here: its size, frame rate, length, AAC, and two decoded frames' PSNR.
 * Run with M11_LONG=1.
 */
test('YouTube preset, 4K60, the whole 2-minute piece (M11_LONG=1)', async ({
  page,
  browserName,
}) => {
  test.skip(process.env.M11_LONG !== '1', 'long: run with M11_LONG=1');
  test.setTimeout(3_600_000);
  const r = await page.evaluate(
    async ({ json }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.videoExport();
      const piece = h.parsePiece(json).piece;
      const opts: VideoExport.VideoOptions = {
        aspect: '16:9',
        size: '2160',
        fps: 60,
        camera: 'follow',
        window: 12,
        theme: 'dark',
        hud: true,
        thickness: true,
        quality: 'high',
        loudness: -14,
        bookends: {
          title: { text: piece.meta.title },
          endCard: 10,
          credit: 'Made with AlgoRhythms',
        },
      };
      const support = await m.videoSupport(opts);
      if (!support.ok) return { skip: support.reason };
      const sink = m.blobSink();
      const t0 = performance.now();
      const res = await m.exportVideo(piece, opts, sink);
      const wall = (performance.now() - t0) / 1000;
      const blob = sink.blob();
      const el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      const once = (type: string) =>
        new Promise<void>((resolve, reject) => {
          el.addEventListener(type, () => resolve(), { once: true });
          el.addEventListener('error', () => reject(new Error(el.error?.message ?? 'error')), {
            once: true,
          });
        });
      const url = URL.createObjectURL(blob);
      const loaded = once('loadeddata');
      el.src = url;
      document.body.append(el);
      await loaded;
      const W = el.videoWidth;
      const H = el.videoHeight;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let se = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let j = 0; j < 3; j++) se += (a[i + j] - b[i + j]) ** 2;
        }
        return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
      };
      const compiled = (await import('/src/core/compiler/compile.ts' as string)).compile(piece);
      const frameAt = async (k: number) => {
        const seeked = once('seeked');
        el.currentTime = (k + 0.5) / 60;
        await seeked;
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
        g.drawImage(el, 0, 0, W, H);
        const got = g.getImageData(0, 0, W, H).data;
        const ref = new OffscreenCanvas(W, H).getContext('2d')!;
        m.previewVideoMoment(ref as never, piece, compiled, opts, k / 60, 1);
        return psnr(got, ref.getImageData(0, 0, W, H).data);
      };
      // Mid-GOP frames in the densest stretch and in the end card.
      const dense = await frameAt(43 * 60 + 15);
      const card = await frameAt(Math.round(compiled.duration * 60) + 9 * 60 + 15);
      const duration = el.duration;
      el.remove();
      URL.revokeObjectURL(url);
      return {
        codecs: `${res.video} + ${res.audio}`,
        aac: support.aac,
        frames: res.frames,
        duration,
        element: `${W}x${H}`,
        fps: res.frames / duration,
        mb: blob.size / 1e6,
        delivered: res.videoBitrate,
        wall,
        dense,
        card,
      };
    },
    { json: PIECE },
  );
  console.log(`video youtube long ${browserName}: ${JSON.stringify(r)}`);
  test.skip('skip' in r, (r as { skip?: string }).skip);
  if ('skip' in r) return;
  expect(r.element).toBe('3840x2160');
  expect(r.fps).toBeCloseTo(60, 0);
  expect(r.dense).toBeGreaterThanOrEqual(MIN_PSNR);
  expect(r.card).toBeGreaterThanOrEqual(MIN_PSNR);
  if (r.aac) expect(r.codecs).toMatch(/mp4a/);
});
