/**
 * Next's spread (PLAN.md §11.3 rev 14, owner 2026-11-23): a card's chord, and the Add → Chord
 * default, keep roughly the spread of the lines before it, widening only as far as the lines need
 * to sound distinct chord tones.
 */
import { describe, expect, it } from 'vitest';
import { parseChord } from '../../../src/core/chords';
import { compile } from '../../../src/core/compiler/compile';
import { chordDefaultAt, suggestNext } from '../../../src/core/suggest';
import type { Key, Moment, Piece } from '../../../src/core/types';
import { piece, pitchesAt } from './compiler-fixtures';

const Am: Key = { tonic: 'A', scale: 'minor' };
/** Next's time; the spread is read once the card's glide has settled. */
const T = 10;
const SETTLED = T + 20;

/** Allowed spread change: the larger of ±5 semitones and ±25 % (build log M10a-3). */
const tolerance = (span: number): number => Math.max(5, 0.25 * span);

/** Lines (start pitches) in A minor, narrow, medium and wide, for 3, 5 and 8 lines. */
const CASES: [string, number[]][] = [
  ['3 narrow', [57, 60, 64]],
  ['3 medium', [52, 60, 69]],
  ['3 wide', [45, 60, 76]],
  ['5 narrow', [57, 60, 62, 64, 67]],
  ['5 medium', [48, 55, 60, 64, 71]],
  ['5 wide', [40, 52, 60, 69, 79]],
  ['8 narrow', [55, 57, 60, 62, 64, 65, 67, 69]],
  ['8 medium', [40, 45, 48, 52, 55, 60, 64, 67]], // the owner's E2–G4
  ['8 wide', [38, 45, 52, 57, 64, 69, 76, 83]],
];

const linesOf = (start: number[]): Piece =>
  piece({ start, key: Am, end: { at: SETTLED + 30, fade: 1 } });

const add = (p: Piece, m: Moment, id = 'card'): Piece => ({
  ...p,
  moments: [...p.moments, { ...m, id }].sort((a, b) => a.at - b.at),
});

const sounding = (p: Piece, t: number): number[] =>
  (pitchesAt(compile(p), t).filter((x) => x !== null) as number[]).sort((a, b) => a - b);

const spanOf = (xs: number[]): number => xs[xs.length - 1] - xs[0];

/** The narrowest span of k distinct pitches of `pcs` that sound them all (k ≥ pcs.length). */
function needed(pcs: number[], k: number): number {
  let best = Infinity;
  for (let a = 0; a < 12; a++) {
    const ps: number[] = [];
    for (let p = a; ps.length < k; p++) if (pcs.includes(p % 12)) ps.push(p);
    best = Math.min(best, spanOf(ps));
  }
  return best;
}

/** Checks the chord `m` (a numeral) added to `p`: spread, chord tones, distinct lines. */
function check(p: Piece, m: Moment, before: number[], what: string): number[] {
  const after = sounding(add(p, m), m.at + 20);
  const sym = m.type === 'chord' && m.notes.kind === 'chord' ? m.notes.symbol : '';
  const chord = parseChord(sym, Am);
  if (!chord.ok) throw new Error(sym);
  const lines = Math.max(before.length, chord.pcs.length);
  expect(after.length, `${what}: lines`).toBe(lines);
  // Every line on a chord tone, every chord tone sounding, no two lines on one pitch.
  for (const x of after)
    expect(chord.pcs, `${what}: ${after}`).toContain(((Math.round(x) % 12) + 12) % 12);
  expect(
    new Set(after.map((x) => ((Math.round(x) % 12) + 12) % 12)).size,
    `${what}: ${after}`,
  ).toBe(chord.pcs.length);
  expect(new Set(after.map(Math.round)).size, `${what}: merges ${after}`).toBe(after.length);
  // The spread before, or what the lines need when that is wider.
  const want = Math.max(spanOf(before), needed(chord.pcs, lines));
  expect(Math.abs(spanOf(after) - want), `${what}: ${before} → ${after}`).toBeLessThanOrEqual(
    tolerance(want),
  );
  return after;
}

describe('Next keeps the spread (owner 2026-11-23)', () => {
  it('each card keeps the lines’ spread for 3, 5 and 8 lines, narrow to wide', () => {
    for (const [name, start] of CASES) {
      const p = linesOf(start);
      const su = suggestNext(p, compile(p), T);
      expect(su.length, name).toBeGreaterThanOrEqual(3);
      for (const x of su) check(p, x.moment, start, `${name} ${x.label}`);
    }
  });

  it('the owner’s case: eight lines over E2–G4 stay within it, ±a few semitones', () => {
    const start = CASES[7][1];
    const p = linesOf(start);
    for (const x of suggestNext(p, compile(p), T)) {
      const after = sounding(add(p, x.moment), SETTLED);
      expect(after[0], x.label).toBeGreaterThanOrEqual(start[0] - 6);
      expect(after[7], x.label).toBeLessThanOrEqual(start[7] + 6);
    }
  });

  it('stacked lines stay merged: the card counts lines, not voices', () => {
    // Twelve voices on five lines (a merged unison of four on A3 and doublings).
    const p = linesOf([45, 45, 45, 45, 52, 52, 57, 57, 60, 64, 64, 64]);
    const before = sounding(p, T);
    expect(before).toEqual([45, 52, 57, 60, 64]);
    for (const x of suggestNext(p, compile(p), T)) {
      expect(x.moment, x.label).toMatchObject({ count: 5 });
      check(p, x.moment, before, x.label);
    }
  });

  it('a chain of eight Next picks does not drift the spread wider or narrower', () => {
    for (const [name, start] of [CASES[1], CASES[4], CASES[7], CASES[8]]) {
      let p = linesOf(start);
      const spans = [spanOf(start)];
      for (let i = 0; i < 8; i++) {
        const t = T + 12 * i;
        p = { ...p, end: { at: t + 60, fade: 1 } };
        const su = suggestNext(p, compile(p), t);
        // Vary the pick: the best card, then the others in turn.
        p = add(p, su[i % su.length].moment, `c${i}`);
        spans.push(spanOf(sounding(p, t + 11.9)));
      }
      const s0 = spans[0];
      for (const s of spans)
        expect(Math.abs(s - s0), `${name}: ${spans}`).toBeLessThanOrEqual(tolerance(s0));
      const steps = spans.slice(1).map((s, i) => s - spans[i]);
      expect(steps.every((d) => d > 0) || steps.every((d) => d < 0), `${name}: ${spans}`).toBe(
        false,
      );
    }
  });

  it('Add → Chord keeps the spread the same way', () => {
    for (const [name, start] of CASES) {
      const p = linesOf(start);
      const fit = chordDefaultAt(p, compile(p), T)!;
      expect(fit.moment.register, name).toBeDefined();
      check(p, { ...fit.moment, id: 'x', at: T, seed: 7 } as Moment, start, `${name} ${fit.name}`);
    }
  });
});
