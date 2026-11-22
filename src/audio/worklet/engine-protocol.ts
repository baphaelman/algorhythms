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
export const ANCHOR_REASONS: readonly AnchorReason[] = [
  'load',
  'play',
  'pause',
  'seek',
  'loop',
  'swap',
  'end',
];

/**
 * Main thread → worklet. Transport commands (`load`, `play`, `pause`, `seek`) carry an increasing
 * `seq`; each anchor echoes the newest one it reflects, so the bridge can ignore confirmations of
 * commands a newer one has overtaken.
 */
export type EngineInMessage =
  /** Replace the score and mix; stops the transport at 0 and clears FX state. */
  | { type: 'load'; seq: number; score: FlatScore; mix: MixSettings }
  /** Wavetables for a timbre name (built in a worker, §8.11). */
  | { type: 'tables'; timbre: string; mips: WavetableSet }
  /** Free these timbres' slots (the bridge evicts least-recently-used names; Graph.forget). */
  | { type: 'forget'; timbres: string[] }
  /** Start playing, from `from` seconds if given. */
  | { type: 'play'; seq: number; from?: number }
  | { type: 'pause'; seq: number }
  | { type: 'seek'; seq: number; to: number }
  /** Loop [start, end) seconds, or stop looping. */
  | { type: 'loop'; range: { start: number; end: number } | null }
  /** Hot-swap after an edit (§8.7). */
  | { type: 'swap'; score: FlatScore }
  /** One parameter; paths are listed in dsp/mix.ts. */
  | { type: 'param'; path: string; value: ParamValue }
  /** The whole mix at once (an addition to §8.2, for preset changes). */
  | { type: 'mix'; mix: MixSettings }
  /**
   * Live mode (§9): the first `voices` voices of the loaded score become live voices
   * (dsp/live.ts) and the transport plays from 0. Answered by `liveApplied` with seq 0.
   */
  | { type: 'liveStart'; voices: number }
  /**
   * `live { segments }` (§8.2, §9): `n` LIVE_STRIDE move records timed from "now" and a level ramp
   * (`gain` NaN: none), applied at the next block; answered by `liveApplied`. `press` > 0: the
   * seq of its press's first message; it re-plans that press from there (dsp/live.ts `rewind`).
   */
  | {
      type: 'live';
      seq: number;
      moves: Float64Array;
      n: number;
      gain: number;
      over: number;
      press?: number;
    }
  /** Live pitch bend in semitones (smoothed on the audio thread). */
  | { type: 'liveBend'; semitones: number };

/** Worklet → main thread. */
export type EngineOutMessage =
  /** Clock anchor: piece time `pieceTime` is heard at context time `contextTime` (§8.3). */
  | {
      type: 'anchor';
      contextTime: number;
      pieceTime: number;
      playing: boolean;
      reason: AnchorReason;
      /** `seq` of the newest transport command applied when this anchor was taken. */
      seq: number;
    }
  /** Drift correction only: the piece time at context frame `frame`. */
  | { type: 'pos'; frame: number; time: number }
  /** Playback reached the end of the piece. */
  | { type: 'ended' }
  /** Post-limiter levels over the last ~50 ms (linear). */
  | { type: 'meter'; peakL: number; peakR: number; rms: number }
  | { type: 'error'; message: string }
  /**
   * Live message `seq` was applied at the block starting at context frame `frame`, live (piece)
   * time `time`: its glides start there (§9 "the worklet stamps the actual frame"). For the
   * latency check: `received` is the first frame of the next block when the newest live message
   * arrived (equal to `frame`: applied at the first block after it arrived); `callback` the device
   * callback period in frames: the median of the last 15 runs of blocks rendered back to back.
   */
  | {
      type: 'liveApplied';
      seq: number;
      frame: number;
      time: number;
      received: number;
      callback: number;
    };

/**
 * Everything needed to start sounding, handed over in `processorOptions` so it is applied in the
 * processor's constructor, before the first block. An OfflineAudioContext may render before any
 * port message arrives, so offline renders use this instead of messages.
 */
export interface EnginePreload {
  score: FlatScore;
  mix: MixSettings;
  tables: { timbre: string; mips: WavetableSet }[];
  /** Start playing from this time (seconds); absent = stay stopped. */
  playFrom?: number;
}

/** `processorOptions` of the engine node. */
export interface EngineProcessorOptions {
  /** Score, mix and tables to load before the first block. */
  preload?: EnginePreload;
  /** Seconds between meter messages. @default 0.05 */
  meterInterval?: number;
  /** Seconds between pos messages while playing. @default 0.25 */
  posInterval?: number;
}
