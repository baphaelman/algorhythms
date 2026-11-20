/** Unit tests for core/rng.ts (PLAN.md §7.7). */

import { describe, expect, it } from 'vitest';
import {
  Purpose,
  base62Id,
  hash32,
  mix32,
  momentSeed,
  rand,
  randHashed,
  randInt,
  toUnit,
} from '../../../src/core/rng';

describe('fixed values (any change alters every saved piece)', () => {
  it('mix32 is murmur3_32 over four little-endian words, seed 0', () => {
    // Cross-checked against an independent reference implementation.
    expect(mix32(1, 2, 3, 4)).toBe(1145416960);
    expect(mix32(0, 0, 0, 0)).toBe(2167721464);
    // Arguments are taken modulo 2³²: 0xffffffff ≡ −1, 2⁴⁰ ≡ 0.
    expect(mix32(0xffffffff, -1, 2 ** 40, 7)).toBe(2196134263);
  });

  it('hash32 snapshots', () => {
    expect(hash32()).toBe(2462723854);
    expect(hash32(0)).toBe(1792828737);
    expect(hash32('v1')).toBe(1602489212);
    expect(hash32(2611, 'k3f9')).toBe(3868068045);
    expect(hash32(-1)).toBe(2268587171);
    expect(hash32(0.5)).toBe(4190512255);
    expect(hash32(NaN)).toBe(3038924205);
  });

  it('rand, momentSeed and base62Id snapshots', () => {
    expect(momentSeed(2611, 'k3f9')).toBe(3868068045);
    expect(momentSeed(2611, 'k3f9', 42)).toBe(42);
    expect(rand(momentSeed(2611, 'k3f9'), 'v7', 12, Purpose.WalkStep)).toBe(0.5894188778474927);
    expect(rand(123456789, 'v1', 0, Purpose.Stagger)).toBe(0.5679574590176344);
    expect(base62Id(2611)).toBe('7nfmLc');
  });

  it('purpose codes are never renumbered', () => {
    expect([
      Purpose.Stagger,
      Purpose.Jitter,
      Purpose.Order,
      Purpose.WalkPick,
      Purpose.WalkStep,
      Purpose.BassLeap,
      Purpose.Birth,
      Purpose.MergeWhich,
      Purpose.Phase,
      Purpose.Detune,
      Purpose.GenTiming,
      Purpose.GenChord,
      Purpose.GenRegister,
      Purpose.GenId,
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});

describe('hash32', () => {
  it('returns uint32s', () => {
    for (const parts of [[], [0], ['x'], [-5, 'y', 1e300], [Infinity], [-Infinity]] as const) {
      const h = hash32(...parts);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('keeps part boundaries and kinds apart', () => {
    expect(hash32('ab', 'c')).not.toBe(hash32('a', 'bc'));
    expect(hash32('abc')).not.toBe(hash32('ab', 'c'));
    expect(hash32(1)).not.toBe(hash32('1'));
    expect(hash32('a')).not.toBe(hash32(97));
    expect(hash32(-1)).not.toBe(hash32(0xffffffff));
    expect(hash32(1, 2)).not.toBe(hash32(2, 1));
    expect(hash32('')).not.toBe(hash32());
    expect(hash32(2 ** 32)).not.toBe(hash32(0));
  });

  it('treats −0 as 0', () => {
    expect(hash32(-0)).toBe(hash32(0));
  });

  it('is a function of its parts only', () => {
    expect(hash32(2611, 'k3f9')).toBe(hash32(2611, 'k3f9'));
  });
});

describe('draws', () => {
  it('toUnit maps uint32 onto [0, 1)', () => {
    expect(toUnit(0)).toBe(0);
    expect(toUnit(0x80000000)).toBe(0.5);
    expect(toUnit(0xffffffff)).toBeLessThan(1);
    expect(toUnit(-1)).toBe(toUnit(0xffffffff));
  });

  it('momentSeed normalises the override to uint32', () => {
    expect(momentSeed(1, 'abc', -1)).toBe(0xffffffff);
    expect(momentSeed(1, 'abc', 0)).toBe(0);
  });

  it('randHashed equals rand', () => {
    expect(randHashed(77, hash32('v3'), 5, Purpose.Jitter)).toBe(rand(77, 'v3', 5, Purpose.Jitter));
  });

  it('randInt stays in [0, n)', () => {
    for (let s = 0; s < 1000; s++) {
      const k = randInt(9, 'v1', s, Purpose.WalkStep, 4);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(4);
      expect(Number.isInteger(k)).toBe(true);
    }
  });

  it('is roughly uniform (chi-square over 32 bins)', () => {
    const bins = new Array<number>(32).fill(0);
    const n = 64000;
    for (let i = 0; i < n; i++) bins[Math.floor(rand(12345, 'v1', i, Purpose.WalkPick) * 32)]++;
    const expected = n / 32;
    const chi2 = bins.reduce((s, b) => s + ((b - expected) * (b - expected)) / expected, 0);
    // 31 degrees of freedom: p = 0.001 at about 61.1.
    expect(chi2).toBeLessThan(61.1);
    const mean = (() => {
      let s = 0;
      for (let i = 0; i < n; i++) s += rand(999, 'v2', i, Purpose.Jitter);
      return s / n;
    })();
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
  });

  it('is independent across purposes, steps, voices and seeds', () => {
    const n = 20000;
    const corr = (f: (i: number) => number, g: (i: number) => number): number => {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        const x = f(i);
        const y = g(i);
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
      const cov = sxy / n - (sx / n) * (sy / n);
      return cov / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
    };
    const limit = 4 / Math.sqrt(n); // about 4 standard errors
    // Same key, different purpose.
    expect(
      Math.abs(
        corr(
          (i) => rand(5, 'v1', i, Purpose.WalkPick),
          (i) => rand(5, 'v1', i, Purpose.WalkStep),
        ),
      ),
    ).toBeLessThan(limit);
    // Consecutive steps.
    expect(
      Math.abs(
        corr(
          (i) => rand(5, 'v1', i, Purpose.Stagger),
          (i) => rand(5, 'v1', i + 1, Purpose.Stagger),
        ),
      ),
    ).toBeLessThan(limit);
    // Neighbouring voices.
    expect(
      Math.abs(
        corr(
          (i) => rand(5, 'v1', i, Purpose.Jitter),
          (i) => rand(5, 'v2', i, Purpose.Jitter),
        ),
      ),
    ).toBeLessThan(limit);
    // Consecutive seeds.
    expect(
      Math.abs(
        corr(
          (i) => rand(i, 'v1', 0, Purpose.Order),
          (i) => rand(i + 1, 'v1', 0, Purpose.Order),
        ),
      ),
    ).toBeLessThan(limit);
  });

  it('avalanches: flipping one input bit flips about half the output bits', () => {
    const popcount = (x: number): number => {
      let c = 0;
      for (let v = x >>> 0; v; v &= v - 1) c++;
      return c;
    };
    let total = 0;
    let count = 0;
    for (let i = 0; i < 200; i++) {
      const base = mix32(i, i * 7, i * 13, 3);
      for (let bit = 0; bit < 32; bit++) {
        total += popcount(base ^ mix32(i ^ (1 << bit), i * 7, i * 13, 3));
        count++;
      }
    }
    expect(Math.abs(total / count - 16)).toBeLessThan(0.3);
  });
});

describe('base62Id', () => {
  it('gives six base62 characters', () => {
    for (let k = 0; k < 500; k++) expect(base62Id(hash32('m', k))).toMatch(/^[0-9A-Za-z]{6}$/);
  });

  it('uses every first character (not just a few, as a plain uint32 → base62 would)', () => {
    const first = new Set<string>();
    for (let k = 0; k < 5000; k++) first.add(base62Id(k)[0]);
    expect(first.size).toBe(62);
  });
});
