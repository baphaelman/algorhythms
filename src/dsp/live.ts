/**
 * Live input on the audio thread (PLAN.md §9 "Engine path", §8.11).
 *
 * The live score is an ordinary flat score (one open life per voice, a hold, a level of 0) whose
 * per-voice arrays are copied into fixed-capacity buffers when live mode starts (`LiveTracks`).
 * A live message carries one LIVE_STRIDE record per moving voice, timed from "now". The worklet
 * queues messages (copying into preallocated buffers) and applies them before the next block at
 * that block's first frame tA (`LiveInput.beforeBlock`), so the glide starts on that block:
 * 1. moves of the voice not yet started by tA are cancelled (segments with t0 ≥ tA; strikes after
 *    tA), and a glide whose hold was cancelled holds again from its end;
 * 2. its pitch p₀ and velocity v at its start t₀ = tA + delay are read from the segment in force,
 *    which is cut there (§7.5 step 1, cut-segment form);
 * 3. the new glide is p₀ → p₁ over `dur` with m₀ = scale · (v·dur − (p₁ − p₀)·e′(0)) when mid-glide
 *    (§7.5; `scale` is core's overshoot clamp), followed by a hold at p₁ with an articulation
 *    strike at the arrival; `dur` 0 is a step (from silence) with a strike at t₀.
 * The level is one shared record per change (linear ramp from the level at tA).
 *
 * The main thread's mirror (src/audio/live-engine.ts) runs the same `LiveTracks.apply` with the
 * stamped tA, so its segments equal the worklet's.
 *
 * Bend shifts every voice's pitch through the graph's reference (`Graph.setPitchOffset`), smoothed
 * per block (BEND_SMOOTHING).
 *
 * Everything after construction is allocation-free.
 */

import {
  LEVEL_GAIN,
  LEVEL_OVER,
  LEVEL_STRIDE,
  LEVEL_T,
  SEG_BX1,
  SEG_BX2,
  SEG_BY1,
  SEG_BY2,
  SEG_CLAMPED,
  SEG_CURVE_P1,
  SEG_CURVE_T1,
  SEG_EASE,
  SEG_M0,
  SEG_P0,
  SEG_P1,
  SEG_STRIDE,
  SEG_T0,
  SEG_T1,
} from '../core/segment';
import { EaseCode, easeDerivRaw, easeRaw, easeSlope0Raw } from '../core/ease';
import { BLOCK_FRAMES, DSP_MAX_VOICES } from './constants';
import type { Graph } from './graph';
import { lastAtOrBefore, VoiceData } from './voice';

// Live move record (Float64Array, LIVE_STRIDE doubles per moving voice).
/** Pool index. */
export const LIVE_VOICE = 0;
/** Start offset after the applied time (s). */
export const LIVE_DELAY = 1;
/** Glide length (s); 0 = step. */
export const LIVE_DUR = 2;
/** Target pitch. */
export const LIVE_P1 = 3;
/** EaseCode and bézier params. */
export const LIVE_EASE = 4;
export const LIVE_BX1 = 5;
export const LIVE_BY1 = 6;
export const LIVE_BX2 = 7;
export const LIVE_BY2 = 8;
/** Scale on the carried-velocity term (overshoot clamp). */
export const LIVE_SCALE = 9;
/** Share of a soft strike at the arrival. */
export const LIVE_SHARE = 10;
/** Pool index of the line the voice is on after the move (core/live-plan.ts: the compiler's line). */
export const LIVE_LINE = 11;
/**
 * 1: the move is a fork's departure (its birth, compile.ts `pendingBirth`); until it starts the
 * voice follows its parent's line, not yet a line of its own.
 */
export const LIVE_BORN = 12;
/**
 * Line of the hold after the move's arrival, when it joins another line there (compile.ts
 * `onJoin`; core/live-plan.ts); −1: LIVE_LINE.
 */
export const LIVE_JOIN = 13;
export const LIVE_STRIDE = 14;
/** Records per message: up to two per voice (a fork first follows its parent's move). */
export const LIVE_MAX_RECORDS = 2 * DSP_MAX_VOICES;

/** Segment records per voice; when full, records before the one in force are dropped. */
export const LIVE_SEG_CAP = 256;
/** Strike and level records per voice (compacted the same way). */
export const LIVE_STRIKE_CAP = 128;
export const LIVE_LEVEL_CAP = 32;
/** Messages that can wait for one block. */
export const LIVE_QUEUE = 32;
/** Applied messages remembered for re-planned presses (a press spans a few messages). */
export const LIVE_RING = 16;
/** Bend smoothing time constant (s). */
export const BEND_SMOOTHING = 0.008;

const INF = Infinity;

/** `src`'s arrays copied into buffers of the live capacities (allocates; once per live start). */
export function liveVoiceData(src: VoiceData): VoiceData {
  const d = new VoiceData();
  d.gain = src.gain;
  d.pan = src.pan;
  d.mute = src.mute;
  d.solo = src.solo;
  d.sendReverb = src.sendReverb;
  d.sendDelay = src.sendDelay;
  d.hash = src.hash;
  d.lives = src.lives;
  d.nLife = src.nLife;
  d.timbres = src.timbres;
  d.nTimbre = src.nTimbre;
  d.timbreSlot = src.timbreSlot;
  const n = Math.min(src.nSeg, LIVE_SEG_CAP);
  d.segs = new Float64Array(LIVE_SEG_CAP * SEG_STRIDE);
  d.segs.set(src.segs.subarray(0, n * SEG_STRIDE));
  d.nSeg = n;
  const copy = (a: Float64Array, fill: number): Float64Array => {
    const out = new Float64Array(LIVE_SEG_CAP).fill(fill);
    out.set(a.subarray(0, n));
    return out;
  };
  d.segGlide = new Uint8Array(LIVE_SEG_CAP);
  d.segGlide.set(src.segGlide.subarray(0, n));
  d.arrive = copy(src.arrive, NaN);
  d.prevArrive = copy(src.prevArrive, NaN);
  d.share = copy(src.share, 1);
  d.prevShare = copy(src.prevShare, 1);
  d.holdStart = copy(src.holdStart, NaN);
  d.warpInA = new Float64Array(LIVE_SEG_CAP).fill(NaN);
  d.warpInC = new Float64Array(LIVE_SEG_CAP);
  d.warpInP = new Int32Array(LIVE_SEG_CAP).fill(-1);
  d.warpOutA = new Float64Array(LIVE_SEG_CAP).fill(NaN);
  d.warpOutC = new Float64Array(LIVE_SEG_CAP);
  d.warpOutP = new Int32Array(LIVE_SEG_CAP).fill(-1);
  const ns = Math.min(src.nStrike, LIVE_STRIKE_CAP);
  const strikes = (a: Float64Array, fill: number): Float64Array => {
    const out = new Float64Array(LIVE_STRIKE_CAP).fill(fill);
    out.set(a.subarray(0, ns));
    return out;
  };
  d.strikeT = strikes(src.strikeT, NaN);
  d.strikeShare = strikes(src.strikeShare, 1);
  d.strikePrevT = strikes(src.strikePrevT, NaN);
  d.strikePrevShare = strikes(src.strikePrevShare, 1);
  d.nStrike = ns;
  const nl = Math.min(src.nLevel, LIVE_LEVEL_CAP);
  d.levels = new Float64Array(LIVE_LEVEL_CAP * LEVEL_STRIDE);
  d.levels.set(src.levels.subarray(0, nl * LEVEL_STRIDE));
  d.levelStart = new Float64Array(LIVE_LEVEL_CAP);
  d.levelStart.set(src.levelStart.subarray(0, nl));
  d.nLevel = nl;
  return d;
}

/**
 * Registers: the doubles `LiveTracks` passes between its methods, so that no double crosses a
 * call boundary (a call TurboFan does not inline boxes it: allocation on the audio thread; the
 * same device as pmath.R). LR[R_TA], LR[R_GAIN], LR[R_OVER] are `run`'s inputs.
 */
export const LR = new Float64Array(8);
export const R_TA = 0;
export const R_GAIN = 1;
export const R_OVER = 2;
const R_T = 3;
const R_P = 4;
const R_V = 5;
const R_X = 6;
const R_Y = 7;

/**
 * The live voices' records (segments, strikes, levels) and the operation that applies a live
 * message to them. Shared by the worklet (whose graph voices render these VoiceData objects) and
 * the main thread's mirror.
 */
export class LiveTracks {
  readonly data: VoiceData[];
  /** Per voice: the `run` call that last moved it (a later record of the same call follows on). */
  private readonly runOf: Int32Array;
  /**
   * Per voice and segment: the line it is on (a pool index; the planner's identity of stacked
   * voices, compile.ts `onJoin` survivors). Main-thread bookkeeping the worklet carries along.
   */
  readonly lines: Float64Array[];
  /** Per voice and segment: 1 if it starts a fork's departure (LIVE_BORN). */
  readonly departs: Uint8Array[];
  private runs = 0;

  constructor(initial: readonly VoiceData[]) {
    this.data = initial.slice(0, DSP_MAX_VOICES).map(liveVoiceData);
    this.runOf = new Int32Array(this.data.length);
    this.lines = this.data.map((_, i) => new Float64Array(LIVE_SEG_CAP).fill(i));
    this.departs = this.data.map(() => new Uint8Array(LIVE_SEG_CAP));
  }

  /**
   * Applies `n` move records of `moves` (from index `base`) and, unless `gain` is NaN, a level
   * ramp to `gain` over `over` for every voice, all at time `tA`. Voices touched get 1 in
   * `touched` (if given). Main thread and tests; the worklet calls `run`.
   */
  apply(
    moves: Float64Array,
    base: number,
    n: number,
    gain: number,
    over: number,
    tA: number,
    touched: Uint8Array | null = null,
    rewind = false,
  ): void {
    LR[R_TA] = tA;
    LR[R_GAIN] = gain;
    LR[R_OVER] = over;
    this.run(moves, base, n, touched, rewind);
  }

  /**
   * `apply` with tA, gain and over in LR[R_TA], LR[R_GAIN], LR[R_OVER]. With `rewind` (a press
   * re-planned from its first change, §9 merge window), every voice first drops what was written
   * from tA on (`rewind`), so the moves replace the press's earlier ones. Allocation-free.
   */
  run(
    moves: Float64Array,
    base: number,
    n: number,
    touched: Uint8Array | null,
    rewind = false,
  ): void {
    const count = this.data.length;
    this.runs++;
    if (rewind) this.rewindAll(touched);
    for (let r = 0; r < n; r++) {
      const o = base + r * LIVE_STRIDE;
      const i = moves[o + LIVE_VOICE] | 0;
      if (i < 0 || i >= count) continue;
      const follows = this.runOf[i] === this.runs;
      this.runOf[i] = this.runs;
      this.move(this.data[i], moves, o, follows, this.lines[i], this.departs[i]);
      if (touched !== null) touched[i] = 1;
    }
    if (LR[R_GAIN] === LR[R_GAIN]) {
      for (let i = 0; i < count; i++) {
        this.level(this.data[i]);
        if (touched !== null) touched[i] = 1;
      }
    }
  }

  /**
   * Out of `run`: inlined there, it left `run` too big to inline into `drain`, which then boxed
   * ~90 B per message (no-GC live harness).
   */
  private rewindAll(touched: Uint8Array | null): void {
    const count = this.data.length;
    for (let i = 0; i < count; i++) {
      this.rewind(this.data[i], this.lines[i], this.departs[i]);
      if (touched !== null) touched[i] = 1;
    }
  }

  private move(
    d: VoiceData,
    m: Float64Array,
    mo: number,
    follows: boolean,
    line: Float64Array,
    departs: Uint8Array,
  ): void {
    const tA = LR[R_TA];
    const delay = m[mo + LIVE_DELAY] > 0 ? m[mo + LIVE_DELAY] : 0;
    const dur = m[mo + LIVE_DUR] > 0 ? m[mo + LIVE_DUR] : 0;
    const p1 = m[mo + LIVE_P1];
    const t0 = tA + delay;
    const s = d.segs;
    // 1. Cancel what has not started by tA (a later record for the voice in the same message, a
    // fork that first follows its parent's move: what has not started by its own start).
    const cut = follows ? t0 : tA;
    let n = d.nSeg;
    while (n > 1 && s[(n - 1) * SEG_STRIDE + SEG_T0] >= cut) n--;
    d.nSeg = n;
    let ns = d.nStrike;
    while (ns > 0 && d.strikeT[ns - 1] > cut) ns--;
    d.nStrike = ns;
    if (n + 3 > LIVE_SEG_CAP) n = this.compactSegs(d, line, departs);
    if (d.nStrike + 2 > LIVE_STRIKE_CAP) this.compactStrikes(d);
    let lo = (n - 1) * SEG_STRIDE;
    // A segment a cancelled move had cut gets its full curve back (the move never happened, as a
    // moment's cancellation of pending moves in the compiler).
    if (s[lo + SEG_T1] >= cut && s[lo + SEG_T1] < s[lo + SEG_CURVE_T1]) {
      s[lo + SEG_T1] = s[lo + SEG_CURVE_T1];
      s[lo + SEG_P1] = s[lo + SEG_CURVE_P1];
    }
    // A glide whose hold was cancelled, ending before this move starts: hold from its end.
    const end = s[lo + SEG_T1];
    if (d.segGlide[n - 1] === 1 && end < t0 && end < INF && s[lo + SEG_T0] < end) {
      LR[R_X] = end;
      LR[R_Y] = s[lo + SEG_P1];
      this.writeHold(d, n);
      line[n] = line[n - 1];
      departs[n] = 0;
      LR[R_Y] = d.share[n - 1];
      this.strike(d, false);
      n++;
      lo += SEG_STRIDE;
    }
    // 2. Start state at t0 from the segment in force, which is cut there.
    LR[R_T] = t0;
    evalPitch(s, lo);
    const p0 = LR[R_P];
    const mid = d.segGlide[n - 1] === 1 && t0 < s[lo + SEG_T1];
    let v = 0;
    if (mid) {
      evalVelocity(s, lo);
      v = LR[R_V];
    }
    if (s[lo + SEG_T0] >= t0) {
      n--; // starts at t0 itself (the live score's first hold): replaced
    } else if (t0 < s[lo + SEG_T1]) {
      s[lo + SEG_T1] = t0;
      s[lo + SEG_P1] = p0;
    }
    // 3. The move.
    const code = m[mo + LIVE_EASE] | 0;
    if (dur > 0) {
      const o = n * SEG_STRIDE;
      // e′(0) is 0 for smootherstep, smoothstep and cosine: no call, so nothing is boxed.
      let s0 = 0;
      if (code === EaseCode.Linear || code === EaseCode.Expo || code === EaseCode.Bezier) {
        s0 = easeSlope0Raw(
          code as EaseCode,
          m[mo + LIVE_BX1],
          m[mo + LIVE_BY1],
          m[mo + LIVE_BX2],
          m[mo + LIVE_BY2],
        );
        if (!(s0 - s0 === 0)) s0 = 0; // ±Infinity (vertical bézier tangent): no finite m₀ matches
      }
      const scale = m[mo + LIVE_SCALE];
      const m0 = mid ? scale * (v * dur - (p1 - p0) * s0) : 0;
      const t1 = t0 + dur;
      s[o + SEG_T0] = t0;
      s[o + SEG_T1] = t1;
      s[o + SEG_P0] = p0;
      s[o + SEG_P1] = p1;
      s[o + SEG_EASE] = code;
      s[o + SEG_BX1] = m[mo + LIVE_BX1];
      s[o + SEG_BY1] = m[mo + LIVE_BY1];
      s[o + SEG_BX2] = m[mo + LIVE_BX2];
      s[o + SEG_BY2] = m[mo + LIVE_BY2];
      s[o + SEG_M0] = m0;
      s[o + SEG_CLAMPED] = mid && scale < 1 ? 1 : 0;
      s[o + SEG_CURVE_T1] = t1;
      s[o + SEG_CURVE_P1] = p1;
      const glide = p0 !== p1 || m0 !== 0;
      d.segGlide[n] = glide ? 1 : 0;
      d.holdStart[n] = glide ? NaN : t0;
      d.share[n] = m[mo + LIVE_SHARE];
      d.warpInA[n] = NaN;
      d.warpOutA[n] = NaN;
      LR[R_X] = t1;
      LR[R_Y] = p1;
      this.writeHold(d, n + 1);
      if (glide) {
        LR[R_Y] = m[mo + LIVE_SHARE];
        this.strike(d, false);
      }
      line[n] = m[mo + LIVE_LINE];
      line[n + 1] = m[mo + LIVE_JOIN] >= 0 ? m[mo + LIVE_JOIN] : m[mo + LIVE_LINE];
      departs[n] = m[mo + LIVE_BORN] > 0 ? 1 : 0;
      departs[n + 1] = 0;
      d.nSeg = n + 2;
    } else {
      LR[R_X] = t0;
      LR[R_Y] = p1;
      this.writeHold(d, n);
      LR[R_Y] = m[mo + LIVE_SHARE];
      this.strike(d, true);
      line[n] = m[mo + LIVE_LINE];
      departs[n] = m[mo + LIVE_BORN] > 0 ? 1 : 0;
      d.nSeg = n + 1;
    }
  }

  /**
   * Undoes voice d's moves from LR[R_TA] on: segments starting there or later and strikes after it
   * are dropped, and the segment they cut is restored to its full curve (with its hold and
   * arrival strike). A press's first change is applied at tA; its later changes rewind to tA and
   * re-plan from the state before the press.
   */
  private rewind(d: VoiceData, line: Float64Array, departs: Uint8Array): void {
    const tA = LR[R_TA];
    const s = d.segs;
    let n = d.nSeg;
    while (n > 1 && s[(n - 1) * SEG_STRIDE + SEG_T0] >= tA) n--;
    d.nSeg = n;
    let ns = d.nStrike;
    while (ns > 0 && d.strikeT[ns - 1] > tA) ns--;
    d.nStrike = ns;
    const lo = (n - 1) * SEG_STRIDE;
    const ct1 = s[lo + SEG_CURVE_T1];
    if (s[lo + SEG_T1] >= tA && s[lo + SEG_T1] < ct1) {
      s[lo + SEG_T1] = ct1;
      s[lo + SEG_P1] = s[lo + SEG_CURVE_P1];
      if (ct1 < INF) {
        LR[R_X] = ct1;
        LR[R_Y] = s[lo + SEG_CURVE_P1];
        this.writeHold(d, n);
        line[n] = line[n - 1];
        departs[n] = 0;
        if (d.segGlide[n - 1] === 1) {
          LR[R_Y] = d.share[n - 1];
          this.strike(d, false);
        }
      }
    }
  }

  /** Writes a hold at LR[R_Y] from LR[R_X] on as segment `k`. */
  private writeHold(d: VoiceData, k: number): void {
    const s = d.segs;
    const o = k * SEG_STRIDE;
    const t = LR[R_X];
    const p = LR[R_Y];
    s[o + SEG_T0] = t;
    s[o + SEG_T1] = INF;
    s[o + SEG_P0] = p;
    s[o + SEG_P1] = p;
    s[o + SEG_EASE] = 0;
    s[o + SEG_BX1] = 0;
    s[o + SEG_BY1] = 0;
    s[o + SEG_BX2] = 1;
    s[o + SEG_BY2] = 1;
    s[o + SEG_M0] = 0;
    s[o + SEG_CLAMPED] = 0;
    s[o + SEG_CURVE_T1] = INF;
    s[o + SEG_CURVE_P1] = p;
    d.segGlide[k] = 0;
    d.holdStart[k] = t;
    d.share[k] = 1;
    d.warpInA[k] = NaN;
    d.warpOutA[k] = NaN;
    d.nSeg = k + 1;
  }

  /**
   * Appends an articulation strike at LR[R_X] with share LR[R_Y] (`fresh`: from silence, so the
   * attack starts at 0).
   */
  private strike(d: VoiceData, fresh: boolean): void {
    const t = LR[R_X];
    let k = d.nStrike;
    if (k > 0 && d.strikeT[k - 1] === t) k--;
    const has = !fresh && k > 0;
    d.strikeT[k] = t;
    d.strikeShare[k] = LR[R_Y];
    d.strikePrevT[k] = has ? d.strikeT[k - 1] : NaN;
    d.strikePrevShare[k] = has ? d.strikeShare[k - 1] : 1;
    d.nStrike = k + 1;
  }

  /** Ramps voice d's level linearly from its value at LR[R_TA] to LR[R_GAIN] over LR[R_OVER]. */
  private level(d: VoiceData): void {
    const tA = LR[R_TA];
    const L = d.levels;
    let k = d.nLevel;
    if (k + 1 > LIVE_LEVEL_CAP) k = this.compactLevels(d);
    let cur = 1;
    if (k > 0) {
      const o = (k - 1) * LEVEL_STRIDE;
      if (L[o + LEVEL_T] >= tA) {
        cur = d.levelStart[k - 1];
        k--;
      } else {
        const ov = L[o + LEVEL_OVER];
        const u = ov > 0 ? (tA - L[o + LEVEL_T]) / ov : 1;
        const g = L[o + LEVEL_GAIN];
        cur = u >= 1 ? g : d.levelStart[k - 1] + (g - d.levelStart[k - 1]) * u;
      }
    }
    const o = k * LEVEL_STRIDE;
    const over = LR[R_OVER];
    L[o + LEVEL_T] = tA;
    L[o + LEVEL_GAIN] = LR[R_GAIN];
    L[o + LEVEL_OVER] = over > 0 ? over : 0;
    d.levelStart[k] = cur;
    d.nLevel = k + 1;
  }

  /**
   * Keeps only the last segment (the one in force at tA); returns the new count, 1. The compactions
   * copy doubles with `copyWithin`: they run too rarely to be optimised, and an unoptimised
   * `a[0] = a[k]` boxes the double (~1.3 KB per no-GC live run).
   */
  private compactSegs(d: VoiceData, line: Float64Array, departs: Uint8Array): number {
    const k = d.nSeg - 1;
    line.copyWithin(0, k, k + 1);
    departs[0] = departs[k];
    d.segs.copyWithin(0, k * SEG_STRIDE, (k + 1) * SEG_STRIDE);
    d.segGlide[0] = d.segGlide[k];
    d.holdStart.copyWithin(0, k, k + 1);
    d.share.copyWithin(0, k, k + 1);
    d.nSeg = 1;
    return 1;
  }

  private compactStrikes(d: VoiceData): void {
    const k = d.nStrike - 1;
    d.strikeT.copyWithin(0, k, k + 1);
    d.strikeShare.copyWithin(0, k, k + 1);
    d.strikePrevT[0] = NaN;
    d.strikePrevShare[0] = 1;
    d.nStrike = 1;
  }

  /** Keeps the last level record (and the one before it if the last starts at tA). */
  private compactLevels(d: VoiceData): number {
    const k = d.nLevel - 1;
    if (d.levels[k * LEVEL_STRIDE + LEVEL_T] >= LR[R_TA] && k > 0) {
      // The last may be overwritten, which reads its start level.
      d.levels.copyWithin(0, (k - 1) * LEVEL_STRIDE, (k + 1) * LEVEL_STRIDE);
      d.levelStart.copyWithin(0, k - 1, k + 1);
      d.nLevel = 2;
      return 2;
    }
    d.levels.copyWithin(0, k * LEVEL_STRIDE, (k + 1) * LEVEL_STRIDE);
    d.levelStart.copyWithin(0, k, k + 1);
    d.nLevel = 1;
    return 1;
  }

  // -------------------------------------------------------------------------------------------
  // Queries (main thread: the mirror; tests)
  // -------------------------------------------------------------------------------------------

  /** Index of voice i's segment in force at t. */
  segmentAt(i: number, t: number): number {
    const d = this.data[i];
    return Math.max(0, lastAtOrBefore(d.segs, d.nSeg, SEG_STRIDE, SEG_T0, t));
  }

  /** Voice i's pitch at t (without bend). */
  pitchAt(i: number, t: number): number {
    LR[R_T] = t;
    evalPitch(this.data[i].segs, this.segmentAt(i, t) * SEG_STRIDE);
    return LR[R_P];
  }

  /** Voice i's dp/dt at t, semitones per second (0 while holding). */
  velocityAt(i: number, t: number): number {
    const k = this.segmentAt(i, t);
    const d = this.data[i];
    if (d.segGlide[k] !== 1 || !(t < d.segs[k * SEG_STRIDE + SEG_T1])) return 0;
    LR[R_T] = t;
    evalVelocity(d.segs, k * SEG_STRIDE);
    return LR[R_V];
  }

  /** Whether voice i is mid-glide at t. */
  glidingAt(i: number, t: number): boolean {
    const k = this.segmentAt(i, t);
    const d = this.data[i];
    const o = k * SEG_STRIDE;
    return d.segGlide[k] === 1 && t >= d.segs[o + SEG_T0] && t < d.segs[o + SEG_T1];
  }

  /** Voice i's committed destination: where its last posted move ends. */
  dest(i: number): number {
    const d = this.data[i];
    return d.segs[(d.nSeg - 1) * SEG_STRIDE + SEG_P1];
  }

  /** Voice i's level at t, and the level its last ramp goes to. */
  levelAt(i: number, t: number): number {
    const d = this.data[i];
    const k = lastAtOrBefore(d.levels, d.nLevel, LEVEL_STRIDE, LEVEL_T, t);
    if (k < 0) return 1;
    const o = k * LEVEL_STRIDE;
    const ov = d.levels[o + LEVEL_OVER];
    const u = ov > 0 ? (t - d.levels[o + LEVEL_T]) / ov : 1;
    const g = d.levels[o + LEVEL_GAIN];
    return u >= 1 ? g : d.levelStart[k] + (g - d.levelStart[k]) * u;
  }

  levelTarget(i: number): number {
    const d = this.data[i];
    return d.nLevel > 0 ? d.levels[(d.nLevel - 1) * LEVEL_STRIDE + LEVEL_GAIN] : 1;
  }

  /** The line voice i is on at t (a pool index; see `lines`). */
  lineAt(i: number, t: number): number {
    return this.lines[i][this.segmentAt(i, t)];
  }

  /**
   * Voice i has more posted after t than the segment in force and its own hold: a later move, or
   * a line change at its arrival (LIVE_JOIN). Main thread.
   */
  postedAfter(i: number, t: number): boolean {
    const d = this.data[i];
    const k = this.segmentAt(i, t);
    if (k + 1 >= d.nSeg) return false;
    if (k + 2 < d.nSeg) return true;
    const s = d.segs;
    const next = s[(k + 1) * SEG_STRIDE + SEG_T0];
    return next > s[k * SEG_STRIDE + SEG_CURVE_T1] || this.lines[i][k + 1] !== this.lines[i][k];
  }

  /** Voice i's fork departure after t (a segment index), or −1: before it, it is not born. */
  departureAfter(i: number, t: number): number {
    const d = this.data[i];
    for (let k = this.segmentAt(i, t) + 1; k < d.nSeg; k++)
      if (this.departs[i][k] === 1 && d.segs[k * SEG_STRIDE + SEG_T0] > t) return k;
    return -1;
  }

  /** A deep copy (main thread). */
  clone(): LiveTracks {
    const c = Object.create(LiveTracks.prototype) as LiveTracks;
    (c as { data: VoiceData[] }).data = this.data.map(liveVoiceData);
    (c as unknown as { runOf: Int32Array }).runOf = new Int32Array(this.data.length);
    (c as { lines: Float64Array[] }).lines = this.lines.map((l) => l.slice());
    (c as { departs: Uint8Array[] }).departs = this.departs.map((l) => l.slice());
    return c;
  }
}

// Segment evaluation for `move`: core/segment's segmentPitch and segmentVelocity with the
// polynomial eases (smootherstep, the default, smoothstep, linear) written out, as easeRaw and
// easeDerivRaw compute them (same arithmetic; tests/dsp/live.test.ts compares). TurboFan inlines
// these into `move` but has no budget left for easeRaw there, and calling it boxed its six double
// arguments (~1.9 KB per message). Cosine, expo and bézier still call core/ease.

/** p(t) of the segment record at `o` of `s` into LR[R_P], for t = LR[R_T] (segmentPitch). */
function evalPitch(s: Float64Array, o: number): void {
  const t = LR[R_T];
  const t0 = s[o + SEG_T0];
  const p0 = s[o + SEG_P0];
  if (t < t0) {
    LR[R_P] = p0;
    return;
  }
  if (t >= s[o + SEG_T1]) {
    LR[R_P] = s[o + SEG_P1];
    return;
  }
  const x = (t - t0) / (s[o + SEG_CURVE_T1] - t0);
  if (x >= 1) {
    LR[R_P] = s[o + SEG_P1];
    return;
  }
  const code = s[o + SEG_EASE];
  let e = 0;
  if (x > 0) {
    if (code === EaseCode.Smootherstep) {
      if (x <= 0.5) e = x * x * x * (x * (x * 6 - 15) + 10);
      else {
        const u = 1 - x;
        e = 1 - u * u * u * (u * (u * 6 - 15) + 10);
      }
      e = e < 0 ? 0 : e > 1 ? 1 : e;
    } else if (code === EaseCode.Smoothstep) {
      e = x * x * (3 - 2 * x);
      e = e < 0 ? 0 : e > 1 ? 1 : e;
    } else if (code === EaseCode.Linear) {
      e = x;
    } else {
      e = easeRaw(
        code as EaseCode,
        x,
        s[o + SEG_BX1],
        s[o + SEG_BY1],
        s[o + SEG_BX2],
        s[o + SEG_BY2],
      );
    }
  }
  const omx = 1 - x;
  LR[R_P] = p0 + (s[o + SEG_CURVE_P1] - p0) * e + s[o + SEG_M0] * (x * omx * omx);
}

/** dp/dt of the segment record at `o` of `s` into LR[R_V], for t = LR[R_T] (segmentVelocity). */
function evalVelocity(s: Float64Array, o: number): void {
  const t = LR[R_T];
  const t0 = s[o + SEG_T0];
  const t1 = s[o + SEG_T1];
  const d = s[o + SEG_CURVE_T1] - t0;
  if (!(d > 0) || !(t1 > t0)) {
    LR[R_V] = 0;
    return;
  }
  const tc = t < t0 ? t0 : t > t1 ? t1 : t;
  let x = (tc - t0) / d;
  if (x > 1) x = 1;
  const code = s[o + SEG_EASE];
  let de: number;
  if (code === EaseCode.Smootherstep) {
    const w = x * (1 - x);
    de = x <= 0 || x >= 1 ? 0 : 30 * w * w;
  } else if (code === EaseCode.Smoothstep) {
    de = x <= 0 || x >= 1 ? 0 : 6 * x * (1 - x);
  } else if (code === EaseCode.Linear) {
    de = 1;
  } else {
    de = easeDerivRaw(
      code as EaseCode,
      x,
      s[o + SEG_BX1],
      s[o + SEG_BY1],
      s[o + SEG_BX2],
      s[o + SEG_BY2],
    );
  }
  const dH = (1 - x) * (1 - 3 * x);
  LR[R_V] = ((s[o + SEG_CURVE_P1] - s[o + SEG_P0]) * de + s[o + SEG_M0] * dH) / d;
}

/**
 * Runs every branch of `LiveTracks.run` on scratch data (segment, strike and level compaction, a
 * glide held again after its hold was cancelled, the replaced first hold, steps, carried velocity,
 * a linear ease, level ramps at a repeated time), so V8 has type feedback for all of them before
 * it optimises: a branch first taken in optimised code deoptimises the function, and until V8
 * re-optimises it the audio thread boxes doubles (~2 KB per message; build log, M7a). Allocates;
 * called once when live mode starts.
 */
export function exerciseLiveTracks(from: VoiceData): void {
  const tracks = new LiveTracks([from]);
  const m = new Float64Array(2 * LIVE_STRIDE);
  m[LIVE_BX2] = 1;
  m[LIVE_BY2] = 1;
  m[LIVE_STRIDE + LIVE_BX2] = 1;
  m[LIVE_STRIDE + LIVE_BY2] = 1;
  m[LIVE_STRIDE + LIVE_DUR] = 0.03;
  m[LIVE_STRIDE + LIVE_SCALE] = 1;
  m[LIVE_STRIDE + LIVE_SHARE] = 1;
  m[LIVE_STRIDE + LIVE_BORN] = 1;
  m[LIVE_STRIDE + LIVE_JOIN] = -1;
  let t = 0;
  // Steps of 0 (a repeated time), 4 ms (interrupting glides) and 40 ms (glides that arrive, so
  // their strikes stay and fill the strike buffer).
  const STEPS = [0.004, 0.04, 0.004, 0, 0.04, 0.004, 0.04];
  for (let k = 0; k < 4 * LIVE_SEG_CAP; k++) {
    m[LIVE_DELAY] = k % 5 === 0 ? 0.05 : 0;
    m[LIVE_DUR] = k % 7 === 0 ? 0 : 0.03;
    m[LIVE_P1] = 50 + (k % 13);
    m[LIVE_EASE] = k % 11 === 0 ? EaseCode.Linear : EaseCode.Smootherstep;
    m[LIVE_SCALE] = k % 3 === 0 ? 0.5 : 1;
    m[LIVE_SHARE] = 1;
    m[LIVE_LINE] = 0;
    m[LIVE_BORN] = k % 4 === 1 ? 1 : 0;
    m[LIVE_JOIN] = k % 3 === 2 ? 0 : -1;
    const gain = k % 2 === 0 ? (k % 4 === 0 ? 0 : 1) : NaN;
    // A second record for the voice now and then (a fork following its parent's move first).
    m[LIVE_STRIDE + LIVE_DELAY] = 0.01 + (k % 3) * 0.01;
    m[LIVE_STRIDE + LIVE_P1] = 52 + (k % 7);
    const recs = k % 6 === 1 ? 2 : 1;
    tracks.apply(m, 0, recs, gain, 0.025, t, null, k % 9 === 4); // a re-planned press now and then
    t += STEPS[k % STEPS.length];
  }
}

/**
 * The worklet's live input: queues messages (copying them) and applies them, and the bend, before
 * each block. Allocation-free after construction.
 */
export class LiveInput {
  readonly tracks: LiveTracks;
  private readonly graph: Graph;
  private readonly rate: number;
  private readonly qMoves = new Float64Array(LIVE_QUEUE * LIVE_MAX_RECORDS * LIVE_STRIDE);
  private readonly qCount = new Int32Array(LIVE_QUEUE);
  private readonly qSeq = new Float64Array(LIVE_QUEUE);
  private readonly qGain = new Float64Array(LIVE_QUEUE);
  private readonly qOver = new Float64Array(LIVE_QUEUE);
  private readonly qPress = new Float64Array(LIVE_QUEUE);
  /** Recently applied seqs and the time each was applied at (a ring), for re-planned presses. */
  private readonly ringSeq = new Float64Array(LIVE_RING).fill(-1);
  private readonly ringTime = new Float64Array(LIVE_RING);
  private ringHead = 0;
  private qHead = 0;
  private qLen = 0;
  private readonly touched = new Uint8Array(DSP_MAX_VOICES);
  private bendTarget = 0;
  private bendNow = 0;
  private readonly bendCoeff: number;
  /** Seqs applied by the last `beforeBlock`, and the time and context frame they apply at. */
  readonly appliedSeq = new Float64Array(LIVE_QUEUE);
  appliedCount = 0;
  appliedTime = 0;
  appliedFrame = 0;

  /** Takes over `graph`'s loaded voices (allocates: call once, when live mode starts). */
  constructor(graph: Graph, voices: number) {
    this.graph = graph;
    this.rate = graph.sampleRate;
    const initial: VoiceData[] = [];
    for (let i = 0; i < voices; i++) initial.push(graph.voiceAt(i).data);
    if (initial.length > 0) exerciseLiveTracks(initial[0]);
    this.tracks = new LiveTracks(initial);
    for (let i = 0; i < this.tracks.data.length; i++) graph.voiceAt(i).data = this.tracks.data[i];
    // One-pole per block: 1 − e^(−block/τ), by its series (no Math.exp on the audio thread path).
    const x = BLOCK_FRAMES / (BEND_SMOOTHING * this.rate);
    this.bendCoeff = x >= 1 ? 1 : x * (1 - x * (0.5 - x / 6));
  }

  /**
   * Queues a message: `n` records of `moves` (copied) and a level ramp (NaN gain: none). With
   * `press` > 0 (the seq of its press's first message) it applies at the time that message was
   * applied, after rewinding to it (`LiveTracks.run`). False if the queue is full (dropped).
   */
  queue(
    seq: number,
    moves: Float64Array,
    n: number,
    gain: number,
    over: number,
    press = 0,
  ): boolean {
    if (this.qLen >= LIVE_QUEUE) return false;
    const slot = (this.qHead + this.qLen) % LIVE_QUEUE;
    const k = n < LIVE_MAX_RECORDS ? n : LIVE_MAX_RECORDS;
    const base = slot * LIVE_MAX_RECORDS * LIVE_STRIDE;
    const len = k * LIVE_STRIDE;
    for (let j = 0; j < len; j++) this.qMoves[base + j] = moves[j];
    this.qCount[slot] = k;
    this.qSeq[slot] = seq;
    this.qGain[slot] = gain;
    this.qOver[slot] = over;
    this.qPress[slot] = press;
    this.qLen++;
    return true;
  }

  /**
   * A re-planned press (queue `slot`): sets LR[R_TA] to the time its first message was applied
   * at; false if that one is no longer remembered.
   */
  private pressTime(slot: number): boolean {
    const press = this.qPress[slot];
    for (let k = 0; k < LIVE_RING; k++) {
      if (this.ringSeq[k] === press) {
        LR[R_TA] = this.ringTime[k];
        return true;
      }
    }
    return false;
  }

  /**
   * Applies the queued messages at the graph's position. Out of `beforeBlock` and taking no
   * arguments: kept inside it, the per-message path left beforeBlock too big to inline into its
   * caller and allocated ~100 B per message (no-GC live harness, M7-c).
   */
  private drain(): void {
    const g = this.graph;
    const tA = g.position;
    const touched = this.touched;
    touched.fill(0);
    while (this.qLen > 0) {
      const slot = this.qHead;
      LR[R_TA] = tA;
      LR[R_GAIN] = this.qGain[slot];
      LR[R_OVER] = this.qOver[slot];
      const rewind = this.qPress[slot] > 0 && this.pressTime(slot);
      this.tracks.run(
        this.qMoves,
        slot * LIVE_MAX_RECORDS * LIVE_STRIDE,
        this.qCount[slot],
        touched,
        rewind,
      );
      this.ringSeq[this.ringHead] = this.qSeq[slot];
      this.ringTime[this.ringHead] = tA;
      this.ringHead = (this.ringHead + 1) % LIVE_RING;
      this.appliedSeq[this.appliedCount++] = this.qSeq[slot];
      this.qHead = (this.qHead + 1) % LIVE_QUEUE;
      this.qLen--;
    }
    const pf = Math.round(tA * this.rate);
    for (let i = 0; i < this.tracks.data.length; i++)
      if (touched[i] === 1) g.voiceAt(i).jump(pf, false);
    this.appliedTime = tA;
  }

  /** Target bend in semitones (smoothed over BEND_SMOOTHING). */
  setBend(semitones: number): void {
    this.bendTarget = semitones === semitones ? semitones : 0;
  }

  /**
   * Applies queued messages at the graph's position (the first frame of the coming block; context
   * frame `frame`) and steps the bend. Call right before `graph.process`.
   */
  beforeBlock(frame: number): void {
    const g = this.graph;
    this.appliedCount = 0;
    if (this.bendNow !== this.bendTarget) {
      let b = this.bendNow + (this.bendTarget - this.bendNow) * this.bendCoeff;
      const diff = this.bendTarget - b;
      if (diff < 1e-6 && diff > -1e-6) b = this.bendTarget;
      this.bendNow = b;
      g.setPitchOffset(b);
    }
    if (this.qLen === 0) return;
    this.drain();
    this.appliedFrame = frame;
  }
}
