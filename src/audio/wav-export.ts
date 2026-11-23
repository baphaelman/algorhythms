/**
 * WAV export (PLAN.md §12): the DSP graph rendered faster than real time from t = 0, in ~1 s
 * chunks that are whole runs of 128-frame blocks, encoded as they are produced. Pure apart from
 * computing; the export worker runs it off the main thread, and the Node tests call it directly.
 * The chunk size changes nothing but how often bytes are handed over (§8.1).
 */

import { flatten, type FlatScore } from '../core/flat';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import { BLOCK_FRAMES } from '../dsp/constants';
import {
  measureLoudness,
  normalize,
  type LoudnessMeasure,
  type NormalizeReport,
} from '../dsp/loudness';
import { createLoadedGraph, exportFrameCount } from './offline';
import { WavEncoder, wavHeader, type WavBitDepth } from './wav';

/** Export options. */
export interface WavExportOptions {
  /** Output sample rate. */
  sampleRate: 44100 | 48000;
  /** 16-bit PCM (TPDF dither), 24-bit PCM, or 32-bit float. */
  bitDepth: WavBitDepth;
  /** Seconds per chunk (rounded to whole blocks). @default 1 */
  chunkSeconds?: number;
  /** Only this span of the render (a video section); absent = all of it. */
  span?: WavSpan;
  /**
   * Loudness normalisation (§12 "Ready for YouTube"): 'off' (default) is the plain render, peaks
   * ≤ −1 dBFS; a target renders everything first, then `normalize`s it to that many LUFS
   * (integrated, of what is exported) with true peaks ≤ −1 dBTP.
   */
  loudness?: ExportLoudness;
}

/** Off, or a target in LUFS. */
export type ExportLoudness = 'off' | -14 | -16;

/** Export-time true-peak ceiling (dBTP) when normalising. */
export const LOUDNESS_CEILING = -1;

/**
 * A span of the render (§12 rev 15, video sections): the samples from `start` to `end` of the
 * render from t = 0 (so they equal the whole render's there, sounds already ringing included),
 * with `fade` seconds of fade-in after a cut start and fade-out before a cut end, so neither cut
 * clicks. `end` absent: to the render's end (the piece's end plus its FX tail), no fade-out.
 */
export interface WavSpan {
  start: number;
  end?: number;
  /** @default SPAN_FADE */
  fade?: number;
}

/** Fade at a section's cuts, seconds. */
export const SPAN_FADE = 0.03;

/** The frames [from, to) a span keeps of a `total`-frame render, and its fade lengths. */
export function spanFrames(
  total: number,
  sampleRate: number,
  span?: WavSpan,
): { from: number; to: number; fadeIn: number; fadeOut: number } {
  if (!span) return { from: 0, to: total, fadeIn: 0, fadeOut: 0 };
  const from = Math.min(total, Math.max(0, Math.round(span.start * sampleRate)));
  const to =
    span.end === undefined
      ? total
      : Math.min(total, Math.max(from, Math.round(span.end * sampleRate)));
  const n = Math.max(0, Math.round((span.fade ?? SPAN_FADE) * sampleRate));
  const len = to - from;
  return {
    from,
    to,
    fadeIn: from > 0 ? Math.min(n, len) : 0,
    fadeOut: to < total ? Math.min(n, len) : 0,
  };
}

/**
 * Gain of frame i (0-based in the span) of a `len`-frame span with these fades: sin² ramps, 0 at
 * the cut sample itself, 1 inside.
 */
export function spanGain(i: number, len: number, fadeIn: number, fadeOut: number): number {
  let g = 1;
  if (i < fadeIn) {
    const s = Math.sin((Math.PI / 2) * (i / fadeIn));
    g *= s * s;
  }
  const j = len - 1 - i;
  if (j < fadeOut) {
    const s = Math.sin((Math.PI / 2) * (j / fadeOut));
    g *= s * s;
  }
  return g;
}

/** What to export. */
export interface WavExportInput {
  score: CompiledScore | FlatScore;
  mix: MixSettings;
  /** Piece timbres (Piece.timbres); built-ins are always available. */
  timbres?: Record<string, Timbre>;
}

/** Total byte length of an export, known before rendering. */
export function wavExportSize(
  input: WavExportInput,
  options: WavExportOptions,
): { frames: number; bytes: number } {
  const all = exportFrameCount(input.score, input.mix, options.sampleRate);
  const { from, to } = spanFrames(all, options.sampleRate, options.span);
  const frames = to - from;
  const header = wavHeader(
    { sampleRate: options.sampleRate, bitDepth: options.bitDepth, channels: 2 },
    frames,
  );
  return { frames, bytes: header.byteLength + frames * (options.bitDepth / 8) * 2 };
}

/**
 * Yields the WAV file as byte chunks: the header, then one chunk per ~`chunkSeconds` of audio.
 * `onProgress` receives the fraction of frames rendered after each chunk.
 */
export function* wavExportChunks(
  input: WavExportInput,
  options: WavExportOptions,
  onProgress?: (fraction: number) => void,
  onLoudness?: (report: NormalizeReport) => void,
): Generator<Uint8Array<ArrayBuffer>> {
  const flat = 'layout' in input.score ? input.score : flatten(input.score);
  const sampleRate = options.sampleRate;
  const all = exportFrameCount(flat, input.mix, sampleRate);
  const { from, to, fadeIn, fadeOut } = spanFrames(all, sampleRate, options.span);
  const frames = to - from;
  const format = { sampleRate, bitDepth: options.bitDepth, channels: 2 } as const;
  yield wavHeader(format, frames);

  const graph = createLoadedGraph({
    score: flat,
    mix: input.mix,
    timbres: input.timbres,
    sampleRate,
  });
  graph.play(0);
  const encoder = new WavEncoder(format, flat.seed);
  const blocksPerChunk = Math.max(
    1,
    Math.round(((options.chunkSeconds ?? 1) * sampleRate) / BLOCK_FRAMES),
  );
  const chunkFrames = blocksPerChunk * BLOCK_FRAMES;
  const left = new Float32Array(chunkFrames);
  const right = new Float32Array(chunkFrames);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  const target = options.loudness ?? 'off';
  if (target !== 'off') {
    // Normalising needs the whole render: render (85 % of the progress), normalise, encode.
    const mix = renderSpan(graph, { from, to, fadeIn, fadeOut }, (f) => onProgress?.(0.85 * f));
    const report = normalize(mix, sampleRate, target, LOUDNESS_CEILING);
    onLoudness?.(report);
    onProgress?.(0.95);
    for (let at = 0; at < frames; at += chunkFrames) {
      const n = Math.min(chunkFrames, frames - at);
      left.set(mix.left.subarray(at, at + n));
      right.set(mix.right.subarray(at, at + n));
      const bytes = encoder.encode(left, right, n);
      onProgress?.(0.95 + (0.05 * (at + n)) / frames);
      yield bytes;
    }
    return;
  }
  if (from > 0 || to < all) {
    yield* spanChunks(graph, encoder, { from, to, fadeIn, fadeOut, chunkFrames }, onProgress);
    return;
  }
  let done = 0;
  while (done < frames) {
    const n = Math.min(chunkFrames, frames - done);
    for (let f = 0; f < n; f += BLOCK_FRAMES) {
      graph.process(bl, br);
      left.set(bl, f);
      right.set(br, f);
    }
    done += n;
    const bytes = encoder.encode(left, right, n);
    onProgress?.(done / frames);
    yield bytes;
  }
}

/**
 * A span's chunks: the graph runs from t = 0 (the frames before `from` are rendered and
 * dropped, so the span equals the whole render's samples there), stopping at `to`; the kept
 * frames get the cut fades. Progress counts every frame rendered.
 */
function* spanChunks(
  graph: ReturnType<typeof createLoadedGraph>,
  encoder: WavEncoder,
  o: { from: number; to: number; fadeIn: number; fadeOut: number; chunkFrames: number },
  onProgress?: (fraction: number) => void,
): Generator<Uint8Array<ArrayBuffer>> {
  const { from, to, fadeIn, fadeOut, chunkFrames } = o;
  const len = to - from;
  const left = new Float32Array(chunkFrames);
  const right = new Float32Array(chunkFrames);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  let fill = 0;
  let kept = 0;
  for (let f = 0; f < to; f += BLOCK_FRAMES) {
    graph.process(bl, br);
    const a = Math.max(f, from);
    const b = Math.min(f + BLOCK_FRAMES, to);
    for (let x = a; x < b; x++) {
      const g = spanGain(kept, len, fadeIn, fadeOut);
      left[fill] = bl[x - f] * g;
      right[fill] = br[x - f] * g;
      fill++;
      kept++;
      if (fill === chunkFrames || kept === len) {
        const bytes = encoder.encode(left, right, fill);
        fill = 0;
        onProgress?.(Math.min(1, (x + 1) / to));
        yield bytes;
      }
    }
  }
}

/**
 * Renders the frames [from, to) of the graph's render from t = 0 into new buffers, with the cut
 * fades: the same samples `wavExportChunks` encodes.
 */
function renderSpan(
  graph: ReturnType<typeof createLoadedGraph>,
  o: { from: number; to: number; fadeIn: number; fadeOut: number },
  onProgress?: (fraction: number) => void,
): { left: Float32Array; right: Float32Array } {
  const { from, to, fadeIn, fadeOut } = o;
  const len = to - from;
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  const every = Math.max(1, Math.round(48000 / BLOCK_FRAMES));
  for (let f = 0, b = 0; f < to; f += BLOCK_FRAMES, b++) {
    graph.process(bl, br);
    const a = Math.max(f, from);
    const e = Math.min(f + BLOCK_FRAMES, to);
    for (let x = a; x < e; x++) {
      const k = x - from;
      const g = fadeIn > 0 || fadeOut > 0 ? spanGain(k, len, fadeIn, fadeOut) : 1;
      left[k] = bl[x - f] * g;
      right[k] = br[x - f] * g;
    }
    if (b % every === 0) onProgress?.(Math.min(1, (f + BLOCK_FRAMES) / to));
  }
  onProgress?.(1);
  return { left, right };
}

/**
 * Measures what a loudness-normalised export would start from (§12 "Ready for YouTube" →
 * Display): the same render (span and cut fades included), measured, not encoded.
 */
export function measureExport(
  input: WavExportInput,
  options: Pick<WavExportOptions, 'sampleRate' | 'span'>,
  onProgress?: (fraction: number) => void,
): LoudnessMeasure {
  const flat = 'layout' in input.score ? input.score : flatten(input.score);
  const sampleRate = options.sampleRate;
  const all = exportFrameCount(flat, input.mix, sampleRate);
  const graph = createLoadedGraph({
    score: flat,
    mix: input.mix,
    timbres: input.timbres,
    sampleRate,
  });
  graph.play(0);
  const mix = renderSpan(graph, spanFrames(all, sampleRate, options.span), onProgress);
  return measureLoudness(mix, sampleRate);
}

/** Renders a whole WAV file into one buffer (tests and small exports). */
export function renderWav(
  input: WavExportInput,
  options: WavExportOptions,
): Uint8Array<ArrayBuffer> {
  const parts = [...wavExportChunks(input, options)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
