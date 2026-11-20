/** Property tests for core/rng.ts (fast-check). */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Purpose, hash32, mix32, rand, toUnit } from '../../../src/core/rng';

const purposes = fc.constantFrom(
  Purpose.Stagger,
  Purpose.Jitter,
  Purpose.Order,
  Purpose.WalkPick,
  Purpose.WalkStep,
  Purpose.BassLeap,
  Purpose.Birth,
  Purpose.MergeWhich,
);
const part = fc.oneof(fc.string(), fc.integer(), fc.double());

describe('rng properties', () => {
  it('rand is deterministic and in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.string(), fc.nat(), purposes, (seed, voice, step, purpose) => {
        const a = rand(seed, voice, step, purpose);
        expect(a).toBe(rand(seed, voice, step, purpose));
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }),
    );
  });

  it('hash32 always returns a uint32 and is deterministic', () => {
    fc.assert(
      fc.property(fc.array(part, { maxLength: 6 }), (parts) => {
        const h = hash32(...parts);
        expect(h).toBe(hash32(...parts));
        expect(h >>> 0).toBe(h);
      }),
    );
  });

  it('mix32 is a function of the arguments modulo 2³²', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer(), fc.integer(), (a, b, c, d) => {
        expect(mix32(a, b, c, d)).toBe(mix32(a >>> 0, b | 0, c + 2 ** 32, d - 2 ** 32));
      }),
    );
  });

  it('toUnit is monotone in the uint32', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xffffffff }), fc.nat({ max: 0xffffffff }), (a, b) => {
        if (a < b) expect(toUnit(a)).toBeLessThan(toUnit(b));
      }),
    );
  });
});
