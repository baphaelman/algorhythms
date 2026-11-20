/**
 * Per-note chord editing (PLAN.md §11.3 "Chord notes", revision 6): pure helpers. The note list is
 * the pitches the chord's voices get, low to high. The first change freezes the chord
 * (`freezeChord`: a `pitches` NoteSet, `assign: 'ordered'`, `count` kept) and keeps the old
 * `notes`/`assign` in `frozenFrom` for Unfreeze.
 */

import { freezeChord } from '../../core/freeze-chord';
import { snapToScale } from '../../core/scales';
import type { ChordMoment, CompiledScore, Key, Piece, Pitch } from '../../core/types';
import type { MomentPatchOf } from './ops';

export type ChordPatch = MomentPatchOf<'chord'>;

/** True if the editor froze this chord (it has something to Unfreeze to). */
export function isFrozenChord(m: ChordMoment): boolean {
  return m.frozenFrom !== undefined;
}

/**
 * The chord's notes, low to high: the stored pitches of a frozen chord, else what each voice it
 * voices gets (`freezeChord`). Null when the chord isn't applied.
 */
export function chordNotes(piece: Piece, score: CompiledScore, m: ChordMoment): Pitch[] | null {
  if (m.frozenFrom && m.notes.kind === 'pitches') return [...m.notes.pitches].sort((a, b) => a - b);
  const f = freezeChord(piece, score, m.id);
  return f && f.notes.kind === 'pitches' ? f.notes.pitches : null;
}

/** `notes` with note `index` set to `pitch`, sorted; null if out of range or unchanged. */
export function withChordNote(
  notes: readonly Pitch[],
  index: number,
  pitch: Pitch,
): Pitch[] | null {
  if (index < 0 || index >= notes.length || pitch < 0 || pitch > 127) return null;
  if (notes[index] === pitch) return null;
  const out = notes.slice();
  out[index] = pitch;
  return out.sort((a, b) => a - b);
}

/** The patch that sets the chord's notes to `pitches`, freezing it if needed. */
export function frozenPatch(m: ChordMoment, pitches: readonly Pitch[]): ChordPatch {
  return {
    notes: { kind: 'pitches', pitches: [...pitches] },
    assign: 'ordered',
    frozenFrom: m.frozenFrom ?? { notes: m.notes, assign: m.assign },
  };
}

/** The patch that restores the chord's notes from before freezing; null if not frozen. */
export function unfreezePatch(m: ChordMoment): ChordPatch | null {
  if (!m.frozenFrom) return null;
  return { notes: m.frozenFrom.notes, assign: m.frozenFrom.assign, frozenFrom: undefined };
}

/** A dragged pitch: snapped to the key, or to the nearest semitone with `chromatic`; 0..127. */
export function dragPitch(p: Pitch, key: Key, chromatic: boolean): Pitch {
  const q = chromatic ? Math.round(p) : snapToScale(p, key);
  return Math.min(127, Math.max(0, q));
}

/** When the chord's notes arrive, for the score dots: its span end, else `at`. */
export function chordArrival(score: CompiledScore, m: ChordMoment): number {
  return score.momentSpans.find((s) => s.id === m.id)?.end ?? m.at;
}
