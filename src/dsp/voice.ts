/**
 * One voice of the DSP graph (PLAN.md §8.4): pitch from flat segment records, always-on detune,
 * vibrato after arrival, band-limited wavetable oscillator with mip crossfade, articulation,
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
  SEG_CURVE_P1,
  SEG_M0,
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
  evalFlatSegmentMotion,
} from '../core/segment';
import type { FlatVoice } from '../core/flat';
import {
  BLOCK_FRAMES,
  CONTROL_PERIOD,
  MIN_LIFE_FADE,
  MUTE_RAMP,
  VOICE_BASE_GAIN,
} from './constants';
import { hash2, unit } from './rng';
import { cos2pi, sin2pi } from './sine';
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
 * One voice's score data plus everything precomputed from it. Built on the main thread side of a
 * message handler (it allocates); assigning it to a voice is a reference copy.
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
        s[o + SEG_P0] !== s[o + SEG_CURVE_P1] || s[o + SEG_M0] !== 0 || !(s[o + SEG_T1] > s[o + SEG_T0]);
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

  /** Life weight 0..1 at t (pure; smootherstep fades, at least MIN_LIFE_FADE long). */
  lifeAt(t: number): number {
    const li = lastAtOrBefore(this.lives, this.nLife, LIFE_STRIDE, LIFE_BORN, t);
    return li < 0 ? 0 : lifeWeight(this.lives, li * LIFE_STRIDE, t);
  }

  /** Pitch at t (pure); NaN when the voice has no segments. */
  pitchAt(t: number): number {
    if (this.nSeg === 0) return NaN;
    const si = Math.max(0, lastAtOrBefore(this.segs, this.nSeg, SEG_STRIDE, SEG_T0, t));
    return evalFlatSegment(this.segs, si * SEG_STRIDE, t);
  }

  /** Timbre slot at t (the crossfade target if one is running); −1 if none. */
  slotAt(t: number): number {
    if (this.nTimbre === 0) return -1;
    const i = Math.max(0, lastAtOrBefore(this.timbres, this.nTimbre, TIMBRE_STRIDE, TIMBRE_T, t));
    return this.timbreSlot[i];
  }
}

/** Shared empty data for voices beyond the pool size. */
export const EMPTY_VOICE_DATA = new VoiceData();

function lifeWeight(L: Float64Array, o: number, t: number): number {
  const born = L[o + LIFE_BORN];
  const died = L[o + LIFE_DIED];
  if (t >= died || t < born) return 0;
  let w = 1;
  const fin = L[o + LIFE_FADE_IN] > MIN_LIFE_FADE ? L[o + LIFE_FADE_IN] : MIN_LIFE_FADE;
  const u = (t - born) / fin;
  if (u < 1) w = smootherstep(u);
  const fout = L[o + LIFE_FADE_OUT] > MIN_LIFE_FADE ? L[o + LIFE_FADE_OUT] : MIN_LIFE_FADE;
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
  readonly sampleRate: number;
  readonly invSampleRate: number;
  /** Seconds per control tick. */
  readonly tickSeconds: number;
  /** Per-tick smoothing coefficients. */
  readonly motionCoeff: number;
  readonly vibratoCoeff: number;
  /** Mute gain change per tick. */
  readonly muteStep: number;
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

/** One synthesis voice (or ghost). */
export class Voice {
  /** Pool index (stems select by it). */
  index = -1;
  data: VoiceData = EMPTY_VOICE_DATA;

  /** Main voice: rendering enabled. Ghost: in use. */
  enabled = false;
  /** Ghosts only: piece frame of the ghost's own timeline at the block start. */
  frame = 0;
  /** Ghosts only: g_n frozen at spawn. */
  gnFrozen = -1;

  // Identity-derived constants.
  private detSign = 1;
  private detMag = 2;
  private detSpreadU = 0;
  private panIndex = 0;

  // Cursors (monotonic between jumps).
  private segCur = 0;
  private lifeCur = -1;
  private levelCur = -1;
  private timbreCur = 0;

  // Oscillator and smoother state.
  private phase = 0;
  private lfoPhase = 0;
  private motionSm = 0;
  private vibSm = 0;
  private muteGain = 1;
  /** Re-initialise smoothers and interpolation at the next tick. */
  private fresh = true;

  // Control values: previous tick (start of the sub-block) and current tick (end).
  prevAmp = 0;
  private curAmp = 0;
  private prevInc = 0;
  private curInc = 0;
  private prevGL = Math.SQRT1_2;
  private curGL = Math.SQRT1_2;
  private prevGR = Math.SQRT1_2;
  private curGR = Math.SQRT1_2;
  /** Pitch (with slew) at the last tick. */
  curPitch = NaN;
  /** Slot of the timbre crossfade target at the last tick. */
  curSlot = -1;
  private curMip = 0;
  private curW = 0;
  private curSendRev = 0;
  private curSendDly = 0;

  // Up to four tables at once (timbre crossfade × slot replacement), matched by identity.
  private readonly roleTab: (Float32Array | null)[] = [null, null, null, null];
  private readonly roleSame: (Uint8Array | null)[] = [null, null, null, null];
  private readonly roleG0 = new Float64Array(4);
  private readonly roleG1 = new Float64Array(4);
  private readonly roleClaim = new Uint8Array(4);

  // Crossfade (seek, loop, swap) and slew (swap).
  private xfMode = XF_NONE;
  private xfPos = 0;
  private xfLen = 1;
  private xfFrom = 1;
  /** A fade-out finished: the ghost can be released. */
  xfDone = false;
  private slewPos = 0;
  private slewLen = 0;
  private slewPitch = 0;
  private slewAmp = 0;

  /** Sets pool identity: detune, start phase and auto-pan position (§8.4). */
  setIdentity(index: number, hash: number, seed: number, poolSize: number): void {
    this.index = index;
    this.detSign = index % 2 === 1 ? 1 : -1;
    this.detMag = DETUNE_MIN + DETUNE_RANGE * unit(hash2(hash, SALT_DETUNE));
    this.detSpreadU = unit(hash2(hash, SALT_SPREAD));
    this.phase = unit(hash2(hash, seed));
    this.lfoPhase = unit(hash2(hash, (seed ^ SALT_LFO) >>> 0));
    this.panIndex =
      (index % 2 === 1 ? 1 : -1) * (0.12 + (0.5 * index) / Math.max(1, poolSize - 1));
  }

  /** Detune in cents for a given timbre spread (§8.4: alternating sign, never below 1 cent). */
  detuneCents(spread: number): number {
    const m = this.detMag + spread * this.detSpreadU;
    return this.detSign * (m > DETUNE_FLOOR ? m : DETUNE_FLOOR);
  }

  /** Start phase in cycles (for tests). */
  get startPhase(): number {
    return this.phase;
  }

  /** Repositions every cursor at piece time t. `fresh` re-initialises smoothers. */
  jump(t: number, fresh: boolean): void {
    const d = this.data;
    this.segCur = Math.max(0, lastAtOrBefore(d.segs, d.nSeg, SEG_STRIDE, SEG_T0, t));
    this.lifeCur = lastAtOrBefore(d.lives, d.nLife, LIFE_STRIDE, LIFE_BORN, t);
    this.levelCur = lastAtOrBefore(d.levels, d.nLevel, LEVEL_STRIDE, LEVEL_T, t);
    this.timbreCur = Math.max(0, lastAtOrBefore(d.timbres, d.nTimbre, TIMBRE_STRIDE, TIMBRE_T, t));
    if (fresh) {
      this.fresh = true;
      this.prevAmp = 0;
      this.slewLen = 0;
    }
  }

  /** Starts an equal-power fade-in from silence over `frames`. */
  fadeIn(frames: number): void {
    this.xfMode = XF_IN;
    this.xfPos = 0;
    this.xfLen = Math.max(1, frames);
    this.xfFrom = 0;
    this.xfDone = false;
  }

  /** Starts an equal-power fade-out from the current crossfade gain over `frames`. */
  fadeOut(frames: number): void {
    const from = this.xfGain();
    this.xfMode = XF_OUT;
    this.xfPos = 0;
    this.xfLen = Math.max(1, frames);
    this.xfFrom = from;
    this.xfDone = from === 0;
  }

  /** Clears any crossfade (full gain). */
  clearFade(): void {
    this.xfMode = XF_NONE;
    this.xfDone = false;
  }

  /** Blends from a frozen pitch and amplitude to the live values over `frames` (swap slew). */
  slew(pitch: number, amp: number, frames: number): void {
    this.slewPitch = pitch;
    this.slewAmp = amp;
    this.slewPos = 0;
    this.slewLen = Math.max(1, frames);
  }

  /** Current crossfade gain (0..1). */
  xfGain(): number {
    if (this.xfMode === XF_NONE) return 1;
    const u = this.xfPos >= this.xfLen ? 1 : this.xfPos / this.xfLen;
    return this.xfMode === XF_IN ? sin2pi(u * 0.25) : this.xfFrom * cos2pi(u * 0.25);
  }

  /** Life weight at t, advancing the life cursor (monotonic in t between jumps). */
  lifeAt(t: number): number {
    const d = this.data;
    const L = d.lives;
    let li = this.lifeCur;
    while (li + 1 < d.nLife && L[(li + 1) * LIFE_STRIDE + LIFE_BORN] <= t) li++;
    this.lifeCur = li;
    return li < 0 ? 0 : lifeWeight(L, li * LIFE_STRIDE, t);
  }

  /** Copies the complete state of `v` (used to spawn a ghost). Allocation-free. */
  copyFrom(v: Voice): void {
    this.index = v.index;
    this.data = v.data;
    this.enabled = true;
    this.detSign = v.detSign;
    this.detMag = v.detMag;
    this.detSpreadU = v.detSpreadU;
    this.panIndex = v.panIndex;
    this.segCur = v.segCur;
    this.lifeCur = v.lifeCur;
    this.levelCur = v.levelCur;
    this.timbreCur = v.timbreCur;
    this.phase = v.phase;
    this.lfoPhase = v.lfoPhase;
    this.motionSm = v.motionSm;
    this.vibSm = v.vibSm;
    this.muteGain = v.muteGain;
    this.fresh = v.fresh;
    this.prevAmp = v.prevAmp;
    this.curAmp = v.curAmp;
    this.prevInc = v.prevInc;
    this.curInc = v.curInc;
    this.prevGL = v.prevGL;
    this.curGL = v.curGL;
    this.prevGR = v.prevGR;
    this.curGR = v.curGR;
    this.curPitch = v.curPitch;
    this.curSlot = v.curSlot;
    this.curMip = v.curMip;
    this.curW = v.curW;
    this.curSendRev = v.curSendRev;
    this.curSendDly = v.curSendDly;
    for (let r = 0; r < 4; r++) {
      this.roleTab[r] = v.roleTab[r];
      this.roleSame[r] = v.roleSame[r];
    }
    this.roleG0.set(v.roleG0);
    this.roleG1.set(v.roleG1);
    this.xfMode = v.xfMode;
    this.xfPos = v.xfPos;
    this.xfLen = v.xfLen;
    this.xfFrom = v.xfFrom;
    this.xfDone = v.xfDone;
    this.slewPos = v.slewPos;
    this.slewLen = v.slewLen;
    this.slewPitch = v.slewPitch;
    this.slewAmp = v.slewAmp;
    this.gnFrozen = v.gnFrozen;
  }

  /** Renders one block starting at piece frame `frame0` into the context's buses. */
  render(ctx: VoiceContext, frame0: number): void {
    const K = CONTROL_PERIOD;
    const inv = ctx.invSampleRate;
    for (let k = 0; k < TICKS_PER_BLOCK; k++) {
      const t = (frame0 + (k + 1) * K) * inv;
      const gn = this.gnFrozen >= 0 ? this.gnFrozen : ctx.gn[k + 1];
      this.tick(ctx, t, gn, ctx.renderFrame0 + (k + 1) * K);
      if (this.prevAmp !== 0 || this.curAmp !== 0) this.synth(ctx, k * K);
      this.prevAmp = this.curAmp;
      this.prevInc = this.curInc;
      this.prevGL = this.curGL;
      this.prevGR = this.curGR;
      this.roleG0.set(this.roleG1);
    }
  }

  /** Adds a table source for this tick, matching it to a role by identity. */
  private addSource(tab: Float32Array, same: Uint8Array | null, g: number): void {
    if (!(g > 0)) return;
    const R = this.roleTab;
    for (let r = 0; r < 4; r++) {
      if (R[r] === tab) {
        this.roleG1[r] += g;
        this.roleClaim[r] = 1;
        return;
      }
    }
    let best = -1;
    let bestG = Infinity;
    for (let r = 0; r < 4; r++) {
      if (this.roleClaim[r] === 0 && this.roleG0[r] < bestG) {
        best = r;
        bestG = this.roleG0[r];
      }
    }
    if (best < 0) return;
    R[best] = tab;
    this.roleSame[best] = same;
    this.roleG0[best] = 0;
    this.roleG1[best] = g;
    this.roleClaim[best] = 1;
  }

  private addSlot(slot: TimbreSlot, weight: number, renderFrame: number): void {
    if (!(weight > 0)) return;
    const w = slot.weight(renderFrame);
    if (slot.data !== null) this.addSource(slot.data, slot.same, weight * w);
    if (w < 1 && slot.prevData !== null) this.addSource(slot.prevData, slot.prevSame, weight * (1 - w));
  }

  /** Computes the control values at the end of a tick (piece time t). */
  private tick(ctx: VoiceContext, t: number, gn: number, renderFrame: number): void {
    const K = CONTROL_PERIOD;
    const d = this.data;

    // Crossfade and slew progress.
    let xf = 1;
    if (this.xfMode !== XF_NONE) {
      this.xfPos += K;
      xf = this.xfGain();
      if (this.xfPos >= this.xfLen) {
        if (this.xfMode === XF_IN) this.xfMode = XF_NONE;
        else this.xfDone = true;
      }
    }
    let slewR = 0;
    if (this.slewLen > 0) {
      this.slewPos += K;
      slewR = 1 - this.slewPos / this.slewLen;
      if (slewR <= 0) {
        slewR = 0;
        this.slewLen = 0;
      }
    }
    const audible = !d.mute && (!ctx.anySolo || d.solo);
    if (audible) {
      if (this.muteGain < 1) this.muteGain = Math.min(1, this.muteGain + ctx.muteStep);
    } else if (this.muteGain > 0) this.muteGain = Math.max(0, this.muteGain - ctx.muteStep);

    const lw = this.lifeAt(t);
    if (!(lw > 0) || xf === 0 || this.muteGain === 0 || d.nSeg === 0 || d.nTimbre === 0) {
      this.silence();
      return;
    }

    // Pitch and motion.
    const s = d.segs;
    let si = this.segCur;
    while (si + 1 < d.nSeg && s[(si + 1) * SEG_STRIDE + SEG_T0] <= t) si++;
    this.segCur = si;
    const so = si * SEG_STRIDE;
    const glide = d.segGlide[si] === 1;
    let p = glide ? evalFlatSegment(s, so, t) : s[so + SEG_P0];
    const motion = glide ? evalFlatSegmentMotion(s, so, t) : 0;

    // Timbre timeline: crossfade from the previous entry's preset (slot A) to this one's (B).
    const T = d.timbres;
    let ti = this.timbreCur;
    while (ti + 1 < d.nTimbre && T[(ti + 1) * TIMBRE_STRIDE + TIMBRE_T] <= t) ti++;
    this.timbreCur = ti;
    const slotB = d.timbreSlot[ti];
    const slotA = ti > 0 ? d.timbreSlot[ti - 1] : slotB;
    const fade = T[ti * TIMBRE_STRIDE + TIMBRE_FADE];
    let x = fade > 0 ? (t - T[ti * TIMBRE_STRIDE + TIMBRE_T]) / fade : 1;
    if (x > 1) x = 1;
    else if (x < 0) x = 0;
    if (slotB < 0 || (slotA < 0 && x < 1)) {
      this.silence();
      return;
    }
    const B = ctx.slots[slotB];
    const A = slotA >= 0 ? ctx.slots[slotA] : B;
    const xa = 1 - x;
    const spread = A.detuneSpread * xa + B.detuneSpread * x;
    const accent = A.accent * xa + B.accent * x;
    const artAmount = A.artAmount * xa + B.artAmount * x;
    const artAttack = A.artAttack * xa + B.artAttack * x;
    const artDecay = A.artDecay * xa + B.artDecay * x;
    const vibRate = A.vibRate * xa + B.vibRate * x;
    const vibDepth = A.vibDepthCents * xa + B.vibDepthCents * x;
    const vibDelay = A.vibDelay * xa + B.vibDelay * x;
    this.curSlot = slotB;

    if (this.fresh) {
      for (let r = 0; r < 4; r++) {
        this.roleTab[r] = null;
        this.roleSame[r] = null;
        this.roleG0[r] = 0;
      }
    }
    this.roleG1.fill(0);
    this.roleClaim.fill(0);
    if (A === B) this.addSlot(B, 1, renderFrame);
    else {
      this.addSlot(A, xa, renderFrame);
      this.addSlot(B, x, renderFrame);
    }

    // Vibrato: only while holding, after its onset delay.
    let vibTarget = 0;
    if (!glide && vibDepth > 0) {
      const u = (t - d.holdStart[si] - vibDelay) / VIBRATO_RAMP;
      vibTarget = u <= 0 ? 0 : u >= 1 ? 1 : u;
    }
    if (this.fresh) {
      this.motionSm = motion;
      this.vibSm = vibTarget;
    } else {
      this.motionSm += (motion - this.motionSm) * ctx.motionCoeff;
      this.vibSm += (vibTarget - this.vibSm) * ctx.vibratoCoeff;
    }
    let vibCents = 0;
    if (this.vibSm > 1e-6) {
      this.lfoPhase += vibRate * ctx.tickSeconds;
      if (this.lfoPhase >= 1) this.lfoPhase -= Math.floor(this.lfoPhase);
      vibCents = vibDepth * this.vibSm * sin2pi(this.lfoPhase);
    }

    // Articulation: attack from the decaying envelope, then exponential decay.
    let artic = 1;
    if (artAmount > 0) {
      const ta = t - d.arrive[si];
      let env = 0;
      if (ta >= 0) {
        if (ta < artAttack) {
          const pa = d.prevArrive[si];
          let e0 = 0;
          if (pa === pa) {
            const tp = d.arrive[si] - pa;
            e0 = tp < artAttack ? tp / artAttack : Math.exp((-(tp - artAttack) * ARTICULATION_DECAY) / artDecay);
          }
          env = e0 + ((1 - e0) * ta) / artAttack;
        } else env = Math.exp((-(ta - artAttack) * ARTICULATION_DECAY) / artDecay);
      }
      artic = 1 - artAmount + artAmount * env;
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

    // Swap slew: blend from the frozen pre-swap values.
    if (slewR > 0) p += (this.slewPitch - p) * slewR;
    this.curPitch = p;

    // Frequency and mip position (log2 f is linear in pitch, so no log is needed).
    const oct =
      ctx.refOct + (p - 69) / 12 + (this.detuneCents(spread) + vibCents) / 1200;
    if (!(oct === oct) || oct > 40 || oct < -40) {
      this.silence();
      return;
    }
    let inc = MIP_BASE_HZ * Math.exp(oct * LN2) * ctx.invSampleRate;
    if (inc > 0.5) inc = 0.5;
    this.curInc = inc;
    let m = Math.floor(oct);
    let w = oct - m;
    if (m < 0) {
      m = 0;
      w = 0;
    } else if (m >= MIP_COUNT - 1) {
      m = MIP_COUNT - 2;
      w = 1;
    }
    this.curMip = m;
    this.curW = w;

    // Amplitude (§8.4) and pan.
    const loud = Math.exp(-(p - LOUDNESS_PITCH) * LOUDNESS_SLOPE);
    let amp =
      VOICE_BASE_GAIN *
      d.gain *
      lw *
      level *
      (1 + accent * this.motionSm) *
      artic *
      loud *
      gn *
      this.muteGain *
      xf;
    if (slewR > 0) amp += (this.slewAmp - amp) * slewR;
    this.curAmp = amp > 0 ? amp : 0;

    let pan = d.pan;
    if (pan !== pan) {
      if (ctx.panByPitch) {
        pan = (p - 60) * PAN_PITCH_SLOPE;
        if (pan > PAN_PITCH_MAX) pan = PAN_PITCH_MAX;
        else if (pan < -PAN_PITCH_MAX) pan = -PAN_PITCH_MAX;
      } else pan = this.panIndex;
    }
    if (pan > 1) pan = 1;
    else if (pan < -1) pan = -1;
    const th = (pan + 1) * 0.125;
    this.curGL = cos2pi(th);
    this.curGR = sin2pi(th);
    this.curSendRev = d.sendReverb === d.sendReverb ? d.sendReverb : ctx.sendReverb;
    this.curSendDly = d.sendDelay === d.sendDelay ? d.sendDelay : ctx.sendDelay;

    if (this.fresh || this.prevAmp === 0) {
      this.prevInc = this.curInc;
      this.prevGL = this.curGL;
      this.prevGR = this.curGR;
      if (this.fresh) this.roleG0.set(this.roleG1);
      this.fresh = false;
    }
  }

  /** Marks the tick silent; the next audible tick re-initialises smoothers. */
  private silence(): void {
    this.curAmp = 0;
    this.roleG1.fill(0);
    this.fresh = true;
  }

  /** Synthesises one control period at buffer offset `off`. */
  private synth(ctx: VoiceContext, off: number): void {
    const K = CONTROL_PERIOD;
    const invK = 1 / K;
    let active = 0;
    let r0 = -1;
    for (let r = 0; r < 4; r++) {
      if (this.roleG0[r] > 0 || this.roleG1[r] > 0) {
        active++;
        r0 = r;
      }
    }
    if (active === 0) return;

    let inc = this.prevInc;
    const dInc = (this.curInc - inc) * invK;
    let gL = this.prevGL;
    const dgL = (this.curGL - gL) * invK;
    let gR = this.prevGR;
    const dgR = (this.curGR - gR) * invK;
    const sR = this.curSendRev;
    const sD = this.curSendDly;
    const dryL = ctx.dryL;
    const dryR = ctx.dryR;
    const revIn = ctx.revIn;
    const dlyIn = ctx.dlyIn;
    const N = WAVETABLE_SIZE;
    const lo = this.curMip * WAVETABLE_STRIDE;
    const hi = lo + WAVETABLE_STRIDE;
    const w = this.curW;
    let phase = this.phase;
    const end = off + K;

    if (active === 1) {
      const tab = this.roleTab[r0] as Float32Array;
      let amp = this.prevAmp * this.roleG0[r0];
      const dAmp = (this.curAmp * this.roleG1[r0] - amp) * invK;
      const same = this.roleSame[r0];
      if (w === 0 || w === 1 || (same !== null && same[this.curMip] === 1)) {
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
        const g0 = this.roleG0[r];
        const g1 = this.roleG1[r];
        if (g0 === 0 && g1 === 0) continue;
        const tab = this.roleTab[r] as Float32Array;
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
      let amp = this.prevAmp;
      const dAmp = (this.curAmp - amp) * invK;
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
    this.phase = phase;
  }
}
