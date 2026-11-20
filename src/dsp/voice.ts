/**
 * One voice of the DSP graph (PLAN.md §8.4): pitch from flat segment records, always-on detune,
 * vibrato after arrival (optionally jittered), seeded slow drift of pitch and amplitude,
 * band-limited wavetable oscillator with mip crossfade, articulation,
 * motion accent, loudness tilt, life fades, level ramps, equal-power pan and FX sends.
 *
 * Evaluation is at control rate: once per CONTROL_PERIOD frames the voice computes its frequency,
 * amplitude, pan and mip position, and the samples in between interpolate linearly (phase
 * increment, amplitude and pan gains). `render` never allocates (§8.11).
 *
 * The same class serves as a "ghost": a copy of a voice that keeps playing its old state while
 * fading out, so seek, loop wrap and hot-swap can crossfade instead of cutting (§8.7).
 */

import {
  LEVEL_GAIN,
  LEVEL_OVER,
  LEVEL_STRIDE,
  LEVEL_T,
  LIFE_BORN,
  LIFE_DIED,
  LIFE_FADE_IN,
  LIFE_FADE_OUT,
  LIFE_STRIDE,
  SEG_BX1,
  SEG_BX2,
  SEG_BY1,
  SEG_BY2,
  SEG_CURVE_P1,
  SEG_CURVE_T1,
  SEG_EASE,
  SEG_M0,
  SEG_P1,
  SEG_P0,
  SEG_STRIDE,
  SEG_T0,
  SEG_T1,
  TIMBRE_FADE,
  TIMBRE_PRESET,
  TIMBRE_STRIDE,
  TIMBRE_T,
  VOICE_GAIN,
  VOICE_ID_HASH,
  VOICE_MUTE,
  VOICE_PAN,
  VOICE_SEND_DELAY,
  VOICE_SEND_REVERB,
  VOICE_SOLO,
  VOICE_STRIDE,
  evalFlatSegment,
  segmentMotion,
  segmentPitch,
} from '../core/segment';
import type { EaseCode } from '../core/ease';
import type { FlatVoice } from '../core/flat';
import {
  BLOCK_FRAMES,
  CONTROL_PERIOD,
  MIN_LIFE_FADE,
  MUTE_RAMP,
  SWAP_CROSSFADE_SEMITONES,
  VOICE_BASE_GAIN,
} from './constants';
import { hash2, Prng, unit } from './rng';
import { SINE, SINE_TABLE_SIZE, cos2pi, sin2pi } from './sine';
import type { TimbreSlot } from './timbre-slot';
import { MIP_BASE_HZ, MIP_COUNT, WAVETABLE_SIZE, WAVETABLE_STRIDE } from './wavetable';

/** Control ticks per block. */
export const TICKS_PER_BLOCK = BLOCK_FRAMES / CONTROL_PERIOD;

const LN2 = Math.LN2;
/** ln(100): the articulation decay reaches 1 % (−40 dB) after `decay` seconds. */
const ARTICULATION_DECAY = 4.605170185988092;
/** Vibrato fades in over this long once its onset delay has passed (seconds). */
const VIBRATO_RAMP = 0.25;
/** Smoothing of the motion accent, so interrupted glides cannot step the gain (seconds). */
const MOTION_SMOOTHING = 0.015;
/** Smoothing of the vibrato depth, so vibrato stops without a pitch step when a glide starts. */
const VIBRATO_SMOOTHING = 0.04;
/** Loudness tilt 2^(−(p − 57)/48) (the prototype's equal-loudness tilt, §8.4). */
const LOUDNESS_PITCH = 57;
const LOUDNESS_SLOPE = LN2 / 48;
/** Pan per semitone for `panAuto: 'pitch'`, centred on middle C, clamped to ±PAN_PITCH_MAX. */
const PAN_PITCH_SLOPE = 1 / 40;
const PAN_PITCH_MAX = 0.8;
/** Detune magnitudes before the timbre's spread (cents, §8.4), and the floor. */
const DETUNE_MIN = 1.5;
const DETUNE_RANGE = 2.5;
const DETUNE_FLOOR = 1;
/** Hash salts. */
const SALT_DETUNE = 0x0de7;
const SALT_SPREAD = 0x5bd1;
const SALT_LFO = 0x1f0c;
const SALT_DRIFT = 0xd71f;
const SALT_VJ_RATE = 0x7a7e;
const SALT_VJ_DEPTH = 0xde97;

/**
 * Drift and vibrato jitter read smooth value noise: Catmull-Rom interpolation through DRIFT_KNOTS
 * seeded random knots in [−1, 1] per voice (a ring; with the incommensurate rates below it does not
 * audibly repeat). The noise phase advances at the timbre's drift rate, or DEFAULT_WANDER_RATE.
 */
const DRIFT_KNOTS = 64;
const DEFAULT_WANDER_RATE = 0.3;
/** Noise streams: phase scale and offset (in knots) of each, read off the same knot ring. */
const NOISE_SCALE = new Float64Array([1, 2.13, 0.61, 0.83, 1.37]);
const NOISE_OFFSET = new Float64Array([0, 23.5, 40.3, 11.7, 52.9]);
/** Vibrato jitter at jitter = 1: fixed per-voice spread and slow wobble, as fractions. */
const VJ_RATE_SPREAD = 0.12;
const VJ_RATE_WOBBLE = 0.08;
const VJ_DEPTH_SPREAD = 0.25;
const VJ_DEPTH_WOBBLE = 0.3;

/** Crossfade modes. */
const XF_NONE = 0;
const XF_IN = 1;
const XF_OUT = 2;

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);
const EMPTY_I32 = new Int32Array(0);

function smootherstep(x: number): number {
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Index of the last record whose `field` is ≤ t, or −1. Binary search; allocation-free. */
export function lastAtOrBefore(
  a: Float64Array,
  count: number,
  stride: number,
  field: number,
  t: number,
): number {
  let lo = 0;
  let hi = count - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid * stride + field] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * One voice's score data plus everything precomputed from it. Built in a message handler (it
 * allocates); assigning it to a voice is a reference copy.
 */
export class VoiceData {
  segs: Float64Array = EMPTY_F64;
  nSeg = 0;
  lives: Float64Array = EMPTY_F64;
  nLife = 0;
  levels: Float64Array = EMPTY_F64;
  nLevel = 0;
  /** Level in effect at the start of each level ramp. */
  levelStart: Float64Array = EMPTY_F64;
  timbres: Float64Array = EMPTY_F64;
  nTimbre = 0;
  /** Graph slot of each timbre record's preset. */
  timbreSlot: Int32Array = EMPTY_I32;
  /** 1 when segment i is a glide (anything but a flat hold). */
  segGlide: Uint8Array = EMPTY_U8;
  /** Time of the arrival whose articulation is running during segment i. */
  arrive: Float64Array = EMPTY_F64;
  /** The arrival before that (NaN if none), to start the attack from the decaying envelope. */
  prevArrive: Float64Array = EMPTY_F64;
  /** Start of the hold containing segment i (NaN during glides), for vibrato onset. */
  holdStart: Float64Array = EMPTY_F64;

  gain = 1;
  /** −1..1, or NaN for auto. */
  pan = NaN;
  mute = false;
  solo = false;
  /** Send overrides; NaN = mix default. */
  sendReverb = NaN;
  sendDelay = NaN;
  hash = 0;

  /** Results of `probe()`. */
  probeLife = 0;
  probePitch = NaN;
  probeSlot = -1;

  /** Builds data for pool voice `index` of a flat score; `slotOf` maps timbreNames indices. */
  static fromFlat(
    fv: FlatVoice,
    params: Float64Array,
    index: number,
    slotOf: Int32Array,
  ): VoiceData {
    const d = new VoiceData();
    d.segs = fv.segments;
    d.nSeg = (fv.segments.length / SEG_STRIDE) | 0;
    d.lives = fv.lives;
    d.nLife = (fv.lives.length / LIFE_STRIDE) | 0;
    d.levels = fv.levels;
    d.nLevel = (fv.levels.length / LEVEL_STRIDE) | 0;
    d.timbres = fv.timbres;
    d.nTimbre = (fv.timbres.length / TIMBRE_STRIDE) | 0;
    const p = index * VOICE_STRIDE;
    d.gain = params[p + VOICE_GAIN];
    d.pan = params[p + VOICE_PAN];
    d.mute = params[p + VOICE_MUTE] === 1;
    d.solo = params[p + VOICE_SOLO] === 1;
    d.sendReverb = params[p + VOICE_SEND_REVERB];
    d.sendDelay = params[p + VOICE_SEND_DELAY];
    d.hash = params[p + VOICE_ID_HASH] >>> 0;

    d.timbreSlot = new Int32Array(d.nTimbre);
    for (let i = 0; i < d.nTimbre; i++) {
      const name = d.timbres[i * TIMBRE_STRIDE + TIMBRE_PRESET];
      d.timbreSlot[i] = name >= 0 && name < slotOf.length ? slotOf[name] : -1;
    }

    const n = d.nSeg;
    const s = d.segs;
    d.segGlide = new Uint8Array(n);
    d.arrive = new Float64Array(n);
    d.prevArrive = new Float64Array(n);
    d.holdStart = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * SEG_STRIDE;
      const glide =
        s[o + SEG_P0] !== s[o + SEG_CURVE_P1] ||
        s[o + SEG_M0] !== 0 ||
        !(s[o + SEG_T1] > s[o + SEG_T0]);
      d.segGlide[i] = glide ? 1 : 0;
      const contiguous = i > 0 && s[o - SEG_STRIDE + SEG_T1] === s[o + SEG_T0];
      if (!contiguous) {
        d.arrive[i] = s[o + SEG_T0];
        d.prevArrive[i] = NaN;
      } else if (d.segGlide[i - 1] === 1 && !glide) {
        d.arrive[i] = s[o + SEG_T0];
        d.prevArrive[i] = d.arrive[i - 1];
      } else {
        d.arrive[i] = d.arrive[i - 1];
        d.prevArrive[i] = d.prevArrive[i - 1];
      }
      d.holdStart[i] = glide
        ? NaN
        : contiguous && d.segGlide[i - 1] === 0
          ? d.holdStart[i - 1]
          : s[o + SEG_T0];
    }

    d.levelStart = new Float64Array(d.nLevel);
    const L = d.levels;
    for (let i = 0; i < d.nLevel; i++) {
      if (i === 0) {
        d.levelStart[0] = 1;
        continue;
      }
      const o = (i - 1) * LEVEL_STRIDE;
      const over = L[o + LEVEL_OVER];
      const u = over > 0 ? (L[i * LEVEL_STRIDE + LEVEL_T] - L[o + LEVEL_T]) / over : 1;
      const start = d.levelStart[i - 1];
      d.levelStart[i] = start + (L[o + LEVEL_GAIN] - start) * (u >= 1 ? 1 : u);
    }
    return d;
  }

  /**
   * Evaluates life weight, pitch and timbre slot at `frame` / `sampleRate` seconds into
   * probeLife, probePitch and probeSlot. Pure apart from those fields; integer arguments only,
   * so calling it from the audio thread boxes nothing.
   */
  probe(frame: number, sampleRate: number): void {
    const t = frame / sampleRate;
    const li = lastAtOrBefore(this.lives, this.nLife, LIFE_STRIDE, LIFE_BORN, t);
    this.probeLife = li < 0 ? 0 : lifeWeight(this.lives, li * LIFE_STRIDE, t);
    if (this.nSeg === 0) this.probePitch = NaN;
    else {
      const si = lastAtOrBefore(this.segs, this.nSeg, SEG_STRIDE, SEG_T0, t);
      this.probePitch = evalFlatSegment(this.segs, (si < 0 ? 0 : si) * SEG_STRIDE, t);
    }
    if (this.nTimbre === 0) this.probeSlot = -1;
    else {
      const ti = lastAtOrBefore(this.timbres, this.nTimbre, TIMBRE_STRIDE, TIMBRE_T, t);
      this.probeSlot = this.timbreSlot[ti < 0 ? 0 : ti];
    }
  }
}

/** Shared empty data for voices beyond the pool size. Never mutated. */
export const EMPTY_VOICE_DATA = new VoiceData();

/** Life weight of the life record at `o` (smootherstep fades, at least MIN_LIFE_FADE long). */
function lifeWeight(L: Float64Array, o: number, t: number): number {
  const born = L[o + LIFE_BORN];
  const died = L[o + LIFE_DIED];
  if (t >= died || t < born) return 0;
  let w = 1;
  // Math.max, not a ternary: a phi of a float64 and an imported constant would box.
  const fin = Math.max(L[o + LIFE_FADE_IN], MIN_LIFE_FADE);
  const u = (t - born) / fin;
  if (u < 1) w = smootherstep(u);
  const fout = Math.max(L[o + LIFE_FADE_OUT], MIN_LIFE_FADE);
  const v = (died - t) / fout;
  if (v < 1) w *= smootherstep(v);
  return w;
}

/**
 * Per-block state shared by every voice: the buses they mix into, the normalisation gain, the
 * timbre slots and mix-wide settings. One instance per graph.
 */
export class VoiceContext {
  /** Timbre slots (owned by the graph). */
  readonly slots: TimbreSlot[];
  readonly sampleRate: number = 0;
  readonly invSampleRate: number = 0;
  /** Seconds per control tick. */
  readonly tickSeconds: number = 0;
  /** Per-tick smoothing coefficients. */
  readonly motionCoeff: number = 0;
  readonly vibratoCoeff: number = 0;
  /** Mute gain change per tick. */
  readonly muteStep: number = 0;
  /** log2(referenceHz / MIP_BASE_HZ). */
  refOct = Math.log2(440 / MIP_BASE_HZ);
  /** `mix.panAuto === 'pitch'`. */
  panByPitch = false;
  /** Some voice is soloed. */
  anySolo = false;
  /** Default send levels (mix.sends). */
  sendReverb = 0;
  sendDelay = 0;
  /** Render frame of the block start (for timbre-slot fades). */
  renderFrame0 = 0;
  /** g_n at the block start (index 0) and at the end of each tick (1..TICKS_PER_BLOCK). */
  readonly gn = new Float64Array(TICKS_PER_BLOCK + 1);
  /** Dry stereo bus and the mono send buses. */
  readonly dryL = new Float64Array(BLOCK_FRAMES);
  readonly dryR = new Float64Array(BLOCK_FRAMES);
  readonly revIn = new Float64Array(BLOCK_FRAMES);
  readonly dlyIn = new Float64Array(BLOCK_FRAMES);
  /** Scratch for the multi-table path. */
  readonly phaseBuf = new Float64Array(CONTROL_PERIOD);
  readonly mixBuf = new Float64Array(CONTROL_PERIOD);

  constructor(sampleRate: number, slots: TimbreSlot[]) {
    this.slots = slots;
    this.sampleRate = sampleRate;
    this.invSampleRate = 1 / sampleRate;
    this.tickSeconds = CONTROL_PERIOD / sampleRate;
    this.motionCoeff = 1 - Math.exp(-this.tickSeconds / MOTION_SMOOTHING);
    this.vibratoCoeff = 1 - Math.exp(-this.tickSeconds / VIBRATO_SMOOTHING);
    this.muteStep = this.tickSeconds / MUTE_RAMP;
  }
}

/** Indices into `Voice.st`, the voice's persistent double-valued state. */
const S_PHASE = 0;
const S_LFO = 1;
const S_MOTION = 2;
const S_VIB = 3;
const S_MUTE = 4;
const S_PREV_AMP = 5;
const S_CUR_AMP = 6;
const S_PREV_INC = 7;
const S_CUR_INC = 8;
const S_PREV_GL = 9;
const S_CUR_GL = 10;
const S_PREV_GR = 11;
const S_CUR_GR = 12;
const S_PITCH = 13;
const S_NOISE_RATE = 14;
const S_SEND_REV = 15;
const S_SEND_DLY = 16;
const S_XF_FROM = 17;
const S_SLEW_PITCH = 18;
const S_SLEW_AMP = 19;
const S_GN_FROZEN = 20;
const S_DET_SIGN = 21;
const S_DET_MAG = 22;
const S_DET_U = 23;
const S_PAN_INDEX = 24;
const S_NOISE_PH = 25;
/** Five noise streams (S_NOISE_0 + j for NOISE_SCALE[j]): pitch ×2, vib rate, vib depth, amp. */
const S_NOISE_0 = 26;
const S_VJ_RATE_U = 31;
const S_VJ_DEPTH_U = 32;
const STATE_SIZE = 33;

/**
 * One synthesis voice (or ghost).
 *
 * Allocation discipline (§8.11). V8 boxes a double (allocates a HeapNumber) whenever one crosses a
 * call it did not inline, and may box doubles stored in object fields. So:
 * - every double that persists between ticks lives in the Float64Array `st`;
 * - the per-tick work is one large method, `render`, written inline. It is too big to be inlined
 *   into the graph, and so gets its own inlining budget, which goes to the shared core/segment
 *   functions it calls (P1);
 * - calls between the graph and a voice pass only integers, booleans and objects.
 * The no-GC test (tests/dsp/no-gc.test.ts) enforces the result.
 */
export class Voice {
  /** Pool index (stems select by it). */
  index = -1;
  data: VoiceData = EMPTY_VOICE_DATA;
  /** Main voice: rendering enabled. Ghost: in use. */
  enabled = false;
  /** A ghost computes its own life weights; a main voice reads `lifeTick` (filled by the graph). */
  isGhost = false;
  /** Ghosts only: piece frame of the ghost's own timeline at the block start. */
  frame = 0;
  /**
   * Life weight per tick of the current block (index k + 1 for tick k; index 0 is scratch),
   * filled by the graph before `render` (for ghosts too), so render's inlining budget is left
   * for the segment functions.
   */
  readonly lifeTick = new Float64Array(TICKS_PER_BLOCK + 1);
  /** Persistent double state (see the S_* indices). */
  private readonly st = new Float64Array(STATE_SIZE);
  private readonly invRate: number = 0;

  // Cursors (monotonic between jumps).
  private segCur = 0;
  private lifeCur = -1;
  private levelCur = -1;
  private timbreCur = 0;
  /** Timbre slot at the last tick. */
  private curSlot = -1;
  /** Re-initialise smoothers and interpolation at the next tick. */
  private fresh = true;

  // Up to four tables at once (timbre crossfade × slot replacement), matched by identity.
  private readonly roleTab: (Float32Array | null)[] = [null, null, null, null];
  private readonly roleSame: (Uint8Array | null)[] = [null, null, null, null];
  private readonly roleG0 = new Float64Array(4);
  private readonly roleG1 = new Float64Array(4);
  private readonly roleClaim = new Uint8Array(4);
  /** Each role's mip spacing, and its mip index and crossfade weight at the last tick. */
  private readonly roleMpo = new Int32Array([1, 1, 1, 1]);
  private readonly roleMip = new Int32Array(4);
  private readonly roleW = new Float64Array(4);
  /** Seeded drift knots (set in setIdentity) and the PRNG that fills them (reused, no allocation). */
  private readonly knots = new Float64Array(DRIFT_KNOTS);
  private readonly prng = new Prng(0);

  // Crossfade (seek, loop, swap) and slew (swap), counted in frames.
  private xfMode = XF_NONE;
  private xfPos = 0;
  private xfLen = 1;
  /** A fade-out finished: the ghost can be released. */
  xfDone = false;
  private slewPos = 0;
  private slewLen = 0;

  constructor(sampleRate: number) {
    this.invRate = 1 / sampleRate;
    const st = this.st;
    st[S_MUTE] = 1;
    st[S_PREV_GL] = st[S_CUR_GL] = st[S_PREV_GR] = st[S_CUR_GR] = Math.SQRT1_2;
    st[S_PITCH] = NaN;
    st[S_SLEW_PITCH] = NaN;
    st[S_GN_FROZEN] = 1;
    st[S_XF_FROM] = 1;
    st[S_DET_SIGN] = 1;
    st[S_DET_MAG] = 2;
  }

  /** Sets pool identity: detune, start phase and auto-pan position (§8.4). */
  setIdentity(index: number, hash: number, seed: number, poolSize: number): void {
    const st = this.st;
    this.index = index;
    st[S_DET_SIGN] = index % 2 === 1 ? 1 : -1;
    st[S_DET_MAG] = DETUNE_MIN + DETUNE_RANGE * unit(hash2(hash, SALT_DETUNE));
    st[S_DET_U] = unit(hash2(hash, SALT_SPREAD));
    st[S_PHASE] = unit(hash2(hash, seed));
    st[S_LFO] = unit(hash2(hash, (seed ^ SALT_LFO) >>> 0));
    st[S_VJ_RATE_U] = 2 * unit(hash2(hash, (seed ^ SALT_VJ_RATE) >>> 0)) - 1;
    st[S_VJ_DEPTH_U] = 2 * unit(hash2(hash, (seed ^ SALT_VJ_DEPTH) >>> 0)) - 1;
    const prng = this.prng;
    prng.state = hash2(hash, (seed ^ SALT_DRIFT) >>> 0);
    const knots = this.knots;
    for (let i = 0; i < DRIFT_KNOTS; i++) knots[i] = 2 * prng.next() - 1;
    st[S_PAN_INDEX] =
      (index % 2 === 1 ? 1 : -1) * (0.12 + (0.5 * index) / Math.max(1, poolSize - 1));
  }

  /** Detune in cents for a timbre spread (§8.4: alternating sign, never below 1 cent). Tests. */
  detuneCents(spread: number): number {
    const m = this.st[S_DET_MAG] + spread * this.st[S_DET_U];
    return this.st[S_DET_SIGN] * (m > DETUNE_FLOOR ? m : DETUNE_FLOOR);
  }

  /** Drift noise knot i (tests: drift is a pure function of the voice hash and piece seed). */
  driftKnot(i: number): number {
    return this.knots[i & (DRIFT_KNOTS - 1)];
  }

  /** Current oscillator phase in cycles (tests). */
  get phaseCycles(): number {
    return this.st[S_PHASE];
  }

  /** Whether the voice produced sound at its last tick. */
  isSounding(): boolean {
    return this.st[S_PREV_AMP] > 0;
  }

  /** Ghosts: freezes g_n at `source[index]` (the value when the ghost was spawned). */
  freezeGn(source: Float64Array, index: number): void {
    this.st[S_GN_FROZEN] = source[index];
  }

  /** Repositions every cursor at piece frame `frame`. `fresh` re-initialises smoothers. */
  jump(frame: number, fresh: boolean): void {
    const d = this.data;
    const t = frame * this.invRate;
    this.segCur = Math.max(0, lastAtOrBefore(d.segs, d.nSeg, SEG_STRIDE, SEG_T0, t));
    this.lifeCur = lastAtOrBefore(d.lives, d.nLife, LIFE_STRIDE, LIFE_BORN, t);
    this.levelCur = lastAtOrBefore(d.levels, d.nLevel, LEVEL_STRIDE, LEVEL_T, t);
    this.timbreCur = Math.max(0, lastAtOrBefore(d.timbres, d.nTimbre, TIMBRE_STRIDE, TIMBRE_T, t));
    if (fresh) {
      this.fresh = true;
      this.st[S_PREV_AMP] = 0;
      this.slewLen = 0;
    }
  }

  /** Starts an equal-power fade-in from silence over `frames`. */
  fadeIn(frames: number): void {
    this.xfMode = XF_IN;
    this.xfPos = 0;
    this.xfLen = Math.max(1, frames);
    this.st[S_XF_FROM] = 0;
    this.xfDone = false;
  }

  /** Starts an equal-power fade-out from the current crossfade gain over `frames`. */
  fadeOut(frames: number): void {
    const from = this.xfGain();
    this.xfMode = XF_OUT;
    this.xfPos = 0;
    this.xfLen = Math.max(1, frames);
    this.st[S_XF_FROM] = from;
    this.xfDone = from === 0;
  }

  /** Clears any crossfade (full gain). */
  clearFade(): void {
    this.xfMode = XF_NONE;
    this.xfDone = false;
  }

  /** Swap slew: blends from the current pitch and amplitude to the live values over `frames`. */
  slewFromCurrent(frames: number): void {
    this.st[S_SLEW_PITCH] = this.st[S_PITCH];
    this.st[S_SLEW_AMP] = this.st[S_PREV_AMP];
    this.slewPos = 0;
    this.slewLen = Math.max(1, frames);
  }

  /** Swap ramp for a voice that was silent: its amplitude rises from 0 over `frames`. */
  slewFromSilence(frames: number): void {
    this.st[S_SLEW_PITCH] = NaN;
    this.st[S_SLEW_AMP] = 0;
    this.slewPos = 0;
    this.slewLen = Math.max(1, frames);
  }

  /** Whether swapping to `nd` at piece frame `frame` needs a crossfade rather than a slew. */
  swapNeedsCrossfade(nd: VoiceData, frame: number, sampleRate: number): boolean {
    if (nd.hash !== this.data.hash) return true;
    nd.probe(frame, sampleRate);
    if (!(nd.probeLife > 0)) return true;
    if (!(Math.abs(nd.probePitch - this.st[S_PITCH]) <= SWAP_CROSSFADE_SEMITONES)) return true;
    return nd.probeSlot !== this.curSlot;
  }

  /** Current crossfade gain (0..1). */
  xfGain(): number {
    if (this.xfMode === XF_NONE) return 1;
    const u = this.xfPos >= this.xfLen ? 1 : this.xfPos / this.xfLen;
    return this.xfMode === XF_IN ? sin2pi(u * 0.25) : this.st[S_XF_FROM] * cos2pi(u * 0.25);
  }

  /** Writes the life weight at piece frame `frame` to lifeTick[slot], advancing the cursor. */
  computeLife(frame: number, slot: number): void {
    const t = frame * this.invRate;
    const d = this.data;
    const L = d.lives;
    let li = this.lifeCur;
    while (li + 1 < d.nLife && L[(li + 1) * LIFE_STRIDE + LIFE_BORN] <= t) li++;
    this.lifeCur = li;
    let w = 0;
    if (li >= 0) {
      const o = li * LIFE_STRIDE;
      const born = L[o + LIFE_BORN];
      const died = L[o + LIFE_DIED];
      if (t < died && t >= born) {
        w = 1;
        // Math.max, not a ternary: a phi of a float64 and an imported constant would box.
        const fin = Math.max(L[o + LIFE_FADE_IN], MIN_LIFE_FADE);
        const u = (t - born) / fin;
        if (u < 1) w = u * u * u * (u * (u * 6 - 15) + 10);
        const fout = Math.max(L[o + LIFE_FADE_OUT], MIN_LIFE_FADE);
        const v = (died - t) / fout;
        if (v < 1) w *= v * v * v * (v * (v * 6 - 15) + 10);
      }
    }
    this.lifeTick[slot] = w;
  }

  /** Copies the complete state of `v` (used to spawn a ghost). Allocation-free. */
  copyFrom(v: Voice): void {
    this.index = v.index;
    this.data = v.data;
    this.enabled = true;
    this.st.set(v.st);
    this.segCur = v.segCur;
    this.lifeCur = v.lifeCur;
    this.levelCur = v.levelCur;
    this.timbreCur = v.timbreCur;
    this.curSlot = v.curSlot;
    this.roleMpo.set(v.roleMpo);
    this.roleMip.set(v.roleMip);
    this.roleW.set(v.roleW);
    this.knots.set(v.knots);
    this.fresh = v.fresh;
    for (let r = 0; r < 4; r++) {
      this.roleTab[r] = v.roleTab[r];
      this.roleSame[r] = v.roleSame[r];
    }
    this.roleG0.set(v.roleG0);
    this.roleG1.set(v.roleG1);
    this.xfMode = v.xfMode;
    this.xfPos = v.xfPos;
    this.xfLen = v.xfLen;
    this.xfDone = v.xfDone;
    this.slewPos = v.slewPos;
    this.slewLen = v.slewLen;
  }

  /**
   * Renders one block starting at piece frame `frame0` into the context's buses. For each control
   * tick it evaluates pitch, timbre, envelopes, frequency, amplitude and pan at the tick's end,
   * then synthesises the tick's frames interpolating from the previous tick.
   */
  render(ctx: VoiceContext, frame0: number): void {
    const K = CONTROL_PERIOD;
    const st = this.st;
    const d = this.data;
    const inv = this.invRate;
    const slots = ctx.slots;
    for (let k = 0; k < TICKS_PER_BLOCK; k++) {
      const frame = frame0 + (k + 1) * K;
      const t = frame * inv;

      // Crossfade, slew and mute-ramp progress.
      let xf = 1;
      if (this.xfMode !== XF_NONE) {
        this.xfPos += K;
        const u = this.xfPos >= this.xfLen ? 1 : this.xfPos / this.xfLen;
        // Equal power: sin(π/2·u) fading in, cos(π/2·u) fading out (shared sine table).
        const pos = (this.xfMode === XF_IN ? u * 0.25 : u * 0.25 + 0.25) * SINE_TABLE_SIZE;
        const i0 = pos | 0;
        const a = SINE[i0];
        const sv = a + (SINE[i0 + 1] - a) * (pos - i0);
        if (this.xfMode === XF_IN) {
          xf = sv;
          if (u >= 1) this.xfMode = XF_NONE;
        } else {
          xf = u >= 1 ? 0 : st[S_XF_FROM] * sv;
          if (u >= 1) this.xfDone = true;
        }
      }
      let slewR = 0;
      if (this.slewLen > 0) {
        this.slewPos += K;
        const r = 1 - this.slewPos / this.slewLen;
        if (r <= 0) this.slewLen = 0;
        else slewR = r;
      }
      if (!d.mute && (!ctx.anySolo || d.solo)) {
        if (st[S_MUTE] < 1) st[S_MUTE] = Math.min(1, st[S_MUTE] + ctx.muteStep);
      } else if (this.fresh)
        st[S_MUTE] = 0; // silent anyway: start muted, no ramp
      else if (st[S_MUTE] > 0) st[S_MUTE] = Math.max(0, st[S_MUTE] - ctx.muteStep);

      const lw = this.lifeTick[k + 1];

      // Timbre timeline: crossfade from the previous entry's preset (slot A) to this one's (B).
      let ok = lw > 0 && xf > 0 && st[S_MUTE] > 0 && d.nSeg > 0 && d.nTimbre > 0;
      let slotA = -1;
      let slotB = -1;
      let x = 1;
      if (ok) {
        const T = d.timbres;
        let ti = this.timbreCur;
        while (ti + 1 < d.nTimbre && T[(ti + 1) * TIMBRE_STRIDE + TIMBRE_T] <= t) ti++;
        this.timbreCur = ti;
        slotB = d.timbreSlot[ti];
        slotA = ti > 0 ? d.timbreSlot[ti - 1] : slotB;
        const fade = T[ti * TIMBRE_STRIDE + TIMBRE_FADE];
        x = fade > 0 ? (t - T[ti * TIMBRE_STRIDE + TIMBRE_T]) / fade : 1;
        if (x > 1) x = 1;
        else if (x < 0) x = 0;
        if (slotB < 0 || (slotA < 0 && x < 1)) ok = false;
        else if (slotA < 0) slotA = slotB;
      }

      if (ok) {
        const A = slots[slotA];
        const B = slots[slotB];
        const xa = 1 - x;
        this.curSlot = slotB;

        // Table sources: each slot's current tables, plus its old ones during a replacement fade.
        if (this.fresh) {
          for (let r = 0; r < 4; r++) {
            this.roleTab[r] = null;
            this.roleSame[r] = null;
            this.roleG0[r] = 0;
          }
        }
        const G1 = this.roleG1;
        const G0 = this.roleG0;
        const claim = this.roleClaim;
        const R = this.roleTab;
        G1.fill(0);
        claim.fill(0);
        const renderFrame = ctx.renderFrame0 + (k + 1) * K;
        for (let src = 0; src < 4; src++) {
          const slot = src < 2 ? B : A;
          if (src >= 2 && A === B) break;
          const weight = A === B ? 1 : src < 2 ? x : xa;
          let sw = 1;
          if (slot.fadeLen > 0) {
            const u = (renderFrame - slot.fadeStart) / slot.fadeLen;
            sw = u >= 1 ? 1 : u <= 0 ? 0 : u;
          }
          const useNew = (src & 1) === 0;
          const tab = useNew ? slot.data : sw < 1 ? slot.prevData : null;
          const g = weight * (useNew ? sw : 1 - sw);
          if (tab === null || !(g > 0)) continue;
          let role = -1;
          for (let r = 0; r < 4 && role < 0; r++) if (R[r] === tab) role = r;
          if (role >= 0) G1[role] += g;
          else {
            let bestG = Infinity;
            for (let r = 0; r < 4; r++) {
              if (claim[r] === 0 && G0[r] < bestG) {
                role = r;
                bestG = G0[r];
              }
            }
            if (role < 0) continue;
            R[role] = tab;
            this.roleSame[role] = useNew ? slot.same : slot.prevSame;
            this.roleMpo[role] = useNew ? slot.mipsPerOctave : slot.prevMipsPerOctave;
            G0[role] = 0;
            G1[role] = g;
          }
          claim[role] = 1;
        }
        ok = G1[0] > 0 || G1[1] > 0 || G1[2] > 0 || G1[3] > 0;

        if (ok) {
          // Pitch and motion from the shared segment code (P1).
          const s = d.segs;
          let si = this.segCur;
          while (si + 1 < d.nSeg && s[(si + 1) * SEG_STRIDE + SEG_T0] <= t) si++;
          this.segCur = si;
          const so = si * SEG_STRIDE;
          const glide = d.segGlide[si] === 1;
          let p = s[so + SEG_P0];
          let motion = 0;
          if (glide) {
            // The raw leaf functions, called directly with the record's fields: the same code
            // evalFlatSegment / evalFlatSegmentMotion run, without their wrapper frames.
            const t0 = s[so + SEG_T0];
            const t1 = s[so + SEG_T1];
            const m0 = s[so + SEG_M0];
            const ct1 = s[so + SEG_CURVE_T1];
            const cp1 = s[so + SEG_CURVE_P1];
            p = segmentPitch(
              t0,
              t1,
              p,
              s[so + SEG_P1],
              s[so + SEG_EASE] as EaseCode,
              s[so + SEG_BX1],
              s[so + SEG_BY1],
              s[so + SEG_BX2],
              s[so + SEG_BY2],
              m0,
              t,
              ct1,
              cp1,
            );
            motion = segmentMotion(t0, t1, s[so + SEG_P0], m0, t, ct1, cp1);
          }

          // Vibrato: only while holding, after its onset delay.
          const vibDepth = A.vibDepthCents * xa + B.vibDepthCents * x;
          let vibTarget = 0;
          if (!glide && vibDepth > 0) {
            const vibDelay = A.vibDelay * xa + B.vibDelay * x;
            const u = (t - d.holdStart[si] - vibDelay) / VIBRATO_RAMP;
            vibTarget = u <= 0 ? 0 : u >= 1 ? 1 : u;
          }
          if (this.fresh) {
            st[S_MOTION] = motion;
            st[S_VIB] = vibTarget;
          } else {
            st[S_MOTION] += (motion - st[S_MOTION]) * ctx.motionCoeff;
            st[S_VIB] += (vibTarget - st[S_VIB]) * ctx.vibratoCoeff;
          }
          // Drift and vibrato jitter: slow seeded noise per voice (see noiseTick).
          let vibRate = A.vibRate * xa + B.vibRate * x;
          let vibDepthNow = vibDepth;
          let driftCents = 0;
          let driftGain = 1;
          const jitter = A.vibJitter * xa + B.vibJitter * x;
          const driftDepth = A.driftCents * xa + B.driftCents * x;
          const driftAmp = A.driftAmp * xa + B.driftAmp * x;
          if (jitter > 0 || driftDepth > 0 || driftAmp > 0) {
            const dr = A.driftRate * xa + B.driftRate * x;
            st[S_NOISE_RATE] = dr > 0 ? dr : DEFAULT_WANDER_RATE;
            this.noiseTick(frame, this.fresh);
            driftCents = driftDepth * (0.75 * st[S_NOISE_0] + 0.35 * st[S_NOISE_0 + 1]);
            driftGain = 1 + driftAmp * st[S_NOISE_0 + 4];
            vibRate *=
              1 + jitter * (VJ_RATE_SPREAD * st[S_VJ_RATE_U] + VJ_RATE_WOBBLE * st[S_NOISE_0 + 2]);
            const df =
              1 +
              jitter * (VJ_DEPTH_SPREAD * st[S_VJ_DEPTH_U] + VJ_DEPTH_WOBBLE * st[S_NOISE_0 + 3]);
            vibDepthNow *= df > 0 ? df : 0;
          }

          let vibCents = 0;
          if (st[S_VIB] > 1e-6) {
            let lfo = st[S_LFO] + vibRate * ctx.tickSeconds;
            lfo -= Math.floor(lfo);
            st[S_LFO] = lfo;
            const pos = lfo * SINE_TABLE_SIZE;
            const i0 = pos | 0;
            const a = SINE[i0];
            vibCents = vibDepthNow * st[S_VIB] * (a + (SINE[i0 + 1] - a) * (pos - i0));
          }

          // Articulation: attack from the decaying envelope, then exponential decay to 1 %.
          let artic = 1;
          const amount = A.artAmount * xa + B.artAmount * x;
          if (amount > 0) {
            const attack = A.artAttack * xa + B.artAttack * x;
            const decay = A.artDecay * xa + B.artDecay * x;
            const ta = t - d.arrive[si];
            let env = 0;
            if (ta >= 0) {
              if (ta < attack) {
                const pa = d.prevArrive[si];
                let e0 = 0;
                if (pa === pa) {
                  const tp = d.arrive[si] - pa;
                  e0 =
                    tp < attack
                      ? tp / attack
                      : Math.exp((-(tp - attack) * ARTICULATION_DECAY) / decay);
                }
                env = e0 + ((1 - e0) * ta) / attack;
              } else env = Math.exp((-(ta - attack) * ARTICULATION_DECAY) / decay);
            }
            artic = 1 - amount + amount * env;
          }

          // Level timeline.
          const Lv = d.levels;
          let li = this.levelCur;
          while (li + 1 < d.nLevel && Lv[(li + 1) * LEVEL_STRIDE + LEVEL_T] <= t) li++;
          this.levelCur = li;
          let level = 1;
          if (li >= 0) {
            const lo = li * LEVEL_STRIDE;
            const start = d.levelStart[li];
            const over = Lv[lo + LEVEL_OVER];
            const u = over > 0 ? (t - Lv[lo + LEVEL_T]) / over : 1;
            level = u >= 1 ? Lv[lo + LEVEL_GAIN] : start + (Lv[lo + LEVEL_GAIN] - start) * u;
          }

          // Swap slew: blend from the frozen pre-swap pitch.
          const sp = st[S_SLEW_PITCH];
          if (slewR > 0 && sp === sp) p += (sp - p) * slewR;
          st[S_PITCH] = p;

          // Frequency and mip position: log2 f is linear in pitch, so no logarithm is needed.
          const spread = A.detuneSpread * xa + B.detuneSpread * x;
          const mag = st[S_DET_MAG] + spread * st[S_DET_U];
          const detune = st[S_DET_SIGN] * (mag > DETUNE_FLOOR ? mag : DETUNE_FLOOR);
          const oct = ctx.refOct + (p - 69) / 12 + (detune + vibCents + driftCents) / 1200;
          if (oct === oct && oct < 40 && oct > -40) {
            let inc = MIP_BASE_HZ * Math.exp(oct * LN2) * ctx.invSampleRate;
            if (inc > 0.5) inc = 0.5;
            st[S_CUR_INC] = inc;
            // Mip index and crossfade weight per role (formant timbres use finer mips).
            for (let r = 0; r < 4; r++) {
              const mpo = this.roleMpo[r];
              const mpos = oct * mpo;
              let m = Math.floor(mpos);
              let w = mpos - m;
              const last = (MIP_COUNT - 1) * mpo; // index of the top mip
              if (m < 0) {
                m = 0;
                w = 0;
              } else if (m >= last) {
                m = last - 1;
                w = 1;
              }
              this.roleMip[r] = m;
              this.roleW[r] = w;
            }

            // Amplitude (§8.4).
            const gn = this.isGhost ? st[S_GN_FROZEN] : ctx.gn[k + 1];
            const accent = A.accent * xa + B.accent * x;
            const loud = Math.exp(-(p - LOUDNESS_PITCH) * LOUDNESS_SLOPE);
            let amp =
              VOICE_BASE_GAIN *
              d.gain *
              lw *
              level *
              driftGain *
              (1 + accent * st[S_MOTION]) *
              artic *
              loud *
              gn *
              st[S_MUTE] *
              xf;
            if (slewR > 0) amp += (st[S_SLEW_AMP] - amp) * slewR;
            st[S_CUR_AMP] = amp > 0 ? amp : 0;

            // Equal-power pan: fixed, by pool index, or by pitch.
            let pan = d.pan;
            if (pan !== pan) {
              if (ctx.panByPitch) {
                pan = (p - 60) * PAN_PITCH_SLOPE;
                if (pan > PAN_PITCH_MAX) pan = PAN_PITCH_MAX;
                else if (pan < -PAN_PITCH_MAX) pan = -PAN_PITCH_MAX;
              } else pan = st[S_PAN_INDEX];
            }
            if (pan > 1) pan = 1;
            else if (pan < -1) pan = -1;
            const ppos = (pan + 1) * 0.125 * SINE_TABLE_SIZE; // θ/2π with θ = (pan + 1)·π/4
            const pi0 = ppos | 0;
            const pfr = ppos - pi0;
            const sa = SINE[pi0];
            st[S_CUR_GR] = sa + (SINE[pi0 + 1] - sa) * pfr;
            const cpos = ppos + SINE_TABLE_SIZE / 4;
            const ci0 = cpos | 0;
            const ca = SINE[ci0];
            st[S_CUR_GL] = ca + (SINE[ci0 + 1] - ca) * (cpos - ci0);
            st[S_SEND_REV] = d.sendReverb === d.sendReverb ? d.sendReverb : ctx.sendReverb;
            st[S_SEND_DLY] = d.sendDelay === d.sendDelay ? d.sendDelay : ctx.sendDelay;

            if (this.fresh || st[S_PREV_AMP] === 0) {
              st[S_PREV_INC] = st[S_CUR_INC];
              st[S_PREV_GL] = st[S_CUR_GL];
              st[S_PREV_GR] = st[S_CUR_GR];
              if (this.fresh) G0.set(G1);
              this.fresh = false;
            }
          } else ok = false;
        }
      }

      if (!ok) {
        st[S_CUR_AMP] = 0;
        this.roleG1.fill(0);
        this.fresh = true;
      }
      if (st[S_PREV_AMP] !== 0 || st[S_CUR_AMP] !== 0) this.synth(ctx, k * K);
      st[S_PREV_AMP] = st[S_CUR_AMP];
      st[S_PREV_INC] = st[S_CUR_INC];
      st[S_PREV_GL] = st[S_CUR_GL];
      st[S_PREV_GR] = st[S_CUR_GR];
      this.roleG0.set(this.roleG1);
    }
  }

  /**
   * Advances the drift noise phase to piece frame `frame` (re-derived from the piece time when
   * `fresh`, so a seek lands where playing through would) and evaluates the five noise streams into
   * st[S_NOISE_0 + j]. Integer and boolean arguments only (no boxing); allocation-free.
   */
  private noiseTick(frame: number, fresh: boolean): void {
    const st = this.st;
    const rate = st[S_NOISE_RATE];
    if (fresh) st[S_NOISE_PH] = frame * this.invRate * rate;
    else st[S_NOISE_PH] += rate * CONTROL_PERIOD * this.invRate;
    const ph = st[S_NOISE_PH];
    const kn = this.knots;
    const mask = DRIFT_KNOTS - 1;
    for (let j = 0; j < 5; j++) {
      const y = ph * NOISE_SCALE[j] + NOISE_OFFSET[j];
      const fi = Math.floor(y);
      const f = y - fi;
      const i = fi | 0;
      const p0 = kn[(i - 1) & mask];
      const p1 = kn[i & mask];
      const p2 = kn[(i + 1) & mask];
      const p3 = kn[(i + 2) & mask];
      // Catmull-Rom through the knots: smooth (C¹) and passes through every knot.
      st[S_NOISE_0 + j] =
        p1 +
        0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
    }
  }

  /** Synthesises one control period at buffer offset `off`. */
  private synth(ctx: VoiceContext, off: number): void {
    const K = CONTROL_PERIOD;
    const invK = 1 / K;
    const st = this.st;
    const G0 = this.roleG0;
    const G1 = this.roleG1;
    let active = 0;
    let r0 = -1;
    for (let r = 0; r < 4; r++) {
      if (G0[r] > 0 || G1[r] > 0) {
        active++;
        r0 = r;
      }
    }
    if (active === 0) return;

    let inc = st[S_PREV_INC];
    const dInc = (st[S_CUR_INC] - inc) * invK;
    let gL = st[S_PREV_GL];
    const dgL = (st[S_CUR_GL] - gL) * invK;
    let gR = st[S_PREV_GR];
    const dgR = (st[S_CUR_GR] - gR) * invK;
    const sR = st[S_SEND_REV];
    const sD = st[S_SEND_DLY];
    const dryL = ctx.dryL;
    const dryR = ctx.dryR;
    const revIn = ctx.revIn;
    const dlyIn = ctx.dlyIn;
    const N = WAVETABLE_SIZE;
    let phase = st[S_PHASE];
    const end = off + K;

    if (active === 1) {
      const tab = this.roleTab[r0] as Float32Array;
      let amp = st[S_PREV_AMP] * G0[r0];
      const dAmp = (st[S_CUR_AMP] * G1[r0] - amp) * invK;
      const same = this.roleSame[r0];
      const mip = this.roleMip[r0];
      const lo = mip * WAVETABLE_STRIDE;
      const hi = lo + WAVETABLE_STRIDE;
      const w = this.roleW[r0];
      if (w === 0 || w === 1 || (same !== null && same[mip] === 1)) {
        const base = w === 1 ? hi : lo;
        for (let i = off; i < end; i++) {
          phase += inc;
          if (phase >= 1) phase -= 1;
          inc += dInc;
          const pos = phase * N;
          const ix = pos | 0;
          const j = base + ix;
          const a = tab[j];
          const y = (a + (tab[j + 1] - a) * (pos - ix)) * amp;
          amp += dAmp;
          dryL[i] += y * gL;
          dryR[i] += y * gR;
          gL += dgL;
          gR += dgR;
          revIn[i] += y * sR;
          dlyIn[i] += y * sD;
        }
      } else {
        for (let i = off; i < end; i++) {
          phase += inc;
          if (phase >= 1) phase -= 1;
          inc += dInc;
          const pos = phase * N;
          const ix = pos | 0;
          const fr = pos - ix;
          const j0 = lo + ix;
          const a0 = tab[j0];
          const s0 = a0 + (tab[j0 + 1] - a0) * fr;
          const j1 = hi + ix;
          const a1 = tab[j1];
          const s1 = a1 + (tab[j1 + 1] - a1) * fr;
          const y = (s0 + (s1 - s0) * w) * amp;
          amp += dAmp;
          dryL[i] += y * gL;
          dryR[i] += y * gR;
          gL += dgL;
          gR += dgR;
          revIn[i] += y * sR;
          dlyIn[i] += y * sD;
        }
      }
    } else {
      const ph = ctx.phaseBuf;
      const mb = ctx.mixBuf;
      for (let i = 0; i < K; i++) {
        phase += inc;
        if (phase >= 1) phase -= 1;
        inc += dInc;
        ph[i] = phase * N;
        mb[i] = 0;
      }
      for (let r = 0; r < 4; r++) {
        const g0 = G0[r];
        const g1 = G1[r];
        if (g0 === 0 && g1 === 0) continue;
        const tab = this.roleTab[r] as Float32Array;
        const lo = this.roleMip[r] * WAVETABLE_STRIDE;
        const hi = lo + WAVETABLE_STRIDE;
        const w = this.roleW[r];
        let g = g0;
        const dg = (g1 - g0) * invK;
        for (let i = 0; i < K; i++) {
          const pos = ph[i];
          const ix = pos | 0;
          const fr = pos - ix;
          const j0 = lo + ix;
          const a0 = tab[j0];
          const s0 = a0 + (tab[j0 + 1] - a0) * fr;
          const j1 = hi + ix;
          const a1 = tab[j1];
          const s1 = a1 + (tab[j1 + 1] - a1) * fr;
          mb[i] += (s0 + (s1 - s0) * w) * g;
          g += dg;
        }
      }
      let amp = st[S_PREV_AMP];
      const dAmp = (st[S_CUR_AMP] - amp) * invK;
      for (let i = 0; i < K; i++) {
        const y = mb[i] * amp;
        amp += dAmp;
        const o = off + i;
        dryL[o] += y * gL;
        dryR[o] += y * gR;
        gL += dgL;
        gR += dgR;
        revIn[o] += y * sR;
        dlyIn[o] += y * sD;
      }
    }
    st[S_PHASE] = phase;
  }
}
