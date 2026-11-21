/**
 * Free octaves before merging lines (owner, 2026-11-21): a chord or degrees chord, with or
 * without `count` and with any voicing, that would put two lines on one resting note moves the
 * extra line to the nearest free octave of a chord tone in its range; lines merge only when the
 * range has no free pitch left. Explicit pitch lists stay literal.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { linesAt } from '../../../src/core/query';
import type { NoteSet, Voicing } from '../../../src/core/types';
import { chordAt, piece } from './compiler-fixtures';
import { lineArtifacts } from './line-artifacts';

const GLIDE = { length: 2, jitter: 0, stagger: 0.5, ease: 'smootherstep' as const };
const pc = (p: number) => ((p % 12) + 12) % 12;
const distinct = (ps: number[]) => new Set(ps).size;

function run(
  start: number[],
  notes: NoteSet,
  opts: {
    voicing?: Voicing;
    register?: [number, number];
    range?: [number, number];
    count?: number;
  },
) {
  return compile(
    piece({
      start,
      glide: GLIDE,
      range: opts.range,
      end: { at: 30, fade: 1 },
      moments: [
        {
          type: 'chord',
          at: 1,
          notes,
          voicing: opts.voicing ?? 'even',
          assign: 'ordered',
          ...(opts.register ? { register: opts.register } : {}),
          ...(opts.count === undefined ? {} : { count: opts.count }),
        },
      ],
    }),
  );
}

describe('free octaves before merging lines (owner, 2026-11-21)', () => {
  it('a narrow register: the extra line takes a chord tone outside it, in its range', () => {
    // C in [60, 67] has three notes (60 64 67) for four lines.
    const s = run([48, 52, 55, 60], { kind: 'chord', symbol: 'C' }, { register: [60, 67] });
    const c = chordAt(s, 25);
    expect(linesAt(s, 25)).toBe(4);
    expect(distinct(c)).toBe(4);
    for (const p of c) expect([0, 4, 7]).toContain(pc(p));
    expect(lineArtifacts(s)).toEqual([]);
  });

  it('a narrow range with no free chord tone: the lines merge', () => {
    const s = run([58, 61, 63, 66], { kind: 'chord', symbol: 'C' }, { range: [58, 68] });
    expect(linesAt(s, 25)).toBe(3);
    expect(chordAt(s, 25)).toEqual([60, 64, 67]);
  });

  it('Nearest: lines that would share their nearest note spread to free chord tones', () => {
    const s = run([59, 60, 61, 62], { kind: 'chord', symbol: 'C' }, { voicing: 'nearest' });
    const c = chordAt(s, 25);
    expect(linesAt(s, 25)).toBe(4);
    expect(distinct(c)).toBe(4);
    for (const p of c) expect([0, 4, 7]).toContain(pc(p));
    expect(c).toContain(60);
    expect(lineArtifacts(s)).toEqual([]);
  });

  it('a short degrees list: octaves of its one note before any unison', () => {
    // Degree 0 (A) in [57, 69] gives two notes for three lines; A45 or A81 is free in range.
    const s = run([50, 55, 62], { kind: 'degrees', degrees: [0] }, { register: [57, 69] });
    const c = chordAt(s, 25);
    expect(linesAt(s, 25)).toBe(3);
    expect(distinct(c)).toBe(3);
    for (const p of c) expect(pc(p)).toBe(9);
  });

  it('with count too', () => {
    const s = run([60], { kind: 'degrees', degrees: [0] }, { register: [57, 69], count: 3 });
    expect(linesAt(s, 25)).toBe(3);
    expect(distinct(chordAt(s, 25))).toBe(3);
  });

  it('explicit pitch lists stay literal: their unisons merge', () => {
    const s = run([48, 52, 55], { kind: 'pitches', pitches: [60, 60, 64] }, {});
    expect(linesAt(s, 25)).toBe(2);
    expect(chordAt(s, 25)).toEqual([60, 64]);
  });
});
