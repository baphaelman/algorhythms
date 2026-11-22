/**
 * Portable math for the DSP: renders must be bit-identical on every platform.
 *
 * V8's Math.exp, log2, pow, sin, … are C (fdlibm/glibc ports) whose last bits depend on how the
 * engine was compiled: on arm64, clang fuses a·b + c into one FMA, on x64 it does not, so Math.exp
 * differs by an ulp for about 1 argument in 2000 between an Apple Silicon Mac and Linux x64, and
 * feedback (the unison lock) can grow such an ulp into a different render. Everything here uses
 * only + − × ÷, Math.floor/round/abs and exact bit operations, so it rounds the same everywhere.
 * Mirrors core/math.ts (log2) and core/ease.ts (exp2, sinPi), which the DSP may not import.
 * Accuracy: relative error about 1e-13 (exp, exp2, pow) and 1e-16 (log2); absolute about
 * 1e-14·max(1, |x|) (sin, cos) and 1e-16 (atan2). Renders differ from Math's by ≤ −144 dBFS.
 *
 * **Audio thread:** V8 boxes doubles passed to or returned from a call it does not inline (the
 * huge render loops exhaust its inlining budget), so `process()` paths use the register forms:
 * write the arguments to `R`, call e.g. `exp2R()`, read `R[0]`. Their bodies make no JS calls,
 * so they allocate nothing whether inlined or not. The plain forms (`exp2(x)`, …) wrap them, so
 * both give identical bits. Two hot spots copy a body inline instead, with the exported
 * constants: `Voice.render` (`exp2R`; inlining even these calls pushed the segment evaluation out
 * of V8's inlining budget) and `Graph.computeGroups` (`atan2R`; its rare snap path was not inlined
 * and ran unoptimised, boxing doubles).
 */

/** Argument and result registers for the allocation-free forms. */
export const R = new Float64Array(2);

export const LN2 = 0.6931471805599453;
export const LOG2E = 1.4426950408889634;
/** log₂ 10 / 20, for decibels. */
const LOG2_10_OVER_20 = 0.1660964047443681;
export const PI = 3.141592653589793;
const INV_PI = 0.3183098861837907;
export const HALF_PI = 1.5707963267948966;
export const QUARTER_PI = 0.7853981633974483;
export const SIXTH_PI = 0.5235987755982989;
const SQRT2 = 1.4142135623730951;
export const SQRT3 = 1.7320508075688772;
/** tan(π/12) = 2 − √3. */
export const TAN_PI_12 = 0.2679491924311227;
/** 2⁵⁴, to lift subnormals into the normal range before reading the exponent. */
const TWO_54 = 18014398509481984;

/** Scratch view for a double's bits (big-endian, the DataView default). */
export const VIEW = new DataView(new ArrayBuffer(8));

/** e^z Taylor coefficients 1/k!, k = 0..13; error < 1e-13 for z ∈ [0, ln 2) (as core/ease.ts). */
export const EXP_C = new Float64Array(14);
EXP_C[0] = 1;
for (let k = 1; k < 14; k++) EXP_C[k] = EXP_C[k - 1]! / k;

/** POW2[n + 1022] = 2^n for n ∈ [−1022, 1023], exact (the exponent bits). */
export const POW2 = new Float64Array(2046);
for (let n = -1022; n <= 1023; n++) {
  VIEW.setUint32(0, (n + 1023) << 20);
  VIEW.setUint32(4, 0);
  POW2[n + 1022] = VIEW.getFloat64(0);
}

/** 1/(2k + 1), k = 0..11: atanh z / z; truncation < 1e-19 for |z| ≤ 0.1716 (as core/math.ts). */
export const ATANH_C = new Float64Array(12);
for (let k = 0; k < 12; k++) ATANH_C[k] = 1 / (2 * k + 1);

/** (−1)^k π^(2k+1)/(2k+1)!, k = 0..8: sin(πu) on |u| ≤ ½, error < 1e-14 (as core/ease.ts). */
const SIN_C = new Float64Array(9);
SIN_C[0] = PI;
for (let k = 1; k < 9; k++) SIN_C[k] = (SIN_C[k - 1]! * -(PI * PI)) / (2 * k * (2 * k + 1));
/** S(½), so that sinPi(±½) = ±1 exactly. */
const SIN_HALF = (() => {
  let acc = SIN_C[8]!;
  for (let k = 7; k >= 0; k--) acc = acc * 0.25 + SIN_C[k]!;
  return acc * 0.5;
})();

/** (−1)^k/(2k + 1), k = 0..15: atan z / z; truncation < 1e-19 for |z| ≤ tan(π/12). */
export const ATAN_C = new Float64Array(16);
for (let k = 0; k < 16; k++) ATAN_C[k] = (k % 2 === 0 ? 1 : -1) / (2 * k + 1);

// ---------------------------------------------------------------------------------------------
// Register forms (no JS calls inside)
// ---------------------------------------------------------------------------------------------

/** R[0] ← 2^R[0]. Exact for integers in the normal range; 0 below −1022. */
export function exp2R(): void {
  const y = R[0]!;
  if (!(y < 1024)) {
    R[0] = y === y ? Infinity : NaN;
    return;
  }
  if (y < -1022) {
    R[0] = 0;
    return;
  }
  const n = Math.floor(y);
  const z = (y - n) * LN2;
  // Horner over EXP_C, written out (tests/dsp/pmath.test.ts checks the literals).
  let acc = 1.6059043836821616e-10 * z + 2.08767569878681e-9;
  acc = acc * z + 2.505210838544172e-8;
  acc = acc * z + 2.7557319223985894e-7;
  acc = acc * z + 0.0000027557319223985893;
  acc = acc * z + 0.0000248015873015873;
  acc = acc * z + 0.0001984126984126984;
  acc = acc * z + 0.001388888888888889;
  acc = acc * z + 0.008333333333333333;
  acc = acc * z + 0.041666666666666664;
  acc = acc * z + 0.16666666666666666;
  acc = acc * z + 0.5;
  acc = acc * z + 1;
  acc = acc * z + 1;
  R[0] = acc * POW2[n + 1022]; // 2^n, n ∈ [−1022, 1023]
}

/** R[0] ← e^R[0]. */
export function expR(): void {
  R[0] = R[0]! * LOG2E;
  exp2R();
}

/** R[0] ← 10^(R[0]/20): decibels to gain. */
export function dbToGainR(): void {
  R[0] = R[0]! * LOG2_10_OVER_20;
  exp2R();
}

/** R[0] ← log₂ R[0]. Exact for powers of two; log2(0) = −∞; negative or NaN gives NaN. */
export function log2R(): void {
  let x = R[0]!;
  if (!(x > 0)) {
    R[0] = x === 0 ? -Infinity : NaN;
    return;
  }
  if (x === Infinity) return;
  let shift = 0;
  if (x < 2.2250738585072014e-308) {
    x *= TWO_54;
    shift = -54;
  }
  VIEW.setFloat64(0, x);
  const hi = VIEW.getUint32(0);
  let e = ((hi >>> 20) & 0x7ff) - 1023 + shift;
  VIEW.setUint32(0, (hi & 0x000fffff) | 0x3ff00000); // mantissa with exponent 0: m ∈ [1, 2)
  let m = VIEW.getFloat64(0);
  if (m > SQRT2) {
    m *= 0.5;
    e += 1;
  }
  // ln m = 2·atanh z, z = (m − 1)/(m + 1); m = 1 gives exactly 0.
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  // Horner over ATANH_C, written out (tests/dsp/pmath.test.ts checks the literals).
  let acc = 0.043478260869565216 * z2 + 0.047619047619047616;
  acc = acc * z2 + 0.05263157894736842;
  acc = acc * z2 + 0.058823529411764705;
  acc = acc * z2 + 0.06666666666666667;
  acc = acc * z2 + 0.07692307692307693;
  acc = acc * z2 + 0.09090909090909091;
  acc = acc * z2 + 0.1111111111111111;
  acc = acc * z2 + 0.14285714285714285;
  acc = acc * z2 + 0.2;
  acc = acc * z2 + 0.3333333333333333;
  acc = acc * z2 + 1;
  R[0] = e + (2 * z * acc) / LN2;
}

/** R[0] ← R[0]^R[1] for R[0] ≥ 0 (x^0 = 1; 0^y = 0 for y > 0, ∞ for y < 0). */
export function powR(): void {
  const x = R[0]!;
  const y = R[1]!;
  if (y === 0) R[0] = 1;
  else if (x === 0) R[0] = y > 0 ? 0 : Infinity;
  else {
    log2R();
    R[0] = R[0]! * y;
    exp2R();
  }
}

/** R[0] ← sin(π·R[0]). sinPi(n) = 0 and sinPi(n + ½) = ±1 exactly. */
export function sinPiR(): void {
  const x = R[0]!;
  let r = x - 2 * Math.round(x * 0.5); // [−1, 1]
  if (r > 0.5) r = 1 - r;
  else if (r < -0.5) r = -1 - r;
  const r2 = r * r;
  let acc = SIN_C[8]!;
  for (let k = 7; k >= 0; k--) acc = acc * r2 + SIN_C[k]!;
  R[0] = (acc * r) / SIN_HALF;
}

/** R[0] ← sin R[0], R[1] ← cos R[0] (radians). */
export function sinCosR(): void {
  const u = R[0]! * INV_PI;
  R[0] = u + 0.5;
  sinPiR();
  const c = R[0]!;
  R[0] = u;
  sinPiR();
  R[1] = c;
}

/** R[0] ← atan2(R[0], R[1]) ∈ [−π, π], Math.atan2's quadrants (signed zeros not kept). */
export function atan2R(): void {
  const y = R[0]!;
  const x = R[1]!;
  if (y !== y || x !== x) {
    R[0] = NaN;
    return;
  }
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let r: number;
  if (ay === 0) r = 0;
  else if (ax === ay) r = QUARTER_PI;
  else {
    // atan t on t ∈ [0, 1); above tan(π/12): atan t = π/6 + atan((√3·t − 1)/(√3 + t)).
    const swap = ay > ax;
    const t = swap ? ax / ay : ay / ax;
    let base = 0;
    let z = t;
    if (t > TAN_PI_12) {
      base = SIXTH_PI;
      z = (t * SQRT3 - 1) / (SQRT3 + t);
    }
    const z2 = z * z;
    let acc = ATAN_C[15]!;
    for (let k = 14; k >= 0; k--) acc = acc * z2 + ATAN_C[k]!;
    r = base + z * acc;
    if (swap) r = HALF_PI - r;
  }
  if (x < 0) r = PI - r;
  R[0] = y < 0 ? -r : r;
}

// ---------------------------------------------------------------------------------------------
// Plain forms (setup code: constructors, tables, prepare)
// ---------------------------------------------------------------------------------------------

/** 2^y. */
export function exp2(y: number): number {
  R[0] = y;
  exp2R();
  return R[0];
}

/** e^x. */
export function exp(x: number): number {
  R[0] = x;
  expR();
  return R[0];
}

/** 10^(db/20). */
export function dbToGain(db: number): number {
  R[0] = db;
  dbToGainR();
  return R[0];
}

/** log₂ x. */
export function log2(x: number): number {
  R[0] = x;
  log2R();
  return R[0];
}

/** Natural logarithm. */
export function ln(x: number): number {
  return log2(x) * LN2;
}

/** x^y for x ≥ 0. */
export function pow(x: number, y: number): number {
  R[0] = x;
  R[1] = y;
  powR();
  return R[0];
}

/** sin(πx). */
export function sinPi(x: number): number {
  R[0] = x;
  sinPiR();
  return R[0];
}

/** cos(πx). */
export function cosPi(x: number): number {
  return sinPi(x + 0.5);
}

/** sin x (radians). */
export function sin(x: number): number {
  return sinPi(x * INV_PI);
}

/** cos x (radians). */
export function cos(x: number): number {
  return sinPi(x * INV_PI + 0.5);
}

/** tan x (radians), |x| < π/2. */
export function tan(x: number): number {
  const u = x * INV_PI;
  return sinPi(u) / sinPi(u + 0.5);
}

/** atan2(y, x). */
export function atan2(y: number, x: number): number {
  R[0] = y;
  R[1] = x;
  atan2R();
  return R[0];
}
