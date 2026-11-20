/** Unit tests for core/tuning.ts. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_HZ, hzOf, pitchOfHz } from '../../../src/core/tuning';

describe('12-TET', () => {
  it('pins A4 and octaves exactly', () => {
    expect(DEFAULT_REFERENCE_HZ).toBe(440);
    expect(hzOf(69)).toBe(440);
    expect(hzOf(81)).toBe(880);
    expect(hzOf(57)).toBe(220);
    expect(hzOf(69, 432)).toBe(432);
    expect(pitchOfHz(440)).toBe(69);
    expect(pitchOfHz(110)).toBe(45);
  });

  it('matches the textbook values', () => {
    expect(hzOf(60)).toBeCloseTo(261.6255653005986, 10);
    expect(hzOf(0)).toBeCloseTo(8.175798915643707, 12);
    expect(hzOf(127)).toBeCloseTo(12543.853951415975, 8);
    expect(hzOf(69.5)).toBeCloseTo(440 * Math.pow(2, 0.5 / 12), 11);
  });

  it('agrees with 440·2^((p − 69)/12) and round-trips', () => {
    fc.assert(
      fc.property(fc.double({ min: -24, max: 160, noNaN: true }), (p) => {
        const ref = 440 * Math.pow(2, (p - 69) / 12);
        expect(Math.abs(hzOf(p) - ref) / ref).toBeLessThan(1e-12);
        expect(pitchOfHz(hzOf(p))).toBeCloseTo(p, 10);
      }),
    );
  });
});
