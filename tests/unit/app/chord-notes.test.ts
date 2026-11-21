/** Per-note chord editing helpers (PLAN.md §11.3 Chord notes, revision 6). */
import { describe, expect, it } from 'vitest';
import {
  chordArrival,
  chordKeepsOrder,
  chordNotes,
  chordOrderPatch,
  dragPitch,
  frozenPatch,
  isFrozenChord,
  unfreezePatch,
  withChordNote,
} from '../../../src/app/editor/chord-notes';
import { patchMoment } from '../../../src/app/editor/ops';
import { compile } from '../../../src/core/compiler/compile';
import type { ChordMoment, Key, Piece } from '../../../src/core/types';
import { chordAt, finalPitch, piece } from '../core/compiler-fixtures';

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
    const m = frozen.moments[1] as ChordMoment;
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
    const m1 = once.moments[1] as ChordMoment;
    expect(at(compile(once))).toEqual(next);
    // A second change keeps the original notes to unfreeze to.
    const twice = patchMoment(once, 'c', frozenPatch(m1, withChordNote(next, 0, next[0] - 1)!));
    const m2 = twice.moments[1] as ChordMoment;
    expect(m2.frozenFrom).toEqual(m1.frozenFrom);
    const back = patchMoment(twice, 'c', unfreezePatch(m2)!);
    expect(back.moments[1]).toEqual(chord);
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

  it('with Keep lines in order off, the edited voice keeps its own note and may cross', () => {
    const p = base();
    const notes = chordNotes(p, compile(p), chord)!;
    // The lowest voice's note goes above its neighbour; the list keeps voice order.
    const up = notes[1] + 2;
    const next = withChordNote(notes, 0, up, false)!;
    expect(next).toEqual([up, ...notes.slice(1)]);
    const crossed = patchMoment(p, 'c', frozenPatch(chord, next, false));
    const m = crossed.moments[1] as ChordMoment;
    expect(m).toMatchObject({ byVoice: true, assign: 'free' });
    expect(chordKeepsOrder(m)).toBe(false);
    expect(chordNotes(crossed, compile(crossed), m)).toEqual(next);
    const s = compile(crossed);
    // Voice 0 (lowest at the start) ends on the new note; the others keep theirs.
    expect(s.voices.slice(0, 4).map(finalPitch)).toEqual(next);
    // Keeping order instead: sorted, the voices swap places.
    const ordered = patchMoment(crossed, 'c', chordOrderPatch(m, true)!);
    const o = ordered.moments[1] as ChordMoment;
    expect(o.byVoice).toBeUndefined();
    expect(o.assign).toBe('ordered');
    expect(compile(ordered).voices.slice(0, 4).map(finalPitch)).toEqual(
      [...next].sort((a, b) => a - b),
    );
    // Unfreeze drops byVoice too.
    expect(patchMoment(crossed, 'c', unfreezePatch(m)!).moments[1]).toEqual(chord);
    expect(chordOrderPatch(chord, true)).toBeNull();
  });
});
