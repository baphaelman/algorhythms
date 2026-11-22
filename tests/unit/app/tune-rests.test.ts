/**
 * PLAN rev 10 editor helpers: typed rests, rest rows and dots, the lane's gap, Follow key
 * (`writtenIn`), and every edit path showing sounding pitches while writing the written ones.
 */

import { describe, expect, it } from 'vitest';
import { moveDots, type MoveEnv } from '../../../src/app/editor/group-move';
import { laneArt } from '../../../src/app/editor/lane';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import {
  addTuneNote,
  followKeyPatch,
  formatTuneText,
  melodyMove,
  parseTuneText,
  randomMelody,
  setTunePitch,
  shiftTuneNotes,
  stepTuneNote,
  tuneDots,
  tuneShiftIn,
} from '../../../src/app/editor/tune';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { pitchAt } from '../../../src/core/query';
import type { Key, Moment, Piece, TuneMoment, TuneNote } from '../../../src/core/types';
import { withOpening } from '../opened-piece';

const C: Key = { tonic: 'C', scale: 'major' };
const D: Key = { tonic: 'D', scale: 'major' };

const NOTES: TuneNote[] = [
  { pitch: 60, len: 1 },
  { rest: true, len: 0.5 },
  { pitch: 64, len: 1 },
];

const tune = (extra: Partial<TuneMoment> = {}): TuneMoment => ({
  id: 'tun',
  type: 'tune',
  at: 4,
  notes: structuredClone(NOTES),
  ...extra,
});

/** One line on C4 from 0, the piece key `key`, and the tune. */
function withTune(m: TuneMoment = tune(), key: Key = C): Piece {
  const p = withOpening(newPiece({ seed: 3 }));
  return { ...p, key, end: { at: 20, fade: 1 }, moments: [...p.moments, m] };
}

const pitches = (n: readonly TuneNote[]) => n.map((x) => x.pitch ?? null);

describe('typed rests', () => {
  it('parses r and rest (any case), lengths as for notes', () => {
    const r = parseTuneText('C4 1, r 0.5, REST 2, Rest, E4', null);
    expect(r).toEqual({
      ok: true,
      notes: [
        { pitch: 60, len: 1 },
        { rest: true, len: 0.5 },
        { rest: true, len: 2 },
        { rest: true, len: 2 },
        { pitch: 64, len: 2 },
      ],
    });
    expect(parseTuneText('rr 1', null).ok).toBe(false);
  });

  it('formats a rest as r and round-trips', () => {
    const text = formatTuneText(tune(), null, () => C);
    expect(text).toBe('C4 1, r 0.5, E4 1');
    expect(parseTuneText(text, null, NOTES)).toEqual({ ok: true, notes: NOTES });
  });

  it('a rest has no ▲/▼ step and no pitch to set; Add note steps from the last note', () => {
    expect(stepTuneNote(NOTES, 1, 1, C)).toBeNull();
    expect(setTunePitch(NOTES, 1, 62)).toBeNull();
    const rest: TuneNote[] = [...NOTES, { rest: true, len: 0.25 }];
    expect(addTuneNote(rest, C, 60, null).at(-1)).toEqual({ pitch: 65, len: 0.25 });
  });
});

describe('rests on the score and the lane', () => {
  it('no dot for a rest; the others keep their note index', () => {
    const ds = tuneDots(compile(withTune()), tune());
    expect(ds.map((d) => [d.t, d.pitch, d.note])).toEqual([
      [4, 60, 0],
      [5.5, 64, 2],
    ]);
  });

  it("the lane's tune bar has a gap for the rest", () => {
    const art = laneArt(tune(), 4, 6.5);
    expect(art?.kind).toBe('tune');
    if (art?.kind !== 'tune') return;
    expect(art.notes.map((n) => [n.left, n.width])).toEqual([
      [0, 40],
      [60, 40],
    ]);
  });
});

describe('Follow key (writtenIn)', () => {
  it('new tunes follow the key at their time', () => {
    const p = withTune(tune(), D);
    const m = defaultMoment('tune', 8, 'zzzzzz', p, compile(p)) as TuneMoment;
    expect(m.writtenIn).toBe('D');
    expect(tuneShiftIn(compile({ ...p, moments: [...p.moments, m as Moment] }), m)).toBe(0);
  });

  it('turning it on or off keeps the sound', () => {
    // Written in C, sounding in D (+2); off writes the sounding pitches.
    const m = tune({ writtenIn: 'C' });
    const s = compile(withTune(m, D));
    expect(pitchAt(s.voices[0], 4.5)).toBe(62);
    const off = followKeyPatch(s, m, false)!;
    expect(off).toEqual({ writtenIn: undefined, notes: shiftTuneNotes(NOTES, 2) });
    // On from absolute: written in the tonic now, notes unchanged.
    const plain = tune();
    expect(followKeyPatch(compile(withTune(plain, D)), plain, true)).toEqual({
      writtenIn: 'D',
      notes: plain.notes,
    });
    expect(followKeyPatch(s, m, true)).toBeNull();
  });

  it('dots show sounding pitches; drags write the written ones back', () => {
    const m = tune({ writtenIn: 'C' });
    const p = withTune(m, D);
    const score = compile(p);
    const ds = tuneDots(score, m);
    expect(ds.map((d) => d.pitch)).toEqual([62, 66]);
    const env: MoveEnv = { score, chordNotes: () => null, keep: false, order: undefined, ids: [] };
    const r = moveDots(p, [{ dot: ds[1], pitch: 67, t: ds[1].t }], env);
    const moved = r.piece.moments.find((x) => x.id === 'tun') as TuneMoment;
    expect(pitches(moved.notes)).toEqual([60, null, 65]);
  });

  it('Melody on and Random melody work in sounding pitches', () => {
    const m = tune({ writtenIn: 'C' });
    const p = withTune(m, D);
    const score = compile(p);
    // Random melodies are drawn in the key at `at` (D) and written back in C.
    const notes = randomMelody(p, score, m, 11);
    const shifted = shiftTuneNotes(notes, 2);
    const outOfD = [0, 3, 5, 8, 10];
    for (const n of shifted) expect(outOfD).not.toContain((((n.pitch ?? 0) % 12) + 12) % 12);
    // Melody on with one line: nothing to move.
    expect(melodyMove(p, score, m, { kind: 'line', line: 'low' }).notes).toBeUndefined();
  });
});
