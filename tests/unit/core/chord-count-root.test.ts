/**
 * Notes: 1 (PLAN §6.4, revision 14; M10b-2): a chord symbol with `count: 1` sounds its bass (the
 * slash bass, else the root), nearest where the lines were, inside the range and register.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { activeAt } from '../../../src/core/query';
import type { ChordMoment } from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const START = [48, 55, 60, 64, 67];

function chord(symbol: string, extra: Partial<ChordMoment> = {}): MomentInput {
  return {
    id: 'c',
    type: 'chord',
    at: 1,
    notes: { kind: 'chord', symbol },
    voicing: 'even',
    assign: 'ordered',
    count: 1,
    ...extra,
  };
}

const one = (moments: MomentInput[], start = START): number[] => {
  const s = compile(piece({ pool: 8, start, glide: GLIDE, end: { at: 12, fade: 1 }, moments }));
  expect(activeAt(s, 8)).toHaveLength(1);
  return chordAt(s, 8);
};

describe('chord count 1', () => {
  it('sounds the root nearest the lines (mean 58.8: D 62, not 50)', () => {
    expect(one([chord('Dm9')])).toEqual([62]);
    expect(one([chord('Am')])).toEqual([57]);
  });

  it('a slash chord sounds its bass', () => {
    expect(one([chord('C/E')])).toEqual([64]);
  });

  it('inside the register when it holds one', () => {
    expect(one([chord('Dm9', { register: [40, 52] })])).toEqual([50]);
  });

  it('from one line, and from silence', () => {
    expect(one([chord('G')], [60])).toEqual([55]);
    // From silence: the voicing put its note on E 64; the nearest A is 69.
    expect(one([chord('Am')], [])).toEqual([69]);
  });

  it('pitches and degrees keep today’s rule', () => {
    expect(
      one([{ ...chord('C'), notes: { kind: 'pitches', pitches: [72] } } as MomentInput]),
    ).toEqual([72]);
    const d = one([{ ...chord('C'), notes: { kind: 'degrees', degrees: [4] } } as MomentInput]);
    // A dorian: degree 4 is E.
    expect(((d[0] % 12) + 12) % 12).toBe(4);
  });
});
