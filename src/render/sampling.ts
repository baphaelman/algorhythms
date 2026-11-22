/**
 * Drawing samples of a voice: core/query `sample`'s algorithm and output, into reused typed arrays,
 * with the subdivision of each glide that lies whole in the range cached per scale (frame budget
 * §10, build log 2026-11-22). The points are the same as `sample`'s: a whole glide is subdivided
 * from its own ends either way; a glide cut by the range (at the view's edges, the playhead, an
 * opacity break) is subdivided afresh.
 *
 * A scale is cached only while consecutive frames use it (`stableScale`): a zoom gesture, or two
 * canvases at different scales, subdivide every time, as before.
 */

import { evalSegment } from '../core/segment';
import type { CompiledVoice, Seconds, Segment } from '../core/types';
import { segmentIndexAt } from '../core/query';

/** One sampling: points 0..n−1 of `t` (seconds) and `p` (pitch; NaN separates lives). */
export interface Samples {
  n: number;
  t: Float64Array;
  p: Float64Array;
}

/** A glide longer than this many steps is not cached. */
const MAX_CACHED_STEPS = 8192;

interface Cached {
  step: number;
  tol: number;
  /** The subdivision's points after the glide's start, its end last. */
  t: Float64Array;
  p: Float64Array;
}
const glides = new WeakMap<Segment, Cached>();

let prevStep = NaN;
let prevTol = NaN;
let stable = false;

/**
 * Declares the scale of the next samplings (once per drawn frame): caching is on while it equals
 * the previous call's.
 */
export function stableScale(maxStep: number, tolerance: number): void {
  stable = maxStep === prevStep && tolerance === prevTol;
  prevStep = maxStep;
  prevTol = tolerance;
}

const moving = (s: Segment): boolean => s.p0 !== s.p1 || (s.m0 ?? 0) !== 0 || s.curve !== undefined;

function grow(out: Samples, n: number): void {
  if (n <= out.t.length) return;
  const m = Math.max(n, out.t.length * 2, 256);
  const t = new Float64Array(m);
  const p = new Float64Array(m);
  t.set(out.t);
  p.set(out.p);
  out.t = t;
  out.p = p;
}

function put(out: Samples, t: Seconds, p: number): void {
  const k = out.n;
  if (k > 0 && out.t[k - 1] === t && out.p[k - 1] === p) return;
  if (k >= out.t.length) grow(out, k + 1);
  out.t[k] = t;
  out.p[k] = p;
  out.n = k + 1;
}

/** core/query `sample`'s subdivision of s over (a, b]: appends the points after a. */
function subdivide(
  out: Samples,
  s: Segment,
  a: Seconds,
  pa: number,
  b: Seconds,
  pb: number,
  depth: number,
  step: number,
  minStep: number,
  tol: number,
): void {
  const m = (a + b) / 2;
  const pm = evalSegment(s, m);
  if (depth < 24 && b - a > minStep && (b - a > step || Math.abs(pm - (pa + pb) / 2) > tol)) {
    subdivide(out, s, a, pa, m, pm, depth + 1, step, minStep, tol);
    subdivide(out, s, m, pm, b, pb, depth + 1, step, minStep, tol);
  } else {
    put(out, b, pb);
  }
}

const SCRATCH: Samples = { n: 0, t: new Float64Array(0), p: new Float64Array(0) };

function cachedGlide(s: Segment, step: number, tol: number): Cached {
  const hit = glides.get(s);
  if (hit && hit.step === step && hit.tol === tol) return hit;
  SCRATCH.n = 0;
  subdivide(
    SCRATCH,
    s,
    s.t0,
    evalSegment(s, s.t0),
    s.t1,
    evalSegment(s, s.t1),
    0,
    step,
    step / 4096,
    tol,
  );
  const n = SCRATCH.n;
  const c: Cached = { step, tol, t: SCRATCH.t.slice(0, n), p: SCRATCH.p.slice(0, n) };
  glides.set(s, c);
  return c;
}

/**
 * Points of `voice` over [t0, t1] into `out` (reset first), as core/query `sample`: holds give their
 * two ends, glides are subdivided (whole ones cached at a stable scale), a NaN pitch separates
 * lives.
 */
export function sampleInto(
  out: Samples,
  voice: CompiledVoice,
  t0: Seconds,
  t1: Seconds,
  maxStep: Seconds,
  tolerance: number,
): Samples {
  out.n = 0;
  if (!(t1 > t0)) return out;
  const step = maxStep > 0 ? maxStep : t1 - t0;
  const minStep = step / 4096;
  const segs = voice.segments;
  let i = segmentIndexAt(voice, t0);
  if (i < 0) i = 0;
  let prevEnd = NaN;
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s.t0 >= t1) break;
    if (s.t1 < t0) continue;
    const a = s.t0 > t0 ? s.t0 : t0;
    const b = s.t1 < t1 ? s.t1 : t1;
    if (prevEnd === prevEnd && s.t0 > prevEnd) {
      // A gap between lives (pushed even after an equal point, as `sample`).
      if (out.n >= out.t.length) grow(out, out.n + 1);
      out.t[out.n] = prevEnd;
      out.p[out.n] = NaN;
      out.n++;
    }
    const pa = evalSegment(s, a);
    put(out, a, pa);
    if (b > a) {
      if (!moving(s)) put(out, b, s.p0);
      else if (
        stable &&
        a === s.t0 &&
        b === s.t1 &&
        maxStep > 0 &&
        (b - a) / step <= MAX_CACHED_STEPS
      ) {
        const c = cachedGlide(s, step, tolerance);
        for (let k = 0; k < c.t.length; k++) put(out, c.t[k], c.p[k]);
      } else {
        subdivide(out, s, a, pa, b, evalSegment(s, b), 0, step, minStep, tolerance);
      }
    }
    prevEnd = s.t1;
  }
  return out;
}

/** An empty sample buffer. */
export function samples(): Samples {
  return { n: 0, t: new Float64Array(0), p: new Float64Array(0) };
}
