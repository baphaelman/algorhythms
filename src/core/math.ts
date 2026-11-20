/**
 * Portable math for core/ (PLAN.md §7.11).
 *
 * Native Math.sin, cos, pow, exp and log are not guaranteed to round the same way on every
 * engine, and core/ must compile a piece identically everywhere. Everything here is built from
 * + − × ÷, Math.floor/round/abs and exact bit manipulation.
 *
 * sinPi, cosPi and exp2 live in core/ease.ts, which must stay a leaf module the DSP can import;
 * they are re-exported here so that the rest of core/ has one place to import math from.
 */

export { cosPi, exp2, sinPi } from './ease';

/** ln 2 as a literal (a constant, not a call to Math.log). */
export const LN2 = 0.6931471805599453;
/** √2 as a literal. */
const SQRT2 = 1.4142135623730951;

/** Scratch view for reading and writing a double's bits (big-endian, the DataView default). */
const VIEW = new DataView(new ArrayBuffer(8));
/** 2⁵⁴, to lift subnormals into the normal range before reading the exponent. */
const TWO_54 = 18014398509481984;

/**
 * Coefficients 1/(2k + 1) of atanh(z)/z = Σ z^(2k)/(2k + 1), k = 0..11. With |z| ≤ 0.1716 the
 * truncation error is below 1e-19.
 */
const ATANH_COEFFS: readonly number[] = Array.from({ length: 12 }, (_, k) => 1 / (2 * k + 1));

/**
 * Portable log₂(x), relative error about 1e-16. Exact for powers of two. log2(0) = −Infinity;
 * negative input and NaN give NaN.
 */
export function log2(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let shift = 0;
  if (x < 2.2250738585072014e-308) {
    x *= TWO_54; // subnormal
    shift = -54;
  }
  VIEW.setFloat64(0, x);
  const hi = VIEW.getUint32(0);
  let e = ((hi >>> 20) & 0x7ff) - 1023 + shift;
  VIEW.setUint32(0, (hi & 0x000fffff) | 0x3ff00000); // same mantissa, exponent 0: m ∈ [1, 2)
  let m = VIEW.getFloat64(0);
  if (m > SQRT2) {
    m *= 0.5; // m ∈ (√½, √2]
    e += 1;
  }
  // ln m = 2·atanh(z), z = (m − 1)/(m + 1); m = 1 gives exactly 0.
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let acc = ATANH_COEFFS[11];
  for (let k = 10; k >= 0; k--) acc = acc * z2 + ATANH_COEFFS[k];
  return e + (2 * z * acc) / LN2;
}

/** x clamped to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear interpolation: a at t = 0, b at t = 1. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Floored modulo: the result has the sign of n (mod(−1, 12) = 11); never −0. */
export function mod(x: number, n: number): number {
  const r = x % n;
  return r < 0 ? r + n : r + 0;
}
