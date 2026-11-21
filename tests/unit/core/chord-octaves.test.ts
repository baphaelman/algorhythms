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

describe('free octaves stay inside the chord’s register (integrator, 2026-11-21)', () => {
  const subset = (
    start: number[],
    rank: [number, number],
    notes: NoteSet,
    register: [number, number],
    extra: {
      count?: number;
      key?: { tonic: 'A'; scale: 'aeolian' };
      range?: [number, number];
    } = {},
  ) =>
    compile(
      piece({
        pool: 16,
        start,
        glide: GLIDE,
        key: extra.key,
        range: extra.range,
        end: { at: 30, fade: 1 },
        moments: [
          {
            type: 'chord',
            at: 1,
            target: { rank },
            notes,
            voicing: 'close',
            assign: 'ordered',
            register,
            ...(extra.count === undefined ? {} : { count: extra.count }),
          },
        ],
      }),
    );
  const crossings = (s: ReturnType<typeof compile>) =>
    s.diagnostics.filter((d) => d.code === 'crossing-untargeted');

  it('the register is full and untargeted lines lie just below it: the lines merge (CrChd2)', () => {
    // As in The Cartographers' Rain (range [38, 84]): bVII in A aeolian has 6 notes in [60, 84]
    // for 7 upper lines; untargeted lines hold 60 and 61. 29a sent the extra line to 59, across
    // them.
    const s = subset(
      [45, 47, 50, 55, 60, 61, 66, 69, 71, 73, 78, 81, 82],
      [6, 12],
      { kind: 'chord', symbol: 'bVII' },
      [60, 84],
      { key: { tonic: 'A', scale: 'aeolian' }, range: [38, 84] },
    );
    const c = chordAt(s, 25);
    expect(c.slice(0, 6)).toEqual([45, 47, 50, 55, 60, 61]);
    expect(c.slice(6)).toEqual([62, 67, 71, 74, 79, 83]);
    expect(crossings(s)).toEqual([]);
  });

  it('room between the register and the untargeted neighbour: the extra note goes there', () => {
    // C in [60, 67] has 3 notes for 4 lines; 53 and 70 are untargeted. 29a took 52, below 53.
    const s = subset([53, 60, 62, 64, 66, 70], [1, 4], { kind: 'chord', symbol: 'C' }, [60, 67]);
    expect(chordAt(s, 25)).toEqual([53, 55, 60, 64, 67, 70]);
    expect(crossings(s)).toEqual([]);
    expect(lineArtifacts(s)).toEqual([]);
  });

  it('no room between the neighbours either: the lines merge rather than cross', () => {
    // As above, with 56 and 70 untargeted: nothing of C lies in (56, 60) or (67, 70).
    const s = subset([56, 60, 62, 64, 66, 70], [1, 4], { kind: 'chord', symbol: 'C' }, [60, 67]);
    expect(chordAt(s, 25)).toEqual([56, 60, 64, 67, 70]);
    expect(linesAt(s, 25)).toBe(5);
    expect(crossings(s)).toEqual([]);
  });

  it('an untargeted line inside the register bounds the room below the targeted lines', () => {
    // 58 and 70 are untargeted, the register [57, 67] holds C's 60 64 67 for four lines above
    // 58: the room below the register lies under 58, so the fourth line merges instead of
    // crossing it (29a took 55).
    const s = subset(
      [45, 58, 61, 63, 65, 66, 70],
      [2, 5],
      { kind: 'chord', symbol: 'C' },
      [57, 67],
    );
    expect(chordAt(s, 25)).toEqual([45, 58, 60, 64, 67, 70]);
    expect(crossings(s)).toEqual([]);
  });

  it('with count: newborns take the room between the neighbours too', () => {
    // Two lines become four: C in [60, 67] gives 60 64 67; the fourth note must lie between
    // the untargeted 53 and 75 (55 or 72), not at 52 or 76.
    const s = subset([53, 62, 65, 75], [1, 2], { kind: 'chord', symbol: 'C' }, [60, 67], {
      count: 6,
    });
    const c = chordAt(s, 25);
    expect(linesAt(s, 25)).toBe(6);
    expect(c.slice(1, 5).filter((p) => p !== 55 && p !== 72)).toEqual([60, 64, 67]);
    expect(c[0]).toBe(53);
    expect(c[5]).toBe(75);
    expect(crossings(s)).toEqual([]);
  });
});
