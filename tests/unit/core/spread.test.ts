/**
 * Spread at range edges (PLAN.md §6.2, §11.3 "Spread keeps its shape at range edges", M4.5-30).
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { pitchAt } from '../../../src/core/query';
import { isScaleTone } from '../../../src/core/scales';
import { spreadInRange } from '../../../src/core/moments/spread';
import type { CompiledScore, Key, Piece } from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

const KEY: Key = { tonic: 'D', scale: 'dorian' };

const spreadPiece = (
  start: number[],
  m: Partial<Extract<MomentInput, { type: 'spread' }>>,
  range: [number, number],
): Piece => {
  const p = piece({
    start,
    range,
    key: KEY,
    glide: { length: 2, jitter: 0, stagger: 0, ease: 'smootherstep' },
    moments: [{ type: 'spread', at: 1, factor: 1.8, around: 'mean', snap: 'scale', ...m }],
  });
  return p;
};

/** Pitches of the started voices at t, in pool (= start) order. */
const linesAt = (s: CompiledScore, n: number, t: number) =>
  s.voices.slice(0, n).map((v) => pitchAt(v, t)!);

/** True if any two lines swap order between t0 and t1, sampled finely. */
function crosses(s: CompiledScore, n: number, t0: number, t1: number): boolean {
  for (let t = t0; t <= t1; t += 0.01) {
    const ps = linesAt(s, n, t);
    for (let i = 1; i < n; i++) if (ps[i] < ps[i - 1] - 1e-9) return true;
  }
  return false;
}

describe('spread at range edges', () => {
  // The owner's case: low lines near the bottom of the range, top lines high, mean centre,
  // factor 1.8. c + f·(p − c) sends the low lines below 36; before M4.5-30 they folded up an
  // octave into the cluster and crossed their neighbours.
  const start = [38, 41, 45, 72, 76, 79];
  const range: [number, number] = [36, 84];

  it('the plain formula would leave the range (the cause)', () => {
    const c = start.reduce((a, b) => a + b) / start.length;
    expect(c + 1.8 * (start[0] - c)).toBeLessThan(range[0]);
  });

  it('keeps order, stays in range, widens, distinct, no crossings', () => {
    const s = compile(spreadPiece(start, {}, range));
    const end = s.duration - 1e-6;
    const out = linesAt(s, start.length, end);
    expect(s.diagnostics.map((d) => d.code)).not.toContain('range-fold');
    expect(s.diagnostics.map((d) => d.code)).not.toContain('spread-crowded');
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
    for (const p of out) {
      expect(p).toBeGreaterThanOrEqual(range[0]);
      expect(p).toBeLessThanOrEqual(range[1]);
      expect(isScaleTone(p, KEY)).toBe(true);
    }
    expect(new Set(out).size).toBe(start.length);
    expect(out[out.length - 1] - out[0]).toBeGreaterThan(start[start.length - 1] - start[0]);
    // The compressed side reaches the range edges (36 = C is in D dorian; 84 = C too).
    expect(out[0]).toBe(36);
    expect(out[out.length - 1]).toBe(84);
    expect(crosses(s, start.length, 0, end)).toBe(false);
    expect(chordAt(s, end)).toEqual(out);
  });

  it('compresses only the side that hits the edge', () => {
    // Top side fits: 72..79 around a mean of 58.5 at 1.5 stays below 96.
    const r = spreadInRange(
      start,
      start.map(() => [36, 96] as const),
      58.5,
      1.5,
      'none',
      KEY,
    );
    expect(r.ok).toBe(true);
    expect(r.pitches[0]).toBeCloseTo(36);
    expect(r.pitches[5]).toBeCloseTo(58.5 + 1.5 * (79 - 58.5));
    // Lower side scaled by one factor: the gaps keep their proportions.
    const k = (58.5 - 36) / (58.5 - 38);
    expect(r.pitches[1]).toBeCloseTo(58.5 - k * (58.5 - 41));
  });

  it('nudges coinciding snapped targets to the nearest free steps', () => {
    // Factor 0.1 squeezes everything onto the centre.
    const r = spreadInRange([55, 57, 60, 62, 64], Array(5).fill([36, 96]), 60, 0.1, 'scale', {
      tonic: 'C',
      scale: 'major',
    });
    expect(r.ok).toBe(true);
    expect(r.pitches).toEqual([57, 59, 60, 62, 64]);
  });

  it('reports a range too small to hold the notes apart', () => {
    const r = spreadInRange([60, 61, 62, 63], Array(4).fill([60, 62]), 61.5, 2, 'chromatic', KEY);
    expect(r.ok).toBe(false);
    for (const p of r.pitches) {
      expect(p).toBeGreaterThanOrEqual(60);
      expect(p).toBeLessThanOrEqual(62);
    }
  });

  it('voices sharing a pitch stay one note', () => {
    const r = spreadInRange([48, 60, 60, 72], Array(4).fill([36, 84]), 60, 2, 'chromatic', KEY);
    expect(r).toEqual({ pitches: [36, 60, 60, 84], ok: true });
  });

  it('a negative factor still mirrors', () => {
    const r = compile(spreadPiece([50, 70], { factor: -1, snap: 'none' }, [36, 96]));
    expect(linesAt(r, 2, r.duration - 1e-6)).toEqual([70, 50]);
  });
});
