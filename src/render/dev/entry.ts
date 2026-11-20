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
    const t = 1 + ((score.duration - 2) * i) / o.frames;
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

(globalThis as unknown as { __render: unknown }).__render = { bench, shot };
