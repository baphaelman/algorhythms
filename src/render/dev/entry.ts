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
  return { score, canvas, g, opts };
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
 * pixels; frame `png` (if any) as a PNG data URL.
 */
async function videoFrames(json: unknown, o: VideoOptions, frames: number[], png: number) {
  const { score, canvas, g, opts } = videoSetup(json, o);
  const out: { k: number; hash: string; inked: number }[] = [];
  const { width: w, height: h } = canvas;
  let url = '';
  for (const k of frames) {
    drawVideoFrame(g, score, opts, k, o.fps);
    const d = g.getImageData(0, 0, w, h).data;
    let inked = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) inked++;
    }
    out.push({ k, hash: hashPixels(g, w, h), inked });
    if (k === png) {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      url = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.readAsDataURL(blob);
      });
    }
  }
  return { frames: out, png: url, duration: score.duration, width: w, height: h };
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
};
