/**
 * Portable easing curves (PLAN.md §7.5, §7.6, §7.11).
 *
 * Pure leaf module: at runtime it imports nothing, so the DSP may import it by value (see
 * docs/build-log.md, "segment evaluation is shared"). Every function here uses only + − × ÷,
 * Math.floor/round/abs and comparisons, which IEEE 754 makes identical on every engine. That keeps
 * compiler decisions that read eased pitches (crossing checks, overshoot clamps) deterministic
 * across browsers.
 *
 * Every ease satisfies e(0) = 0 and e(1) = 1 exactly; inputs outside [0, 1] are clamped. The
 * standard eases (all but bézier) stay within [0, 1] and are monotone non-decreasing up to
 * floating-point rounding (adjacent inputs may differ by an ulp the "wrong" way).
 *
 * The functions come in two forms: `easeRaw(code, x, x1, y1, x2, y2)` takes scalars and never
 * allocates (for the audio thread), and `ease(code, x, bezier)` takes a params object.
 */

import type { EaseRef } from './types';

/** Numeric ease identifiers, used in flat segment records (core/flat.ts) and the DSP. */
export const EaseCode = {
  Smootherstep: 0,
  Smoothstep: 1,
  Cosine: 2,
  Linear: 3,
  Expo: 4,
  Bezier: 5,
} as const;
/** One of the `EaseCode` values. */
export type EaseCode = (typeof EaseCode)[keyof typeof EaseCode];

/** CSS cubic-bezier control points P1 = (x1, y1) and P2 = (x2, y2); x1 and x2 lie in [0, 1]. */
export interface BezierParams {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Placeholder params for non-bézier eases (a linear bézier). */
export const NO_BEZIER: BezierParams = Object.freeze({ x1: 0, y1: 0, x2: 1, y2: 1 });

/** Maps an `EaseRef` from the piece to its numeric code. */
export function easeCodeOf(ref: EaseRef): EaseCode {
  switch (ref) {
    case 'smootherstep':
      return EaseCode.Smootherstep;
    case 'smoothstep':
      return EaseCode.Smoothstep;
    case 'cosine':
      return EaseCode.Cosine;
    case 'linear':
      return EaseCode.Linear;
    case 'expo':
      return EaseCode.Expo;
    default:
      return EaseCode.Bezier;
  }
}

/** The bézier params of an `EaseRef`, or `NO_BEZIER` for the named eases. */
export function bezierOf(ref: EaseRef): BezierParams {
  return typeof ref === 'object' ? ref : NO_BEZIER;
}

// ---------------------------------------------------------------------------------------------
// Portable transcendental helpers
// ---------------------------------------------------------------------------------------------

const PI = 3.141592653589793;
/** ln 2 as a literal (a constant, not a call to Math.log). */
const LN2 = 0.6931471805599453;

/**
 * Taylor coefficients of sin(πu) in odd powers of u, up to u^17:
 * c[k] = (−1)^k π^(2k+1) / (2k+1)!. On |u| ≤ 1/2 the truncation error is below 1e-14.
 * Built by multiplication only, which is deterministic under IEEE 754.
 */
const SIN_PI_COEFFS: readonly number[] = (() => {
  const c: number[] = [PI];
  for (let k = 1; k <= 8; k++) {
    c.push((c[k - 1] * -(PI * PI)) / (2 * k * (2 * k + 1)));
  }
  return c;
})();

/** Odd polynomial approximating sin(πu) on [−1/2, 1/2]; exactly odd, so S(−u) = −S(u). */
function sinPiPoly(u: number): number {
  const u2 = u * u;
  let acc = SIN_PI_COEFFS[8];
  for (let k = 7; k >= 0; k--) acc = acc * u2 + SIN_PI_COEFFS[k];
  return acc * u;
}

/** Derivative of `sinPiPoly` with respect to u. */
function sinPiPolyDeriv(u: number): number {
  const u2 = u * u;
  let acc = 17 * SIN_PI_COEFFS[8];
  for (let k = 7; k >= 0; k--) acc = acc * u2 + (2 * k + 1) * SIN_PI_COEFFS[k];
  return acc;
}

/** S(1/2): dividing by it makes sinPi(±1/2) = ±1 exactly. */
const SIN_PI_HALF = sinPiPoly(0.5);

/**
 * Portable sin(πx) for any finite x, accurate to about 1e-14, with sinPi(±1/2) = ±1 and
 * sinPi(n) = 0 exactly for integers n. For use in core/ wherever a sine is needed (e.g. the
 * motion curve sin(π·x) of §7.9).
 */
export function sinPi(x: number): number {
  let r = x - 2 * Math.round(x * 0.5); // r ∈ [−1, 1]
  if (r > 0.5) r = 1 - r;
  else if (r < -0.5) r = -1 - r;
  return sinPiPoly(r) / SIN_PI_HALF;
}

/** Portable cos(πx) = sin(π(x + 1/2)). */
export function cosPi(x: number): number {
  return sinPi(x + 0.5);
}

/** Taylor coefficients of e^z = Σ z^k / k!, k = 0..13; error < 1e-13 for z ∈ [0, ln 2). */
const EXP_COEFFS: readonly number[] = (() => {
  const c: number[] = [1];
  for (let k = 1; k <= 13; k++) c.push(c[k - 1] / k);
  return c;
})();

/** 2^n for an integer n, exact wherever 2^n is a normal double. */
function pow2Int(n: number): number {
  let base = n < 0 ? 0.5 : 2;
  let e = n < 0 ? -n : n;
  let result = 1;
  while (e > 0) {
    if (e % 2 === 1) result *= base;
    base *= base;
    e = Math.floor(e / 2);
  }
  return result;
}

/**
 * Portable 2^y, relative error about 1e-13. Exact for integer y in the normal range.
 * Monotone across integer boundaries (the Taylor series underestimates 2^f on [0, 1)).
 */
export function exp2(y: number): number {
  if (y !== y) return NaN;
  if (y >= 1024) return Infinity;
  if (y <= -1022) return 0;
  const n = Math.floor(y);
  const z = (y - n) * LN2;
  let acc = EXP_COEFFS[13];
  for (let k = 12; k >= 0; k--) acc = acc * z + EXP_COEFFS[k];
  return acc * pow2Int(n);
}

// ---------------------------------------------------------------------------------------------
// The eases
// ---------------------------------------------------------------------------------------------

/** 2^−10: the expo ease's raw value at 0, subtracted so that e(0) = 0 exactly. */
const EXPO_FLOOR = 1 / 1024;
/** Normaliser 2·(1 − 2^−10), so that e(1/2) = 1/2 and e(1) = 1 exactly. */
const EXPO_NORM = 2 * (1 - EXPO_FLOOR);
/** Slope of the expo ease at 0 (and at 1): 20·ln2·2^−10 / (2·(1 − 2^−10)) = 10·ln2/1023. */
const EXPO_SLOPE_END = (20 * LN2 * EXPO_FLOOR) / EXPO_NORM;

/** Newton's method stops once |Bx(t) − x| is below this. */
const BEZIER_NEWTON_EPS = 1e-14;

/**
 * Solves Bx(t) = x for t ∈ [0, 1]: Newton's method from t = x, then bisection to full double
 * precision if Newton stalls (a flat or vertical tangent) or leaves [0, 1].
 */
function bezierSolveT(x: number, ax: number, bx: number, cx: number): number {
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = ((ax * t + bx) * t + cx) * t - x;
    if (Math.abs(err) < BEZIER_NEWTON_EPS) return t;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-9) break;
    t -= err / d;
    if (t < 0 || t > 1) break;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 64; i++) {
    const xt = ((ax * t + bx) * t + cx) * t;
    if (xt === x) return t;
    if (x > xt) lo = t;
    else hi = t;
    const mid = (lo + hi) * 0.5;
    if (mid === t) return t;
    t = mid;
  }
  return t;
}

function bezierValue(x: number, x1: number, y1: number, x2: number, y2: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const t = bezierSolveT(x, ax, bx, cx);
  return ((ay * t + by) * t + cy) * t;
}

function bezierDeriv(x: number, x1: number, y1: number, x2: number, y2: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const t = bezierSolveT(x, ax, bx, cx);
  const dx = (3 * ax * t + 2 * bx) * t + cx;
  const dy = (3 * ay * t + 2 * by) * t + cy;
  if (dx === 0) return dy === 0 ? 0 : dy > 0 ? Infinity : -Infinity;
  return dy / dx;
}

/** CSS start tangent: through P1 if x1 > 0, else through P2 if x2 > 0, else flat. */
function bezierSlope0(x1: number, y1: number, x2: number, y2: number): number {
  if (x1 > 0) return y1 / x1;
  if (x2 > 0) return y2 / x2;
  return 0;
}

/** CSS end tangent: through P2 if x2 < 1, else through P1 if x1 < 1, else flat. */
function bezierSlope1(x1: number, y1: number, x2: number, y2: number): number {
  if (x2 < 1) return (1 - y2) / (1 - x2);
  if (x1 < 1) return (1 - y1) / (1 - x1);
  return 0;
}

/**
 * e(x) for an ease code, allocation-free. Bézier params are read only for `EaseCode.Bezier`.
 * - smootherstep: 6x⁵ − 15x⁴ + 10x³ (exact polynomial)
 * - smoothstep:   3x² − 2x³ (exact polynomial)
 * - linear:       x
 * - cosine:       (1 − cos πx)/2, via the portable `sinPi`
 * - expo:         ease-in-out exponential, normalised to pass exactly through 0, 1/2 and 1
 * - bezier:       CSS cubic-bezier(x1, y1, x2, y2), solved by Newton's method plus bisection
 */
export function easeRaw(
  code: EaseCode,
  x: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let e: number;
  switch (code) {
    case EaseCode.Smootherstep:
      e = x * x * x * (x * (x * 6 - 15) + 10);
      break;
    case EaseCode.Smoothstep:
      e = x * x * (3 - 2 * x);
      break;
    case EaseCode.Cosine:
      e = (1 + sinPiPoly(x - 0.5) / SIN_PI_HALF) * 0.5;
      break;
    case EaseCode.Expo:
      e =
        x <= 0.5
          ? (exp2(20 * x - 10) - EXPO_FLOOR) / EXPO_NORM
          : 1 - (exp2(10 - 20 * x) - EXPO_FLOOR) / EXPO_NORM;
      break;
    case EaseCode.Bezier:
      return bezierValue(x, x1, y1, x2, y2); // may overshoot [0, 1] by design
    default:
      return x; // linear
  }
  // Rounding can push a polynomial an ulp past the ends (e.g. 1.0000000000000002 near x = 1).
  return e < 0 ? 0 : e > 1 ? 1 : e;
}

/** e(x) for an ease code; `bezier` is read only for `EaseCode.Bezier`. */
export function ease(code: EaseCode, x: number, bezier: BezierParams = NO_BEZIER): number {
  return easeRaw(code, x, bezier.x1, bezier.y1, bezier.x2, bezier.y2);
}

/** e′(0): the starting slope, used for the interruption term m0 = v·d − (p1 − p0)·e′(0) (§7.5). */
export function easeSlope0Raw(
  code: EaseCode,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  switch (code) {
    case EaseCode.Linear:
      return 1;
    case EaseCode.Expo:
      return EXPO_SLOPE_END;
    case EaseCode.Bezier:
      return bezierSlope0(x1, y1, x2, y2);
    default:
      return 0; // smootherstep, smoothstep, cosine
  }
}

/** e′(0) for an ease code; see `easeSlope0Raw`. */
export function easeSlope0(code: EaseCode, bezier: BezierParams = NO_BEZIER): number {
  return easeSlope0Raw(code, bezier.x1, bezier.y1, bezier.x2, bezier.y2);
}

/** e′(1): the arrival slope. */
export function easeSlope1Raw(
  code: EaseCode,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  switch (code) {
    case EaseCode.Linear:
      return 1;
    case EaseCode.Expo:
      return EXPO_SLOPE_END;
    case EaseCode.Bezier:
      return bezierSlope1(x1, y1, x2, y2);
    default:
      return 0;
  }
}

/**
 * e′(x), the derivative of exactly the curve `easeRaw` computes, allocation-free. At x ≤ 0 and
 * x ≥ 1 it returns the end slopes. A bézier with a vertical tangent returns ±Infinity.
 */
export function easeDerivRaw(
  code: EaseCode,
  x: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  if (x <= 0) return easeSlope0Raw(code, x1, y1, x2, y2);
  if (x >= 1) return easeSlope1Raw(code, x1, y1, x2, y2);
  switch (code) {
    case EaseCode.Smootherstep: {
      const w = x * (1 - x);
      return 30 * w * w;
    }
    case EaseCode.Smoothstep:
      return 6 * x * (1 - x);
    case EaseCode.Cosine:
      return sinPiPolyDeriv(x - 0.5) / (2 * SIN_PI_HALF);
    case EaseCode.Linear:
      return 1;
    case EaseCode.Expo:
      return x <= 0.5
        ? (20 * LN2 * exp2(20 * x - 10)) / EXPO_NORM
        : (20 * LN2 * exp2(10 - 20 * x)) / EXPO_NORM;
    case EaseCode.Bezier:
      return bezierDeriv(x, x1, y1, x2, y2);
    default:
      return 1;
  }
}

/** e′(x) for an ease code; see `easeDerivRaw`. */
export function easeDeriv(code: EaseCode, x: number, bezier: BezierParams = NO_BEZIER): number {
  return easeDerivRaw(code, x, bezier.x1, bezier.y1, bezier.x2, bezier.y2);
}
