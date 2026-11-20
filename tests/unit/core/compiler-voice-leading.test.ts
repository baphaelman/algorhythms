/**
 * Voice leading (PLAN.md §7.2): the DPs and the Hungarian solver against brute force.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assignFree,
  assignInjective,
  assignOrdered,
  assignSurjective,
  assignmentCost,
  hungarian,
} from '../../../src/core/voice-leading';
import { voiceNotes } from '../../../src/core/voicing';

const sorted = (xs: number[]): number[] => xs.slice().sort((a, b) => a - b);

/** All non-decreasing maps f: [0,a) → [0,k), optionally injective or surjective. */
function* maps(a: number, k: number, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === a) {
    yield prefix;
    return;
  }
  const start = prefix.length ? prefix[prefix.length - 1] : 0;
  for (let j = start; j < k; j++) yield* maps(a, k, [...prefix, j]);
}

function bruteOrdered(p: number[], q: number[], kind: 'inj' | 'surj'): number {
  let best = Infinity;
  for (const f of maps(p.length, q.length)) {
    if (kind === 'inj' && new Set(f).size !== f.length) continue;
    if (kind === 'surj' && new Set(f).size !== q.length) continue;
    best = Math.min(best, assignmentCost(p, q, f));
  }
  return best;
}

function* permutations(n: number, k: number, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === n) {
    yield prefix;
    return;
  }
  for (let j = 0; j < k; j++) if (!prefix.includes(j)) yield* permutations(n, k, [...prefix, j]);
}

const pitch = fc.integer({ min: 36, max: 84 });

describe('ordered assignment (§7.2)', () => {
  it('k = a is the identity', () => {
    expect(assignOrdered([40, 50, 60], [61, 62, 63])).toEqual([0, 1, 2]);
  });

  it('injective DP (k > a) is optimal, order-preserving and injective', () => {
    fc.assert(
      fc.property(
        fc.array(pitch, { minLength: 1, maxLength: 5 }),
        fc.array(pitch, { minLength: 1, maxLength: 7 }),
        (ps, qs) => {
          const p = sorted(ps);
          const q = sorted(qs);
          fc.pre(q.length >= p.length);
          const f = assignInjective(p, q);
          for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
          expect(assignmentCost(p, q, f)).toBe(bruteOrdered(p, q, 'inj'));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('surjective DP (k < a) is optimal, non-decreasing and covers every target', () => {
    fc.assert(
      fc.property(
        fc.array(pitch, { minLength: 1, maxLength: 7 }),
        fc.array(pitch, { minLength: 1, maxLength: 5 }),
        (ps, qs) => {
          const p = sorted(ps);
          const q = sorted(qs);
          fc.pre(q.length <= p.length);
          const f = assignSurjective(p, q);
          for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThanOrEqual(f[i - 1]);
          expect(new Set(f).size).toBe(q.length);
          expect(assignmentCost(p, q, f)).toBe(bruteOrdered(p, q, 'surj'));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the prototype case: 3 voices onto 5 targets moves least', () => {
    expect(assignOrdered([50, 57, 64], [47, 52, 55, 60, 67])).toEqual([1, 2, 4]);
  });
});

describe('free assignment (Hungarian, §7.2)', () => {
  it('is optimal against brute force for k ≥ a', () => {
    fc.assert(
      fc.property(
        fc.array(pitch, { minLength: 1, maxLength: 5 }),
        fc.array(pitch, { minLength: 1, maxLength: 6 }),
        (p, q) => {
          fc.pre(q.length >= p.length);
          const f = assignFree(p, q);
          expect(new Set(f).size).toBe(p.length);
          let best = Infinity;
          for (const g of permutations(p.length, q.length)) {
            best = Math.min(best, assignmentCost(p, q, g));
          }
          expect(assignmentCost(p, q, f)).toBeCloseTo(best, 9);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('for k < a covers every target with minimal cost', () => {
    fc.assert(
      fc.property(
        fc.array(pitch, { minLength: 2, maxLength: 6 }),
        fc.array(pitch, { minLength: 1, maxLength: 4 }),
        (p, q) => {
          fc.pre(q.length < p.length);
          const f = assignFree(p, q);
          expect(new Set(f).size).toBe(q.length);
          // Brute force over all surjections (any order).
          let best = Infinity;
          const rec = (i: number, g: number[]): void => {
            if (i === p.length) {
              if (new Set(g).size === q.length) best = Math.min(best, assignmentCost(p, q, g));
              return;
            }
            for (let j = 0; j < q.length; j++) rec(i + 1, [...g, j]);
          };
          rec(0, []);
          expect(assignmentCost(p, q, f)).toBeCloseTo(best, 9);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('may cross where ordered may not', () => {
    // Free can swap; with equal costs it is still a valid optimum.
    const f = assignFree([60, 62], [61, 70]);
    expect(assignmentCost([60, 62], [61, 70], f)).toBe(9);
  });
});

describe('degenerate inputs never hang or produce NaN', () => {
  it('hungarian terminates on NaN and infinite costs (a NaN destination once looped forever)', () => {
    const f = assignFree([NaN, 71], [53, 63, 71, 82]);
    expect(f).toHaveLength(2);
    expect(new Set(f).size).toBe(2);
    for (const j of f) expect(j >= 0 && j < 4).toBe(true);
    const cost = Float64Array.from([Infinity, NaN, 1, Infinity]);
    const cols = hungarian(cost, 2, 2);
    expect(new Set(cols).size).toBe(2);
  });

  it('nearest slash chord with no chord tone above the bass doubles inside the register', () => {
    // C/E in [46, 52]: candidates 48 and 52, bass E = 52, nothing above it.
    const r = voiceNotes({
      notes: { kind: 'chord', symbol: 'C/E' },
      k: 4,
      mode: 'nearest',
      register: [46, 52],
      key: { tonic: 'C', scale: 'major' },
      current: [64, 66, 68, 71],
      voices: [64, 66, 68, 71],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(4);
    for (const q of r.targets) {
      expect(Number.isFinite(q)).toBe(true);
      expect(q >= 46 && q <= 52).toBe(true);
    }
  });
});
