/**
 * Spread (M4.5-30) on 29a's distinct lines: stacked lines, crowded ranges.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { activeAt, linesAt, pitchAt, stackAt, weightAt } from '../../../src/core/query';
import type { CompiledScore } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

const GLIDE = { length: 2, jitter: 0, stagger: 0, ease: 'smootherstep' as const };

/** Resting pitch → summed stack and weight of the lines heard there at t. */
function rest(s: CompiledScore, t: number) {
  const out = new Map<number, { lines: number; stack: number; weight: number }>();
  for (const i of activeAt(s, t)) {
    const v = s.voices[i];
    const life = v.lives.find((l) => l.born <= t && (l.died === undefined || t < l.died));
    if (life?.died !== undefined && life.died < s.duration && t >= life.died - (life.fadeOut ?? 0))
      continue;
    const p = Math.round(pitchAt(v, t)! * 1000) / 1000;
    const e = out.get(p) ?? { lines: 0, stack: 0, weight: 0 };
    e.lines++;
    e.stack += stackAt(v, t);
    e.weight += weightAt(v, t);
    out.set(p, e);
  }
  return out;
}

describe('spread on distinct lines', () => {
  it('a stacked line spreads as one note: no fork, stack and weight kept', () => {
    const s = compile(
      piece({
        start: [60, 60, 67],
        glide: GLIDE,
        moments: [{ type: 'spread', at: 1, factor: 2, around: 'mean', snap: 'scale' }],
      }),
    );
    const end = s.duration - 1e-6;
    expect(s.diagnostics.map((d) => d.code)).not.toContain('no-effect');
    expect(linesAt(s, 0.5)).toBe(2);
    expect(linesAt(s, end)).toBe(2);
    const r = [...rest(s, end).values()];
    expect(r.map((e) => e.stack).sort()).toEqual([1, 2]);
    expect(r.reduce((a, e) => a + e.weight, 0)).toBeCloseTo(3);
  });

  it('a crowded spread warns and its coincident lines merge (weight summed)', () => {
    const s = compile(
      piece({
        start: [60, 61, 62, 63, 64],
        range: [60, 64],
        glide: GLIDE,
        moments: [{ type: 'spread', at: 1, factor: 2, around: 'mean', snap: 'scale' }],
      }),
    );
    const codes = s.diagnostics.map((d) => d.code);
    expect(codes).toContain('spread-crowded');
    const end = s.duration - 1e-6;
    const r = rest(s, end);
    for (const e of r.values()) expect(e.lines).toBe(1);
    expect([...r.values()].reduce((a, e) => a + e.weight, 0)).toBeCloseTo(5);
    expect([...r.values()].reduce((a, e) => a + e.stack, 0)).toBe(5);
  });

  it('a spread on a unison is one line: no-effect', () => {
    const s = compile(
      piece({
        start: [60, 60, 60, 60],
        glide: GLIDE,
        moments: [{ type: 'spread', at: 1, factor: 2, around: 'mean', snap: 'scale' }],
      }),
    );
    expect(s.diagnostics.map((d) => d.code)).toContain('no-effect');
    expect(linesAt(s, s.duration - 1e-6)).toBe(1);
  });
});
