/**
 * Preset files round-trip exactly (PLAN.md §15 M6): any valid timbre, saved and loaded, comes
 * back deep-equal, and saving it again gives the same text. Out-of-range values are refused.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TimbreSchema } from '../../../src/core/schema';
import { parseTimbrePreset, serializeTimbrePreset } from '../../../src/core/timbre-preset';
import type { Timbre } from '../../../src/core/types';

/** A finite double in [min, max] (no −0: JSON writes it as 0). */
const num = (min: number, max: number, opts: { minExcluded?: boolean } = {}) =>
  fc
    .double({ min, max, noNaN: true, noDefaultInfinity: true, ...opts })
    .map((x) => (Object.is(x, -0) ? 0 : x));
const nonNeg = (max = 1e6) => num(0, max);

const timbre: fc.Arbitrary<Timbre> = fc.record(
  {
    harmonics: fc.array(num(-1e3, 1e3), { maxLength: 32 }),
    stretch: num(-0.5, 1),
    fm: fc.record(
      {
        ratio: num(0, 32, { minExcluded: true }),
        index: num(0, 20),
        indexTrack: num(-4, 4),
        held: num(0, 1),
      },
      { requiredKeys: ['ratio', 'index', 'indexTrack'] },
    ),
    strikePartials: fc.array(
      fc.record({
        ratio: num(0, 32, { minExcluded: true }),
        amp: num(0, 4),
        decay: num(0, 60, { minExcluded: true }),
      }),
      { maxLength: 16 },
    ),
    noise: fc.record({ level: num(0, 4), bandwidth: num(0, 8, { minExcluded: true }) }),
    brightness: fc.record({ tilt: num(-1e3, 1e3), track: num(-1e3, 1e3) }),
    detuneSpread: nonNeg(),
    accent: num(-1e3, 1e3),
    articulation: fc.record(
      { amount: num(-10, 10), attack: nonNeg(), decay: nonNeg(), crisp: fc.boolean() },
      { requiredKeys: ['amount', 'attack', 'decay'] },
    ),
    vibrato: fc.record(
      { rate: nonNeg(), depthCents: nonNeg(), delay: nonNeg(), jitter: num(0, 1) },
      { requiredKeys: ['rate', 'depthCents', 'delay'] },
    ),
    formants: fc.array(
      fc.record({
        hz: num(0, 2e4, { minExcluded: true }),
        bw: num(0, 2e4, { minExcluded: true }),
        gain: nonNeg(10),
      }),
      { maxLength: 8 },
    ),
    drift: fc.record(
      { cents: nonNeg(100), rate: nonNeg(10), amp: nonNeg(1) },
      { requiredKeys: ['cents', 'rate'] },
    ),
    wobble: num(0, 100),
  },
  {
    requiredKeys: [
      'harmonics',
      'stretch',
      'brightness',
      'detuneSpread',
      'accent',
      'articulation',
      'vibrato',
    ],
  },
) as fc.Arbitrary<Timbre>;

const name = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => s.trim() === s && s.length > 0);

describe('timbre preset round trip', () => {
  it('any valid timbre comes back deep-equal, and saves to the same text', () => {
    fc.assert(
      fc.property(name, timbre, (n, t) => {
        expect(TimbreSchema.safeParse(t).success).toBe(true);
        const text = serializeTimbrePreset(n, t);
        const r = parseTimbrePreset(text);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.name).toBe(n);
        // fast-check's records have no prototype; compare as plain JSON values.
        expect(r.timbre).toStrictEqual(JSON.parse(JSON.stringify(t)));
        expect(r.warnings).toEqual([]);
        expect(serializeTimbrePreset(r.name, r.timbre)).toBe(text);
      }),
      { numRuns: 300 },
    );
  });

  it('refuses a timbre with one bounded field pushed out of range', () => {
    const outside = fc.oneof(
      num(1, 1e3, { minExcluded: true }).map((x) => ['stretch', x] as const),
      num(-1e3, -0.5, {})
        .filter((x) => x < -0.5)
        .map((x) => ['stretch', x] as const),
      num(32, 1e3, { minExcluded: true }).map((x) => ['fm.ratio', x] as const),
      num(20, 1e3, { minExcluded: true }).map((x) => ['fm.index', x] as const),
      num(1, 1e3, { minExcluded: true }).map((x) => ['fm.held', x] as const),
      num(4, 1e3, { minExcluded: true }).map((x) => ['noise.level', x] as const),
      num(8, 1e3, { minExcluded: true }).map((x) => ['noise.bandwidth', x] as const),
      num(-1e3, 0)
        .filter((x) => x < 0)
        .map((x) => ['detuneSpread', x] as const),
    );
    fc.assert(
      fc.property(timbre, outside, (t, [path, x]) => {
        const bad = structuredClone(t) as unknown as Record<string, Record<string, unknown>>;
        const [a, b] = path.split('.');
        if (b === undefined) (bad as Record<string, unknown>)[a] = x;
        else
          bad[a] = {
            ...(a === 'fm' ? { ratio: 1, index: 1, indexTrack: 0 } : { level: 1, bandwidth: 1 }),
            ...bad[a],
            [b]: x,
          };
        const r = parseTimbrePreset(serializeTimbrePreset('x', bad as unknown as Timbre));
        expect(r.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
