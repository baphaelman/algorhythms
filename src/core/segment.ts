/**
 * Segment evaluation and the flat record layouts (PLAN.md §7.5, §7.9, §8.11).
 *
 * Pure leaf module: at runtime it imports only core/ease.ts. The DSP imports it by value, so the
 * compiler, renderer, MIDI exporter and audio thread all evaluate pitch with the same code (P1).
 * That is a recorded deviation from §14 ("dsp imports only types from core"); see
 * docs/build-log.md. The record layouts live here rather than in flat.ts for the same reason: the
 * DSP must read flat records, and it may import only this file and ease.ts from core. flat.ts
 * re-exports every constant, so main-thread code can import them from there.
 *
 * A segment is
 *
 *   p(x) = p0 + (p1 − p0)·e(x) + m0·H(x),   H(x) = x³ − 2x² + x = x(1 − x)²,
 *   x = (t − t0)/(t1 − t0), clamped to [0, 1].
 *
 * H(0) = H(1) = 0, H′(0) = 1, H′(1) = 0, so p(t0) = p0 and p(t1) = p1 exactly (both are returned
 * by branch, not by arithmetic), and the start slope carries the interrupted velocity (§7.5).
 *
 * Cut segments (M1, additive): when a glide is interrupted at tᵢ (§7.5 step 1, "truncate S"), its
 * curve keeps the parametrisation of the glide as planned, which ran to `curveT1` and aimed at
 * `curveP1`. The segment itself ends at t1 = tᵢ with p1 = its pitch there. Then
 *
 *   x = (t − t0)/(curveT1 − t0),   p = p0 + (curveP1 − p0)·e(x) + m0·H(x)   for t0 ≤ t < t1.
 *
 * For an uncut segment curveT1 = t1 and curveP1 = p1, which is the formula above unchanged.
 */

import { easeDerivRaw, easeRaw, type EaseCode, easeCodeOf, sinPi } from './ease';
import type { Pitch, Seconds, Segment } from './types';

/** Local alias for the hot path: under Vitest's module runner an imported binding is a getter. */
const easeAt = easeRaw;

// ---------------------------------------------------------------------------------------------
// Flat record layouts (Float64Array, fixed stride). Offsets are indices within one record.
// ---------------------------------------------------------------------------------------------

/** Segment record: start time. */
export const SEG_T0 = 0;
/** Segment record: end time. */
export const SEG_T1 = 1;
/** Segment record: pitch at t0. */
export const SEG_P0 = 2;
/** Segment record: pitch at t1. */
export const SEG_P1 = 3;
/** Segment record: `EaseCode`. */
export const SEG_EASE = 4;
/** Segment record: bézier x1 (0 for non-bézier eases). */
export const SEG_BX1 = 5;
/** Segment record: bézier y1 (0 for non-bézier eases). */
export const SEG_BY1 = 6;
/** Segment record: bézier x2 (1 for non-bézier eases). */
export const SEG_BX2 = 7;
/** Segment record: bézier y2 (1 for non-bézier eases). */
export const SEG_BY2 = 8;
/** Segment record: carried-velocity term m0 (0 if none). */
export const SEG_M0 = 9;
/** Segment record: 1 if the overshoot clamp applied, else 0. */
export const SEG_CLAMPED = 10;
/** Segment record: end time of the planned glide (equals SEG_T1 unless the segment was cut). */
export const SEG_CURVE_T1 = 11;
/** Segment record: target of the planned glide (equals SEG_P1 unless the segment was cut). */
export const SEG_CURVE_P1 = 12;
/** Doubles per segment record. */
export const SEG_STRIDE = 13;

/** Life record: audible onset. */
export const LIFE_BORN = 0;
/** Life record: end of the fade-out; +Infinity if the voice is alive at the end. */
export const LIFE_DIED = 1;
/** Life record: fade-in length. */
export const LIFE_FADE_IN = 2;
/** Life record: fade-out length, ending at LIFE_DIED (0 if none). */
export const LIFE_FADE_OUT = 3;
/** Doubles per life record. */
export const LIFE_STRIDE = 4;

/** Level record: ramp start time. */
export const LEVEL_T = 0;
/** Level record: target linear gain. */
export const LEVEL_GAIN = 1;
/** Level record: ramp length (0 = step). */
export const LEVEL_OVER = 2;
/** Doubles per level record. */
export const LEVEL_STRIDE = 3;

/** Timbre record: crossfade start time. */
export const TIMBRE_T = 0;
/** Timbre record: index into FlatScore.timbreNames. */
export const TIMBRE_PRESET = 1;
/** Timbre record: crossfade length. */
export const TIMBRE_FADE = 2;
/** Doubles per timbre record. */
export const TIMBRE_STRIDE = 3;

/** Voice-params record: static linear gain. */
export const VOICE_GAIN = 0;
/** Voice-params record: pan −1..1, or NaN for 'auto'. */
export const VOICE_PAN = 1;
/** Voice-params record: 1 if muted. */
export const VOICE_MUTE = 2;
/** Voice-params record: 1 if soloed. */
export const VOICE_SOLO = 3;
/** Voice-params record: reverb send override, or NaN for "use mix.sends.reverb". */
export const VOICE_SEND_REVERB = 4;
/** Voice-params record: delay send override, or NaN for "use mix.sends.delay". */
export const VOICE_SEND_DELAY = 5;
/** Voice-params record: unsigned 32-bit hash of the voice id, for seeding detune and phase. */
export const VOICE_ID_HASH = 6;
/** Doubles per voice-params record. */
export const VOICE_STRIDE = 7;

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/**
 * p(t) from scalar segment fields; allocation-free. Before t0 it returns p0, from t1 on it
 * returns p1 (a zero-length segment is a step at t0). `curveT1` and `curveP1` describe the planned
 * glide of a cut segment (see the module comment); they default to t1 and p1.
 */
export function segmentPitch(
  t0: Seconds,
  t1: Seconds,
  p0: Pitch,
  p1: Pitch,
  code: EaseCode,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  m0: number,
  t: Seconds,
  curveT1: Seconds = t1,
  curveP1: Pitch = p1,
): Pitch {
  if (t < t0) return p0;
  if (t >= t1) return p1;
  const x = (t - t0) / (curveT1 - t0); // in [0, 1); x = 0 yields p0 exactly
  if (x >= 1) return p1;
  const omx = 1 - x;
  return p0 + (curveP1 - p0) * easeAt(code, x, x1, y1, x2, y2) + m0 * (x * omx * omx);
}

/**
 * dp/dt in semitones per second from scalar segment fields; allocation-free. Outside [t0, t1]
 * it returns the slope at the nearer end. A zero-length segment returns 0. `curveT1` and
 * `curveP1` are as in `segmentPitch`.
 */
export function segmentVelocity(
  t0: Seconds,
  t1: Seconds,
  p0: Pitch,
  p1: Pitch,
  code: EaseCode,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  m0: number,
  t: Seconds,
  curveT1: Seconds = t1,
  curveP1: Pitch = p1,
): number {
  const d = curveT1 - t0;
  if (!(d > 0) || !(t1 > t0)) return 0;
  const tc = t < t0 ? t0 : t > t1 ? t1 : t;
  let x = (tc - t0) / d;
  if (x > 1) x = 1;
  const dH = (1 - x) * (1 - 3 * x); // H′(x) = 3x² − 4x + 1
  return ((curveP1 - p0) * easeDerivRaw(code, x, x1, y1, x2, y2) + m0 * dH) / d;
}

/**
 * Motion 0..1 (§7.9): sin(π·x) during a glide, x being the position in the planned glide, and 0
 * during a hold (p0 = curveP1 with no carried velocity). Allocation-free; shared by the query API
 * (motionAt) and the DSP's accent term (§8.4), so both read the same value (P1). Outside
 * [t0, t1) it returns 0.
 */
export function segmentMotion(
  t0: Seconds,
  t1: Seconds,
  p0: Pitch,
  m0: number,
  t: Seconds,
  curveT1: Seconds,
  curveP1: Pitch,
): number {
  if (t < t0 || t >= t1) return 0;
  if (p0 === curveP1 && m0 === 0) return 0;
  const x = (t - t0) / (curveT1 - t0);
  if (!(x > 0)) return 0;
  return x >= 1 ? 0 : sinPi(x);
}

/** p(t) of a compiled segment (§7.9). Clamped to p0 before t0 and p1 after t1. */
export function evalSegment(seg: Segment, t: Seconds): Pitch {
  const e = seg.ease;
  const code = easeCodeOf(e);
  const ct1 = seg.curve ? seg.curve.t1 : seg.t1;
  const cp1 = seg.curve ? seg.curve.p1 : seg.p1;
  const m0 = seg.m0 ?? 0;
  return typeof e === 'object'
    ? segmentPitch(seg.t0, seg.t1, seg.p0, seg.p1, code, e.x1, e.y1, e.x2, e.y2, m0, t, ct1, cp1)
    : segmentPitch(seg.t0, seg.t1, seg.p0, seg.p1, code, 0, 0, 1, 1, m0, t, ct1, cp1);
}

/** dp/dt of a compiled segment in semitones per second; used for interruptions (§7.5). */
export function evalSegmentVelocity(seg: Segment, t: Seconds): number {
  const e = seg.ease;
  const code = easeCodeOf(e);
  const ct1 = seg.curve ? seg.curve.t1 : seg.t1;
  const cp1 = seg.curve ? seg.curve.p1 : seg.p1;
  const m0 = seg.m0 ?? 0;
  return typeof e === 'object'
    ? segmentVelocity(seg.t0, seg.t1, seg.p0, seg.p1, code, e.x1, e.y1, e.x2, e.y2, m0, t, ct1, cp1)
    : segmentVelocity(seg.t0, seg.t1, seg.p0, seg.p1, code, 0, 0, 1, 1, m0, t, ct1, cp1);
}

/** Motion 0..1 of a compiled segment at t; see `segmentMotion`. */
export function evalSegmentMotion(seg: Segment, t: Seconds): number {
  const ct1 = seg.curve ? seg.curve.t1 : seg.t1;
  const cp1 = seg.curve ? seg.curve.p1 : seg.p1;
  return segmentMotion(seg.t0, seg.t1, seg.p0, seg.m0 ?? 0, t, ct1, cp1);
}

/**
 * p(t) of the flat segment record starting at `offset` in `records` (a multiple of SEG_STRIDE);
 * allocation-free, for the audio thread.
 */
export function evalFlatSegment(records: Float64Array, offset: number, t: Seconds): Pitch {
  return segmentPitch(
    records[offset + SEG_T0],
    records[offset + SEG_T1],
    records[offset + SEG_P0],
    records[offset + SEG_P1],
    records[offset + SEG_EASE] as EaseCode,
    records[offset + SEG_BX1],
    records[offset + SEG_BY1],
    records[offset + SEG_BX2],
    records[offset + SEG_BY2],
    records[offset + SEG_M0],
    t,
    records[offset + SEG_CURVE_T1],
    records[offset + SEG_CURVE_P1],
  );
}

/** Motion 0..1 of the flat segment record at `offset`; allocation-free, for the DSP's accent. */
export function evalFlatSegmentMotion(records: Float64Array, offset: number, t: Seconds): number {
  return segmentMotion(
    records[offset + SEG_T0],
    records[offset + SEG_T1],
    records[offset + SEG_P0],
    records[offset + SEG_M0],
    t,
    records[offset + SEG_CURVE_T1],
    records[offset + SEG_CURVE_P1],
  );
}
