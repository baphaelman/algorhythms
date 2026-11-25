/**
 * Browser bundle for the render e2e test (tests/e2e/render.spec.ts): the core compiler plus the
 * renderer, exposed on globalThis. The e2e bundles this file with Vite into an IIFE and injects it
 * into a blank page, so it needs no HTML entry or app code.
 */
import { compile } from '../../core/compiler/compile';
import { parsePiece } from '../../core/schema';
import type { CompiledScore, Piece } from '../../core/types';
import { DEFAULT_FUTURE_OPACITY, drawScore, followStart, type ScoreStyle } from '../index';
import { DARK_TOKENS, LIGHT_TOKENS, supportsOklch } from '../index';
import { pitchAt } from '../../core/query';
import { strandsOf } from '../strands';
import {
  drawVideoFrame,
  videoMarkers,
  videoSize,
  videoStyle,
  type VideoAspect,
  type VideoFrameOptions,
  type VideoSize,
} from '../video';
import { EXPORT_LOOK, pieceLook, type Look } from '../look';
import { drawEndCard } from '../video';
import { drawPosterLayout } from '../poster';
import { layoutPoster, measureWith, type PosterLayout } from '../poster-layout';
import type { PosterDoc, RowBreak } from '../../core/types';

function compileExample(json: unknown): { score: CompiledScore; piece: Piece } {
  const parsed = parsePiece(json);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return { score: compile(parsed.piece), piece: parsed.piece };
}

/** Repeats the pool's voices (shifted by 7 semitones per copy) until there are `n` voices. */
function stress(score: CompiledScore, n: number): CompiledScore {
  const voices = [];
  for (let i = 0; i < n; i++) {
    const src = score.voices[i % score.voices.length];
    const shift = Math.floor(i / score.voices.length) * 7;
    voices.push({
      ...src,
      index: i,
      segments: src.segments.map((s) => ({
        ...s,
        p0: s.p0 + shift,
        p1: s.p1 + shift,
        curve: s.curve && { ...s.curve, p1: s.curve.p1 + shift },
      })),
    });
  }
  return { ...score, voices };
}

interface BenchOptions {
  frames: number;
  window: number;
  colors: ScoreStyle['colors'];
  dark: boolean;
  voices?: number;
  /** Read a pixel after each frame, so the GPU/raster work is included. */
  flush: boolean;
  /** Playhead range [from, to] in s (default: the whole piece). */
  range?: [number, number];
}

function bench(canvas: HTMLCanvasElement, json: unknown, o: BenchOptions) {
  let { score } = compileExample(json);
  if (o.voices) score = stress(score, o.voices);
  const g = canvas.getContext('2d', { willReadFrequently: false });
  if (!g) throw new Error('no 2d context');
  const size = { width: canvas.width, height: canvas.height };
  const cam = (t: number) => ({
    start: followStart('smooth', 0, t, o.window, score.duration),
    window: o.window,
  });
  const style: ScoreStyle = {
    tokens: o.dark ? DARK_TOKENS : LIGHT_TOKENS,
    dark: o.dark,
    colors: o.colors,
    oklch: supportsOklch(),
    futureOpacity: DEFAULT_FUTURE_OPACITY,
    hud: true,
  };
  const times: number[] = [];
  // warm-up
  const t0 = score.duration * 0.3;
  for (let i = 0; i < 10; i++) drawScore(g, score, cam(t0), style, t0, size, 1);
  for (let i = 0; i < o.frames; i++) {
    const [r0, r1] = o.range ?? [1, score.duration - 1];
    const t = r0 + ((r1 - r0) * i) / o.frames;
    const w0 = performance.now();
    drawScore(g, score, cam(t), style, t, size, 1);
    if (o.flush) g.getImageData(0, 0, 1, 1);
    times.push(performance.now() - w0);
  }
  times.sort((a, b) => a - b);
  return {
    median: times[times.length >> 1],
    p95: times[Math.floor(times.length * 0.95)],
    max: times[times.length - 1],
    voices: score.voices.length,
    duration: score.duration,
  };
}

/** Draws one frame for the screenshot. */
function shot(canvas: HTMLCanvasElement, json: unknown, t: number, win: number, dark: boolean) {
  const { score, piece } = compileExample(json);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  const labels: Record<string, string> = {};
  for (const m of piece.moments) if (m.label) labels[m.id] = m.label;
  drawScore(
    g,
    score,
    { start: followStart('smooth', 0, t, win, score.duration), window: win },
    {
      tokens: dark ? DARK_TOKENS : LIGHT_TOKENS,
      dark,
      colors: 'pitch',
      oklch: supportsOklch(),
      futureOpacity: t <= 0 ? 1 : 0,
      hud: true,
      labels,
    },
    t,
    { width: canvas.width, height: canvas.height },
    1,
  );
  return score.duration;
}

/** The merges and splits of a piece: time, kind, strand count and the rope's pitch. */
function bundles(json: unknown) {
  const { score } = compileExample(json);
  return strandsOf(score).bundles.map((b) => ({
    t: b.t,
    split: b.split,
    n: b.members.length,
    pitch: pitchAt(score.voices[b.anchor], b.t + (b.split ? -1e-6 : 1e-6)),
  }));
}

interface FrameOptions {
  t: number;
  start: number;
  window: number;
  dark: boolean;
  future: number;
  dpr: number;
  colors?: ScoreStyle['colors'];
  pitchRange?: [number, number];
  heads?: boolean;
  highlight?: string[];
}

/** Draws one frame (seam.spec) at CSS size canvas.width/dpr × canvas.height/dpr; returns the view. */
function seamFrame(canvas: HTMLCanvasElement, json: unknown, o: FrameOptions) {
  const { score } = compileExample(json);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  const size = { width: canvas.width / o.dpr, height: canvas.height / o.dpr };
  const cam = { start: o.start, window: o.window, pitchRange: o.pitchRange };
  const style: ScoreStyle = {
    tokens: o.dark ? DARK_TOKENS : LIGHT_TOKENS,
    dark: o.dark,
    colors: o.colors ?? 'pitch',
    oklch: supportsOklch(),
    futureOpacity: o.future,
    hud: false,
    heads: o.heads,
    highlight: o.highlight ? new Set(o.highlight) : undefined,
  };
  const v = drawScore(g, score, cam, style, o.t, size, o.dpr);
  return { ...v };
}

/**
 * Draws one frame of `json` with the ghost at `ghost` (no HUD, heads or playhead) and returns the
 * view's mapping, for pixel checks.
 */
function frame(
  canvas: HTMLCanvasElement,
  json: unknown,
  o: { t: number; start: number; window: number; ghost: number; colors: ScoreStyle['colors'] },
) {
  const { score } = compileExample(json);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  const v = drawScore(
    g,
    score,
    { start: o.start, window: o.window },
    {
      tokens: LIGHT_TOKENS,
      dark: false,
      colors: o.colors,
      oklch: supportsOklch(),
      futureOpacity: o.ghost,
      hud: false,
      heads: false,
      playhead: false,
    },
    o.t,
    { width: canvas.width, height: canvas.height },
    1,
  );
  return { start: v.start, pps: v.pps, pLo: v.pLo, pHi: v.pHi, padT: v.padT, padB: v.padB };
}

interface VideoOptions {
  aspect: VideoAspect;
  size: VideoSize;
  camera: 'follow' | 'whole';
  window: number;
  dark: boolean;
  thickness: boolean;
  fps: number;
  /** Stress the pool to this many voices (0: as written). */
  voices?: number;
  /** Draw with EXPORT_LOOK and these changes (theme and thickness from above). */
  exportLook?: Partial<Look>;
  /** Over the poster (M15): the poster laid out from these. */
  poster?: {
    rows: number;
    size: { w: number; h: number };
    doc?: PosterDoc;
    rowBreak?: RowBreak;
    playhead?: boolean;
    /** The Window slider; absent = one row's height. */
    window?: number;
  };
}

function videoSetup(json: unknown, o: VideoOptions) {
  const { score: s0, piece } = compileExample(json);
  const score = o.voices ? stress(s0, o.voices) : s0;
  const px = videoSize(o.aspect, o.size);
  const canvas = new OffscreenCanvas(px.width, px.height);
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('no 2d context');
  const style = videoStyle({
    theme: o.dark ? 'dark' : 'light',
    thickness: o.thickness,
    oklch: supportsOklch(),
    customColors: piece.voices.map((v) => v.color),
    ...videoMarkers(piece),
    ...(o.exportLook
      ? {
          look: {
            ...EXPORT_LOOK,
            theme: o.dark ? ('dark' as const) : ('light' as const),
            thickness: o.thickness,
            ...o.exportLook,
          },
          ...pieceLook(piece),
        }
      : {}),
  });
  const opts: VideoFrameOptions = {
    aspect: o.aspect,
    size: o.size,
    camera: o.camera,
    window: o.window,
    style,
  };
  let layout: PosterLayout | null = null;
  if (o.poster) {
    const look: Look = {
      ...EXPORT_LOOK,
      theme: o.dark ? 'dark' : 'light',
      thickness: o.thickness,
      ...o.exportLook,
    };
    layout = layoutPoster({
      compiled: score,
      piece,
      ...(o.poster.doc ? { doc: o.poster.doc } : {}),
      look,
      base: { rows: o.poster.rows, size: o.poster.size },
      oklch: supportsOklch(),
      measure: measureWith(new OffscreenCanvas(1, 1).getContext('2d')!),
    });
    opts.frame = 'poster';
    opts.poster = layout;
    if (o.poster.window !== undefined) opts.window = o.poster.window;
    else delete opts.window;
    if (o.poster.rowBreak) opts.rowBreak = o.poster.rowBreak;
    if (o.poster.playhead !== undefined) opts.playhead = o.poster.playhead;
  }
  return { score, canvas, g, opts, layout };
}

/**
 * The end card over the poster against the poster drawn by `drawPosterLayout` at the same scale
 * and place: pixels compared inside the poster's box (count differing by more than 48 of 255 in
 * any channel, and the mean difference).
 */
async function posterEndCard(json: unknown, o: VideoOptions) {
  const { score, canvas, g, opts, layout } = videoSetup(json, o);
  if (!layout) throw new Error('no poster');
  const { width: w, height: h } = canvas;
  drawEndCard(g, score, opts);
  const a = g.getImageData(0, 0, w, h).data;
  const k = Math.min(w / layout.width, h / layout.height);
  const pw = Math.round(layout.width * k);
  const ph = Math.round(layout.height * k);
  const off = new OffscreenCanvas(Math.ceil(layout.width * k), Math.ceil(layout.height * k));
  const og = off.getContext('2d')!;
  drawPosterLayout(og, score, layout, k);
  const x0 = (w - layout.width * k) / 2;
  const y0 = (h - layout.height * k) / 2;
  const ref = new OffscreenCanvas(w, h).getContext('2d')!;
  ref.drawImage(off, x0, y0);
  const b = ref.getImageData(0, 0, w, h).data;
  let n = 0;
  let sum = 0;
  let total = 0;
  for (let y = Math.ceil(y0) + 1; y < Math.floor(y0 + ph) - 1; y++)
    for (let x = Math.ceil(x0) + 1; x < Math.floor(x0 + pw) - 1; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      );
      if (d > 48) n++;
      sum += d;
      total++;
    }
  const url = async (c: OffscreenCanvas): Promise<string> => {
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.readAsDataURL(blob);
    });
  };
  return {
    differ: n,
    mean: sum / Math.max(1, total),
    total,
    png: await url(canvas),
    ref: await url(ref.canvas),
  };
}

/** FNV-1a over the pixels. */
function hashPixels(g: OffscreenCanvasRenderingContext2D, w: number, h: number): string {
  const d = g.getImageData(0, 0, w, h).data;
  let x = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) x = Math.imul(x ^ d[i], 0x01000193);
  return (x >>> 0).toString(16);
}

/**
 * Video frames on an OffscreenCanvas: per frame k, the pixel hash and the count of non-paper
 * pixels; frame `png` (if any) as a PNG data URL (the last one; `pngs`: each). A frame drawn again
 * is compared with its first draw: `repeats` has the differing pixels' count and box.
 */
async function videoFrames(json: unknown, o: VideoOptions, frames: number[], png: number) {
  const { score, canvas, g, opts } = videoSetup(json, o);
  const out: { k: number; hash: string; inked: number }[] = [];
  const repeats: { k: number; n: number; box: number[] }[] = [];
  const first = new Map<number, Uint8ClampedArray>();
  const pngs: string[] = [];
  const { width: w, height: h } = canvas;
  for (const k of frames) {
    drawVideoFrame(g, score, opts, k, o.fps);
    const d = g.getImageData(0, 0, w, h).data;
    let inked = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) inked++;
    }
    out.push({ k, hash: hashPixels(g, w, h), inked });
    const f = first.get(k);
    if (!f) first.set(k, d);
    else {
      let n = 0;
      const box = [w, h, -1, -1];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === f[i] && d[i + 1] === f[i + 1] && d[i + 2] === f[i + 2]) continue;
        n++;
        const x = (i >> 2) % w;
        const y = Math.floor((i >> 2) / w);
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
      repeats.push({ k, n, box });
    }
    if (k === png) {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      pngs.push(
        await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.readAsDataURL(blob);
        }),
      );
    }
  }
  const url = pngs[pngs.length - 1] ?? '';
  return { frames: out, png: url, pngs, repeats, duration: score.duration, width: w, height: h };
}

/** Frame cost (ms) over `n` frames spread across the piece, raster flushed with one pixel read. */
function videoBench(json: unknown, o: VideoOptions, n: number) {
  const { score, g, opts } = videoSetup(json, o);
  const last = Math.floor(score.duration * o.fps);
  for (let i = 0; i < 10; i++) drawVideoFrame(g, score, opts, (last * 0.3) | 0, o.fps);
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = Math.round((last * i) / n);
    const w0 = performance.now();
    drawVideoFrame(g, score, opts, k, o.fps);
    g.getImageData(0, 0, 1, 1);
    times.push(performance.now() - w0);
  }
  times.sort((a, b) => a - b);
  return {
    median: times[times.length >> 1],
    p95: times[Math.floor(times.length * 0.95)],
    max: times[times.length - 1],
    voices: score.voices.length,
  };
}

(globalThis as unknown as { __render: unknown }).__render = {
  bench,
  shot,
  frame,
  seamFrame,
  bundles,
  videoFrames,
  videoBench,
  posterEndCard,
};
