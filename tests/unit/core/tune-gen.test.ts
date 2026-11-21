/** Random tune melodies (core/tune-gen.ts). */

import { describe, expect, it } from 'vitest';
import { randomTune, type TuneGenInput } from '../../../src/core/tune-gen';
import { isScaleTone, scaleDegreeIndex, noteName } from '../../../src/core/scales';
import type { Key } from '../../../src/core/types';

const C: Key = { tonic: 'C', scale: 'major' };
const Am: Key = { tonic: 'A', scale: 'minor' };

const base = (extra: Partial<TuneGenInput> = {}): TuneGenInput => ({
  seed: 1,
  key: C,
  start: 67,
  range: [55, 84],
  total: 4, // two bars at 120
  beat: 0.5,
  ...extra,
});

const sum = (xs: readonly { len: number }[]): number => xs.reduce((a, n) => a + n.len, 0);

describe('randomTune', () => {
  it('is deterministic per seed and differs across seeds', () => {
    expect(randomTune(base())).toEqual(randomTune(base()));
    const seen = new Set<string>();
    for (let s = 0; s < 20; s++) seen.add(JSON.stringify(randomTune(base({ seed: s }))));
    expect(seen.size).toBeGreaterThan(15);
  });

  it('stays in key and in range, lengths sum to the total, mostly steps', () => {
    let steps = 0;
    let moves = 0;
    for (let s = 0; s < 300; s++) {
      const key = s % 2 ? Am : C;
      const beat = s % 3 === 0 ? null : 0.4 + (s % 5) * 0.1;
      const start = 50 + (s % 30);
      const range: [number, number] = [start - 7 - (s % 6), start + 4 + (s % 9)];
      const total = 1 + (s % 17) * 0.73;
      const notes = randomTune({ seed: s * 7919, key, start, range, total, beat });
      expect(sum(notes)).toBeCloseTo(total, 6);
      for (const n of notes) {
        expect(isScaleTone(n.pitch, key)).toBe(true);
        expect(n.pitch).toBeGreaterThanOrEqual(range[0]);
        expect(n.pitch).toBeLessThanOrEqual(range[1]);
        expect(n.len).toBeGreaterThan(0);
      }
      // Grid lengths: 1–4 units (the last note also takes the remainder).
      const unit = beat ? beat / 2 : 0.25;
      for (const n of notes.slice(0, -1)) {
        const u = n.len / unit;
        expect(Math.abs(u - Math.round(u))).toBeLessThan(1e-4);
        expect(Math.round(u)).toBeGreaterThanOrEqual(1);
        expect(Math.round(u)).toBeLessThanOrEqual(4);
      }
      // Starts within a 3rd of the line's pitch.
      expect(
        Math.abs(scaleDegreeIndex(notes[0].pitch, key) - scaleDegreeIndex(start, key)),
      ).toBeLessThanOrEqual(2);
      for (let i = 1; i < notes.length; i++) {
        const d = Math.abs(
          scaleDegreeIndex(notes[i].pitch, key) - scaleDegreeIndex(notes[i - 1].pitch, key),
        );
        moves++;
        if (d <= 2) steps++;
      }
    }
    expect(steps / moves).toBeGreaterThan(0.8);
  });

  it('note lengths: 1/8, 1/4, dotted 1/4, 1/2 with a tempo; 0.25–1 s without', () => {
    for (let s = 0; s < 50; s++) {
      for (const n of randomTune(base({ seed: s }))) expect([0.25, 0.5, 0.75, 1]).toContain(n.len);
      for (const n of randomTune(base({ seed: s, beat: null })))
        expect([0.25, 0.5, 0.75, 1]).toContain(n.len);
      for (const n of randomTune(base({ seed: s, beat: 1 })).slice(0, -1))
        expect([0.5, 1, 1.5, 2]).toContain(n.len);
    }
  });

  it('ends on a chord tone of the given harmony, else the tonic or fifth', () => {
    for (let s = 0; s < 50; s++) {
      const a = randomTune(base({ seed: s, endPcs: [2, 5, 9] })).at(-1)!;
      expect([2, 5, 9]).toContain(a.pitch % 12);
      const b = randomTune(base({ seed: s })).at(-1)!;
      expect([0, 7]).toContain(b.pitch % 12);
      // A chromatic harmony tone is not in the key: tonic/fifth instead.
      const c = randomTune(base({ seed: s, endPcs: [1] })).at(-1)!;
      expect([0, 7]).toContain(c.pitch % 12);
    }
  });

  it('ends on a long note and repeats rhythm cells', () => {
    let repeated = 0;
    for (let s = 0; s < 50; s++) {
      const notes = randomTune(base({ seed: s, total: 8 }));
      expect(notes.at(-1)!.len).toBe(1); // a half note at 120
      const lens = notes.map((n) => n.len).join(' ');
      const first = notes
        .slice(0, 3)
        .map((n) => n.len)
        .join(' ');
      if (lens.indexOf(first, 1) > 0) repeated++;
    }
    expect(repeated).toBeGreaterThan(30);
  });

  it('short and empty totals', () => {
    expect(randomTune(base({ total: 0 }))).toEqual([]);
    const one = randomTune(base({ total: 0.1 }));
    expect(one).toHaveLength(1);
    expect(one[0].len).toBeCloseTo(0.1, 9);
    expect(sum(randomTune(base({ total: 0.75 })))).toBeCloseTo(0.75, 9);
  });

  it('a range with the start outside it still stays inside', () => {
    for (let s = 0; s < 30; s++) {
      for (const n of randomTune(base({ seed: s, start: 40, range: [60, 72] }))) {
        expect(n.pitch).toBeGreaterThanOrEqual(60);
        expect(n.pitch).toBeLessThanOrEqual(72);
      }
    }
  });

  it.skipIf(!process.env.TUNE_EXAMPLES)('prints examples', () => {
    for (const s of [1, 2, 3, 4, 5]) {
      const notes = randomTune(base({ seed: s * 101, endPcs: [0, 4, 7] }));
      console.log(notes.map((n) => `${noteName(n.pitch)} ${n.len / 0.5}`).join(', '));
    }
  });
});
