/**
 * Query API over a compiled score (PLAN.md §7.9). Every consumer (renderer, MIDI, editor)
 * evaluates pitch through these or through core/segment.ts, never by hand (P1).
 *
 * - `pitchAt(voice, t)`: binary search over the segments, O(log n); null while dormant.
 * - `motionAt(voice, t)`: 0..1, sin(π·x) during a glide (x in the planned glide), 0 while
 *   holding or dormant. The same function feeds the DSP's accent term (segment.ts).
 * - `sample(voice, t0, t1, maxStep)`: [t, p] points for drawing. Holds emit their two ends; glides
 *   are subdivided adaptively until the chord error is below `tolerance` semitones and steps are
 *   at most `maxStep` seconds. Gaps between lives are marked with a [t, NaN] break.
 */

import { evalSegment, evalSegmentMotion } from './segment';
import type {
  CompiledScore,
  CompiledVoice,
  HarmonyChange,
  Key,
  Life,
  Pitch,
  Seconds,
  Segment,
} from './types';

/** Index of the last segment with t0 ≤ t, or −1. */
export function segmentIndexAt(voice: CompiledVoice, t: Seconds): number {
  const s = voice.segments;
  let lo = 0;
  let hi = s.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t0 <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The life containing t (born ≤ t < died), or null. */
export function lifeAt(voice: CompiledVoice, t: Seconds): Life | null {
  const lives = voice.lives;
  let lo = 0;
  let hi = lives.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lives[mid];
    if (t < l.born) hi = mid - 1;
    else if (l.died !== undefined && t >= l.died) lo = mid + 1;
    else return l;
  }
  return null;
}

/** The segment sounding at t, or null while dormant. */
export function segmentAt(voice: CompiledVoice, t: Seconds): Segment | null {
  if (!lifeAt(voice, t)) return null;
  const i = segmentIndexAt(voice, t);
  if (i < 0) return null;
  const s = voice.segments[i];
  return t <= s.t1 ? s : null;
}

/** Pitch of a voice at t; null while it is dormant (§7.9). */
export function pitchAt(voice: CompiledVoice, t: Seconds): Pitch | null {
  const s = segmentAt(voice, t);
  return s ? evalSegment(s, t) : null;
}

/** Motion 0..1 at t: sin(π·x) during a glide, 0 while holding or dormant (§7.9). */
export function motionAt(voice: CompiledVoice, t: Seconds): number {
  const s = segmentAt(voice, t);
  return s ? evalSegmentMotion(s, t) : 0;
}

/** True when the segment changes pitch. */
function moving(s: Segment): boolean {
  return s.p0 !== s.p1 || (s.m0 ?? 0) !== 0 || s.curve !== undefined;
}

/**
 * Points [t, p] of a voice over [t0, t1] for drawing (§7.9). Holds emit their two ends; glides
 * are subdivided until |p(mid) − chord| ≤ tolerance and each step is ≤ maxStep (a step never
 * shrinks below maxStep/4096). A [t, NaN] point separates lives.
 */
export function sample(
  voice: CompiledVoice,
  t0: Seconds,
  t1: Seconds,
  maxStep: Seconds,
  tolerance = 0.01,
): [Seconds, Pitch][] {
  const out: [Seconds, Pitch][] = [];
  if (!(t1 > t0)) return out;
  const step = maxStep > 0 ? maxStep : t1 - t0;
  const minStep = step / 4096;
  const push = (t: Seconds, p: Pitch): void => {
    const last = out[out.length - 1];
    if (last && last[0] === t && last[1] === p) return;
    out.push([t, p]);
  };
  const subdivide = (
    s: Segment,
    a: Seconds,
    pa: Pitch,
    b: Seconds,
    pb: Pitch,
    depth: number,
  ): void => {
    const m = (a + b) / 2;
    const pm = evalSegment(s, m);
    const needs =
      depth < 24 && b - a > minStep && (b - a > step || Math.abs(pm - (pa + pb) / 2) > tolerance);
    if (needs) {
      subdivide(s, a, pa, m, pm, depth + 1);
      subdivide(s, m, pm, b, pb, depth + 1);
    } else {
      push(b, pb);
    }
  };
  let i = segmentIndexAt(voice, t0);
  if (i < 0) i = 0;
  let prevEnd = NaN;
  for (; i < voice.segments.length; i++) {
    const s = voice.segments[i];
    if (s.t0 >= t1) break;
    if (s.t1 < t0) continue;
    const a = s.t0 > t0 ? s.t0 : t0;
    const b = s.t1 < t1 ? s.t1 : t1;
    if (!Number.isNaN(prevEnd) && s.t0 > prevEnd) out.push([prevEnd, NaN]); // gap between lives
    const pa = evalSegment(s, a);
    push(a, pa);
    if (b > a) {
      if (moving(s)) subdivide(s, a, pa, b, evalSegment(s, b), 0);
      else push(b, s.p0);
    }
    prevEnd = s.t1;
  }
  return out;
}

/** Pool indices of the voices sounding at t. */
export function activeAt(score: CompiledScore, t: Seconds): number[] {
  const out: number[] = [];
  for (const v of score.voices) if (lifeAt(v, t)) out.push(v.index);
  return out;
}

/** The key in effect at t (the last key entry with entry.t ≤ t). */
export function keyAt(score: CompiledScore, t: Seconds): Key {
  let k = score.keys[0].key;
  for (const e of score.keys) {
    if (e.t <= t) k = e.key;
    else break;
  }
  return k;
}

/**
 * The harmony in effect at t (HUD, §10): the last entry of `score.harmony` with entry.t ≤ t, or
 * null before the first one. Binary search, no allocation.
 */
export function chordAt(score: CompiledScore, t: Seconds): HarmonyChange | null {
  const h = score.harmony;
  if (!h) return null;
  let lo = 0;
  let hi = h.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? null : h[found];
}

/** A sounding voice found by `noteAt`. */
export interface NoteHit {
  /** Pool index. */
  voice: number;
  /** Pitch sounding at t (a note moment's `from`). */
  pitch: Pitch;
  /** Where its current segment is heading (its planned end). */
  dest: Pitch;
  /** |pitch − the queried pitch|. */
  distance: number;
}

/**
 * The voice sounding at t whose pitch is nearest `pitch` (hit testing a line, e.g. to add a note
 * moment, §11.3), or null if none sounds or the nearest is farther than `maxDistance` semitones.
 * Ties: the lower pool index.
 */
export function noteAt(
  score: CompiledScore,
  t: Seconds,
  pitch: Pitch,
  maxDistance = Infinity,
): NoteHit | null {
  let hit: NoteHit | null = null;
  for (const v of score.voices) {
    const s = segmentAt(v, t);
    if (!s) continue;
    const p = evalSegment(s, t);
    const d = Math.abs(p - pitch);
    if (d > maxDistance || (hit && d >= hit.distance)) continue;
    hit = { voice: v.index, pitch: p, dest: s.curve ? s.curve.p1 : s.p1, distance: d };
  }
  return hit;
}
