/** Per-note chord editing helpers (PLAN.md §11.3 Chord notes, revision 6). */
import { describe, expect, it } from 'vitest';
import {
  chordArrival,
  chordNotes,
  dragPitch,
  frozenPatch,
  isFrozenChord,
  unfreezePatch,
  withChordNote,
} from '../../../src/app/editor/chord-notes';
import { patchMoment } from '../../../src/app/editor/ops';
import { compile } from '../../../src/core/compiler/compile';
import type { ChordMoment, Key, Piece } from '../../../src/core/types';
import { chordAt, piece } from '../core/compiler-fixtures';

const C_MAJOR: Key = { tonic: 'C', scale: 'major' };

const chord: ChordMoment = {
  id: 'c',
  type: 'chord',
  at: 1,
  notes: { kind: 'chord', symbol: 'Am' },
  voicing: 'even',
  assign: 'free',
};
const base = (c: ChordMoment = chord): Piece =>
  piece({ start: [48, 55, 60, 64], glide: { length: 2, jitter: 0, stagger: 0 }, moments: [c] });
const at = (s: ReturnType<typeof compile>) => [...chordAt(s, 6)].sort((a, b) => a - b);

describe('chord notes', () => {
  it('lists the notes each voice gets, low to high, before and after freezing', () => {
    const p = base();
    const s = compile(p);
    const notes = chordNotes(p, s, chord)!;
    expect(notes).toEqual(at(s));
    const frozen = patchMoment(p, 'c', frozenPatch(chord, notes));
    const m = frozen.moments[0] as ChordMoment;
    expect(isFrozenChord(m)).toBe(true);
    expect(m.assign).toBe('ordered');
    expect(m.frozenFrom).toEqual({ notes: chord.notes, assign: 'free' });
    // Freezing alone keeps the sound.
    expect(at(compile(frozen))).toEqual(notes);
    expect(chordNotes(frozen, compile(frozen), m)).toEqual(notes);
  });

  it('a note change edits one pitch, keeps frozenFrom, and Unfreeze restores', () => {
    const p = base();
    const notes = chordNotes(p, compile(p), chord)!;
    const next = withChordNote(notes, 1, notes[1] + 1)!;
    expect(next.filter((x, i) => x !== notes[i])).toHaveLength(1);
    const once = patchMoment(p, 'c', frozenPatch(chord, next));
    const m1 = once.moments[0] as ChordMoment;
    expect(at(compile(once))).toEqual(next);
    // A second change keeps the original notes to unfreeze to.
    const twice = patchMoment(once, 'c', frozenPatch(m1, withChordNote(next, 0, next[0] - 1)!));
    const m2 = twice.moments[0] as ChordMoment;
    expect(m2.frozenFrom).toEqual(m1.frozenFrom);
    const back = patchMoment(twice, 'c', unfreezePatch(m2)!);
    expect(back.moments[0]).toEqual(chord);
    expect(unfreezePatch(chord)).toBeNull();
  });

  it('withChordNote keeps notes sorted and rejects no-ops and out-of-range', () => {
    expect(withChordNote([48, 55, 60], 0, 57)).toEqual([55, 57, 60]);
    expect(withChordNote([48, 55, 60], 0, 48)).toBeNull();
    expect(withChordNote([48, 55, 60], 3, 50)).toBeNull();
    expect(withChordNote([48, 55, 60], 2, 128)).toBeNull();
  });

  it('dragPitch snaps to the key, or to semitones with chromatic', () => {
    expect(dragPitch(60.9, C_MAJOR, false)).toBe(60);
    expect(dragPitch(61.2, C_MAJOR, true)).toBe(61);
    expect(dragPitch(140, C_MAJOR, true)).toBe(127);
  });

  it('dots sit at the chord span end', () => {
    const p = base();
    const s = compile(p);
    expect(chordArrival(s, chord)).toBeCloseTo(3, 6);
  });
});
