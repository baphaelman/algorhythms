/**
 * Tune: random melody and double-click inserted notes (owner, 2026-11-21): `insertTuneNote`
 * (split, on a start, append, prepend, empty), `randomMelody` (line, range, length, key) and
 * `newTuneLength`.
 */

import { describe, expect, it } from 'vitest';
import {
  insertTuneNote,
  newTuneLength,
  randomMelody,
  tuneEnd,
  tuneLineAt,
} from '../../../src/app/editor/tune';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { isScaleTone } from '../../../src/core/scales';
import type { Piece, TuneMoment } from '../../../src/core/types';
import { withStart } from '../core/compiler-fixtures';

const m = {
  at: 2,
  notes: [
    { pitch: 60, len: 1 },
    { pitch: 62, len: 0.5 },
    { pitch: 64, len: 1 },
  ],
};

describe('insertTuneNote', () => {
  it('inside a note: splits it, the new note gets the rest', () => {
    const r = insertTuneNote(m, 2.4, 67, 0.5)!;
    expect(r.at).toBe(2);
    expect(r.index).toBe(1);
    expect(r.notes).toEqual([
      { pitch: 60, len: 0.4 },
      { pitch: 67, len: 0.6 },
      { pitch: 62, len: 0.5 },
      { pitch: 64, len: 1 },
    ]);
    expect(tuneEnd(r)).toBeCloseTo(tuneEnd(m), 9);
    const last = insertTuneNote(m, 4, 59, 0.5)!;
    expect(last.index).toBe(3);
    expect(last.notes.slice(2)).toEqual([
      { pitch: 64, len: 0.5 },
      { pitch: 59, len: 0.5 },
    ]);
  });

  it("on a note's start: the new note takes that note's first half", () => {
    const r = insertTuneNote(m, 3, 67, 0.5)!;
    expect(r.index).toBe(1);
    expect(r.notes).toEqual([
      { pitch: 60, len: 1 },
      { pitch: 67, len: 0.25 },
      { pitch: 62, len: 0.25 },
      { pitch: 64, len: 1 },
    ]);
    // Within the shortest note of a start counts too, as does the tune's start.
    expect(insertTuneNote(m, 3.02, 67, 0.5)!.index).toBe(1);
    expect(insertTuneNote(m, 2.98, 67, 0.5)!.index).toBe(1);
    expect(insertTuneNote(m, 2, 67, 0.5)!.notes.slice(0, 2)).toEqual([
      { pitch: 67, len: 0.5 },
      { pitch: 60, len: 0.5 },
    ]);
  });

  it('after the end: appended at t, the last note stretched to it', () => {
    const r = insertTuneNote(m, 6, 65, 0.5)!;
    expect(r.at).toBe(2);
    expect(r.index).toBe(3);
    expect(r.notes.slice(2)).toEqual([
      { pitch: 64, len: 2.5 },
      { pitch: 65, len: 0.5 },
    ]);
    // At the end exactly: no stretch.
    expect(insertTuneNote(m, 4.5, 65, 1)!.notes.slice(2)).toEqual([
      { pitch: 64, len: 1 },
      { pitch: 65, len: 1 },
    ]);
  });

  it('before the start: prepended, `at` moves to t', () => {
    const r = insertTuneNote(m, 0.5, 55, 0.5)!;
    expect(r.at).toBe(0.5);
    expect(r.index).toBe(0);
    expect(r.notes[0]).toEqual({ pitch: 55, len: 1.5 });
    expect(r.notes.slice(1)).toEqual(m.notes);
    expect(tuneEnd(r)).toBeCloseTo(tuneEnd(m), 9);
  });

  it('an empty tune: the one note at t; clamps; too short to halve', () => {
    expect(insertTuneNote({ at: 1, notes: [] }, 3, 60, 0.5)).toEqual({
      at: 3,
      notes: [{ pitch: 60, len: 0.5 }],
      index: 0,
    });
    expect(insertTuneNote(m, 2.4, 200, 0.5)!.notes[1].pitch).toBe(127);
    expect(insertTuneNote({ at: 0, notes: [{ pitch: 60, len: 0.06 }] }, 0, 62, 0.5)).toBeNull();
    expect(insertTuneNote(m, NaN, 60, 0.5)).toBeNull();
  });
});

/** A3, C4, E4 from 0 in C major, a tune at 4 on the top line. */
function make(t: Partial<TuneMoment> = {}, bpm?: number): Piece {
  const p = newPiece({ seed: 3 });
  const q: Piece = { ...p, key: { tonic: 'C', scale: 'major' }, end: { at: 20, fade: 1 } };
  if (bpm) q.view = { ...q.view, gridBpm: bpm };
  q.voices = q.voices.map((v) => ({ ...v, range: [55, 79] as [number, number] }));
  const tune: TuneMoment = {
    id: 'tun',
    type: 'tune',
    at: 4,
    line: 'high',
    notes: [
      { pitch: 65, len: 1 },
      { pitch: 67, len: 1.5 },
    ],
    ...t,
  };
  q.moments = withStart(q, [57, 60, 64], [tune]);
  return q;
}
const tuneOf = (p: Piece): TuneMoment => p.moments.find((x) => x.id === 'tun') as TuneMoment;

describe('randomMelody', () => {
  it("uses the tune's line (its pitch before the tune), range and current length", () => {
    const p = make();
    const s = compile(p);
    expect(tuneLineAt(p, s, tuneOf(p))).toMatchObject({ voice: 2, pitch: 64, range: [55, 79] });
    for (let seed = 0; seed < 30; seed++) {
      const notes = randomMelody(p, s, tuneOf(p), seed);
      expect(notes.reduce((a, n) => a + n.len, 0)).toBeCloseTo(2.5, 6);
      for (const n of notes) {
        expect(isScaleTone(n.pitch, p.key)).toBe(true);
        expect(n.pitch).toBeGreaterThanOrEqual(55);
        expect(n.pitch).toBeLessThanOrEqual(79);
      }
      expect(Math.abs(notes[0].pitch - 64)).toBeLessThanOrEqual(4);
      expect(randomMelody(p, s, tuneOf(p), seed)).toEqual(notes);
    }
  });

  it('an empty tune gets two bars (with a tempo) or 4 s; lengths in beats', () => {
    const p = make({ notes: [] }, 90);
    const s = compile(p);
    expect(newTuneLength(p.view)).toBeCloseTo(16 / 3, 6);
    // Not compiled onto a line: the line the tune's `line` picks (the top one).
    expect(tuneLineAt(p, s, tuneOf(p)).voice).toBe(2);
    const notes = randomMelody(p, s, tuneOf(p), 7);
    expect(notes.reduce((a, n) => a + n.len, 0)).toBeCloseTo(16 / 3, 5);
    const beat = 60 / 90;
    for (const n of notes) {
      expect([0.5, 1, 1.5, 2].some((b) => Math.abs(n.len - b * beat) < 1e-5)).toBe(true);
    }
    expect(newTuneLength(undefined)).toBe(4);
  });
});
