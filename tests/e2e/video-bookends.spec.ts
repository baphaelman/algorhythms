/**
 * Ready for YouTube (PLAN.md §12, §15 M11): one export with a lead-in, fades, a title card and an
 * end card, plus glow, vignette and guide lines at pitches. The MP4's length (to a frame), its
 * frames at key times against the export's own drawing, its audio (delayed by exactly the
 * lead-in, silent in the lead-in and the card), and the thumbnail (1280×720 JPEG under 2 MB).
 * With FRAMES_OUT set, the title card, a glow + vignette + guides frame and the end card are
 * written there as 1080p PNGs for review.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openVideoExport } from './export-open';
import { guarded } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown } };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** The section, its music and the bookends (video times τ in s). */
const SECTION = { start: 12, end: 24 };
const LEAD = 1;
const CARD = 5;
/** 1 s lead-in + 12 s of music + 5 s of end card. */
const LENGTH = LEAD + (SECTION.end - SECTION.start) + CARD;
const FPS = 30;
const BOOKENDS: {
  fadeIn: number;
  leadIn: number;
  title?: { text: string; subtitle?: string };
  endCard?: number;
  fadeOut: number;
  credit: string;
} = {
  fadeIn: 0.5,
  leadIn: LEAD,
  title: { text: 'Kite Day', subtitle: 'a test of the title card' },
  endCard: CARD,
  fadeOut: 1,
  credit: 'Made with AlgoRhythms',
};
/** Key frames: τ → what it shows. */
const KEYS = {
  black: 0,
  lead: 0.9,
  title: 3,
  glow: 9,
  cross: LEAD + 12 + 1,
  card: LEAD + 12 + 3,
  fadeOut: LENGTH - 0.1,
};

test('a video with a lead-in, title card, end card and fades; the thumbnail', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Chromium (the export pipeline is covered per engine)');
  test.skip(info.project.name.endsWith('-prod'), 'once');
  test.setTimeout(240_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openVideoExport(page);
  await choose(page, 'export-vsize', '720p');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));

  const r = await page.evaluate(
    async ({ SECTION, BOOKENDS, KEYS, FPS, wantPngs }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const run = await h.exportRun();
      const m = await h.videoExport();
      const base = run.lastPreviewRequest()!.options as Parameters<typeof m.exportVideo>[1];
      const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
      const look = {
        ...base.look!,
        theme: 'dark' as const,
        glow: 0.7,
        vignette: 0.6,
        pitchGuides: { pitches: [64, 71], labels: true },
      };
      const opts = {
        ...base,
        fps: FPS as 30,
        theme: 'dark' as const,
        camera: 'follow' as const,
        window: 12,
        look,
        section: SECTION,
        bookends: BOOKENDS,
      };
      const sink = m.blobSink();
      const result = await m.exportVideo(piece, opts, sink);
      const blob = sink.blob();
      const el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      const once = (type: string) =>
        new Promise<void>((resolve, reject) => {
          el.addEventListener(type, () => resolve(), { once: true });
          el.addEventListener('error', () => reject(new Error(el.error?.message ?? 'media')), {
            once: true,
          });
        });
      const url = URL.createObjectURL(blob);
      const loaded = once('loadeddata');
      el.src = url;
      document.body.append(el);
      await loaded;
      const W = 1280;
      const H = 720;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      const frameAt = async (tau: number) => {
        const seeked = once('seeked');
        el.currentTime = tau + 0.5 / FPS;
        await seeked;
        await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 50)));
        g.drawImage(el, 0, 0, W, H);
        return g.getImageData(0, 0, W, H).data;
      };
      const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let se = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let j = 0; j < 3; j++) {
            const d = a[i + j] - b[i + j];
            se += d * d;
          }
        }
        return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
      };
      const mean = (a: Uint8ClampedArray) => {
        let s = 0;
        for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2];
        return s / ((a.length / 4) * 3);
      };
      const ref = (o: typeof opts, tau: number) =>
        m.referenceFrame(piece, o, Math.round(tau * FPS)).data;
      const { title: _t, ...noTitle } = BOOKENDS;
      const { endCard: _e, ...noCard } = BOOKENDS;
      const k: Record<string, number> = {};
      const frames: Record<string, Uint8ClampedArray> = {};
      for (const [name, tau] of Object.entries(KEYS)) {
        frames[name] = await frameAt(tau);
        k[name] = psnr(frames[name], ref(opts, tau));
      }
      const checks = {
        blackMean: mean(frames.black),
        fadeOutMean: mean(frames.fadeOut),
        titleVsNoTitle: psnr(frames.title, ref({ ...opts, bookends: noTitle }, KEYS.title)),
        cardVsNoCard: psnr(frames.card, ref({ ...opts, bookends: noCard }, KEYS.card)),
        crossVsCard: psnr(frames.cross, ref(opts, KEYS.card)),
      };
      const duration = el.duration;
      el.remove();
      URL.revokeObjectURL(url);

      // Audio: decoded against the padded offline render.
      const decoded = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(
        await blob.arrayBuffer(),
      );
      const [wl, wr] = await m.renderMix(piece, SECTION, 'off', BOOKENDS);
      const dl = decoded.getChannelData(0);
      const dr = decoded.getChannelData(1);
      const lead = Math.round(BOOKENDS.leadIn * 48000);
      const span = 2 * 48000;
      const a = new Float32Array(span);
      const b = new Float32Array(span + 960);
      for (let i = 0; i < span; i++) a[i] = wl[lead + i] + wr[lead + i];
      for (let i = 0; i < span + 960; i++) b[i] = (dl[lead + i] ?? 0) + (dr[lead + i] ?? 0);
      const lag = m.xcorrLag(a, b, -480, 480);
      let firstSound = -1;
      for (let i = 0; i < wl.length; i++) {
        if (Math.abs(wl[i]) > 1e-4 || Math.abs(wr[i]) > 1e-4) {
          firstSound = i;
          break;
        }
      }
      const peak = (x: Float32Array, from: number, to: number) => {
        let p = 0;
        for (let i = from; i < Math.min(to, x.length); i++) p = Math.max(p, Math.abs(x[i]));
        return p;
      };
      const musicEnd = lead + 12 * 48000;
      let ew = 0;
      let ed = 0;
      for (let i = lead; i < musicEnd; i++) {
        ew += wl[i] * wl[i] + wr[i] * wr[i];
        ed += dl[i] * dl[i] + dr[i] * dr[i];
      }

      // Thumbnail: the whole piece and a time, with the title.
      const thumbs = [];
      for (const at of ['whole', 18] as const) {
        const t = await m.exportThumbnail(piece, opts, at);
        const bmp = await createImageBitmap(t);
        thumbs.push({ type: t.type, size: t.size, width: bmp.width, height: bmp.height });
      }
      const square = await m.exportThumbnail(piece, { ...opts, aspect: '1:1' }, 'whole');
      const sq = await createImageBitmap(square);

      // 1080p PNGs of three frames for review.
      const pngs: Record<string, string> = {};
      if (wantPngs) {
        const big = { ...opts, size: '1080' as const };
        for (const [name, tau] of [
          ['title', KEYS.title],
          ['glow-vignette-guides', KEYS.glow],
          ['end-card', KEYS.card],
        ] as const) {
          const img = m.referenceFrame(piece, big, Math.round(tau * FPS));
          const oc = new OffscreenCanvas(img.width, img.height);
          oc.getContext('2d')!.putImageData(img, 0, 0);
          const png = await oc.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await png.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          pngs[name] = btoa(s);
        }
        const tb = await m.exportThumbnail(piece, opts, 'whole');
        const tbytes = new Uint8Array(await tb.arrayBuffer());
        let s = '';
        for (let i = 0; i < tbytes.length; i += 0x8000)
          s += String.fromCharCode(...tbytes.subarray(i, i + 0x8000));
        pngs['thumbnail.jpg'] = btoa(s);
      }
      return {
        frames: result.frames,
        seconds: result.duration,
        duration,
        k,
        checks,
        lagMs: (lag / 48000) * 1000,
        lead,
        firstSound,
        leadPeak: Math.max(peak(dl, 0, lead - 2400), peak(dr, 0, lead - 2400)),
        cardPeak: Math.max(
          peak(dl, musicEnd + 4800, dl.length - 2400),
          peak(dr, musicEnd + 4800, dr.length - 2400),
        ),
        wavCardPeak: Math.max(peak(wl, musicEnd, wl.length), peak(wr, musicEnd, wr.length)),
        wavSeconds: wl.length / 48000,
        rmsDb: 10 * Math.log10(ed / ew),
        thumbs,
        square: { type: square.type, width: sq.width, height: sq.height },
        pngs,
      };
    },
    { SECTION, BOOKENDS, KEYS, FPS, wantPngs: !!process.env.FRAMES_OUT },
  );
  const { pngs, ...shown } = r;
  console.log(`video bookends: ${JSON.stringify(shown)}`);
  if (process.env.FRAMES_OUT) {
    mkdirSync(process.env.FRAMES_OUT, { recursive: true });
    for (const [name, b64] of Object.entries(pngs)) {
      const file = name.includes('.') ? name : `${name}.png`;
      writeFileSync(join(process.env.FRAMES_OUT, file), Buffer.from(b64, 'base64'));
    }
  }

  // Length: lead-in + music + end card, to a frame; the audio is that long too.
  expect(r.seconds).toBeCloseTo(LENGTH, 6);
  expect(r.wavSeconds).toBeCloseTo(LENGTH, 6);
  expect(r.frames).toBe(LENGTH * FPS);
  expect(Math.abs(r.duration - LENGTH), 'duration').toBeLessThanOrEqual(1 / FPS);

  // Frames: each key time matches the export's own drawing.
  for (const [name, v] of Object.entries(r.k)) expect(v, `${name} PSNR`).toBeGreaterThanOrEqual(34);
  expect(r.checks.blackMean, 'black at τ = 0').toBeLessThan(3);
  expect(r.checks.fadeOutMean, 'nearly black at the end').toBeLessThan(10);
  expect(r.checks.titleVsNoTitle, 'the title card shows').toBeLessThanOrEqual(r.k.title - 4);
  expect(r.checks.cardVsNoCard, 'the end card shows').toBeLessThanOrEqual(r.k.card - 4);
  expect(r.checks.crossVsCard, 'the crossfade is not yet the card').toBeLessThanOrEqual(
    r.k.cross - 2,
  );

  // Audio: delayed by exactly the lead-in, silent before it and in the card.
  expect(r.firstSound).toBeGreaterThanOrEqual(r.lead);
  expect(Math.abs(r.lagMs), 'audio lag (ms)').toBeLessThanOrEqual(1);
  expect(r.leadPeak, 'lead-in silent').toBeLessThan(1e-3);
  expect(r.wavCardPeak, 'render silent in the card').toBe(0);
  expect(r.cardPeak, 'card silent').toBeLessThan(1e-3);
  expect(Math.abs(r.rmsDb), 'audio RMS (dB)').toBeLessThanOrEqual(1);

  // Thumbnails.
  for (const t of r.thumbs) {
    expect(t).toMatchObject({ type: 'image/jpeg', width: 1280, height: 720 });
    expect(t.size).toBeLessThan(2_000_000);
  }
  expect(r.square).toEqual({ type: 'image/jpeg', width: 1080, height: 1080 });
});

test('glow without canvas filter (older Safari): the ring passes look like the blur', async ({
  page,
}, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'engine-only');
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.videoExport();
    const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
    const { EXPORT_LOOK } = await import('/src/render/look.ts' as string);
    const base = {
      aspect: '16:9' as const,
      size: '720' as const,
      fps: 30 as const,
      camera: 'follow' as const,
      window: 12,
      theme: 'dark' as const,
      hud: false,
      thickness: true,
      look: { ...EXPORT_LOOK, theme: 'dark', hud: [] },
    };
    const glow = { ...base, look: { ...base.look, glow: 1 } };
    // Does this engine really blur (not just keep the property: Playwright's WebKit)? A dot under
    // blur(2px) must spread 3 px; the app's detection must agree.
    const probe = new OffscreenCanvas(16, 16).getContext('2d') as OffscreenCanvasRenderingContext2D;
    probe.filter = 'blur(2px)';
    probe.fillStyle = '#fff';
    probe.fillRect(8, 8, 1, 1);
    const realBlur = probe.getImageData(11, 8, 1, 1).data[3] > 0;
    const { canFilter } = await import('/src/render/layer.ts' as string);
    const detected = canFilter(new OffscreenCanvas(16, 16).getContext('2d'));
    const k = 600;
    const plain = m.referenceFrame(piece, base, k).data;
    const filtered = m.referenceFrame(piece, glow, k).data;
    const proto = OffscreenCanvasRenderingContext2D.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'filter');
    Object.defineProperty(proto, 'filter', {
      configurable: true,
      get: () => 'none',
      set: () => undefined,
    });
    let rings: Uint8ClampedArray;
    try {
      rings = m.referenceFrame(piece, glow, k).data;
    } finally {
      if (desc) Object.defineProperty(proto, 'filter', desc);
      else delete (proto as { filter?: unknown }).filter;
    }
    const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let se = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let j = 0; j < 3; j++) {
          const d = a[i + j] - b[i + j];
          se += d * d;
        }
      }
      return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
    };
    return {
      hasFilter: !!desc,
      realBlur,
      detected,
      glowVsPlain: psnr(filtered, plain),
      ringsVsFilter: psnr(rings, filtered),
      ringsVsPlain: psnr(rings, plain),
    };
  });
  console.log(`glow fallback: ${JSON.stringify(r)}`);
  // The glow changes the frame on every engine; detection matches what the engine really does.
  expect(r.detected, 'canFilter agrees with a real blur').toBe(r.realBlur);
  expect(r.glowVsPlain).toBeLessThan(45);
  expect(r.ringsVsPlain).toBeLessThan(45);
  if (r.realBlur) {
    // The fallback is much closer to the engine's blur than to no glow.
    expect(r.ringsVsFilter).toBeGreaterThanOrEqual(r.glowVsPlain + 6);
  } else {
    // No real blur (WebKit): the glow already draws the ring passes, so stubbing changes nothing.
    expect(r.ringsVsFilter).toBeGreaterThanOrEqual(60);
  }
});
