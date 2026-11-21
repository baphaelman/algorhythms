/**
 * Tune editing (PLAN.md §6.2 `tune`, §11.3; R9-7): the inspector's note list. Pure: note starts,
 * lengths in beats (with a tempo) or seconds, ▲/▼ by a scale step in the key at the note, add and
 * remove. R9-8: the score's tune dots (`tuneDots`, moving note starts) and typed notes.
 */

import { noteName, stepByScale } from '../../core/scales';
import type {
  CompiledScore,
  Key,
  Pitch,
  Seconds,
  TuneMoment,
  TuneNote,
  ViewSettings,
} from '../../core/types';
import { noteLabel } from '../../render';
import { formatNum, parseNum, parsePitch } from '../ui/inspector/fields';
import type { ArrivalDot } from './arrival-points';
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

/**
 * The tune's score dots (R9-8): one per note, at its start and stored pitch, with `note` = its
 * index. The voice is the line the compiler moved for that note (a segment of the tune within the
 * note), else the previous note's.
 */
export function tuneDots(score: CompiledScore, m: TuneMoment): ArrivalDot[] {
  const S = tuneNoteStarts(m);
  const segs: { t0: Seconds; t1: Seconds; v: number }[] = [];
  for (const v of score.voices) {
    for (const s of v.segments) {
      if (s.momentId === m.id) segs.push({ t0: s.t0, t1: s.t1, v: v.index });
    }
  }
  let voice: number | undefined = segs[0]?.v;
  return m.notes.map((n, k) => {
    const lo = S[k] - 1e-6;
    const hi = S[k + 1] - 1e-6;
    const hit =
      segs.find((s) => s.t0 >= lo && s.t0 < hi) ?? segs.find((s) => s.t0 < hi && s.t1 > lo);
    if (hit) voice = hit.v;
    const d: ArrivalDot = { momentId: m.id, type: 'tune', t: S[k], pitch: n.pitch, note: k };
    if (voice !== undefined) d.voice = voice;
    return d;
  });
}

/**
 * Moving note starts (R9-8, score dots): note k's start goes to `starts.get(k)` and its end stays,
 * so the note before it and note k change length (note 0 moves `at`). When every note moves, the
 * whole tune shifts by note 0's offset. Starts are clamped so every note keeps MIN_TUNE_LEN and
 * `at` stays ≥ 0. Null when nothing changes.
 */
export function moveTuneStarts(
  m: Pick<TuneMoment, 'at' | 'notes'>,
  starts: ReadonlyMap<number, Seconds>,
): { at: Seconds; notes: TuneNote[] } | null {
  const n = m.notes.length;
  const moved = [...starts.keys()].filter((k) => k >= 0 && k < n).sort((a, b) => a - b);
  if (moved.length === 0 || moved.some((k) => !Number.isFinite(starts.get(k)))) return null;
  const S = tuneNoteStarts(m);
  if (moved.length === n) {
    const at = Math.max(0, roundUs(m.at + (starts.get(0)! - S[0]))) + 0;
    return at === m.at ? null : { at, notes: m.notes.slice() };
  }
  const T = S.slice();
  for (const k of moved) {
    T[k] = Math.max(k === 0 ? 0 : T[k - 1] + MIN_TUNE_LEN, roundUs(starts.get(k)!));
  }
  for (let i = moved.length - 1; i >= 0; i--) {
    const k = moved[i];
    T[k] = Math.min(T[k], T[k + 1] - MIN_TUNE_LEN);
  }
  // A start squeezed between neighbours closer than two shortest notes stays where it was.
  for (const k of moved) {
    const lo = k === 0 ? 0 : T[k - 1] + MIN_TUNE_LEN - 1e-9;
    if (T[k] < lo) T[k] = S[k];
  }
  T.forEach((t, k) => (T[k] = roundUs(t)));
  if (T.every((t, k) => Math.abs(t - S[k]) < 1e-9)) return null;
  const notes = m.notes.map((x, k) =>
    T[k] === S[k] && T[k + 1] === S[k + 1] ? x : { ...x, len: roundUs(T[k + 1] - T[k]) },
  );
  return { at: Math.max(0, T[0]) + 0, notes };
}

/** Note k's pitch set to `pitch` (clamped to 0..127); null if unchanged. */
export function setTunePitch(
  notes: readonly TuneNote[],
  k: number,
  pitch: Pitch,
): TuneNote[] | null {
  const n = notes[k];
  if (!n || !Number.isFinite(pitch)) return null;
  const p = clampPitch(pitch);
  return p === n.pitch ? null : withNote(notes, k, { pitch: p });
}

// ---------------------------------------------------------------------------------------------
// Typed notes (R9-8): "F#5 2, E5 1, D5 1"
// ---------------------------------------------------------------------------------------------

/** Longest typed length: 64 beats, or 60 s without a tempo (as the list's length boxes). */
const MAX_BEATS = 64;
const MAX_SECONDS = 60;

/** A length as typed: beats (with a tempo) or seconds, up to 3 decimals. */
export function formatTuneLen(len: Seconds, beat: Seconds | null): string {
  return formatNum(lenShown(len, beat), 3);
}

/**
 * A pitch as typed: its name in `key` (ASCII '#'/'b'; a double accidental falls back to sharps),
 * plus cents when it is not a whole semitone ("C4+25").
 */
export function formatTunePitch(p: Pitch, key?: Key): string {
  const n = Math.round(p);
  const cents = Math.round((p - n) * 100);
  let name = noteLabel(n, key).replace(/♯/g, '#').replace(/♭/g, 'b');
  if (parsePitch(name) !== n) name = noteName(n);
  return cents === 0 ? name : `${name}${cents > 0 ? '+' : '-'}${Math.abs(cents)}`;
}

/**
 * The notes as typed text, "F#5 2, E5 1, D5 1": each note's name (spelled in the key at its
 * start, `keyAt`) and length (beats with a tempo, else seconds).
 */
export function formatTuneText(
  m: Pick<TuneMoment, 'at' | 'notes'>,
  beat: Seconds | null,
  keyAt?: (t: Seconds) => Key,
): string {
  const starts = tuneNoteStarts(m);
  return m.notes
    .map((n, k) => `${formatTunePitch(n.pitch, keyAt?.(starts[k]))} ${formatTuneLen(n.len, beat)}`)
    .join(', ');
}

export type TuneParse = { ok: true; notes: TuneNote[] } | { ok: false; error: string };

/**
 * Parses typed notes: comma-separated items "<pitch> <length>". A pitch is a note name with
 * octave (sharps, flats, cents: "F#5", "Bb4", "C4+25"), not a MIDI number; a length is beats (with
 * a tempo, `beat` s each) or seconds, decimals allowed; a missing length repeats the previous one
 * (the first: one beat, or 0.5 s). Empty text is an empty tune. With `prev` (the current notes),
 * a length typed as shown keeps its exact value, so committing the shown text changes nothing.
 * Errors name the note.
 */
export function parseTuneText(
  text: string,
  beat: Seconds | null,
  prev: readonly TuneNote[] = [],
): TuneParse {
  const t = text.trim();
  if (t === '') return { ok: true, notes: [] };
  const items = t.split(',').map((s) => s.trim());
  const unit = beat ? 'beats' : 's';
  const min = beat ? MIN_TUNE_LEN / beat : MIN_TUNE_LEN;
  const max = beat ? MAX_BEATS : MAX_SECONDS;
  const notes: TuneNote[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const at = `Note ${k + 1}`;
    if (it === '') return { ok: false, error: `${at} is empty: remove the extra comma` };
    const parts = it.split(/\s+/);
    if (parts.length > 2) {
      return { ok: false, error: `${at}: “${it}” should be a note and a length, like “E5 1”` };
    }
    // Names only: a bare number is more likely a misplaced length than a MIDI note.
    const pitch = /^[A-Ga-g]/.test(parts[0]) ? parsePitch(parts[0]) : null;
    if (pitch === null) {
      return { ok: false, error: `${at}: “${parts[0]}” is not a note name like F#5` };
    }
    let len: Seconds;
    if (parts.length === 1) {
      len = notes.at(-1)?.len ?? beat ?? 0.5;
    } else {
      const v = parseNum(parts[1]);
      if (v === null) return { ok: false, error: `${at}: “${parts[1]}” is not a length` };
      if (v < min - 1e-9) {
        return {
          ok: false,
          error: `${at}: the length must be at least ${formatNum(min, 3)} ${unit}`,
        };
      }
      if (v > max) return { ok: false, error: `${at}: the length must be at most ${max} ${unit}` };
      const old = prev[k];
      len =
        old && formatTuneLen(old.len, beat) === formatNum(v, 3) ? old.len : lenFromShown(v, beat);
    }
    notes.push({ pitch, len });
  }
  return { ok: true, notes };
}
