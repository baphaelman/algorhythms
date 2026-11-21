/**
 * M4.5-29a (owner, 2026-11-21): `count` and "Notes: n" count lines heard, not Σ weights; every
 * join passes the dying line's weight to its survivor; walks never step onto another line's note.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { linesAt, stackAt } from '../../../src/core/query';
import type { CompiledScore } from '../../../src/core/types';
import { chordAt, piece, weightAt, type MomentInput } from './compiler-fixtures';
import { lineArtifacts } from './line-artifacts';

const GLIDE = { length: 2, jitter: 0, stagger: 0.5, ease: 'smootherstep' as const };

/** Σ weight of the lines heard at t (lines fading out after a join or merge excluded). */
function totalWeight(s: CompiledScore, t: number): number {
  let w = 0;
  for (const v of s.voices) {
    const life = v.lives.find((l) => l.born <= t && t < (l.died ?? Infinity));
    if (!life || (life.died !== undefined && t >= life.died - (life.fadeOut ?? 0))) continue;
    w += weightAt(v, t);
  }
  return w;
}

const unison = (at: number): MomentInput => ({ type: 'unison', at, pitch: 60, octaves: false });
const chord = (at: number, pitches: number[], count?: number): MomentInput => ({
  type: 'chord',
  at,
  notes: { kind: 'pitches', pitches },
  voicing: 'even',
  assign: 'ordered',
  ...(count === undefined ? {} : { count }),
});

describe('count counts lines (owner, 2026-11-21)', () => {
  it('a chord count after a unison sounds that many lines, sharing the merged weight', () => {
    const s = compile(
      piece({
        start: [48, 52, 55, 60],
        glide: GLIDE,
        end: { at: 30, fade: 1 },
        moments: [unison(1), chord(10, [48, 55, 64], 3)],
      }),
    );
    expect(linesAt(s, 8)).toBe(1);
    expect(totalWeight(s, 8)).toBeCloseTo(4, 9);
    expect(linesAt(s, 25)).toBe(3);
    expect(chordAt(s, 25)).toEqual([48, 55, 64]);
    expect(totalWeight(s, 25)).toBeCloseTo(4, 9);
    expect(show(lineArtifacts(s))).toEqual([]);
  });

  it('without count, the merged line still opens into its voices', () => {
    const s = compile(
      piece({
        start: [48, 52, 55, 60],
        glide: GLIDE,
        end: { at: 30, fade: 1 },
        moments: [unison(1), chord(10, [48, 52, 55, 60])],
      }),
    );
    expect(linesAt(s, 25)).toBe(4);
    expect(totalWeight(s, 25)).toBeCloseTo(4, 9);
  });

  it('a split count is lines after the split', () => {
    const s = compile(
      piece({
        start: [60, 60, 64],
        glide: GLIDE,
        end: { at: 30, fade: 1 },
        moments: [{ type: 'split', at: 1, count: 4, voicing: 'even' }],
      }),
    );
    expect(linesAt(s, 0.5)).toBe(2);
    expect(linesAt(s, 25)).toBe(4);
  });

  it('more lines than notes: the extra voices add their weight to the line on that note', () => {
    // One line, count 5, one pitch class and a register narrower than an octave.
    const s = compile(
      piece({
        start: [60],
        glide: GLIDE,
        end: { at: 30, fade: 1 },
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'pitches', pitches: [60] },
            register: [55, 66],
            voicing: 'even',
            assign: 'ordered',
            count: 5,
          },
        ],
      }),
    );
    expect(linesAt(s, 25)).toBe(1);
    expect(s.voices.filter((v) => v.lives.length > 0)).toHaveLength(1);
    expect(totalWeight(s, 25)).toBeCloseTo(5, 9);
    expect(stackAt(s.voices[0], 25)).toBe(5);
  });
});

describe('every join keeps the summed weight (owner, 2026-11-21)', () => {
  it('a merge passes the dying lines’ weight to their survivors', () => {
    const s = compile(
      piece({
        start: [48, 55, 60, 64],
        glide: GLIDE,
        end: { at: 30, fade: 1 },
        moments: [{ type: 'merge', at: 1, count: 2, which: 'top', fade: 1.5 }],
      }),
    );
    expect(linesAt(s, 20)).toBe(2);
    expect(totalWeight(s, 20)).toBeCloseTo(4, 9);
    // The stack does not grow: a later chord without count still sees two lines.
    for (const v of s.voices) expect(stackAt(v, 20)).toBe(1);
  });

  it('a chord count death passes its weight, with a zero fade too', () => {
    for (const fade of [0, 1]) {
      const s = compile(
        piece({
          start: [48, 55, 60, 64],
          glide: { ...GLIDE, length: fade === 0 ? 0.5 : 2 },
          end: { at: 30, fade: 1 },
          moments: [
            fade === 0
              ? { type: 'merge', at: 1, count: 1, which: 'top', fade: 0 }
              : chord(1, [48, 60], 2),
          ],
        }),
      );
      expect(totalWeight(s, 20), `fade ${fade}`).toBeCloseTo(4, 9);
    }
  });

  it('incremental compiles match full ones through hand-overs', () => {
    const p = piece({
      start: [48, 55, 60, 64, 67],
      glide: GLIDE,
      end: { at: 40, fade: 1 },
      moments: [
        { type: 'merge', at: 1, count: 2, which: 'inner', fade: 2 },
        chord(8, [50, 57, 62, 65], 4),
        unison(16),
        chord(24, [48, 60, 72], 3),
      ],
    });
    const inc = createIncrementalCompiler();
    inc.compile(p);
    const q = structuredClone(p);
    q.moments[2].at = 17;
    expect(inc.compile(q)).toEqual(compile(q));
  });
});

describe('walk steps skip notes held by other lines (revision 8)', () => {
  it('lines a step apart never land on each other, so they never merge', () => {
    const s = compile(
      piece({
        start: [57, 59, 60, 62],
        key: { tonic: 'A', scale: 'aeolian' },
        end: { at: 40, fade: 1 },
        moments: [
          {
            type: 'walk',
            at: 1,
            until: 35,
            grid: 0.5,
            density: 1,
            steps: [-1, 1],
            stepGlide: 0.2,
          },
        ],
      }),
    );
    expect(s.walkSteps.length).toBeGreaterThan(20);
    for (let t = 1; t < 36; t += 0.25) expect(linesAt(s, t), `t ${t}`).toBe(4);
  });
});

function show(as: ReturnType<typeof lineArtifacts>): string[] {
  return as.map((a) => `${a.kind} ${a.voice}`);
}
