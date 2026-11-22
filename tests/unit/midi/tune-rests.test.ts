/** MIDI export of tune rests and re-strikes (PLAN rev 10): a rest ends the note, a repeat strikes anew. */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import type { TuneNote } from '../../../src/core/types';
import { exportMidi, PPQ } from '../../../src/midi/export';
import { piece, type MomentInput } from '../core/compiler-fixtures';
import { parseSmf, reconstruct, tempoOf } from './smf-parser';

const NOTES: TuneNote[] = [
  { pitch: 62, len: 1 },
  { rest: true, len: 1 },
  { pitch: 64, len: 1 },
  { pitch: 64, len: 1 },
  { pitch: 65, len: 1 },
];

function score(strike?: boolean) {
  const m = { type: 'tune', at: 1, notes: NOTES, ...(strike === undefined ? {} : { strike }) };
  return compile(
    piece({
      pool: 2,
      start: [60],
      glide: { length: 0.5, stagger: 0, jitter: 0 },
      moments: [m as MomentInput],
      end: { at: 8, fade: 0.5 },
    }),
  );
}

/** Notes of the tune's track as [note, on, off] in seconds. */
function notesOf(notesOnly: boolean, strike?: boolean): [number, number, number][] {
  const file = exportMidi(score(strike), notesOnly ? { mode: 'notesOnly' } : {}).files[0];
  const smf = parseSmf(file.data);
  const tr = reconstruct(smf.tracks[1]);
  const tps = (PPQ * 1e6) / tempoOf(smf.tracks[0]);
  return tr.notes.map((n) => [n.note, +(n.on / tps).toFixed(3), +(n.off / tps).toFixed(3)]);
}

describe('MIDI: tune rests and re-strikes', () => {
  it('a rest ends the note; the next comes in as a new note', () => {
    const ns = notesOf(false);
    // 60 → 62 glides in one note (bends), then the rest, then 64 (re-struck at 4); 65 is a bend.
    expect(ns.map((n) => n[0])).toEqual([60, 64, 64]);
    expect(ns[0][2]).toBeCloseTo(2.02, 2);
    expect(ns[1][1]).toBe(3);
    expect(ns[1][2]).toBe(4);
    expect(ns[2][1]).toBe(4);
  });

  it('strike: false holds the repeat as one note', () => {
    const ns = notesOf(false, false);
    expect(ns.map((n) => n[1])).toEqual([0, 3]);
  });

  it('notes only: one note per arrival, the repeat split', () => {
    const ns = notesOf(true);
    expect(ns.map((n) => n[0])).toEqual([60, 62, 64, 64, 65]);
    expect(ns.filter((n) => n[0] === 64).map((n) => [n[1], n[2]])).toEqual([
      [3, 4],
      [4, 5],
    ]);
    expect(notesOf(true, false).filter((n) => n[0] === 64)).toHaveLength(1);
  });
});
