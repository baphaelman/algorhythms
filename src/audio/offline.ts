/**
 * Faster-than-real-time rendering with the DSP graph, outside any AudioContext: the core of the
 * WAV export (PLAN.md §12) and of the Node DSP tests. Always in 128-frame blocks from t = 0, so a
 * render equals live playback from t = 0 at the same sample rate (§8.1).
 */

import { flatten, type FlatScore } from '../core/flat';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import { BLOCK_FRAMES } from '../dsp/constants';
import { Graph, RenderMode } from '../dsp/graph';
import { fxTailSeconds } from '../dsp/mix';
import { resolveTimbre, tablesFor } from './timbres';

/** Inputs every offline render needs. */
export interface RenderInput {
  /** The compiled score (or an already flattened one). */
  score: CompiledScore | FlatScore;
  mix: MixSettings;
  /** Piece timbres (Piece.timbres); built-ins are always available. */
  timbres?: Record<string, Timbre>;
  sampleRate: number;
}

function isFlat(score: CompiledScore | FlatScore): score is FlatScore {
  return 'layout' in score;
}

/** A graph loaded with the score, mix and every timbre it uses, ready to `play(0)`. */
export function createLoadedGraph(input: RenderInput): Graph {
  const flat = isFlat(input.score) ? input.score : flatten(input.score);
  const graph = new Graph(input.sampleRate);
  graph.load(flat, input.mix);
  for (const name of flat.timbreNames) {
    graph.setTables(name, tablesFor(resolveTimbre(name, input.timbres), input.sampleRate), 0);
  }
  return graph;
}

/** Frames an export renders: the piece plus its FX tail, rounded up to whole blocks. */
export function exportFrameCount(score: CompiledScore | FlatScore, mix: MixSettings, sampleRate: number): number {
  const seconds = score.duration + fxTailSeconds(mix) + 0.05;
  return Math.ceil((seconds * sampleRate) / BLOCK_FRAMES) * BLOCK_FRAMES;
}

/** Which part of the mix a render produces (stems, §12). */
export type RenderPart =
  | { kind: 'mix'; captureGain?: Float32Array }
  | { kind: 'voice'; index: number; replayGain: Float32Array }
  | { kind: 'fx'; replayGain: Float32Array };

/**
 * Renders `frames` frames (a multiple of 128) into new stereo buffers. With a `part`, renders a
 * stem: one voice or the FX returns, through the same tone and limiter delay, scaled by a
 * replayed limiter gain; or the mix while capturing that gain.
 */
export function renderOffline(
  input: RenderInput,
  frames: number,
  part: RenderPart = { kind: 'mix' },
): { left: Float32Array; right: Float32Array } {
  const graph = createLoadedGraph(input);
  if (part.kind === 'mix') {
    if (part.captureGain) graph.setLimiterCapture(part.captureGain);
  } else {
    graph.setRenderMode(part.kind === 'voice' ? RenderMode.Voice : RenderMode.Fx, part.kind === 'voice' ? part.index : -1);
    graph.setLimiterReplay(part.replayGain);
  }
  graph.play(0);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  for (let f = 0; f < frames; f += BLOCK_FRAMES) {
    graph.process(bl, br);
    const n = Math.min(BLOCK_FRAMES, frames - f);
    left.set(n === BLOCK_FRAMES ? bl : bl.subarray(0, n), f);
    right.set(n === BLOCK_FRAMES ? br : br.subarray(0, n), f);
  }
  return { left, right };
}
