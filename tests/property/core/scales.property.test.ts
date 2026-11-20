/** Property tests for core/scales.ts (fast-check). */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SCALE_NAMES,
  isScaleTone,
  scaleDegreeIndex,
  snapToScale,
  stepByScale,
} from '../../../src/core/scales';
import type { Key, PitchClass } from '../../../src/core/types';

const tonic = fc.constantFrom<PitchClass>(
  'C',
  'C#',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
);
const builtinKey = fc.record({ tonic, scale: fc.constantFrom(...SCALE_NAMES) });
const customKey = fc.record({
  tonic,
  scale: fc
    .uniqueArray(fc.integer({ min: 1, max: 11 }), { maxLength: 11 })
    .map((rest) => ({ kind: 'custom' as const, intervals: [0, ...rest].sort((a, b) => a - b) })),
});
const key: fc.Arbitrary<Key> = fc.oneof(builtinKey, customKey);
const pitch = fc.double({ min: 0, max: 127, noNaN: true });

describe('scale properties', () => {
  it('snapToScale gives the nearest scale tone, ties down', () => {
    fc.assert(
      fc.property(key, pitch, (k, p) => {
        const q = snapToScale(p, k);
        expect(isScaleTone(q, k)).toBe(true);
        const d = Math.abs(p - q);
        for (let c = Math.floor(p) - 12; c <= Math.ceil(p) + 12; c++) {
          if (!isScaleTone(c, k)) continue;
          const dc = Math.abs(p - c);
          expect(dc).toBeGreaterThanOrEqual(d);
          if (dc === d) expect(q).toBeLessThanOrEqual(c);
        }
      }),
    );
  });

  it('scaleDegreeIndex is monotone in pitch', () => {
    fc.assert(
      fc.property(key, pitch, pitch, (k, a, b) => {
        if (a <= b) expect(scaleDegreeIndex(a, k)).toBeLessThanOrEqual(scaleDegreeIndex(b, k));
      }),
    );
  });

  it('stepping composes and inverts', () => {
    fc.assert(
      fc.property(
        key,
        pitch,
        fc.integer({ min: -20, max: 20 }),
        fc.integer({ min: -20, max: 20 }),
        (k, p, a, b) => {
          const s = snapToScale(p, k);
          expect(stepByScale(stepByScale(p, a, k), b, k)).toBe(stepByScale(p, a + b, k));
          expect(stepByScale(stepByScale(p, a, k), -a, k)).toBe(s);
          if (a > 0) expect(stepByScale(p, a, k)).toBeGreaterThan(s);
          if (a < 0) expect(stepByScale(p, a, k)).toBeLessThan(s);
        },
      ),
    );
  });
});
