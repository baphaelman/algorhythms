/** Unit tests for core/math.ts (PLAN.md §7.11). Native Math is fine here, as a reference. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as ease from '../../../src/core/ease';
import { clamp, cosPi, exp2, lerp, log2, mod, sinPi } from '../../../src/core/math';

describe('re-exports', () => {
  it('sinPi, cosPi and exp2 are the ease.ts functions, not copies', () => {
    expect(sinPi).toBe(ease.sinPi);
    expect(cosPi).toBe(ease.cosPi);
    expect(exp2).toBe(ease.exp2);
  });
});

describe('log2', () => {
  it('is exact on powers of two, including subnormals', () => {
    for (let e = -1074; e <= 1023; e++) expect(log2(2 ** e)).toBe(e);
  });

  it('matches Math.log2 to about 1 ulp', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-300, max: 1e300, noNaN: true }), (x) => {
        const ref = Math.log2(x);
        expect(Math.abs(log2(x) - ref)).toBeLessThanOrEqual(Math.max(Math.abs(ref), 1) * 4e-16);
      }),
      { numRuns: 5000 },
    );
    for (const x of [1.5, 3, 10, 440 / 261.6255653005986, 0.1, 1e-310]) {
      expect(log2(x)).toBeCloseTo(Math.log2(x), 14);
    }
  });

  it('handles the edges', () => {
    expect(log2(0)).toBe(-Infinity);
    expect(log2(-0)).toBe(-Infinity);
    expect(log2(Infinity)).toBe(Infinity);
    expect(log2(-1)).toBeNaN();
    expect(log2(NaN)).toBeNaN();
    expect(log2(1)).toBe(0);
  });

  it('inverts exp2', () => {
    fc.assert(
      fc.property(fc.double({ min: -60, max: 60, noNaN: true }), (y) => {
        expect(log2(exp2(y))).toBeCloseTo(y, 11);
      }),
    );
  });
});

describe('small helpers', () => {
  it('clamp, lerp, mod', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(lerp(2, 4, 0.25)).toBe(2.5);
    expect(mod(-1, 12)).toBe(11);
    expect(mod(25, 12)).toBe(1);
    expect(Object.is(mod(-12, 12), 0)).toBe(true);
    expect(mod(-0.5, 12)).toBe(11.5);
  });
});
