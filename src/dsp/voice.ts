/**
 * One voice of the DSP graph (PLAN.md §8.4): pitch from flat segment records, always-on detune,
 * vibrato after arrival (optionally jittered), seeded slow drift of pitch and amplitude,
 * band-limited wavetable oscillator with mip crossfade, articulation,
 * motion accent, loudness tilt, life fades, level ramps, equal-power pan and FX sends.
 *
 * Unison lock (docs/build-log.md, "Unison lock"): the graph groups voices whose pitches meet, once
 * per block, and hands each voice its lock amount λ, a pitch correction toward the group, a phase
 * and vibrato-phase pull, a group gain h and (for a voice starting from silence) a phase to start
 * at. Within a group every voice moves to the group's mean pitch (detune and drift included) and
 * level drift and vibrato jitter fade out by λ, so the group sums to one steady tone; h keeps that
 * tone at the level of the same voices spread into a chord. A glide that arrives at or leaves a
 * unison is warped near the unison pitch (`warpOffset`), so the voices meet early and part late
 * instead of beating slowly on the way.
 *
 * Evaluation is at control rate: once per CONTROL_PERIOD frames the voice computes its frequency,
 * amplitude, pan and mip position, and the samples in between interpolate linearly (phase
 * increment, amplitude and pan gains). `render` never allocates (§8.11).
 *
 * The same class serves as a "ghost": a copy of a voice that keeps playing its old state while
 * fading out, so seek, loop wrap and hot-swap can crossfade instead of cutting (§8.7).
 */

import {
  WEIGHT_OVER,
  WEIGHT_STRIDE,
  WEIGHT_T,
  WEIGHT_W,
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
  COINCIDE_WINDOW,
  CONTROL_PERIOD,
  DSP_MAX_VOICES,
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
export const LOUDNESS_PITCH = 57;
export const LOUDNESS_SLOPE = LN2 / 48;
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
const KNOT_MASK = DRIFT_KNOTS - 1;
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
  /** Weight records (revision 8) and the weight in effect at the start of each ramp. */
  weights: Float64Array = EMPTY_F64;
  nWeight = 0;
  weightStart: Float64Array = EMPTY_F64;
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
  /**
   * Share of a soft strike at `arrive` and at `prevArrive` (1/√k for k coincident arrivals; see
   * `computeStrikeShares`). 1 until computed.
   */
  share: Float64Array = EMPTY_F64;
  prevShare: Float64Array = EMPTY_F64;
  /** Start of the hold containing segment i (NaN during glides), for vibrato onset. */
  holdStart: Float64Array = EMPTY_F64;
  /**
   * Unison warp of glide i (see `computeUnisonWarps`): the unison pitch it arrives at (In) or
   * leaves from (Out), NaN if none; the zone C in semitones; the partner voice's pool index.
   */
  warpInA: Float64Array = EMPTY_F64;
  warpInC: Float64Array = EMPTY_F64;
  warpInP: Int32Array = EMPTY_I32;
  warpOutA: Float64Array = EMPTY_F64;
  warpOutC: Float64Array = EMPTY_F64;
  warpOutP: Int32Array = EMPTY_I32;

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
    const ws = fv.weights ?? EMPTY_F64;
    d.weights = ws;
    d.nWeight = (ws.length / WEIGHT_STRIDE) | 0;
    d.weightStart = new Float64Array(d.nWeight);
    for (let i = 0; i < d.nWeight; i++) {
      if (i === 0) {
        d.weightStart[0] = 1;
        continue;
      }
      const o = (i - 1) * WEIGHT_STRIDE;
      const over = ws[o + WEIGHT_OVER];
      const u = over > 0 ? (ws[i * WEIGHT_STRIDE + WEIGHT_T] - ws[o + WEIGHT_T]) / over : 1;
      const start = d.weightStart[i - 1];
      d.weightStart[i] = start + (ws[o + WEIGHT_W] - start) * (u >= 1 ? 1 : u);
    }
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
    d.share = new Float64Array(n).fill(1);
    d.prevShare = new Float64Array(n).fill(1);
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

    d.warpInA = new Float64Array(n).fill(NaN);
    d.warpInC = new Float64Array(n);
    d.warpInP = new Int32Array(n).fill(-1);
    d.warpOutA = new Float64Array(n).fill(NaN);
    d.warpOutC = new Float64Array(n);
    d.warpOutP = new Int32Array(n).fill(-1);

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
   * so calling it from the audio thread boxes nothing once it is optimised.
   *
   * The life weight, evalFlatSegment and warpOffset are written out (same arithmetic; tests/dsp/
   * probe.test.ts): with their frames, TurboFan's 920-byte inlining budget could not also hold
   * segmentPitch, and each probe boxed segmentPitch's 13 arguments (docs/build-log.md, "No-GC
   * lock flake").
   */
  probe(frame: number, sampleRate: number): void {
    const t = frame / sampleRate;
    const L = this.lives;
    const li = lastAtOrBefore(L, this.nLife, LIFE_STRIDE, LIFE_BORN, t);
    let w = 0;
    if (li >= 0) {
      const o = li * LIFE_STRIDE;
      const born = L[o + LIFE_BORN];
      const died = L[o + LIFE_DIED];
      if (!(t >= died || t < born)) {
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
    this.probeLife = w;
    if (this.nSeg === 0) this.probePitch = NaN;
    else {
      const si = lastAtOrBefore(this.segs, this.nSeg, SEG_STRIDE, SEG_T0, t);
      const s = si < 0 ? 0 : si;
      const g = this.segs;
      const o = s * SEG_STRIDE;
      const p = segmentPitch(
        g[o + SEG_T0],
        g[o + SEG_T1],
        g[o + SEG_P0],
        g[o + SEG_P1],
        g[o + SEG_EASE] as EaseCode,
        g[o + SEG_BX1],
        g[o + SEG_BY1],
        g[o + SEG_BX2],
        g[o + SEG_BY2],
        g[o + SEG_M0],
        t,
        g[o + SEG_CURVE_T1],
        g[o + SEG_CURVE_P1],
      );
      // warpOffset(p, warpInA, warpInC) and warpOffset(p, warpOutA, warpOutC).
      let wIn = 0;
      let wOut = 0;
      for (let e = 0; e < 2; e++) {
        const a = e === 0 ? this.warpInA[s] : this.warpOutA[s];
        const c = e === 0 ? this.warpInC[s] : this.warpOutC[s];
        if (!(a === a)) continue;
        const x = p - a;
        const r = x < 0 ? -x : x;
        if (!(r < c)) continue;
        const r0 = c * WARP_CORE;
        let u = (r - r0) / (c - r0);
        if (u < 0) u = 0;
        const off = x * (u * u * (3 - 2 * u) - 1);
        if (e === 0) wIn = off;
        else wOut = off;
      }
      this.probePitch = p + wIn + wOut;
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

/**
 * Unison warp (docs/build-log.md, "Unison lock: steady approach and parting"). Two voices whose
 * pitches converge beat at their frequency difference, and a glide spends a long time in the
 * slow-beat zone because eases approach their target slowly. A glide that arrives at (or leaves)
 * a unison is therefore warped near the unison pitch A: at distance r = |p − A| it sounds at
 * A ± y(r), with y = r for r ≥ C, y = 0 for r ≤ WARP_CORE·C and y = r·smoothstep between. So the
 * voices meet (or stay together) while the score still has them up to WARP_CORE·C apart, and the
 * slow-beat zone passes 2–3× faster. C is the distance that beats at WARP_HZ against A, within
 * [WARP_MIN, WARP_MAX] semitones, and at most the glide's own span (half of it if both ends warp).
 */
const WARP_HZ = 12;
const WARP_MIN = 0.2;
const WARP_MAX = 1;
const WARP_CORE = 0.4;
/** A partner counts if it is within WARP_TOL semitones of A at the glide's end and WARP_DWELL s on. */
const WARP_TOL = 0.2;
const WARP_DWELL = 0.2;

/** The warp's pitch offset (semitones) at score pitch p, for anchor a (NaN = none) and zone c. */
export function warpOffset(p: number, a: number, c: number): number {
  if (!(a === a)) return 0;
  const x = p - a;
  const r = x < 0 ? -x : x;
  if (!(r < c)) return 0;
  const r0 = c * WARP_CORE;
  let u = (r - r0) / (c - r0);
  if (u < 0) u = 0;
  return x * (u * u * (3 - 2 * u) - 1);
}

/**
 * Arrival bloom: strikes that land together share one bloom (COINCIDE_WINDOW). For every arrival
 * of every voice, k = 1 + Σ over the other voices of w(Δt), w a raised cosine from 1 at Δt = 0 to
 * 0 at the window (each voice's nearest arrival), and the arrival's share is 1/√k: k coherent
 * strikes then add up like √k incoherent ones. Crisp timbres ignore it (Voice.render). Called
 * from a message handler (allocates).
 */
export function computeStrikeShares(data: VoiceData[]): void {
  const times: Float64Array[] = data.map((d) => {
    const out: number[] = [];
    for (let i = 0; i < d.nSeg; i++) {
      if (d.prevArrive[i] === d.prevArrive[i] && (i === 0 || d.arrive[i] !== d.arrive[i - 1])) {
        out.push(d.arrive[i]);
      }
    }
    return Float64Array.from(out);
  });
  const nearest = (ts: Float64Array, t: number): number => {
    let best = Infinity;
    for (let j = 0; j < ts.length; j++) best = Math.min(best, Math.abs(ts[j] - t));
    return best;
  };
  for (let v = 0; v < data.length; v++) {
    const d = data[v];
    for (let i = 0; i < d.nSeg; i++) {
      if (i > 0 && d.arrive[i] === d.arrive[i - 1]) {
        d.share[i] = d.share[i - 1];
        d.prevShare[i] = d.prevShare[i - 1];
        continue;
      }
      d.prevShare[i] = i > 0 ? d.share[i - 1] : 1;
      if (!(d.prevArrive[i] === d.prevArrive[i])) {
        d.share[i] = 1;
        continue;
      }
      let k = 1;
      for (let u = 0; u < data.length; u++) {
        if (u === v) continue;
        const dt = nearest(times[u], d.arrive[i]);
        if (dt < COINCIDE_WINDOW) k += 0.5 + 0.5 * Math.cos((Math.PI * dt) / COINCIDE_WINDOW);
      }
      d.share[i] = 1 / Math.sqrt(k);
    }
  }
}

/** Score pitch of `d` at time t, or NaN when it is not alive then. Allocates nothing; not hot. */
function pitchAt(d: VoiceData, t: number): number {
  const li = lastAtOrBefore(d.lives, d.nLife, LIFE_STRIDE, LIFE_BORN, t);
  if (li < 0 || !(t < d.lives[li * LIFE_STRIDE + LIFE_DIED]) || d.nSeg === 0) return NaN;
  const si = lastAtOrBefore(d.segs, d.nSeg, SEG_STRIDE, SEG_T0, t);
  return evalFlatSegment(d.segs, (si < 0 ? 0 : si) * SEG_STRIDE, t);
}

/** Whether some voice other than `self` stays within WARP_TOL of a over [t0, t1]; its index or −1. */
function unisonPartner(data: VoiceData[], self: number, a: number, t0: number, t1: number): number {
  for (let u = 0; u < data.length; u++) {
    if (u === self) continue;
    let ok = true;
    for (let k = 0; k <= 4 && ok; k++) {
      const p = pitchAt(data[u], t0 + ((t1 - t0) * k) / 4);
      ok = Math.abs(p - a) <= WARP_TOL;
    }
    if (ok) return u;
  }
  return -1;
}

/**
 * Finds every glide that arrives at a unison (another voice is at its end pitch from its end time
 * for WARP_DWELL seconds) or leaves one (another voice was at its start pitch for WARP_DWELL
 * seconds up to its start), and sets its warp. Only glides that start or end at rest qualify
 * (not interrupted ones), so the warped pitch stays smooth across segment boundaries. Called
 * from a message handler (allocates).
 */
export function computeUnisonWarps(data: VoiceData[], referenceHz: number): void {
  for (let v = 0; v < data.length; v++) {
    const d = data[v];
    const s = d.segs;
    for (let i = 0; i < d.nSeg; i++) {
      d.warpInA[i] = NaN;
      d.warpOutA[i] = NaN;
      if (d.segGlide[i] !== 1) continue;
      const o = i * SEG_STRIDE;
      const p0 = s[o + SEG_P0];
      const p1 = s[o + SEG_P1];
      const span = Math.abs(p1 - p0);
      if (!(span > WARP_TOL)) continue;
      const t0 = s[o + SEG_T0];
      const t1 = s[o + SEG_T1];
      if (s[o + SEG_CURVE_T1] === t1) {
        const u = unisonPartner(data, v, p1, t1, t1 + WARP_DWELL);
        if (u >= 0) {
          d.warpInA[i] = p1;
          d.warpInP[i] = u;
        }
      }
      if (s[o + SEG_M0] === 0) {
        const u = unisonPartner(data, v, p0, t0 - WARP_DWELL, t0);
        if (u >= 0) {
          d.warpOutA[i] = p0;
          d.warpOutP[i] = u;
        }
      }
      const both = d.warpInA[i] === d.warpInA[i] && d.warpOutA[i] === d.warpOutA[i];
      const limit = both ? span / 2 : span;
      d.warpInC[i] = Math.min(limit, warpZone(p1, referenceHz));
      d.warpOutC[i] = Math.min(limit, warpZone(p0, referenceHz));
    }
  }
}

/** Zone C (semitones) at MIDI pitch p: the distance that beats at WARP_HZ against it. */
function warpZone(p: number, referenceHz: number): number {
  const hz = referenceHz * Math.pow(2, (p - 69) / 12);
  const c = 12 * Math.log2(1 + WARP_HZ / hz);
  return Math.min(WARP_MAX, Math.max(WARP_MIN, c));
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

  /**
   * 1: the unison lock is on (always, in the app). 0 turns it off for every voice: only the tests'
   * no-lock reference uses it (revision 8 removed `wobble`, the per-timbre way to turn it off).
   */
  lockable = 1;

  // Unison lock, by pool index. Written by each main voice at the end of its block (g*In), read
  // by the graph's group pass, which writes the per-block controls (g*Out) the voices then read.
  /** 1 when the voice synthesised (was alive with tables) at its last tick. */
  readonly gOk = new Uint8Array(DSP_MAX_VOICES);
  /** Score pitch (after swap slew) in cents. */
  readonly gPitch = new Float64Array(DSP_MAX_VOICES);
  /** The voice's own modulated pitch in cents: pitch + detune + drift + vibrato. */
  readonly gMod = new Float64Array(DSP_MAX_VOICES);
  /** Raw amplitude: everything but g_n, h, mute, crossfades and slews. */
  readonly gAmp = new Float64Array(DSP_MAX_VOICES);
  /** Oscillator phase and vibrato LFO phase, in cycles. */
  readonly gPhase = new Float64Array(DSP_MAX_VOICES);
  readonly gLfo = new Float64Array(DSP_MAX_VOICES);
  /** Own phase increment per sample (before the lock pull). */
  readonly gInc = new Float64Array(DSP_MAX_VOICES);
  /** Accumulated phase pull θ (cycles, wrapped to [−0.5, 0.5)). */
  readonly gTheta = new Float64Array(DSP_MAX_VOICES);
  /** Lockability 0..1 (VoiceContext.lockable). */
  readonly gLock = new Float64Array(DSP_MAX_VOICES).fill(1);
  /** 1 while the voice is inside a unison warp zone (see warpOffset). */
  readonly gWarp = new Float64Array(DSP_MAX_VOICES);
  /** Lock amount λ (0..1) for this block. */
  readonly gLam = new Float64Array(DSP_MAX_VOICES);
  /** Pitch correction toward the group, cents. */
  readonly gCorr = new Float64Array(DSP_MAX_VOICES);
  /** Phase pull: added to the phase increment per sample. */
  readonly gDInc = new Float64Array(DSP_MAX_VOICES);
  /** Vibrato-phase pull: added to the vibrato rate, Hz. */
  readonly gDLfo = new Float64Array(DSP_MAX_VOICES);
  /** Group gain h at the block start and end. */
  readonly gH0 = new Float64Array(DSP_MAX_VOICES).fill(1);
  readonly gH1 = new Float64Array(DSP_MAX_VOICES).fill(1);
  /**
   * Start phase for a voice starting from silence (NaN = keep its own), the increment by which
   * it advances per frame of the block before the voice starts, and the vibrato phase.
   */
  readonly gSnapPh = new Float64Array(DSP_MAX_VOICES).fill(NaN);
  readonly gSnapInc = new Float64Array(DSP_MAX_VOICES);
  readonly gSnapLfo = new Float64Array(DSP_MAX_VOICES);

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
/** Unison lock controls for the current block (copied from the context; frozen in ghosts). */
const S_LAM = 33;
const S_CORR = 34;
const S_DINC = 35;
const S_DLFO = 36;
const S_H0 = 37;
const S_H1 = 38;
const S_SNAP_PH = 39;
const S_SNAP_INC = 40;
const S_SNAP_LFO = 41;
/** Values published to the group pass at the end of each block. */
const S_RAW_AMP = 42;
const S_OWN_INC = 43;
const S_MOD = 44;
const S_LOCKABLE = 45;
/**
 * Accumulated phase pull θ, in cycles: how far the group has moved this voice's phase from where it
 * would be on its own. Leaving a group unwinds it, so voices part with unrelated phases.
 */
const S_THETA = 46;
/** 1 while a unison warp zone is active (last tick), for the group pass's capture. */
const S_WARP = 47;
const STATE_SIZE = 48;

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
  /**
   * Power per tick for the sum normalisation: life weight × line weight (revision 8). lifeTick
   * already carries √weight, the line's amplitude factor.
   */
  readonly powTick = new Float64Array(TICKS_PER_BLOCK + 1);
  /** Persistent double state (see the S_* indices). */
  private readonly st = new Float64Array(STATE_SIZE);
  private readonly invRate: number = 0;

  /** Amplitude at the last control tick (before pan and the limiter); for tests. */
  get amplitude(): number {
    return this.st[S_CUR_AMP];
  }

  // Cursors (monotonic between jumps).
  private segCur = 0;
  private lifeCur = -1;
  private levelCur = -1;
  private weightCur = -1;
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
    st[S_H0] = st[S_H1] = 1;
    st[S_SNAP_PH] = NaN;
    st[S_LOCKABLE] = 1;
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

  /**
   * Detune in cents for a timbre's spread, before any unison lock fades it (§8.4: alternating
   * sign; never below 1 cent). Tests.
   */
  detuneCents(spread: number): number {
    const m = this.st[S_DET_MAG] + spread * this.st[S_DET_U];
    return this.st[S_DET_SIGN] * Math.max(m, DETUNE_FLOOR);
  }

  /** Unison lock amount λ (0..1) in effect for the last block (tests). */
  get lockAmount(): number {
    return this.st[S_LAM];
  }

  /** Whether the voice starts from scratch at its next tick (after a jump, or from silence). */
  get isFresh(): boolean {
    return this.fresh;
  }

  /** Publishes the current oscillator and vibrato phases to the group pass. */
  publishPhase(ctx: VoiceContext): void {
    ctx.gPhase[this.index] = this.st[S_PHASE];
    ctx.gLfo[this.index] = this.st[S_LFO];
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
    this.weightCur = lastAtOrBefore(d.weights, d.nWeight, WEIGHT_STRIDE, WEIGHT_T, t);
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
    // Line weight (revision 8): power of `lw` lines, so √lw in amplitude.
    let lw = 1;
    const W = d.weights;
    let wi = this.weightCur;
    while (wi + 1 < d.nWeight && W[(wi + 1) * WEIGHT_STRIDE + WEIGHT_T] <= t) wi++;
    this.weightCur = wi;
    if (wi >= 0) {
      const wo = wi * WEIGHT_STRIDE;
      const over = W[wo + WEIGHT_OVER];
      const u = over > 0 ? (t - W[wo + WEIGHT_T]) / over : 1;
      const start = d.weightStart[wi];
      lw = u >= 1 ? W[wo + WEIGHT_W] : start + (W[wo + WEIGHT_W] - start) * u;
      if (!(lw > 0)) lw = 0;
    }
    this.powTick[slot] = w * lw;
    this.lifeTick[slot] = lw === 1 ? w : w * Math.sqrt(lw);
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
    this.weightCur = v.weightCur;
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
  render(ctx: VoiceContext, frame0: number, audible: boolean): void {
    const K = CONTROL_PERIOD;
    const st = this.st;
    const d = this.data;
    const inv = this.invRate;
    const slots = ctx.slots;
    if (!this.isGhost) {
      // This block's unison-lock controls (see Graph.computeGroups). Ghosts keep the copies they
      // were spawned with, frozen.
      const gi = this.index;
      st[S_LAM] = ctx.gLam[gi];
      st[S_CORR] = ctx.gCorr[gi];
      st[S_DINC] = ctx.gDInc[gi];
      st[S_DLFO] = ctx.gDLfo[gi];
      st[S_H0] = ctx.gH0[gi];
      st[S_H1] = ctx.gH1[gi];
      st[S_SNAP_PH] = ctx.gSnapPh[gi];
      st[S_SNAP_INC] = ctx.gSnapInc[gi];
      st[S_SNAP_LFO] = ctx.gSnapLfo[gi];
    } else {
      st[S_H0] = st[S_H1];
      st[S_DINC] = 0;
      st[S_DLFO] = 0;
      st[S_SNAP_PH] = NaN;
    }
    const lam = st[S_LAM];
    const free = 1 - lam;
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
      st[S_WARP] = 0;

      // Timbre timeline: crossfade from the previous entry's preset (slot A) to this one's (B).
      // A muted voice keeps running silently, so it stays locked in its group and unmuting it
      // changes nothing but its own level.
      let ok = lw > 0 && xf > 0 && d.nSeg > 0 && d.nTimbre > 0;
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
            // Unison warp (see warpOffset; written out here, not called: render's inlining
            // budget). Faded by both voices' lockability (VoiceContext.lockable).
            const wia = d.warpInA[si];
            const woa = d.warpOutA[si];
            if (wia === wia || woa === woa) {
              let off = 0;
              for (let e = 0; e < 2; e++) {
                const a = e === 0 ? wia : woa;
                const c = e === 0 ? d.warpInC[si] : d.warpOutC[si];
                const xw = p - a;
                const r = xw < 0 ? -xw : xw;
                if (r < c) {
                  const r0 = c * WARP_CORE;
                  let u = (r - r0) / (c - r0);
                  if (u < 0) u = 0;
                  const lk = ctx.gLock[e === 0 ? d.warpInP[si] : d.warpOutP[si]];
                  off += xw * (u * u * (3 - 2 * u) - 1) * lk;
                  if (st[S_WARP] !== 1) st[S_WARP] = e === 0 ? 1 : 2;
                }
              }
              p += off * ctx.lockable;
            }
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
            // Starting from silence inside a group: take the group's phase (and vibrato phase),
            // advanced to this tick, so the lock holds from the first sample.
            const sp = st[S_SNAP_PH];
            if (sp === sp) {
              let ph = sp + st[S_SNAP_INC] * (k * K);
              ph -= Math.floor(ph);
              st[S_THETA] += ph - st[S_PHASE];
              st[S_PHASE] = ph;
              st[S_LFO] = st[S_SNAP_LFO];
            }
          } else {
            st[S_MOTION] += (motion - st[S_MOTION]) * ctx.motionCoeff;
            st[S_VIB] += (vibTarget - st[S_VIB]) * ctx.vibratoCoeff;
          }
          // Drift and vibrato jitter: slow seeded noise per voice.
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
            // The noise streams, written out here rather than as a method: render's TurboFan
            // inlining budget (920 bytecode bytes) cannot hold a noise method plus segmentPitch
            // and segmentMotion, and whichever is left out then boxes doubles at every call (a
            // scavenge every few seconds). Advance the noise phase to `frame` (re-derived from
            // the piece time when fresh, so a seek lands where playing through would) and
            // evaluate the five streams into st[S_NOISE_0 + j].
            const nRate = st[S_NOISE_RATE];
            if (this.fresh) st[S_NOISE_PH] = t * nRate;
            else st[S_NOISE_PH] += nRate * K * inv;
            const nPh = st[S_NOISE_PH];
            const kn = this.knots;
            for (let j = 0; j < 5; j++) {
              const y = nPh * NOISE_SCALE[j] + NOISE_OFFSET[j];
              const fi = Math.floor(y);
              const f = y - fi;
              const i = fi | 0;
              const p0 = kn[(i - 1) & KNOT_MASK];
              const p1 = kn[i & KNOT_MASK];
              const p2 = kn[(i + 1) & KNOT_MASK];
              const p3 = kn[(i + 2) & KNOT_MASK];
              // Catmull-Rom through the knots: smooth (C¹) and passes through every knot.
              st[S_NOISE_0 + j] =
                p1 +
                0.5 *
                  f *
                  (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
            }
            // Within a unison group (λ) level drift and vibrato jitter fade out, so the group stays
            // one steady tone (pitch drift and detune are averaged across the group instead).
            driftCents = driftDepth * (0.75 * st[S_NOISE_0] + 0.35 * st[S_NOISE_0 + 1]);
            driftGain = 1 + free * driftAmp * st[S_NOISE_0 + 4];
            const jf = jitter * free;
            vibRate *=
              1 + jf * (VJ_RATE_SPREAD * st[S_VJ_RATE_U] + VJ_RATE_WOBBLE * st[S_NOISE_0 + 2]);
            const df =
              1 + jf * (VJ_DEPTH_SPREAD * st[S_VJ_DEPTH_U] + VJ_DEPTH_WOBBLE * st[S_NOISE_0 + 3]);
            vibDepthNow *= df > 0 ? df : 0;
          }
          // The group pulls vibrato phases together, so a locked group keeps its full vibrato.
          vibRate = Math.max(0, vibRate + st[S_DLFO]);

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

          // Articulation (build log, "Arrival bloom"): a smootherstep attack from the still-decaying
          // envelope up to the strike's height h, then exponential decay to 1 %. The attack is at
          // least MIN_ARTICULATION_ATTACK, and BLOOM_ATTACK·√amount unless crisp (timbreParams). A
          // soft strike rises to its share of coincident arrivals, a crisp one always to 1. The
          // held level 1 − amount does not depend on h.
          let artic = 1;
          const amount = A.artAmount * xa + B.artAmount * x;
          if (amount > 0) {
            const attack = A.artAttack * xa + B.artAttack * x;
            const decay = A.artDecay * xa + B.artDecay * x;
            const crisp = A.artCrisp * xa + B.artCrisp * x;
            const ta = t - d.arrive[si];
            let env = 0;
            if (ta >= 0) {
              const sh = d.share[si];
              const h = sh + (1 - sh) * crisp;
              if (ta < attack) {
                const pa = d.prevArrive[si];
                let e0 = 0;
                if (pa === pa) {
                  const ps = d.prevShare[si];
                  const tp = d.arrive[si] - pa;
                  const v = tp / attack;
                  e0 =
                    (ps + (1 - ps) * crisp) *
                    (v < 1
                      ? v * v * v * (v * (v * 6 - 15) + 10)
                      : Math.exp((-(tp - attack) * ARTICULATION_DECAY) / decay));
                }
                const u = ta / attack;
                env = e0 + (h - e0) * u * u * u * (u * (u * 6 - 15) + 10);
              } else env = h * Math.exp((-(ta - attack) * ARTICULATION_DECAY) / decay);
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

          // Detune (§8.4).
          st[S_LOCKABLE] = ctx.lockable;
          const spread = A.detuneSpread * xa + B.detuneSpread * x;
          const mag = st[S_DET_MAG] + spread * st[S_DET_U];
          const detune = st[S_DET_SIGN] * Math.max(mag, DETUNE_FLOOR);

          // Frequency and mip position: log2 f is linear in pitch, so no logarithm is needed.
          // Within a group, the correction moves the voice to the group's (stillness-weighted)
          // mean modulated pitch, so its detune and drift merge into the group's.
          const own = detune + driftCents + vibCents;
          st[S_MOD] = p * 100 + own;
          const oct = ctx.refOct + (p - 69) / 12 + (own + st[S_CORR]) / 1200;
          if (oct === oct && oct < 40 && oct > -40) {
            let inc = MIP_BASE_HZ * Math.exp(oct * LN2) * ctx.invSampleRate;
            if (inc > 0.5) inc = 0.5;
            st[S_OWN_INC] = inc;
            // The group's phase pull, accumulated into θ.
            inc += st[S_DINC];
            st[S_THETA] += st[S_DINC] * K;
            st[S_CUR_INC] = inc > 0.5 ? 0.5 : inc < 0 ? 0 : inc;
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
            const raw =
              VOICE_BASE_GAIN *
              d.gain *
              lw *
              level *
              driftGain *
              (1 + accent * st[S_MOTION]) *
              artic *
              loud;
            st[S_RAW_AMP] = raw;
            // Group gain h, interpolated across the block.
            const h = st[S_H0] + ((st[S_H1] - st[S_H0]) * (k + 1)) / TICKS_PER_BLOCK;
            let amp = raw * h * gn * st[S_MUTE] * xf;
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
      // The phase advances whenever the voice runs, whether or not it is heard (muted, or not the
      // stem being rendered), so the group pass sees the same phases in every render mode.
      if (st[S_PREV_AMP] !== 0 || st[S_CUR_AMP] !== 0) this.synth(ctx, k * K, audible);
      else if (ok) this.advance();
      st[S_PREV_AMP] = st[S_CUR_AMP];
      st[S_PREV_INC] = st[S_CUR_INC];
      st[S_PREV_GL] = st[S_CUR_GL];
      st[S_PREV_GR] = st[S_CUR_GR];
      this.roleG0.set(this.roleG1);
    }
    if (!this.isGhost) {
      // Publish this block's end state to the next group pass.
      const gi = this.index;
      ctx.gOk[gi] = this.fresh ? 0 : 1;
      ctx.gPitch[gi] = st[S_PITCH] * 100;
      ctx.gMod[gi] = st[S_MOD];
      ctx.gAmp[gi] = st[S_RAW_AMP];
      ctx.gPhase[gi] = st[S_PHASE];
      ctx.gLfo[gi] = st[S_LFO];
      ctx.gInc[gi] = st[S_OWN_INC];
      ctx.gLock[gi] = st[S_LOCKABLE];
      ctx.gWarp[gi] = st[S_WARP];
      let th = st[S_THETA];
      th -= Math.floor(th + 0.5);
      st[S_THETA] = th;
      ctx.gTheta[gi] = th;
    }
  }

  /** Advances the phase over one control period without producing sound (same arithmetic). */
  private advance(): void {
    const st = this.st;
    let inc = st[S_PREV_INC];
    const dInc = (st[S_CUR_INC] - inc) * (1 / CONTROL_PERIOD);
    let phase = st[S_PHASE];
    for (let i = 0; i < CONTROL_PERIOD; i++) {
      phase += inc;
      if (phase >= 1) phase -= 1;
      inc += dInc;
    }
    st[S_PHASE] = phase;
  }

  /** Synthesises one control period at buffer offset `off` (only advances it if not `audible`). */
  private synth(ctx: VoiceContext, off: number, audible: boolean): void {
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
    if (!audible) {
      this.advance();
      return;
    }

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
