/**
 * The MP4 muxer (src/video/mp4.ts, M8) with real WebCodecs chunks: 2 s of synthetic frames and a
 * tone are encoded in the page, muxed in both layouts, and played by a `<video>`: duration within
 * one frame, and a seek to a middle frame shows that frame. Each codec pair runs where the browser
 * can both encode and play it (Playwright's Chromium lacks H.264/AAC, Firefox lacks AAC encode;
 * Firefox has H.264 + Opus; CI's WebKit covers H.264 + AAC).
 */

import { expect, test } from '@playwright/test';
import type * as Mp4 from '../../src/video/mp4';

type MuxWindow = { __algorhythms: { video(): Promise<typeof Mp4> } };

const PAIRS = {
  'h264 + aac': { video: 'avc1.42001f', audio: 'mp4a.40.2' },
  'h264 + opus': { video: 'avc1.42001f', audio: 'opus' },
  'vp9 + opus': { video: 'vp09.00.10.08', audio: 'opus' },
};

interface Result {
  skip?: string;
  layouts?: { layout: string; duration: number; frame: number; bytes: number; onset: number }[];
  info?: string;
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => '__algorhythms' in window);
});

for (const [name, pair] of Object.entries(PAIRS)) {
  test(`${name}: muxed file plays, with the right duration and frames`, async ({ page }) => {
    const r = await page.evaluate(async (pair): Promise<Result> => {
      if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
        return { skip: 'no WebCodecs encoders' };
      }
      const W = 320;
      const H = 240;
      const FPS = 30;
      const FRAMES = 60;
      const RATE = 48000;
      const vConfig: VideoEncoderConfig = {
        codec: pair.video,
        width: W,
        height: H,
        bitrate: 1_000_000,
        framerate: FPS,
        ...(pair.video.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}),
      };
      const aConfig: AudioEncoderConfig = {
        codec: pair.audio,
        sampleRate: RATE,
        numberOfChannels: 2,
        bitrate: 128_000,
      };
      const mime = `video/mp4; codecs="${pair.video}, ${pair.audio}"`;
      const [vs, as] = await Promise.all([
        VideoEncoder.isConfigSupported(vConfig).catch(() => ({ supported: false })),
        AudioEncoder.isConfigSupported(aConfig).catch(() => ({ supported: false })),
      ]);
      if (!vs.supported) return { skip: `cannot encode ${pair.video}` };
      if (!as.supported) return { skip: `cannot encode ${pair.audio}` };
      if (!document.createElement('video').canPlayType(mime))
        return { skip: `cannot play ${mime}` };

      // Encode once; mux the same chunks into both layouts.
      type Out = { chunk: Mp4.Mp4Chunk; meta?: { decoderConfig?: Mp4.Mp4DecoderConfig } };
      const mp4 = await (window as unknown as MuxWindow).__algorhythms.video();
      const events: { video: boolean; out: Out }[] = [];
      const fail: unknown[] = [];
      const ve = new VideoEncoder({
        output: (c, meta) => events.push({ video: true, out: { chunk: mp4.chunkFrom(c), meta } }),
        error: (e) => fail.push(e),
      });
      const ae = new AudioEncoder({
        output: (c, meta) => events.push({ video: false, out: { chunk: mp4.chunkFrom(c), meta } }),
        error: (e) => fail.push(e),
      });
      ve.configure(vConfig);
      ae.configure(aConfig);

      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d')!;
      const BLOCK = 1024;
      let sent = 0;
      for (let k = 0; k < FRAMES; k++) {
        // Frame k: a flat grey of level 4k (read back after the seek).
        const v = 4 * k;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(0, 0, W, H);
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((k * 1e6) / FPS),
          duration: Math.round(1e6 / FPS),
        });
        ve.encode(frame, { keyFrame: k % 30 === 0 });
        frame.close();
        // Audio up to the end of this frame, in 1024-sample blocks.
        const upTo = Math.round(((k + 1) * RATE) / FPS);
        while (sent + BLOCK <= upTo || (k === FRAMES - 1 && sent < upTo)) {
          const n = Math.min(BLOCK, upTo - sent);
          const data = new Float32Array(n * 2);
          for (let i = 0; i < n; i++) {
            // Silence, then a tone from 0.5 s (its onset is found after decoding).
            const j = sent + i;
            data[i] = data[n + i] =
              j < RATE / 2 ? 0 : 0.5 * Math.sin((2 * Math.PI * 440 * j) / RATE);
          }
          const ad = new AudioData({
            format: 'f32-planar',
            sampleRate: RATE,
            numberOfFrames: n,
            numberOfChannels: 2,
            timestamp: Math.round((sent * 1e6) / RATE),
            data,
          });
          ae.encode(ad);
          ad.close();
          sent += n;
        }
      }
      await Promise.all([ve.flush(), ae.flush()]);
      ve.close();
      ae.close();
      if (fail.length) throw new Error(String(fail[0]));

      const aud = events.filter((e) => !e.video).map((e) => e.out);
      const desc = aud.find((o) => o.meta?.decoderConfig?.description)?.meta?.decoderConfig;
      const ts = (o?: Out) => `${o?.chunk.timestamp}/${o?.chunk.duration}`;
      const info = `audio: ${aud.length} chunks, ts/dur ${aud.slice(0, 3).map(ts).join(' ')} … ${ts(aud.at(-1))}, description ${desc?.description?.byteLength ?? 'none'} B`;

      const layouts: NonNullable<Result['layouts']> = [];
      for (const layout of ['streaming', 'faststart'] as const) {
        const sink = mp4.memorySink();
        const m = new mp4.Mp4Muxer({
          layout,
          sink,
          video: { codec: pair.video, width: W, height: H, frameRate: FPS },
          audio: { codec: pair.audio, sampleRate: RATE, numberOfChannels: 2 },
        });
        for (const e of events) {
          if (e.video) void m.addVideoChunk(e.out.chunk, e.out.meta);
          else void m.addAudioChunk(e.out.chunk, e.out.meta);
        }
        await m.finish();
        const blob = new Blob(sink.parts as BlobPart[], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const el = document.createElement('video');
        el.muted = true;
        el.preload = 'auto';
        const once = (type: string) =>
          new Promise<void>((resolve, reject) => {
            el.addEventListener(type, () => resolve(), { once: true });
            el.addEventListener(
              'error',
              () => reject(new Error(`${layout}: ${el.error?.message ?? 'media error'}`)),
              { once: true },
            );
          });
        const loaded = once('loadeddata');
        el.src = url;
        document.body.append(el);
        await loaded;
        // Seek into the middle of frame 31.
        const seeked = once('seeked');
        el.currentTime = 31.5 / FPS;
        await seeked;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const cg = c.getContext('2d')!;
        cg.drawImage(el, 0, 0, W, H);
        const px = cg.getImageData(W / 2, H / 2, 1, 1).data;
        // Audio sync: where the decoded tone starts (priming must be cut exactly once).
        const decoded = await new OfflineAudioContext(2, RATE, RATE).decodeAudioData(
          await blob.arrayBuffer(),
        );
        const ch = decoded.getChannelData(0);
        let at = 0;
        while (at < ch.length && Math.abs(ch[at]) < 0.05) at++;
        const onset = at / decoded.sampleRate;
        layouts.push({ layout, duration: el.duration, frame: px[1] / 4, bytes: blob.size, onset });
        el.remove();
        URL.revokeObjectURL(url);
      }
      return { layouts, info };
    }, pair);

    test.skip(!!r.skip, r.skip);
    console.log(`${name}: ${r.info}; ${JSON.stringify(r.layouts)}`);
    for (const l of r.layouts!) {
      expect(Math.abs(l.duration - 2), `${l.layout} duration ${l.duration}`).toBeLessThanOrEqual(
        1 / 30,
      );
      expect(Math.abs(l.frame - 31), `${l.layout} frame after the seek`).toBeLessThanOrEqual(1);
      // Where the decoded tone starts. Opus: Chromium's and Firefox's decodeAudioData apply the
      // dOps pre-skip and then the edit list as well, so they hear it 6.5 ms early; ffmpeg applies
      // the edit list only and decodes these files at 0.5 s (boxes as ffmpeg writes them). AAC
      // priming is encoder-specific (default 0): logged only, settled in M8-b.
      if (pair.audio === 'opus') {
        expect(Math.abs(l.onset - 0.5), `${l.layout} audio onset ${l.onset}`).toBeLessThan(0.008);
      }
    }
  });
}
