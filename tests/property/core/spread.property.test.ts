/**
 * Spread at range edges (PLAN.md §11.3, M4.5-30): with factor ≥ 0, targets keep pitch order, stay
 * in range and are distinct notes, both from the moment function and through the compiler.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { spreadInRange } from '../../../src/core/moments/spread';
import { pitchAt } from '../../../src/core/query';
import { scalePcs } from '../../../src/core/scales';
import type { CompiledScore, Key } from '../../../src/core/types';
import { piece } from '../../unit/core/compiler-fixtures';

// Slowest test under 0.5 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

const RUNS = Number(process.env.PROP_RUNS ?? 200);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);
const params = { numRuns: RUNS, seed: SEED, path: process.env.PROP_PATH };

const KEYS: Key[] = [
  { tonic: 'C', scale: 'major' },
  { tonic: 'D', scale: 'dorian' },
  { tonic: 'F#', scale: 'pentatonic-minor' },
];
const SNAPS = ['scale', 'chromatic', 'none'] as const;

/** Grid pitches (integers on the key, or semitones) in [lo, hi]. */
function capacity(lo: number, hi: number, snap: (typeof SNAPS)[number], key: Key): number {
  const pcs = scalePcs(key);
  let n = 0;
  for (let p = Math.ceil(lo); p <= hi; p++)
    if (snap !== 'scale' || pcs.includes(((p % 12) + 12) % 12)) n++;
  return n;
}

/** A uniform range [lo, lo + width] and 1..8 distinct pitches inside it, ascending. */
const voicingArb = fc
  .record({ lo: fc.integer({ min: 24, max: 72 }), width: fc.integer({ min: 4, max: 48 }) })
  .chain(({ lo, width }) =>
    fc.record({
      lo: fc.constant(lo),
      hi: fc.constant(lo + width),
      dests: fc
        .uniqueArray(fc.integer({ min: lo, max: lo + width }), { minLength: 1, maxLength: 8 })
        .map((xs) => xs.sort((a, b) => a - b)),
      factor: fc.double({ min: 0, max: 4, noNaN: true }),
      around: fc.oneof(
        fc.constant('mean' as const),
        fc.constant('median' as const),
        fc.integer({ min: lo - 12, max: lo + width + 12 }),
      ),
      snap: fc.constantFrom(...SNAPS),
      key: fc.constantFrom(...KEYS),
    }),
  );

const centre = (ds: number[], around: 'mean' | 'median' | number): number => {
  if (typeof around === 'number') return around;
  const n = ds.length;
  if (around === 'mean') return ds.reduce((a, b) => a + b) / n;
  return n % 2 ? ds[(n - 1) / 2] : (ds[n / 2 - 1] + ds[n / 2]) / 2;
};

describe('spread (factor ≥ 0) property', () => {
  it('the moment function: in range, ordered and distinct (per-voice ranges)', () => {
    const arb = voicingArb.chain((v) =>
      fc.record({
        v: fc.constant(v),
        // Each voice's own range: the uniform one, trimmed on either side towards its pitch.
        trims: fc.array(fc.tuple(fc.nat(12), fc.nat(12)), {
          minLength: v.dests.length,
          maxLength: v.dests.length,
        }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ v, trims }) => {
        const ranges = v.dests.map((d, i): [number, number] => [
          Math.min(d - 2, Math.max(v.lo, v.lo + trims[i][0])),
          Math.max(d + 2, Math.min(v.hi, v.hi - trims[i][1])),
        ]);
        const c = centre(v.dests, v.around);
        const r = spreadInRange(v.dests, ranges, c, v.factor, v.snap, v.key);
        const ps = r.pitches;
        for (let i = 0; i < ps.length; i++) {
          expect(ps[i]).toBeGreaterThanOrEqual(ranges[i][0]);
          expect(ps[i]).toBeLessThanOrEqual(ranges[i][1]);
        }
        if (r.ok) for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
        else for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
      }),
      params,
    );
  });

  it('uniform range: always ok when the range holds the notes; widens with factor ≥ 1', () => {
    fc.assert(
      fc.property(voicingArb, (v) => {
        const ranges = v.dests.map((): [number, number] => [v.lo, v.hi]);
        const c = centre(v.dests, v.around);
        const r = spreadInRange(v.dests, ranges, c, v.factor, v.snap, v.key);
        if (capacity(v.lo, v.hi, v.snap, v.key) >= v.dests.length) expect(r.ok).toBe(true);
        const ps = r.pitches;
        const n = ps.length;
        const inside = c >= v.lo && c <= v.hi;
        if (v.snap === 'none' && v.factor >= 1 && inside && n > 1) {
          expect(ps[n - 1] - ps[0]).toBeGreaterThanOrEqual(v.dests[n - 1] - v.dests[0] - 1e-9);
        }
      }),
      params,
    );
  });

  it('through the compiler: final lines in range, in order, distinct, never crossing', () => {
    const lines = (s: CompiledScore, n: number, t: number) =>
      s.voices.slice(0, n).map((x) => pitchAt(x, t)!);
    fc.assert(
      fc.property(voicingArb, (v) => {
        if (capacity(v.lo, v.hi, v.snap, v.key) < v.dests.length) return;
        const s = compile(
          piece({
            start: v.dests,
            range: [v.lo, v.hi],
            key: v.key,
            glide: { length: 2, jitter: 0, stagger: 0 },
            moments: [{ type: 'spread', at: 1, factor: v.factor, around: v.around, snap: v.snap }],
          }),
        );
        const n = v.dests.length;
        expect(s.diagnostics.map((d) => d.code)).not.toContain('range-fold');
        expect(s.diagnostics.map((d) => d.code)).not.toContain('spread-crowded');
        for (let t = 0; t <= s.duration; t += 0.05) {
          const ps = lines(s, n, Math.min(t, s.duration - 1e-6));
          for (let i = 1; i < n; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1] - 1e-9);
        }
        const out = lines(s, n, s.duration - 1e-6);
        for (let i = 0; i < n; i++) {
          expect(out[i]).toBeGreaterThanOrEqual(v.lo);
          expect(out[i]).toBeLessThanOrEqual(v.hi);
          if (i > 0) expect(out[i]).toBeGreaterThan(out[i - 1]);
        }
      }),
      { ...params, numRuns: Math.max(1, Math.round(RUNS / 2)) },
    );
  });
});
