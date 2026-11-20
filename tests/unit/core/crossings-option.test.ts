/**
 * Compile option `crossings: 'allow'` (dev toggle): default behaviour is unchanged, 'allow' skips
 * voice-crossing enforcement.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { pitchAt } from '../../../src/core/query';
import type { CompiledScore, Piece } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

/** A tight cluster that moves up as a whole: staggered starts would run lower voices through. */
const crossy = (seed: number): Piece =>
  piece({
    seed,
    pool: 4,
    start: [60, 61, 62, 63],
    glide: { length: 3, jitter: 0.5, stagger: 1 },
    moments: [
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'chord', symbol: 'C' },
        voicing: 'even',
        assign: 'ordered',
        register: [70, 80],
      },
    ],
  });

/** Largest amount by which a voice sits above the next-higher voice, over the whole piece. */
function worstCrossing(s: CompiledScore): number {
  let worst = 0;
  const order = s.voices.map((v) => v);
  for (let t = 0; t < s.duration; t += 0.02) {
    const ps = order.map((v) => pitchAt(v, t));
    for (let i = 0; i + 1 < ps.length; i++) {
      const lo = ps[i];
      const hi = ps[i + 1];
      if (lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi)) {
        worst = Math.max(worst, lo - hi);
      }
    }
  }
  return worst;
}

const seeds = [1, 2, 3, 7, 11, 2611];

describe("compile option crossings: 'allow'", () => {
  it("default, 'forbid' and omitted options give identical output", () => {
    for (const seed of seeds) {
      const a = JSON.stringify(compile(crossy(seed)));
      expect(JSON.stringify(compile(crossy(seed), {}))).toBe(a);
      expect(JSON.stringify(compile(crossy(seed), { crossings: 'forbid' }))).toBe(a);
    }
  });

  it("'allow' is deterministic and emits no crossing diagnostics", () => {
    for (const seed of seeds) {
      const a = compile(crossy(seed), { crossings: 'allow' });
      expect(JSON.stringify(compile(crossy(seed), { crossings: 'allow' }))).toBe(JSON.stringify(a));
      expect(a.diagnostics.filter((d) => d.code.startsWith('crossing-'))).toEqual([]);
    }
  });

  it("'allow' lets voices cross where the default does not", () => {
    let allowCrossed = 0;
    for (const seed of seeds) {
      const f = compile(crossy(seed));
      const a = compile(crossy(seed), { crossings: 'allow' });
      if (worstCrossing(a) > worstCrossing(f) + 1e-6) allowCrossed++;
    }
    expect(allowCrossed).toBeGreaterThan(0);
  });
});
