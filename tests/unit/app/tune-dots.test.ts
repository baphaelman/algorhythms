/**
 * R9-8: tune dots (one per note at its start; dragging moves pitch and start) and typed notes
 * (parser and formatter, beats and seconds).
 */

import { describe, expect, it } from 'vitest';
import { allArrivals, dotAction, momentArrivals } from '../../../src/app/editor/arrival-points';
import { isDot, pickedIn } from '../../../src/app/editor/dot-selection';
import { groupTargets, moveDots, type MoveEnv } from '../../../src/app/editor/group-move';
import {
  MIN_TUNE_LEN,
  formatTunePitch,
  formatTuneText,
  moveTuneStarts,
  parseTuneText,
  setTunePitch,
  tuneDots,
} from '../../../src/app/editor/tune';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { Key, Piece, TuneMoment, TuneNote } from '../../../src/core/types';

const C: Key = { tonic: 'C', scale: 'major' };
const F: Key = { tonic: 'F', scale: 'major' };
const D: Key = { tonic: 'D', scale: 'major' };

const tune = (extra: Partial<TuneMoment> = {}): TuneMoment => ({
  id: 'tun',
  type: 'tune',
  at: 4,
  notes: [
    { pitch: 60, len: 1 },
    { pitch: 64, len: 0.5 },
    { pitch: 62, len: 1.5 },
  ],
  ...extra,
});

/** One line on C4 from 0, and the tune. */
function withTune(m: TuneMoment = tune()): Piece {
  const p = newPiece({ seed: 3 });
  return { ...p, key: C, end: { at: 20, fade: 1 }, moments: [...p.moments, m] };
}

const lens = (n: readonly TuneNote[]) => n.map((x) => x.len);

describe('tune dots', () => {
  it('one dot per note at its start and pitch, on the tune line', () => {
    const p = withTune();
    const score = compile(p);
    const ds = tuneDots(score, tune());
    expect(ds.map((d) => [d.t, d.pitch, d.note])).toEqual([
      [4, 60, 0],
      [5, 64, 1],
      [5.5, 62, 2],
    ]);
    expect(ds.every((d) => d.type === 'tune' && d.voice !== undefined)).toBe(true);
    expect(new Set(ds.map((d) => d.voice)).size).toBe(1);
    expect(momentArrivals(score, tune())).toEqual(ds);
    // Hover: the tune's dots, not its landings.
    const all = allArrivals(p, score).filter((d) => d.momentId === 'tun');
    expect(all.map((d) => d.note)).toEqual([0, 1, 2]);
    expect(dotAction(p, ds[1], () => null)).toEqual({ kind: 'tune', id: 'tun', note: 1 });
  });

  it('the dot selection tells tune dots apart by note, across moves', () => {
    const ds = tuneDots(compile(withTune()), tune());
    expect(isDot(ds[0], ds[1])).toBe(false);
    const moved = { ...ds[1], t: 4.5, pitch: 67 };
    expect(isDot(ds[1], moved)).toBe(true);
    expect(pickedIn([ds[1]], [ds[0], moved, ds[2]])).toEqual([false, true, false]);
  });
});

describe('moving note starts', () => {
  it('a middle note: the note before it and the note change length; the end stays', () => {
    const r = moveTuneStarts(tune(), new Map([[1, 4.5]]))!;
    expect(r.at).toBe(4);
    expect(lens(r.notes)).toEqual([0.5, 1, 1.5]);
    const later = moveTuneStarts(tune(), new Map([[1, 5.25]]))!;
    expect(lens(later.notes)).toEqual([1.25, 0.25, 1.5]);
  });

  it('the first note moves `at`; the last note keeps the tune end', () => {
    const r = moveTuneStarts(tune(), new Map([[0, 3]]))!;
    expect(r.at).toBe(3);
    expect(lens(r.notes)).toEqual([2, 0.5, 1.5]);
    const last = moveTuneStarts(tune(), new Map([[2, 6]]))!;
    expect(lens(last.notes)).toEqual([1, 1, 1]);
  });

  it('clamps at the neighbours (shortest note) and at 0', () => {
    const r = moveTuneStarts(tune(), new Map([[1, 9]]))!;
    expect(lens(r.notes)).toEqual([1.5 - MIN_TUNE_LEN, MIN_TUNE_LEN, 1.5]);
    const back = moveTuneStarts(tune(), new Map([[1, 0]]))!;
    expect(lens(back.notes)).toEqual([MIN_TUNE_LEN, 1.5 - MIN_TUNE_LEN, 1.5]);
    expect(moveTuneStarts(tune(), new Map([[0, -3]]))!.at).toBe(0);
  });

  it('every note moving shifts the tune; no change is null', () => {
    const all = new Map([
      [0, 5],
      [1, 6],
      [2, 6.5],
    ]);
    const r = moveTuneStarts(tune(), all)!;
    expect(r.at).toBe(5);
    expect(lens(r.notes)).toEqual([1, 0.5, 1.5]);
    expect(moveTuneStarts(tune(), new Map([[1, 5]]))).toBeNull();
    expect(moveTuneStarts(tune(), new Map([[7, 5]]))).toBeNull();
    expect(moveTuneStarts(tune(), new Map([[1, NaN]]))).toBeNull();
  });

  it('pitch: set and clamped; unchanged is null', () => {
    expect(setTunePitch(tune().notes, 1, 65)?.[1].pitch).toBe(65);
    expect(setTunePitch(tune().notes, 1, 200)?.[1].pitch).toBe(127);
    expect(setTunePitch(tune().notes, 1, 64)).toBeNull();
    expect(setTunePitch(tune().notes, 5, 64)).toBeNull();
  });
});

describe('dragging tune dots (moveDots)', () => {
  const env = (p: Piece): MoveEnv => ({
    score: compile(p),
    chordNotes: () => null,
    keep: false,
    order: undefined,
    ids: ['n1', 'n2', 'n3'],
  });
  const tuneIn = (p: Piece) => p.moments.find((m) => m.id === 'tun') as TuneMoment;

  it('vertically the pitch, sideways the start; one moment edited, none added', () => {
    const p = withTune();
    const ds = tuneDots(compile(p), tune());
    const r = moveDots(p, [{ dot: ds[1], pitch: 65, t: 4.5 }], env(p));
    const m = tuneIn(r.piece);
    expect(m.notes.map((n) => n.pitch)).toEqual([60, 65, 62]);
    expect(lens(m.notes)).toEqual([0.5, 1, 1.5]);
    expect(r.piece.moments).toHaveLength(p.moments.length);
    expect(r.hosts).toEqual(['tun']);
    // A pure vertical move keeps the lengths.
    const v = tuneIn(moveDots(p, [{ dot: ds[2], pitch: 59, t: ds[2].t }], env(p)).piece);
    expect(lens(v.notes)).toEqual([1, 0.5, 1.5]);
  });

  it('a group drag: scale steps in the key and the same time offset', () => {
    const p = withTune();
    const ds = tuneDots(compile(p), tune());
    // Grab note 0 (C4) and drag it up a scale step (D4) and 0.25 s later: E4 → F4 for note 1.
    const moves = groupTargets([ds[0], ds[1]], ds[0], 62, 4.25, () => C, false);
    const m = tuneIn(moveDots(p, moves, env(p)).piece);
    expect(m.at).toBe(4.25);
    expect(m.notes.map((n) => n.pitch)).toEqual([62, 65, 62]);
    // Both starts move: note 0 keeps its length, note 1 ends where it did.
    expect(lens(m.notes)).toEqual([1, 0.25, 1.5]);
    // All three: the whole tune shifts.
    const all = groupTargets(ds, ds[0], 60, 6, () => C, false);
    const s = tuneIn(moveDots(p, all, env(p)).piece);
    expect(s.at).toBe(6);
    expect(lens(s.notes)).toEqual([1, 0.5, 1.5]);
  });
});

describe('typed notes', () => {
  it('parses names, flats, decimals; lengths in beats with a tempo', () => {
    const r = parseTuneText('F#5 2, E5 1, D5 1.5, Bb4 0.25', 0.5);
    expect(r).toEqual({
      ok: true,
      notes: [
        { pitch: 78, len: 1 },
        { pitch: 76, len: 0.5 },
        { pitch: 74, len: 0.75 },
        { pitch: 70, len: 0.125 },
      ],
    });
  });

  it('lengths in seconds without a tempo; spacing, case and ♯/♭ are free', () => {
    const r = parseTuneText('  f#5   0.4 ,e♭4 1,C4+25 .5 ', null);
    expect(r).toEqual({
      ok: true,
      notes: [
        { pitch: 78, len: 0.4 },
        { pitch: 63, len: 1 },
        { pitch: 60.25, len: 0.5 },
      ],
    });
  });

  it('a missing length repeats the previous one; empty text is an empty tune', () => {
    expect(parseTuneText('C4, D4 2, E4', 0.5)).toEqual({
      ok: true,
      notes: [
        { pitch: 60, len: 0.5 },
        { pitch: 62, len: 1 },
        { pitch: 64, len: 1 },
      ],
    });
    expect(parseTuneText('C4', null)).toEqual({ ok: true, notes: [{ pitch: 60, len: 0.5 }] });
    expect(parseTuneText('   ', 0.5)).toEqual({ ok: true, notes: [] });
  });

  it('errors name the note', () => {
    const err = (text: string, beat: number | null = 0.5) => {
      const r = parseTuneText(text, beat);
      return r.ok ? null : r.error;
    };
    expect(err('H5 1')).toMatch(/^Note 1: “H5” is not a note name/);
    expect(err('C4 1, 60 2')).toMatch(/^Note 2: “60” is not a note name/);
    expect(err('C4 1, D4 x')).toMatch(/^Note 2: “x” is not a length/);
    expect(err('C4 1 2')).toMatch(/^Note 1: .* should be a note and a length/);
    expect(err('C4 1,, D4 1')).toMatch(/^Note 2 is empty/);
    expect(err('C4 0')).toMatch(/at least 0\.1 beats/);
    expect(err('C4 -1', null)).toMatch(/at least 0\.05 s/);
    expect(err('C4 65')).toMatch(/at most 64 beats/);
    expect(err('C4 61', null)).toMatch(/at most 60 s/);
    expect(err('G9 1')).toBeNull(); // MIDI 127
    expect(err('G#9 1')).toMatch(/not a note name/);
  });

  it('formats in the key at each note, lengths in beats or seconds', () => {
    const m = tune({
      notes: [
        { pitch: 66, len: 1 },
        { pitch: 70, len: 0.25 },
        { pitch: 60.5, len: 1 / 3 },
      ],
    });
    expect(formatTuneText(m, 0.5, () => D)).toBe('F#4 2, A#4 0.5, C#4-50 0.667');
    expect(formatTuneText(m, null, () => F)).toBe('Gb4 1, Bb4 0.25, Db4-50 0.333');
    expect(formatTuneText(m, null)).toBe('F#4 1, A#4 0.25, C#4-50 0.333');
    expect(formatTuneText(tune({ notes: [] }), 0.5)).toBe('');
    // Spellings over the octave line still parse back to the same pitch.
    expect(formatTunePitch(60, { tonic: 'C#', scale: 'major' })).toBe('B#3');
    expect(formatTunePitch(59, { tonic: 'Gb', scale: 'major' })).toBe('Cb4');
  });

  it('round trip: format → parse gives the same notes, exact lengths kept via prev', () => {
    const m = tune({
      notes: [
        { pitch: 78, len: 1 },
        { pitch: 70, len: 1 / 3 },
        { pitch: 61.25, len: 0.05 },
      ],
    });
    for (const beat of [0.5, null, 0.4]) {
      for (const key of [C, F, D]) {
        const text = formatTuneText(m, beat, () => key);
        const r = parseTuneText(text, beat, m.notes);
        expect(r).toEqual({ ok: true, notes: m.notes });
        // Without prev: the same text again (lengths to the shown precision).
        const loose = parseTuneText(text, beat);
        expect(loose.ok).toBe(true);
        if (loose.ok)
          expect(formatTuneText({ ...m, notes: loose.notes }, beat, () => key)).toBe(text);
      }
    }
    // A changed length is taken as typed.
    const r = parseTuneText('F#5 2, Bb4 1, C#4+25 0.1', 0.5, m.notes);
    expect(r.ok && lens(r.notes)).toEqual([1, 0.5, 0.05]);
  });
});
