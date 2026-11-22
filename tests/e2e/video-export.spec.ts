/**
 * Video export (src/app/video-export.ts, PLAN.md §12, §15 M8): the featured piece cut to 7 s,
 * exported at 720p30 into a memory sink and played back in a `<video>`:
 * - duration within one frame of the WAV render's length;
 * - decoded frames k (start, middle, a glide, last) against `drawVideoFrame` of frame k (PSNR,
 *   with frame k ± 15 as the positive control);
 * - decoded audio (decodeAudioData) against the WAV render: lag by cross-correlation, RMS;
 * - ffprobe of the file where it is installed.
 * Also: the main-thread fallback, cancel within 1 s, and speed at 1080p30 (Follow, Whole; logged,
 * loose gate). Codecs are what each browser picks (Playwright's Chromium and Firefox: H.264 +
 * Opus; CI's WebKit: H.264 + AAC).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type * as VideoExport from '../../src/app/video-export';

interface Store {
  getState(): {
    piece: unknown;
    compiled: {
      duration: number;
      voices: { segments: { t0: number; t1: number; p0: number; p1: number }[] }[];
    };
  };
}
interface HookWindow {
  __algorhythms: {
    store: Store;
    actions: { loadPiece(p: unknown): void };
    videoExport(): Promise<typeof VideoExport>;
  };
}

const FFPROBE = '/usr/bin/ffprobe';
const FFMPEG = '/usr/bin/ffmpeg';
const OPTS: VideoExport.VideoOptions = {
  aspect: '16:9',
  size: '720',
  fps: 30,
  camera: 'follow',
  window: 12,
  theme: 'dark',
  hud: true,
  thickness: true,
};
/**
 * Codec tolerance: decoded frame vs a direct render, PSNR over RGB. Frames measure 39.4–46 dB
 * (Firefox on Linux CI lowest, frame 197), the control (the frame 15 away) 30.6–36 dB. A frame
 * must reach MIN_PSNR and beat its own control by MIN_MARGIN dB.
 */
const MIN_PSNR = 37;
const MIN_MARGIN = 4;

async function loadShort(page: Page, seconds: number): Promise<void> {
  await page.evaluate((at) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as { end: { at: number; fade: number } };
    p.end = { at, fade: 1 };
    h.actions.loadPiece(p);
  }, seconds);
}

test.beforeEach(async ({ page }, info) => {
  // The prod build runs the main test only (the worker's bundled URL); the rest once per engine.
  test.skip(
    info.project.name.endsWith('-prod') && !info.title.includes('plays'),
    'once per engine',
  );
  await page.goto('./');
  await page.waitForFunction(() => '__algorhythms' in window);
});

interface PlayResult {
  skip?: string;
  codecs?: string;
  thread?: string;
  priming?: number;
  /** `codecDelay` of the audio codec (samples; applied for AAC only). */
  codecDelay?: number;
  frames?: number;
  wavSeconds?: number;
  elementDuration?: number;
  checks?: { k: number; psnr: number; control: number }[];
  lagMs?: number;
  rmsDb?: number;
  bytes?: number;
  file?: string;
}

for (const vp9 of [false, true]) {
  test(`720p30 export plays${vp9 ? ' (VP9 fallback)' : ''}: duration, frames and audio match the direct renders`, async ({
    page,
    browserName,
  }, info) => {
    test.setTimeout(240_000);
    test.skip(vp9 && info.project.name.endsWith('-prod'), 'once per engine');
    await loadShort(page, 7);
    const r = await page.evaluate(
      async ({ opts, vp9 }): Promise<PlayResult> => {
        const h = (window as unknown as HookWindow).__algorhythms;
        const m = await h.videoExport();
        const support = await m.videoSupport(opts);
        if (!support.ok) return { skip: support.reason };
        const video = vp9 ? m.videoCodecs(1280, 720, opts.fps).at(-1)! : support.video;
        if (
          vp9 &&
          !(await VideoEncoder.isConfigSupported({ codec: video, width: 1280, height: 720 }))
            .supported
        ) {
          return { skip: `cannot encode ${video}` };
        }
        const mime = `video/mp4; codecs="${video}, ${support.audio}"`;
        if (!document.createElement('video').canPlayType(mime))
          return { skip: `cannot play ${mime}` };
        const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
        const sink = m.blobSink();
        const res = await m.exportVideo(piece, opts, sink, { codecs: { video } });
        const delay = await m.codecDelay(support.audio);
        const blob = sink.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());

        // <video>: duration, then frames.
        const el = document.createElement('video');
        el.muted = true;
        el.preload = 'auto';
        const once = (type: string) =>
          new Promise<void>((resolve, reject) => {
            el.addEventListener(type, () => resolve(), { once: true });
            el.addEventListener(
              'error',
              () => reject(new Error(el.error?.message ?? 'media error')),
              {
                once: true,
              },
            );
          });
        const url = URL.createObjectURL(blob);
        const loaded = once('loadeddata');
        el.src = url;
        document.body.append(el);
        await loaded;
        const elementDuration = el.duration;

        const { fps } = opts;
        const n = res.frames;
        // A frame in the middle of a glide (pitch moving by more than a semitone).
        let glide = Math.round(n / 3);
        for (const v of h.store.getState().compiled.voices) {
          const s = v.segments.find((s) => Math.abs(s.p1 - s.p0) > 1 && s.t0 > 0.5 && s.t1 < 6.5);
          if (s) {
            glide = Math.round(((s.t0 + s.t1) / 2) * fps);
            break;
          }
        }
        const W = 1280;
        const H = 720;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let se = 0;
          for (let i = 0; i < a.length; i += 4) {
            for (let j = 0; j < 3; j++) {
              const d = a[i + j] - b[i + j];
              se += d * d;
            }
          }
          const mse = se / ((a.length / 4) * 3);
          return 10 * Math.log10((255 * 255) / Math.max(mse, 1e-9));
        };
        const checks: { k: number; psnr: number; control: number }[] = [];
        for (const k of [0, Math.round(n / 2), glide, n - 1]) {
          const seeked = once('seeked');
          el.currentTime = (k + 0.5) / fps;
          await seeked;
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
          g.drawImage(el, 0, 0, W, H);
          const got = g.getImageData(0, 0, W, H).data;
          const ref = m.referenceFrame(piece, opts, k).data;
          // The control: a frame 0.5 s away inside the piece (the tail holds the last frame).
          const end = Math.floor(h.store.getState().compiled.duration * fps);
          const kk = Math.min(k, end);
          const kc = kk + 15 <= end ? kk + 15 : kk - 15;
          const control = m.referenceFrame(piece, opts, kc).data;
          checks.push({ k, psnr: psnr(got, ref), control: psnr(got, control) });
        }
        el.remove();
        URL.revokeObjectURL(url);

        // Audio: decoded MP4 vs the WAV render.
        const decoded = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(
          bytes.slice().buffer,
        );
        const [wl, wr] = await m.renderMix(piece);
        const dl = decoded.getChannelData(0);
        const dr = decoded.getChannelData(1);
        const len = Math.min(dl.length, wl.length);
        const span = Math.min(len - 960, 3 * 48000);
        const a = new Float32Array(span);
        const b = new Float32Array(span + 960);
        for (let i = 0; i < span; i++) a[i] = wl[i] + wr[i];
        for (let i = 0; i < span + 960 && i < len; i++) b[i] = dl[i] + dr[i];
        const lag = m.xcorrLag(a, b, -480, 480);
        let ew = 0;
        let ed = 0;
        for (let i = 0; i < len; i++) {
          ew += wl[i] * wl[i] + wr[i] * wr[i];
          ed += dl[i] * dl[i] + dr[i] * dr[i];
        }
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return {
          codecs: `${res.video} + ${res.audio}`,
          codecDelay: delay,
          thread: res.thread,
          priming: res.primingSamples,
          frames: n,
          wavSeconds: wl.length / 48000,
          elementDuration,
          checks,
          lagMs: (lag / 48000) * 1000,
          rmsDb: 10 * Math.log10(ed / ew),
          bytes: bytes.length,
          file: btoa(bin),
        };
      },
      { opts: OPTS, vp9 },
    );

    test.skip(!!r.skip, r.skip);
    const { file, ...shown } = r;
    console.log(`video export ${browserName}: ${JSON.stringify(shown)}`);
    info.annotations.push({ type: 'video-export', description: JSON.stringify(shown) });

    // WebKit may fall back to the main thread (not run here); the others must use the worker.
    if (browserName !== 'webkit') expect(r.thread).toBe('worker');
    expect(Math.abs(r.elementDuration! - r.wavSeconds!), 'duration').toBeLessThanOrEqual(1 / 30);
    expect(r.frames).toBe(Math.ceil(r.wavSeconds! * 30 - 1e-6));
    for (const c of r.checks!) {
      expect(c.psnr, `frame ${c.k} PSNR`).toBeGreaterThanOrEqual(MIN_PSNR);
      expect(c.control, `frame ${c.k} control PSNR`).toBeLessThanOrEqual(c.psnr - MIN_MARGIN);
    }
    // AAC: WebKit's decodeAudioData lands 3.25 ms early with the measured 2112-sample priming in
    // the edit list (imperceptible; lip sync tolerance ~20 ms); not resolvable without macOS.
    const maxLagMs = r.codecs!.endsWith('aac') ? 5 : 1;
    expect(Math.abs(r.lagMs!), 'audio lag (ms)').toBeLessThanOrEqual(maxLagMs);
    expect(Math.abs(r.rmsDb!), 'audio RMS (dB)').toBeLessThanOrEqual(1);

    // ffprobe where installed: codecs, duration and frame count.
    const out = info.outputPath(`video-export-${browserName}${vp9 ? '-vp9' : ''}.mp4`);
    writeFileSync(out, Buffer.from(file!, 'base64'));
    if (!existsSync(FFPROBE)) return;
    const probe = JSON.parse(
      execFileSync(FFPROBE, [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        out,
      ]).toString(),
    ) as {
      streams: {
        codec_type: string;
        codec_name: string;
        nb_read_frames?: string;
        width?: number;
      }[];
      format: { duration: string };
    };
    const v = probe.streams.find((s) => s.codec_type === 'video')!;
    const a = probe.streams.find((s) => s.codec_type === 'audio')!;
    console.log(
      `ffprobe ${browserName}: ${v.codec_name} ${v.width} ${v.nb_read_frames} frames, ${a.codec_name}, ${probe.format.duration} s`,
    );
    expect(v.codec_name).toBe(r.codecs!.startsWith('avc') ? 'h264' : 'vp9');
    expect(a.codec_name).toBe(r.codecs!.endsWith('opus') ? 'opus' : 'aac');
    expect(v.width).toBe(1280);
    expect(Number(v.nb_read_frames)).toBe(r.frames);
    expect(Math.abs(Number(probe.format.duration) - r.wavSeconds!)).toBeLessThanOrEqual(1 / 30);
    // A clean decode: no complaints about the avcC / bitstream (Firefox's avcC needed a repair).
    if (existsSync(FFMPEG)) {
      const run = spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-f', 'null', '-']);
      expect(run.status).toBe(0);
      expect(run.stderr.toString()).toBe('');
    }
  });
}

test('main-thread fallback makes the same video', async ({ page }) => {
  test.setTimeout(120_000);
  await loadShort(page, 2);
  const r = await page.evaluate(async (opts) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.videoExport();
    if (!(await m.videoSupport(opts)).ok) return null;
    const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
    const run = async (mainThread: boolean) => {
      const sink = m.blobSink();
      const res = await m.exportVideo(piece, opts, sink, { mainThread });
      return { thread: res.thread, frames: res.frames, bytes: sink.size };
    };
    return { worker: await run(false), main: await run(true) };
  }, OPTS);
  test.skip(!r, 'no video export here');
  expect(r!.main.thread).toBe('main');
  expect(r!.main.frames).toBe(r!.worker.frames);
  // Same frames, same encoder settings: sizes within a few per cent.
  expect(Math.abs(r!.main.bytes / r!.worker.bytes - 1)).toBeLessThan(0.05);
});

test('cancel stops within 1 s with an AbortError', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.videoExport();
    const full: VideoExport.VideoOptions = {
      aspect: '16:9',
      size: '1080',
      fps: 30,
      camera: 'follow',
      window: 12,
      theme: 'light',
      hud: true,
      thickness: true,
    };
    if (!(await m.videoSupport(full)).ok) return null;
    const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
    const ac = new AbortController();
    let progress = 0;
    const p = m.exportVideo(piece, full, m.blobSink(), {
      signal: ac.signal,
      onProgress: (f) => (progress = f),
    });
    while (progress < 0.03) await new Promise((r) => setTimeout(r, 20));
    const t0 = performance.now();
    ac.abort();
    try {
      await p;
      return { name: 'resolved', ms: performance.now() - t0, progress };
    } catch (e) {
      return { name: (e as Error).name, ms: performance.now() - t0, progress };
    }
  });
  test.skip(!r, 'no video export here');
  console.log(`cancel: ${JSON.stringify(r)}`);
  expect(r!.name).toBe('AbortError');
  expect(r!.ms).toBeLessThan(1000);
});

test('speed: 30 s at 1080p30, Follow and Whole (logged; loose gate)', async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(600_000);
  await loadShort(page, 30);
  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.videoExport();
    const out: Record<string, { fps: number; rtf: number; seconds: number; mb: number }> = {};
    for (const camera of ['follow', 'whole'] as const) {
      const opts: VideoExport.VideoOptions = {
        aspect: '16:9',
        size: '1080',
        fps: 30,
        camera,
        window: 12,
        theme: 'dark',
        hud: true,
        thickness: true,
      };
      if (!(await m.videoSupport(opts)).ok) return null;
      const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
      const sink = m.blobSink();
      const t0 = performance.now();
      const res = await m.exportVideo(piece, opts, sink);
      const s = (performance.now() - t0) / 1000;
      out[camera] = {
        fps: res.frames / s,
        rtf: res.duration / s,
        seconds: res.duration,
        mb: sink.size / 1e6,
      };
    }
    return out;
  });
  test.skip(!r, 'no video export here');
  console.log(`video export speed ${browserName}: ${JSON.stringify(r)}`);
  info.annotations.push({ type: 'speed', description: JSON.stringify(r) });
  expect(r!.follow.rtf).toBeGreaterThan(0.3);
});

test('every aspect, size and fps has codecs', async ({ page, browserName }) => {
  const r = await page.evaluate(async () => {
    const m = await (window as unknown as HookWindow).__algorhythms.videoExport();
    const out: Record<string, string> = {};
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      for (const size of ['1080', '720'] as const) {
        for (const fps of [30, 60] as const) {
          const s = await m.videoSupport({ aspect, size, fps });
          out[`${aspect} ${size} ${fps}`] = s.ok ? `${s.video} + ${s.audio}` : `no: ${s.reason}`;
        }
      }
    }
    return out;
  });
  console.log(`video support ${browserName}: ${JSON.stringify(r)}`);
  for (const [k, v] of Object.entries(r)) expect(v, k).not.toMatch(/^no:/);
});
