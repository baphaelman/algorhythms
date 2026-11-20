/**
 * Interruption with carried velocity and the overshoot clamp (PLAN.md §7.5).
 *
 * A move starting at t₀ while the voice is mid-glide keeps the ease the moment asked for and adds
 * a velocity term that dies away:
 *
 *   p(x) = p₀ + (p₁ − p₀)·e(x) + m₀·H(x),   H(x) = x(1 − x)²,   m₀ = v·d − (p₁ − p₀)·e′(0)
 *
 * so the join is C¹. When the carried velocity makes the curve overshoot [min(p₀,p₁), max(p₀,p₁)]
 * by more than the limit L, m₀ is scaled down until the curve fits (at the 64 check points and in
 * between, see overshootScale), and the segment is flagged `clamped` (C⁰ join only).
 *
 * The limits are given separately above and below, so the caller can include the room left to the
 * voice's range (§7.8) next to min(1 semitone, gap to the neighbour under `ordered`).
 */

import { bezierOf, EaseCode, easeCodeOf, easeRaw, easeSlope0 } from './ease';
import type { EaseRef, Pitch, Seconds, Segment } from './types';

/** Local aliases for the hot paths: under Vitest's module runner an imported binding is a getter. */
const easeAt = easeRaw;
const BEZIER = EaseCode.Bezier;

/** Number of points (x = i/63) at which overshoot and crossings are checked (§7.2, §7.5). */
export const CHECK_SAMPLES = 64;

/** The largest overshoot ever allowed, in semitones (§7.5). */
export const MAX_OVERSHOOT = 1;

/** Bisection steps for the clamp: the scale on m₀ is found to 2⁻³⁰. */
const BISECT_STEPS = 30;

/** A voice's pitch and velocity at the moment a move starts. */
export interface StartState {
  /** Pitch at t₀. */
  p: Pitch;
  /** dp/dt at t₀ in semitones per second (0 when holding). */
  v: number;
  /** True when the voice is mid-glide, so the interruption rule applies (§7.1 move-start). */
  mid: boolean;
}

/** How far the curve may leave [min(p₀,p₁), max(p₀,p₁)], above and below, in semitones. */
export interface OvershootLimits {
  up: number;
  down: number;
}

/** No neighbour constraint: the §7.5 cap of 1 semitone each way. */
export const FREE_LIMITS: OvershootLimits = Object.freeze({
  up: MAX_OVERSHOOT,
  down: MAX_OVERSHOOT,
});

/** H(x) = x(1 − x)² at the check points x = i/63. */
const H_TABLE: Float64Array = (() => {
  const h = new Float64Array(CHECK_SAMPLES);
  for (let i = 0; i < CHECK_SAMPLES; i++) {
    const x = i / (CHECK_SAMPLES - 1);
    h[i] = x * (1 - x) * (1 - x);
  }
  return h;
})();

/** e(x) of the named eases at the check points (the same values easeRaw returns). */
const EASE_TABLES: readonly Float64Array[] = [
  EaseCode.Smootherstep,
  EaseCode.Smoothstep,
  EaseCode.Cosine,
  EaseCode.Linear,
  EaseCode.Expo,
].map((code) => {
  const t = new Float64Array(CHECK_SAMPLES);
  for (let i = 0; i < CHECK_SAMPLES; i++) t[i] = easeRaw(code, i / (CHECK_SAMPLES - 1), 0, 0, 1, 1);
  return t;
});

/** max H(x) = H(1/3) = 4/27. */
const H_MAX = 4 / 27;

/** Scratch: p₀ + (p₁ − p₀)·e(x) at the check points. The compiler is single-threaded. */
const BASE = new Float64Array(CHECK_SAMPLES);

/**
 * Largest s ∈ [0, 1] such that the curve with m₀·s stays within the limits (§7.5 "scale m₀ down
 * by bisection until it fits"). The constraint is linear in s at each point, so the bound is
 * computed directly from the 64 check points, then refined between them (see below) so that it
 * also holds for the continuous curve, which §7.8's ranges need; bisection remains the fallback
 * if rounding makes the direct value fail. The ease's own overshoot (a bézier with y outside
 * [0, 1]) is the user's choice and is added to the allowance, so only the carried velocity is
 * limited. Returns 1 when no clamp is needed.
 */
export function overshootScale(
  p0: Pitch,
  p1: Pitch,
  code: EaseCode,
  ease: EaseRef,
  m0: number,
  limits: OvershootLimits,
): number {
  if (m0 === 0) return 1;
  // Exact shortcut for eases within [0, 1]: p₀ + (p₁ − p₀)·e stays in [lo, hi] and
  // 0 ≤ H ≤ 4/27, so the curve leaves the range by at most |m₀|·4/27, on m₀'s side.
  if (code !== BEZIER) {
    const reach = (m0 < 0 ? -m0 : m0) * H_MAX;
    if (reach <= (m0 > 0 ? limits.up : limits.down)) return 1;
  }
  const bz = bezierOf(ease);
  const lo = p0 < p1 ? p0 : p1;
  const hi = p0 < p1 ? p1 : p0;
  const d = p1 - p0;
  let baseMax = hi;
  let baseMin = lo;
  const table = code === BEZIER ? null : EASE_TABLES[code];
  for (let i = 0; i < CHECK_SAMPLES; i++) {
    const e = table ? table[i] : easeAt(code, i / (CHECK_SAMPLES - 1), bz.x1, bz.y1, bz.x2, bz.y2);
    const b = p0 + d * e;
    BASE[i] = b;
    if (b > baseMax) baseMax = b;
    if (b < baseMin) baseMin = b;
  }
  const ceil = baseMax + (limits.up > 0 ? limits.up : 0);
  const floor = baseMin - (limits.down > 0 ? limits.down : 0);
  // At each x the curve is linear in the scale s on m₀ (base + s·m₀·H), and m₀·H pushes towards
  // one side only, so the largest s that keeps the curve inside is the infimum over x of
  // r(x) = (side − base(x)) / (m₀·H(x)). The minimum over the 64 check points (what the
  // bisection of §7.5 converges to) overestimates it between the points: by a first-order amount
  // in the end intervals, where H → 0 (a newborn leaving its range edge dipped 0.002 semitones out
  // before x = 1/63), and by a second-order amount around interior minima. So the end intervals
  // and the sampled interior minima are refined by golden-section search, and the clamp holds for
  // the continuous curve, not only at the samples (§7.8 ranges, §7.2's tightened clamp).
  const side = m0 > 0 ? ceil : floor;
  const last = CHECK_SAMPLES - 2;
  for (let i = 1; i <= last; i++) RATIO[i] = (side - BASE[i]) / (m0 * H_TABLE[i]);
  RATIO[0] = Infinity;
  RATIO[CHECK_SAMPLES - 1] = Infinity;
  const ratioAt = (x: number): number =>
    (side - (p0 + d * easeAt(code, x, bz.x1, bz.y1, bz.x2, bz.y2))) / (m0 * x * (1 - x) * (1 - x));
  const step = 1 / (CHECK_SAMPLES - 1);
  let exact = 1;
  for (let i = 1; i <= last; i++) if (RATIO[i] < exact) exact = RATIO[i];
  // Room to the side at the bracket ends, |side − base|, for the skip test below.
  const room = (j: number): number => (m0 > 0 ? side - BASE[j] : BASE[j] - side);
  const am0 = m0 > 0 ? m0 : -m0;
  for (let i = 1; i <= last; i++) {
    const r = RATIO[i];
    const end = i === 1 || i === last;
    if (!end && !(r <= RATIO[i - 1] && r <= RATIO[i + 1] && r < REFINE_BELOW)) continue;
    // Named eases are monotone, so over [x_{i−1}, x_{i+1}] the room is at least its smaller end
    // value and H at most its larger end value (or 4/27 around x = 1/3): when that lower bound on
    // r already reaches the current minimum, the search cannot lower it.
    if (table) {
      const hA = H_TABLE[i - 1];
      const hB = H_TABLE[i + 1];
      const hMax = i - 1 <= 21 && i + 1 >= 21 ? H_MAX : hA > hB ? hA : hB;
      const rA = room(i - 1);
      const rB = room(i + 1);
      if ((rA < rB ? rA : rB) >= exact * am0 * hMax) continue;
    }
    const a = i === 1 ? EDGE : (i - 1) * step;
    const b = i === last ? 1 - EDGE : (i + 1) * step;
    const m = goldenMin(ratioAt, a, b);
    if (m < exact) exact = m;
  }
  if (exact >= 1) return 1;
  if (exact > 0) {
    exact *= 1 - 1e-9;
    if (fits(m0 * exact, ceil, floor)) return exact;
  } else {
    return 0;
  }
  let ok = 0;
  let bad = exact;
  for (let k = 0; k < BISECT_STEPS; k++) {
    const mid = (ok + bad) * 0.5;
    if (fits(m0 * mid, ceil, floor)) ok = mid;
    else bad = mid;
  }
  return ok;
}

/** Scratch: per-point scale bounds r(x) at the check points (ends are +∞). */
const RATIO = new Float64Array(CHECK_SAMPLES);
/** Interior sampled minima of r below this are refined (others cannot drop below 1 in between). */
const REFINE_BELOW = 2;
/** The end intervals are searched from this distance to x = 0 and x = 1 (H vanishes there). */
const EDGE = 1e-9;
const GOLDEN_STEPS = 48;
const INV_PHI = 0.6180339887498949;

/** Minimum of f over [a, b] by golden-section search (f unimodal there); the smallest value seen. */
function goldenMin(f: (x: number) => number, a: number, b: number): number {
  let c = b - (b - a) * INV_PHI;
  let e = a + (b - a) * INV_PHI;
  let fc = f(c);
  let fe = f(e);
  let best = fc < fe ? fc : fe;
  for (let k = 0; k < GOLDEN_STEPS; k++) {
    if (fc < fe) {
      b = e;
      e = c;
      fe = fc;
      c = b - (b - a) * INV_PHI;
      fc = f(c);
      if (fc < best) best = fc;
    } else {
      a = c;
      c = e;
      fc = fe;
      e = a + (b - a) * INV_PHI;
      fe = f(e);
      if (fe < best) best = fe;
    }
  }
  const fa = f(a);
  const fb = f(b);
  if (fa < best) best = fa;
  if (fb < best) best = fb;
  return best;
}

function fits(m: number, ceil: number, floor: number): boolean {
  for (let i = 1; i < CHECK_SAMPLES - 1; i++) {
    const y = BASE[i] + m * H_TABLE[i];
    if (y > ceil || y < floor) return false;
  }
  return true;
}

/** m₀ after the overshoot clamp, and whether the clamp applied (§7.5). */
export interface CarriedVelocity {
  m0: number;
  clamped: boolean;
}

/**
 * The carried-velocity term of a move from `start` over d seconds to p₁ (§7.5), after the
 * overshoot clamp. Holding voices carry nothing. An infinite e′(0) (a bézier with a vertical start
 * tangent) contributes nothing, since no finite m₀ could match it.
 */
export function carriedVelocity(
  start: StartState,
  d: Seconds,
  p1: Pitch,
  ease: EaseRef,
  limits: OvershootLimits,
): CarriedVelocity {
  if (!start.mid) return { m0: 0, clamped: false };
  const code = easeCodeOf(ease);
  const s0 = easeSlope0(code, bezierOf(ease));
  const p0 = start.p;
  const m0 = start.v * d - (Number.isFinite(s0) ? (p1 - p0) * s0 : 0);
  if (m0 === 0) return { m0: 0, clamped: false };
  const s = overshootScale(p0, p1, code, ease, m0, limits);
  return s < 1 ? { m0: m0 * s, clamped: true } : { m0, clamped: false };
}

/** The segment of a move from a carried-velocity term; `crossScale` < 1 tightens it (§7.2). */
export function segmentFromCarried(
  p0: Pitch,
  t0: Seconds,
  d: Seconds,
  p1: Pitch,
  ease: EaseRef,
  carried: CarriedVelocity,
  crossScale = 1,
  momentId?: string,
): Segment {
  const seg: Segment = { t0, t1: t0 + d, p0, p1, ease };
  let m0 = carried.m0;
  let clamped = carried.clamped;
  if (m0 !== 0 && crossScale < 1) {
    m0 *= crossScale > 0 ? crossScale : 0;
    clamped = true;
  }
  if (m0 !== 0) seg.m0 = m0;
  if (clamped) seg.clamped = true;
  if (momentId !== undefined) seg.momentId = momentId;
  return seg;
}

/**
 * The segment of a move starting at t₀ from `start`, lasting d seconds, to p₁ (§7.5).
 *
 * - Holding voices (`start.mid` false) get a plain eased glide (m₀ = 0).
 * - Mid-glide voices carry their velocity: m₀ = v·d − (p₁ − p₀)·e′(0).
 * - The overshoot clamp scales m₀ to fit `limits`; `crossScale` (< 1 when the crossing check had
 *   to tighten it, §7.2) scales it further. Either sets `clamped`.
 */
export function buildMoveSegment(
  start: StartState,
  t0: Seconds,
  d: Seconds,
  p1: Pitch,
  ease: EaseRef,
  limits: OvershootLimits,
  crossScale = 1,
  momentId?: string,
): Segment {
  const carried = carriedVelocity(start, d, p1, ease, limits);
  return segmentFromCarried(start.p, t0, d, p1, ease, carried, crossScale, momentId);
}
