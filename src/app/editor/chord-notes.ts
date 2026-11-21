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
 * The chord's notes, one per voice in voice order (low to high by where the voices were heading):
 * the stored pitches of a frozen chord (sorted unless `byVoice`), else what each voice it voices
 * gets (`freezeChord`). Null when the chord isn't applied.
 */
export function chordNotes(piece: Piece, score: CompiledScore, m: ChordMoment): Pitch[] | null {
  // A by-voice opening (a migrated v1 start, M4.5-27) lists its notes in voice order too.
  if ((m.frozenFrom || m.byVoice) && m.notes.kind === 'pitches') {
    const ps = [...m.notes.pitches];
    return m.byVoice ? ps : ps.sort((a, b) => a - b);
  }
  const f = freezeChord(piece, score, m.id);
  return f && f.notes.kind === 'pitches' ? f.notes.pitches : null;
}

/**
 * `notes` with note `index` set to `pitch`; sorted when `keepOrder`, else each voice keeps its
 * place. Null if out of range or unchanged.
 */
export function withChordNote(
  notes: readonly Pitch[],
  index: number,
  pitch: Pitch,
  keepOrder = true,
): Pitch[] | null {
  if (index < 0 || index >= notes.length || pitch < 0 || pitch > 127) return null;
  if (notes[index] === pitch) return null;
  const out = notes.slice();
  out[index] = pitch;
  return keepOrder ? out.sort((a, b) => a - b) : out;
}

/**
 * The patch that sets the chord's notes to `pitches` (in voice order), freezing it if needed.
 * `keepOrder` ("Keep lines in order", §11.3): sorted and ordered; else `byVoice` (each voice keeps
 * its own note, lines may cross) with `assign: 'free'`.
 */
export function frozenPatch(
  m: ChordMoment,
  pitches: readonly Pitch[],
  keepOrder = true,
): ChordPatch {
  const frozenFrom = m.frozenFrom ?? { notes: m.notes, assign: m.assign };
  if (keepOrder) {
    const sorted = [...pitches].sort((a, b) => a - b);
    return {
      notes: { kind: 'pitches', pitches: sorted },
      assign: 'ordered',
      byVoice: undefined,
      frozenFrom,
    };
  }
  return {
    notes: { kind: 'pitches', pitches: [...pitches] },
    assign: 'free',
    byVoice: true,
    frozenFrom,
  };
}

/** The patch that switches a frozen chord's "Keep lines in order"; null if not frozen. */
export function chordOrderPatch(m: ChordMoment, keepOrder: boolean): ChordPatch | null {
  if (!m.frozenFrom || m.notes.kind !== 'pitches') return null;
  return frozenPatch(m, m.notes.pitches, keepOrder);
}

/** True when a frozen chord keeps its lines in order (not `byVoice`). */
export function chordKeepsOrder(m: ChordMoment): boolean {
  return !m.byVoice;
}

/** The patch that restores the chord's notes from before freezing; null if not frozen. */
export function unfreezePatch(m: ChordMoment): ChordPatch | null {
  if (!m.frozenFrom) return null;
  return {
    notes: m.frozenFrom.notes,
    assign: m.frozenFrom.assign,
    frozenFrom: undefined,
    byVoice: undefined,
  };
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
