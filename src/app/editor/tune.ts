/**
 * Tune editing (PLAN.md §6.2 `tune`, §11.3; R9-7): the inspector's note list. Pure: note starts,
 * lengths in beats (with a tempo) or seconds, ▲/▼ by a scale step in the key at the note, add and
 * remove. Dragging dots on the score and typed input are R9-8.
 */

import { stepByScale } from '../../core/scales';
import type { Key, Pitch, Seconds, TuneMoment, TuneNote, ViewSettings } from '../../core/types';
import { scaleNeighbour } from './walk-steps';

/** Shortest note length the editor writes, seconds. */
export const MIN_TUNE_LEN: Seconds = 0.05;

/** Rounds to 1 µs so lengths print cleanly. */
const roundUs = (t: Seconds): Seconds => Math.round(t * 1e6) / 1e6;

/** Seconds per beat when the piece has a tempo (`view.gridBpm`), else null. */
export function tuneBeat(view: Pick<ViewSettings, 'gridBpm'> | undefined): Seconds | null {
  const bpm = view?.gridBpm;
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null;
}

/** Note k's start: `at` plus the lengths before it (the last entry is the tune's end). */
export function tuneNoteStarts(m: Pick<TuneMoment, 'at' | 'notes'>): Seconds[] {
  const out: Seconds[] = [m.at];
  let t = m.at;
  for (const n of m.notes) out.push((t += Math.max(0, n.len)));
  return out;
}

/** The tune's end: `at` plus every note's length. */
export function tuneEnd(m: Pick<TuneMoment, 'at' | 'notes'>): Seconds {
  return tuneNoteStarts(m).at(-1) ?? m.at;
}

/** A length shown in the list: beats (with a tempo, `beat` s) or seconds. */
export function lenShown(len: Seconds, beat: Seconds | null): number {
  return beat ? roundUs(len / beat) : len;
}

/** A shown length back to seconds (≥ MIN_TUNE_LEN). */
export function lenFromShown(v: number, beat: Seconds | null): Seconds {
  return Math.max(MIN_TUNE_LEN, roundUs(beat ? v * beat : v));
}

/** `notes` with note k replaced by `patch` (a new array; unchanged if k is out of range). */
function withNote(notes: readonly TuneNote[], k: number, patch: Partial<TuneNote>): TuneNote[] {
  return notes.map((n, i) => (i === k ? { ...n, ...patch } : n));
}

/** Note k moved one scale step up or down in `key` (off-scale notes go to the nearest step). */
export function stepTuneNote(
  notes: readonly TuneNote[],
  k: number,
  dir: 1 | -1,
  key: Key,
): TuneNote[] | null {
  const n = notes[k];
  if (!n) return null;
  const pitch = clampPitch(scaleNeighbour(n.pitch, dir, key));
  return pitch === n.pitch ? null : withNote(notes, k, { pitch });
}

/** Note k's length set to `len` seconds (≥ MIN_TUNE_LEN); null if unchanged. */
export function setTuneLen(notes: readonly TuneNote[], k: number, len: Seconds): TuneNote[] | null {
  const n = notes[k];
  if (!n || !Number.isFinite(len)) return null;
  const v = Math.max(MIN_TUNE_LEN, roundUs(len));
  return v === n.len ? null : withNote(notes, k, { len: v });
}

/**
 * A note appended after the last: one scale step above it, same length (an empty tune starts on
 * `fallback`, one beat or 0.5 s long).
 */
export function addTuneNote(
  notes: readonly TuneNote[],
  key: Key,
  fallback: Pitch,
  beat: Seconds | null,
): TuneNote[] {
  const last = notes.at(-1);
  const note: TuneNote = last
    ? { pitch: clampPitch(stepByScale(last.pitch, 1, key)), len: last.len }
    : { pitch: clampPitch(Math.round(fallback)), len: beat ?? 0.5 };
  return [...notes, note];
}

/** `notes` without note k; null if k is out of range. */
export function removeTuneNote(notes: readonly TuneNote[], k: number): TuneNote[] | null {
  if (k < 0 || k >= notes.length) return null;
  return notes.filter((_, i) => i !== k);
}

/**
 * Dragging the tune's end on the lane by `dt` seconds: the last note's length (≥ MIN_TUNE_LEN).
 * Null when nothing changes (or the tune has no notes).
 */
export function tuneEndDrag(m: Pick<TuneMoment, 'notes'>, dt: Seconds): TuneNote[] | null {
  const k = m.notes.length - 1;
  if (k < 0) return null;
  return setTuneLen(m.notes, k, m.notes[k].len + dt);
}

function clampPitch(p: Pitch): Pitch {
  return Math.min(127, Math.max(0, p));
}
