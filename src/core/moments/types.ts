/**
 * The interface between the compiler's event loop and the moment functions (PLAN.md §6.2, §7.1).
 *
 * A point moment's function reads the state at its time through `MomentEnv` (committed
 * destinations, the key in effect, the targeted voices) and returns *intents*: where each voice
 * should go, which voices are born and which die. The compiler then draws timings, enforces the
 * crossing guarantee, schedules the moves and keeps them cancellable (§7.1, §7.2).
 */

import type { Purpose } from '../rng';
import type { DiagnosticLevel, Glide, Key, Pitch, Seconds } from '../types';

export const enum IntentKind {
  /** Move an active voice. */
  Move = 0,
  /** Birth a dormant voice (§7.4). */
  Birth = 1,
  /** Glide a voice into a survivor, then fade it out (§7.4). */
  Death = 2,
}

export interface Intent {
  /** Pool index. */
  voice: number;
  /** Target pitch (folded into the voice's range by the compiler, §7.8). */
  to: Pitch;
  kind: IntentKind;
  /** Births: pool index of the parent (−1 for none: the newborn appears at `to`). */
  parent?: number;
  /** Deaths: fade-out length after the glide ends. */
  fade?: Seconds;
  /**
   * Deaths: pool index of the survivor it merges into (−1 or absent: none). The dying voice
   * follows that voice's later moves until its fade ends (§7.4, M4.5-17).
   */
  into?: number;
}

export interface MomentPlan {
  /** Crossing enforcement and neighbour-gap overshoot limits apply (§7.2, §7.5). */
  ordered: boolean;
  intents: Intent[];
  /**
   * Note moments (§6.2): per applied change, the index in `intents` of the move that carries the
   * new note, and the pitch it replaced (where `back` returns it).
   */
  notes?: { intent: number; from: Pitch }[];
}

/** What a moment function may read and do. */
export interface MomentEnv {
  /** The moment's time. */
  readonly t: Seconds;
  readonly momentId: string;
  /** Key in effect at t. */
  readonly key: Key;
  /** Effective moment seed (§7.7). */
  readonly seed: number;
  /** Glide merged over the piece defaults. */
  readonly glide: Glide;
  /** Targeted active voices, sorted by committed destination (ties: pool index). */
  readonly targeted: readonly number[];
  /** Every active voice, sorted the same way. */
  readonly active: readonly number[];
  /** Committed destination (after the targeted voices' pending moves were cancelled). */
  dest(v: number): Pitch;
  /** Pitch sounding at t (before moves starting at t); NaN when silent. */
  now(v: number): Pitch;
  range(v: number): readonly [Pitch, Pitch];
  id(v: number): string;
  /** True if the voice's life is open at t (it can be a birth parent). */
  sounding(v: number): boolean;
  /** Pool voices a split may birth at t, in pool order (§7.4). */
  dormant(): number[];
  /** Pool index of a voice id, or −1. */
  indexOf(id: string): number;
  diag(level: DiagnosticLevel, code: string, message: string): void;
  /** Keyed draw (§7.7); v = −1 for a moment-level draw (voice id ''). */
  rand(v: number, step: number, purpose: Purpose): number;
}

/** Union of the given voices' ranges. */
export function unionRange(env: MomentEnv, voices: readonly number[]): [Pitch, Pitch] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of voices) {
    const r = env.range(v);
    if (r[0] < lo) lo = r[0];
    if (r[1] > hi) hi = r[1];
  }
  return [lo, hi];
}

/** The plain moves of `voices` to `targets` (parallel arrays). */
export function movesTo(voices: readonly number[], targets: readonly Pitch[]): Intent[] {
  return voices.map((voice, i) => ({ voice, to: targets[i], kind: IntentKind.Move }));
}
