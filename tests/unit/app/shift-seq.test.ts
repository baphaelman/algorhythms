/**
 * M13 shift sequence in the editor: typed steps (amounts, ":length" in beats or seconds, the
 * spacing default, fractions, errors by step), the text shown for stored steps, the patch, the
 * summary, and the Chords row's one block per step.
 */
import { describe, expect, it } from 'vitest';
import { laneBlocks } from '../../../src/app/editor/lane';
import { rowsOf } from '../../../src/app/editor/rows';
import {
  formatShiftSeq,
  parseShiftSeq,
  shiftSeqPatch,
  shiftSeqSummary,
} from '../../../src/app/editor/shift-seq';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { Moment, Piece } from '../../../src/core/types';

const BEAT = 0.5; // 120 bpm
const SPACING = 2; // a bar of 4

const ok = (
  text: string,
  unit: 'scaleSteps' | 'semitones' = 'scaleSteps',
  beat: number | null = BEAT,
) => {
  const r = parseShiftSeq(text, unit, beat, SPACING);
  if (!r.ok) throw new Error(r.error);
  return r.seq;
};
const err = (text: string, unit: 'scaleSteps' | 'semitones' = 'scaleSteps') => {
  const r = parseShiftSeq(text, unit, BEAT, SPACING);
  return r.ok ? null : r.error;
};

describe('parseShiftSeq', () => {
  it('the doo-wop round: amounts only, each the spacing long', () => {
    expect(ok('−2 −1 −1 +1 +1 +1 +1')).toEqual(
      [-2, -1, -1, 1, 1, 1, 1].map((by) => ({ by, len: SPACING })),
    );
  });

  it('lengths after a colon, in beats; fractions; ASCII minus and commas', () => {
    expect(ok('-2:1, −1:½ 3:1/4 +1:1½ 0:2.5')).toEqual([
      { by: -2, len: 0.5 },
      { by: -1, len: 0.25 },
      { by: 3, len: 0.125 },
      { by: 1, len: 0.75 },
      { by: 0, len: 1.25 },
    ]);
    // Without a tempo, lengths are seconds.
    expect(ok('+1:1.5', 'scaleSteps', null)).toEqual([{ by: 1, len: 1.5 }]);
  });

  it('semitones may be fractional; scale steps are whole', () => {
    expect(ok('+0.5 −1.5', 'semitones')).toEqual([
      { by: 0.5, len: SPACING },
      { by: -1.5, len: SPACING },
    ]);
    expect(err('+0.5')).toMatch(/^Step 1: scale steps are whole numbers/);
  });

  it('errors name the step', () => {
    expect(err('−1 x')).toMatch(/^Step 2: “x” is not an amount/);
    expect(err('−1 +2:q')).toMatch(/^Step 2: “q” is not a length/);
    expect(err('+1:0')).toMatch(/^Step 1: the length must be at least/);
    expect(err('+1:99')).toMatch(/^Step 1: the length must be at most 64 beats/);
    expect(err('+1:2:3')).toMatch(/^Step 1: .* should be an amount and a length/);
  });

  it('empty text is no sequence', () => {
    expect(ok('  ')).toEqual([]);
    expect(shiftSeqPatch([])).toEqual({ seq: undefined });
    expect(shiftSeqPatch([{ by: -2, len: 1 }])).toEqual({ seq: [{ by: -2, len: 1 }], by: -2 });
  });
});

describe('formatShiftSeq', () => {
  it('shows lengths only where they differ from the spacing, and round-trips', () => {
    const seq = [
      { by: -2, len: 2 },
      { by: -1, len: 2 },
      { by: 1, len: 0.5 },
      { by: 0, len: 1 / 3 },
    ];
    const text = formatShiftSeq(seq, BEAT, SPACING);
    expect(text).toBe('−2 −1 +1:1 0:0.667');
    // Committing the shown text keeps the exact lengths.
    const r = parseShiftSeq(text, 'scaleSteps', BEAT, SPACING, seq);
    expect(r.ok && r.seq).toEqual(seq);
  });
});

describe('shiftSeqSummary', () => {
  it('counts the steps, sums them and says where it ends', () => {
    const when = (t: number) => `${t}s`;
    expect(shiftSeqSummary(ok('−2 −1 −1 +1 +1 +1 +1'), 'scaleSteps', 4, when)).toBe(
      '7 steps, net 0 steps, ends at 18s',
    );
    expect(shiftSeqSummary(ok('−1:1', 'semitones'), 'semitones', 0, when)).toBe(
      '1 step, net −1 semitone, ends at 0.5s',
    );
  });
});

describe('the Chords row', () => {
  it('draws one block per step, labelled by its amount, inside one lane block', () => {
    const p: Piece = {
      ...newPiece({ seed: 7, key: { tonic: 'C', scale: 'major' } }),
    };
    p.moments = [
      {
        id: 'c0',
        type: 'chord',
        at: 0,
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'even',
        assign: 'ordered',
      },
      {
        id: 'sq',
        type: 'shift',
        at: 2,
        by: -2,
        unit: 'scaleSteps',
        seq: [
          { by: -2, len: 2 },
          { by: -1, len: 1 },
          { by: 3, len: 1 },
        ],
      } as Moment,
    ];
    const blocks = laneBlocks(rowsOf(p, compile(p))).filter((x) => x.id === 'sq');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].chords?.map((c) => [c.start, c.label])).toEqual([
      [2, '−2 steps'],
      [4, '−1 steps'],
      [5, '+3 steps'],
    ]);
    expect(blocks[0].chords?.slice(0, 2).map((c) => c.end)).toEqual([4, 5]);
  });
});
