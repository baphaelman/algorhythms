/**
 * Long video exports (PLAN §15 M8, acceptance lines 2 and 3), opt-in: `VIDEO_LONG=1`, Chromium
 * dev only, reported, loose gates. Not run in CI (minutes per export).
 * - speed: the featured piece cut to 180 s, 1080p30, Follow and Whole: wall time and real-time
 *   factor;
 * - drift: the featured piece cut to 600 s, 720p30 Follow, streamed to disk through an exposed
 *   function. ffprobe: frame count, the last frame's pts, both streams' durations vs the WAV
 *   length. Near the piece's end, the decoded frame (ffmpeg) is compared with the direct renders
 *   of frames k − 1, k, k + 1 (k must win), and the decoded audio is cross-correlated with the
 *   WAV render (lag in samples);
 * - Whole-piece frame cost near the end of 30, 180 and 600 s pieces.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown; compiled: { duration: number } } };
    actions: { loadPiece(p: unknown): void };
    videoExport(): Promise<typeof VideoExport>;
  };
}

const FFPROBE = '/usr/bin/ffprobe';
const FFMPEG = '/usr/bin/ffmpeg';

test.beforeEach(async ({ page }, info) => {
  test.skip(!process.env.VIDEO_LONG, 'set VIDEO_LONG=1');
  test.skip(info.project.name !== 'chromium-dev', 'chromium-dev only');
  await page.goto('./');
  await page.waitForFunction(() => '__algorhythms' in window);
});

async function cut(page: Page, at: number): Promise<number> {
  return page.evaluate((at) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as { end?: { at: number; fade: number } };
    p.end = { at, fade: 2 };
    h.actions.loadPiece(p);
    return h.store.getState().compiled.duration;
  }, at);
}

test('3-minute piece at 1080p30: Follow and Whole wall time (reported)', async ({ page }) => {
  test.setTimeout(1_800_000);
  const duration = await cut(page, 180);
  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.videoExport();
    const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
    const out: Record<string, unknown> = {};
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
      const sink = m.blobSink();
      const t0 = performance.now();
      const res = await m.exportVideo(piece, opts, sink);
      const s = (performance.now() - t0) / 1000;
      out[camera] = {
        codecs: `${res.video} + ${res.audio}`,
        thread: res.thread,
        frames: res.frames,
        seconds: res.duration,
        wallSeconds: s,
        fps: res.frames / s,
        rtf: res.duration / s,
        mb: sink.size / 1e6,
        mbps: (sink.size * 8) / 1e6 / res.duration,
      };
    }
    return out;
  });
  console.log(`video long speed: ${JSON.stringify({ pieceSeconds: duration, ...r })}`);
  expect(duration).toBeGreaterThan(179);
});

test('10-minute piece at 720p30 Follow: no drift (ffprobe, end frame, end audio)', async ({
  page,
}, info) => {
  test.skip(!existsSync(FFPROBE) || !existsSync(FFMPEG), 'needs ffmpeg');
  test.setTimeout(1_800_000);
  const duration = await cut(page, 600);
  const file = info.outputPath('long-600.mp4');
  const fd = openSync(file, 'w');
  await page.exposeFunction('__sinkWrite', (b64: string, position: number | null) => {
    const buf = Buffer.from(b64, 'base64');
    writeSync(fd, buf, 0, buf.length, position ?? null);
  });
  const opts: VideoExport.VideoOptions = {
    aspect: '16:9',
    size: '720',
    fps: 30,
    camera: 'follow',
    window: 12,
    theme: 'dark',
    hud: true,
    thickness: true,
  };
  // k: a frame 5 s before the piece's end (inside the piece, not the held tail).
  const k = Math.round((duration - 5) * opts.fps);
  const r = await page.evaluate(
    async ({ opts, k }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.videoExport();
      const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
      const w = window as unknown as {
        __sinkWrite(b64: string, position: number | null): Promise<void>;
      };
      const b64 = (bytes: Uint8Array) => {
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(s);
      };
      let pos = 0;
      const sink: VideoExport.VideoSink = {
        positioned: true,
        async write(bytes, position) {
          if (position === undefined) {
            await w.__sinkWrite(b64(bytes), pos);
            pos += bytes.length;
          } else {
            await w.__sinkWrite(b64(bytes), position);
          }
        },
      };
      const t0 = performance.now();
      const res = await m.exportVideo(piece, opts, sink);
      const wallSeconds = (performance.now() - t0) / 1000;
      const refs = [k - 1, k, k + 1].map((j) =>
        b64(new Uint8Array(m.referenceFrame(piece, opts, j).data.buffer)),
      );
      // The WAV mix (mono sum) over 3 s ending 5 s before the piece's end.
      const [wl, wr] = await m.renderMix(piece);
      const a0 = Math.round((k / opts.fps - 3) * 48000);
      const mono = new Float32Array(3 * 48000);
      for (let i = 0; i < mono.length; i++) mono[i] = wl[a0 + i] + wr[a0 + i];
      return {
        codecs: `${res.video} + ${res.audio}`,
        frames: res.frames,
        seconds: res.duration,
        wavSamples: wl.length,
        wallSeconds,
        bytes: pos,
        refs,
        a0,
        mono: b64(new Uint8Array(mono.buffer)),
      };
    },
    { opts, k },
  );
  closeSync(fd);

  const probe = JSON.parse(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-count_packets',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      file,
    ]).toString(),
  ) as {
    streams: {
      codec_type: string;
      nb_read_packets: string;
      duration: string;
      duration_ts: number;
      time_base: string;
    }[];
    format: { duration: string };
  };
  const v = probe.streams.find((s) => s.codec_type === 'video')!;
  const a = probe.streams.find((s) => s.codec_type === 'audio')!;
  const lastPts = Number(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim()
      .split('\n')
      .map(Number)
      .reduce((x, y) => Math.max(x, y), 0),
  );

  // The decoded frame k (RGBA) vs the direct renders of k − 1, k, k + 1.
  const W = 1280;
  const H = 720;
  const got = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${k})`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    { maxBuffer: 64 << 20 },
  );
  const psnr = (ref: Buffer) => {
    let se = 0;
    for (let i = 0; i < W * H * 4; i += 4) {
      for (let j = 0; j < 3; j++) {
        const d = got[i + j] - ref[i + j];
        se += d * d;
      }
    }
    return 10 * Math.log10((255 * 255) / Math.max(se / (W * H * 3), 1e-9));
  };
  const framePsnr = r.refs.map((s) => psnr(Buffer.from(s, 'base64')));

  // Decoded audio near the end vs the WAV render: lag by cross-correlation (±10 ms).
  const pcm = execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 },
  );
  const dec = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const wavBuf = Buffer.from(r.mono, 'base64');
  const ref = new Float32Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.length / 4);
  let best = 0;
  let bestLag = 0;
  for (let lag = -480; lag <= 480; lag++) {
    let s = 0;
    for (let i = 0; i < ref.length; i++) {
      const j = r.a0 + i + lag;
      s += ref[i] * (dec[2 * j] + dec[2 * j + 1]);
    }
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }

  const report = {
    pieceSeconds: duration,
    codecs: r.codecs,
    frames: r.frames,
    seconds: r.seconds,
    wavSeconds: r.wavSamples / 48000,
    wallSeconds: r.wallSeconds,
    rtf: r.seconds / r.wallSeconds,
    mb: r.bytes / 1e6,
    videoPackets: Number(v.nb_read_packets),
    lastPts,
    expectedLastPts: (r.frames - 1) / opts.fps,
    videoDuration: Number(v.duration),
    audioDuration: Number(a.duration),
    formatDuration: Number(probe.format.duration),
    decodedAudioSeconds: dec.length / 2 / 48000,
    k,
    framePsnr: { [k - 1]: framePsnr[0], [k]: framePsnr[1], [k + 1]: framePsnr[2] },
    audioLagSamples: bestLag,
  };
  console.log(`video long drift: ${JSON.stringify(report)}`);
  expect(duration).toBeGreaterThan(599);
  expect(report.videoPackets).toBe(r.frames);
  expect(Math.abs(lastPts - report.expectedLastPts)).toBeLessThan(1e-3);
  expect(Math.abs(report.audioDuration - report.wavSeconds)).toBeLessThanOrEqual(1 / 30);
  expect(framePsnr[1]).toBeGreaterThan(Math.max(framePsnr[0], framePsnr[2]));
  expect(Math.abs(bestLag)).toBeLessThanOrEqual(48);
});

test('Whole-piece frame cost grows with the piece (reported)', async ({ page }) => {
  test.setTimeout(600_000);
  // `referenceFrame` = compile + draw + readback; Whole − Follow at the same frame isolates the
  // extra drawing of the whole piece's lines.
  const out: Record<number, Record<string, number>> = {};
  for (const at of [30, 180, 600]) {
    const duration = await cut(page, at);
    out[at] = await page.evaluate(async (duration) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.videoExport();
      const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
      const cost: Record<string, number> = {};
      const k = Math.floor((duration - 1) * 30);
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
        m.referenceFrame(piece, opts, k);
        const ms: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          m.referenceFrame(piece, opts, k - i);
          ms.push(performance.now() - t0);
        }
        cost[camera] = ms.sort((a, b) => a - b)[2];
      }
      cost.wholeExtra = cost.whole - cost.follow;
      return cost;
    }, duration);
  }
  console.log(`video long frame cost near the end (ms, median of 5): ${JSON.stringify(out)}`);
});
