/**
 * core/ease.ts against native-Math references (allowed in tests): every ease within 1e-4 (in
 * practice ~1e-12), exact endpoints, monotone standard eases, and derivatives.
 */

import { describe, expect, it } from 'vitest';
import {
  type BezierParams,
  EaseCode,
  bezierOf,
  cosPi,
  ease,
  easeCodeOf,
  easeDeriv,
  easeSlope0,
  exp2,
  sinPi,
} from '../../src/core/ease';

const N = 4000;
const xs = Array.from({ length: N + 1 }, (_, i) => i / N);

/** Ease-in-out exponential, normalised through 0, 1/2 and 1 (the definition in ease.ts). */
function expoRef(x: number): number {
  const a = 2 ** -10;
  return x <= 0.5
    ? (Math.pow(2, 20 * x - 10) - a) / (2 * (1 - a))
    : 1 - (Math.pow(2, 10 - 20 * x) - a) / (2 * (1 - a));
}

/** CSS cubic-bezier by 200 bisection steps on t: slow and simple. */
function bezierRef(x: number, { x1, y1, x2, y2 }: BezierParams): number {
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

const REFERENCES: [string, EaseCode, (x: number) => number][] = [
  ['smootherstep', EaseCode.Smootherstep, (x) => 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3],
  ['smoothstep', EaseCode.Smoothstep, (x) => 3 * x ** 2 - 2 * x ** 3],
  ['cosine', EaseCode.Cosine, (x) => (1 - Math.cos(Math.PI * x)) / 2],
  ['linear', EaseCode.Linear, (x) => x],
  ['expo', EaseCode.Expo, expoRef],
];

const BEZIERS: BezierParams[] = [
  { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }, // CSS "ease"
  { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, // ease-in-out
  { x1: 0, y1: 0, x2: 1, y2: 1 }, // linear
  { x1: 0.68, y1: -0.55, x2: 0.265, y2: 1.55 }, // back in-out: overshoots both ends
  { x1: 0, y1: 1, x2: 1, y2: 0 }, // x1 = 0: vertical-ish start
  { x1: 1, y1: 0, x2: 0, y2: 1 }, // vertical tangent mid-way
];

describe('standard eases', () => {
  it.each(REFERENCES)('%s matches its native-Math reference within 1e-4', (_n, code, ref) => {
    let worst = 0;
    for (const x of xs) worst = Math.max(worst, Math.abs(ease(code, x) - ref(x)));
    expect(worst).toBeLessThan(1e-4);
    expect(worst).toBeLessThan(1e-10); // the approximations are far better than required
  });

  it.each(REFERENCES)('%s: e(0) = 0 and e(1) = 1 exactly; clamps outside [0, 1]', (_n, code) => {
    expect(ease(code, 0)).toBe(0);
    expect(ease(code, 1)).toBe(1);
    expect(ease(code, -3)).toBe(0);
    expect(ease(code, 7)).toBe(1);
  });

  it.each(REFERENCES)('%s is monotone non-decreasing', (_n, code) => {
    let prev = ease(code, 0);
    for (let i = 1; i <= 100_000; i++) {
      const y = ease(code, i / 100_000);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('smootherstep is monotone next to 1 (property seed 353562081)', () => {
    // The direct polynomial gave 0.9999999999999999 here and 0.9999999999999987 at the larger x.
    const lo = ease(EaseCode.Smootherstep, 0.9999970971090307);
    const hi = ease(EaseCode.Smootherstep, 0.9999999999995448);
    expect(lo).toBeLessThanOrEqual(hi);
    expect(hi).toBe(1);
    // A dense sweep over the last 2^-12 before 1, where the old form dipped by up to 4e-15.
    let prev = 0;
    let dips = 0;
    for (let k = 1 << 18; k >= 0; k--) {
      const y = ease(EaseCode.Smootherstep, 1 - k * 2 ** -30);
      if (y < prev) dips++;
      prev = y;
    }
    expect(dips).toBe(0);
  });

  it.each(REFERENCES)('%s: e(1/2) = 1/2 (all are symmetric)', (_n, code) => {
    expect(ease(code, 0.5)).toBeCloseTo(0.5, 14);
  });
});

describe('bezier (CSS cubic-bezier semantics)', () => {
  it.each(BEZIERS)('matches a bisection reference within 1e-4: %o', (bz) => {
    let worst = 0;
    for (const x of xs)
      worst = Math.max(worst, Math.abs(ease(EaseCode.Bezier, x, bz) - bezierRef(x, bz)));
    expect(worst).toBeLessThan(1e-4);
    // Near a vertical tangent x ∝ (t − t*)^k, so a 1e-16 rounding in x moves t by ~1e-6: the last
    // two curves are ill-conditioned for any double-precision solver, including the reference.
    if (BEZIERS.indexOf(bz) < 4) expect(worst).toBeLessThan(1e-9);
  });

  it.each(BEZIERS)('e(0) = 0 and e(1) = 1 exactly: %o', (bz) => {
    expect(ease(EaseCode.Bezier, 0, bz)).toBe(0);
    expect(ease(EaseCode.Bezier, 1, bz)).toBe(1);
  });

  it('overshooting control points overshoot', () => {
    const back = BEZIERS[3];
    const ys = xs.map((x) => ease(EaseCode.Bezier, x, back));
    expect(Math.min(...ys)).toBeLessThan(-0.05);
    expect(Math.max(...ys)).toBeGreaterThan(1.05);
  });
});

describe('derivatives', () => {
  const h = 1e-6;
  const cases: [string, EaseCode, BezierParams | undefined][] = [
    ...REFERENCES.map(([n, c]): [string, EaseCode, undefined] => [n, c, undefined]),
    ['bezier ease', EaseCode.Bezier, BEZIERS[0]],
    ['bezier back', EaseCode.Bezier, BEZIERS[3]],
  ];

  it.each(cases)('%s: easeDeriv matches central differences', (_n, code, bz) => {
    for (let i = 1; i < 200; i++) {
      const x = i / 200;
      const fd = (ease(code, x + h, bz) - ease(code, x - h, bz)) / (2 * h);
      expect(easeDeriv(code, x, bz)).toBeCloseTo(fd, 4);
    }
  });

  it('slopes at 0 (§7.5: e′(0) enters m0)', () => {
    expect(easeSlope0(EaseCode.Smootherstep)).toBe(0);
    expect(easeSlope0(EaseCode.Smoothstep)).toBe(0);
    expect(easeSlope0(EaseCode.Cosine)).toBe(0);
    expect(easeSlope0(EaseCode.Linear)).toBe(1);
    expect(easeSlope0(EaseCode.Expo)).toBeCloseTo((10 * Math.LN2) / 1023, 15);
    expect(easeSlope0(EaseCode.Expo)).toBeCloseTo((expoRef(1e-7) - expoRef(0)) / 1e-7, 6);
    expect(easeSlope0(EaseCode.Bezier, { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })).toBeCloseTo(
      0.4,
      15,
    );
    // CSS: x1 = 0 falls back to the tangent through P2, else flat
    expect(easeSlope0(EaseCode.Bezier, { x1: 0, y1: 0.5, x2: 0.5, y2: 1 })).toBe(2);
    expect(easeSlope0(EaseCode.Bezier, { x1: 0, y1: 0.5, x2: 0, y2: 1 })).toBe(0);
  });

  it('easeDeriv at the ends returns the end slopes', () => {
    for (const [, code] of REFERENCES) {
      expect(easeDeriv(code, 0)).toBe(easeSlope0(code));
    }
    expect(easeDeriv(EaseCode.Smootherstep, 1)).toBe(0);
    expect(easeDeriv(EaseCode.Linear, 1)).toBe(1);
  });
});

describe('EaseRef mapping', () => {
  it('maps every named ease and bezier', () => {
    expect(easeCodeOf('smootherstep')).toBe(EaseCode.Smootherstep);
    expect(easeCodeOf('smoothstep')).toBe(EaseCode.Smoothstep);
    expect(easeCodeOf('cosine')).toBe(EaseCode.Cosine);
    expect(easeCodeOf('linear')).toBe(EaseCode.Linear);
    expect(easeCodeOf('expo')).toBe(EaseCode.Expo);
    const bz = { kind: 'bezier' as const, x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 };
    expect(easeCodeOf(bz)).toBe(EaseCode.Bezier);
    expect(bezierOf(bz)).toBe(bz);
    expect(bezierOf('linear')).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });
});

describe('portable helpers', () => {
  it('sinPi and cosPi match Math.sin/cos within 1e-12 over many periods', () => {
    for (let i = -4000; i <= 4000; i++) {
      const x = i / 997;
      expect(Math.abs(sinPi(x) - Math.sin(Math.PI * x))).toBeLessThan(1e-12);
      expect(Math.abs(cosPi(x) - Math.cos(Math.PI * x))).toBeLessThan(1e-12);
    }
  });

  it('sinPi is exact at the quarter points', () => {
    expect(sinPi(0)).toBe(0);
    expect(sinPi(0.5)).toBe(1);
    expect(sinPi(-0.5)).toBe(-1);
    expect(sinPi(1)).toBe(0);
    expect(sinPi(1.5)).toBe(-1);
    expect(Math.abs(sinPi(17))).toBe(0);
  });

  it('exp2 matches 2 ** y within 1e-12 relative and is exact on integers', () => {
    for (let i = -3000; i <= 3000; i++) {
      const y = i / 97;
      const ref = 2 ** y;
      expect(Math.abs(exp2(y) - ref) / ref).toBeLessThan(1e-12);
    }
    for (let n = -60; n <= 60; n++) expect(exp2(n)).toBe(2 ** n);
    expect(exp2(NaN)).toBeNaN();
    expect(exp2(5000)).toBe(Infinity);
    expect(exp2(-5000)).toBe(0);
  });

  it('exp2 is monotone across integer boundaries', () => {
    for (let n = -12; n <= 12; n++) {
      expect(exp2(n - 1e-12)).toBeLessThanOrEqual(exp2(n));
      expect(exp2(n)).toBeLessThanOrEqual(exp2(n + 1e-12));
    }
  });
});
