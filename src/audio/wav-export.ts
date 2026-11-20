/**
 * WAV export (PLAN.md §12): the DSP graph rendered faster than real time from t = 0, in ~1 s
 * chunks that are whole runs of 128-frame blocks, encoded as they are produced. Pure apart from
 * computing; the export worker runs it off the main thread, and the Node tests call it directly.
 * The chunk size changes nothing but how often bytes are handed over (§8.1).
 */

import { flatten, type FlatScore } from '../core/flat';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import { BLOCK_FRAMES } from '../dsp/constants';
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
}

/** What to export. */
export interface WavExportInput {
  score: CompiledScore | FlatScore;
  mix: MixSettings;
  /** Piece timbres (Piece.timbres); built-ins are always available. */
  timbres?: Record<string, Timbre>;
}

/** Total byte length of an export, known before rendering. */
export function wavExportSize(input: WavExportInput, options: WavExportOptions): { frames: number; bytes: number } {
  const frames = exportFrameCount(input.score, input.mix, options.sampleRate);
  const header = wavHeader({ sampleRate: options.sampleRate, bitDepth: options.bitDepth, channels: 2 }, frames);
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
): Generator<Uint8Array<ArrayBuffer>> {
  const flat = 'layout' in input.score ? input.score : flatten(input.score);
  const sampleRate = options.sampleRate;
  const frames = exportFrameCount(flat, input.mix, sampleRate);
  const format = { sampleRate, bitDepth: options.bitDepth, channels: 2 } as const;
  yield wavHeader(format, frames);

  const graph = createLoadedGraph({ score: flat, mix: input.mix, timbres: input.timbres, sampleRate });
  graph.play(0);
  const encoder = new WavEncoder(format, flat.seed);
  const blocksPerChunk = Math.max(1, Math.round(((options.chunkSeconds ?? 1) * sampleRate) / BLOCK_FRAMES));
  const chunkFrames = blocksPerChunk * BLOCK_FRAMES;
  const left = new Float32Array(chunkFrames);
  const right = new Float32Array(chunkFrames);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
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

/** Renders a whole WAV file into one buffer (tests and small exports). */
export function renderWav(input: WavExportInput, options: WavExportOptions): Uint8Array<ArrayBuffer> {
  const parts = [...wavExportChunks(input, options)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
