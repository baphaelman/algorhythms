/**
 * Messages between the engine worklet and its main-thread bridge (PLAN.md §8.2). Environment-
 * neutral: imported by both sides. Scores and wavetables travel as typed arrays in the transfer
 * list; there is no SharedArrayBuffer (GitHub Pages cannot set COOP/COEP).
 */

import type { FlatScore } from '../../core/flat';
import type { MixSettings } from '../../core/types';
import type { ParamValue } from '../../dsp/mix';
import type { WavetableSet } from '../../dsp/wavetable';

/** Name the engine processor is registered under. */
export const ENGINE_PROCESSOR = 'algorhythms-engine';

/** Why an anchor was posted (§8.3). `pos` anchors are made by the bridge from drift corrections. */
export type AnchorReason = 'load' | 'play' | 'pause' | 'seek' | 'loop' | 'swap' | 'end' | 'pos';

/** Index → name, matching dsp/graph.ts `AnchorReason`. */
export const ANCHOR_REASONS: readonly AnchorReason[] = ['load', 'play', 'pause', 'seek', 'loop', 'swap', 'end'];

/** Main thread → worklet. */
export type EngineInMessage =
  /** Replace the score and mix; stops the transport at 0 and clears FX state. */
  | { type: 'load'; score: FlatScore; mix: MixSettings }
  /** Wavetables for a timbre name (built in a worker, §8.11). */
  | { type: 'tables'; timbre: string; mips: WavetableSet }
  /** Start playing, from `from` seconds if given. */
  | { type: 'play'; from?: number }
  | { type: 'pause' }
  | { type: 'seek'; to: number }
  /** Loop [start, end) seconds, or stop looping. */
  | { type: 'loop'; range: { start: number; end: number } | null }
  /** Hot-swap after an edit (§8.7). */
  | { type: 'swap'; score: FlatScore }
  /** One parameter; paths are listed in dsp/mix.ts. */
  | { type: 'param'; path: string; value: ParamValue }
  /** The whole mix at once (an addition to §8.2, for preset changes). */
  | { type: 'mix'; mix: MixSettings };

/** Worklet → main thread. */
export type EngineOutMessage =
  /** Clock anchor: piece time `pieceTime` is heard at context time `contextTime` (§8.3). */
  | { type: 'anchor'; contextTime: number; pieceTime: number; playing: boolean; reason: AnchorReason }
  /** Drift correction only: the piece time at context frame `frame`. */
  | { type: 'pos'; frame: number; time: number }
  /** Playback reached the end of the piece. */
  | { type: 'ended' }
  /** Post-limiter levels over the last ~50 ms (linear). */
  | { type: 'meter'; peakL: number; peakR: number; rms: number }
  | { type: 'error'; message: string };

/** `processorOptions` of the engine node. */
export interface EngineProcessorOptions {
  /** Seconds between meter messages. @default 0.05 */
  meterInterval?: number;
  /** Seconds between pos messages while playing. @default 0.25 */
  posInterval?: number;
}
