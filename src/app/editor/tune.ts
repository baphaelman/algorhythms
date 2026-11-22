/**
 * Tune editing (PLAN.md §6.2 `tune`, §11.3; R9-7): the inspector's note list. Pure: note starts,
 * lengths in beats (with a tempo) or seconds, ▲/▼ by a scale step in the key at the note, add and
 * remove. R9-8: the score's tune dots (`tuneDots`, moving note starts) and typed notes. Random
 * melodies and notes inserted by a double-click (owner, 2026-11-21).
 */

import { compile } from '../../core/compiler/compile';
import { readState } from '../../core/effect';
import { partOf, selectorPart } from '../../core/parts';
import { chordAt, keyAt } from '../../core/query';
import {
  isScaleTone,
  noteName,
  scaleDegreeIndex,
  snapToScale,
  stepByScale,
} from '../../core/scales';
import { isRest, tuneShift } from '../../core/moments/tune';
import { randomTune } from '../../core/tune-gen';
import type {
  CompiledScore,
  Key,
  Piece,
  Pitch,
  PitchClass,
  Seconds,
  TuneLine,
  TuneMoment,
  TuneNote,
  ViewSettings,
  VoiceId,
  VoiceSelector,
} from '../../core/types';
import { noteLabel } from '../../render';
import { formatNum, parseNum, parsePitch } from '../ui/inspector/fields';
import { patchMoment } from './ops';
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
function withNote(
  notes: readonly TuneNote[],
  k: number,
  patch: { pitch?: Pitch; len?: Seconds },
): TuneNote[] {
  return notes.map((n, i) => (i === k ? ({ ...n, ...patch } as TuneNote) : n));
}

// ---------------------------------------------------------------------------------------------
// Revision 10: sounding pitches (`writtenIn`) and rests
// ---------------------------------------------------------------------------------------------

/** Semitones tune `m` sounds shifted by in the compiled score (`writtenIn` → the key at `at`). */
export function tuneShiftIn(score: CompiledScore, m: Pick<TuneMoment, 'at' | 'writtenIn'>): number {
  return m.writtenIn === undefined ? 0 : tuneShift(m.writtenIn, keyAt(score, m.at));
}

/** Notes moved by `shift` semitones (rests unchanged); the same array for 0. */
export function shiftTuneNotes(notes: readonly TuneNote[], shift: number): TuneNote[] {
  if (shift === 0) return notes as TuneNote[];
  return notes.map((n) => (isRest(n) ? n : { ...n, pitch: n.pitch + shift }));
}

/** The tonic a new tune at `at` is written in (revision 10: new tunes follow the key). */
export function writtenInAt(score: CompiledScore, at: Seconds): PitchClass {
  return keyAt(score, at).tonic;
}

/**
 * Follow key on or off (inspector): `writtenIn` set to the tonic at `at`, or dropped. The notes
 * are rewritten so the tune sounds the same now: on, the shift is 0; off, the sounding pitches
 * become the written ones.
 */
export function followKeyPatch(
  score: CompiledScore,
  m: TuneMoment,
  on: boolean,
): { writtenIn: PitchClass | undefined; notes: TuneNote[] } | null {
  if (on === (m.writtenIn !== undefined)) return null;
  const notes = shiftTuneNotes(m.notes, tuneShiftIn(score, m));
  return { writtenIn: on ? writtenInAt(score, m.at) : undefined, notes };
}

/** Note k moved one scale step up or down in `key` (off-scale notes go to the nearest step). */
export function stepTuneNote(
  notes: readonly TuneNote[],
  k: number,
  dir: 1 | -1,
  key: Key,
): TuneNote[] | null {
  const n = notes[k];
  if (!n || isRest(n)) return null;
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
  const last = notes.findLast((n) => !isRest(n));
  const note: TuneNote = last
    ? { pitch: clampPitch(stepByScale(last.pitch, 1, key)), len: notes.at(-1)!.len }
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
 * The tune's score dots (R9-8): one per note, at its start and sounding pitch (revision 10: the
 * written pitch + `tuneShiftIn`), with `note` = its index; none for a rest. The voice is the line
 * the compiler moved for that note (a segment of the tune within the note), else the previous
 * note's.
 */
export function tuneDots(score: CompiledScore, m: TuneMoment): ArrivalDot[] {
  const shift = tuneShiftIn(score, m);
  const S = tuneNoteStarts(m);
  const segs: { t0: Seconds; t1: Seconds; v: number }[] = [];
  for (const v of score.voices) {
    for (const s of v.segments) {
      if (s.momentId === m.id) segs.push({ t0: s.t0, t1: s.t1, v: v.index });
    }
  }
  let voice: number | undefined = segs[0]?.v;
  const out: ArrivalDot[] = [];
  m.notes.forEach((n, k) => {
    const lo = S[k] - 1e-6;
    const hi = S[k + 1] - 1e-6;
    const hit =
      segs.find((s) => s.t0 >= lo && s.t0 < hi) ?? segs.find((s) => s.t0 < hi && s.t1 > lo);
    if (hit) voice = hit.v;
    if (isRest(n)) return;
    const d: ArrivalDot = {
      momentId: m.id,
      type: 'tune',
      t: S[k],
      pitch: n.pitch + shift,
      note: k,
    };
    if (voice !== undefined) d.voice = voice;
    out.push(d);
  });
  return out;
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
  if (!n || isRest(n) || !Number.isFinite(pitch)) return null;
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
 * start, `keyAt`) and length (beats with a tempo, else seconds); a rest is "r 1".
 */
export function formatTuneText(
  m: Pick<TuneMoment, 'at' | 'notes'>,
  beat: Seconds | null,
  keyAt?: (t: Seconds) => Key,
): string {
  const starts = tuneNoteStarts(m);
  return m.notes
    .map(
      (n, k) =>
        `${isRest(n) ? 'r' : formatTunePitch(n.pitch, keyAt?.(starts[k]))} ${formatTuneLen(n.len, beat)}`,
    )
    .join(', ');
}

export type TuneParse = { ok: true; notes: TuneNote[] } | { ok: false; error: string };

/**
 * Parses typed notes: comma-separated items "<pitch> <length>", or "r <length>" / "rest <length>"
 * for a rest (revision 10). A pitch is a note name with
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
    const rest = /^(r|rest)$/i.test(parts[0]);
    // Names only: a bare number is more likely a misplaced length than a MIDI note.
    const pitch = rest ? null : /^[A-Ga-g]/.test(parts[0]) ? parsePitch(parts[0]) : null;
    if (pitch === null && !rest) {
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
    notes.push(pitch === null ? { rest: true, len } : { pitch, len });
  }
  return { ok: true, notes };
}

/** A "Melody on" choice (owner, 2026-11-21): one sounding note's voice, or a line of the target. */
export type MelodyChoice = { kind: 'voice'; id: VoiceId } | { kind: 'line'; line: TuneLine };

/** One entry of the "Melody on" menu. `pitch`: a note's pitch before the tune moves it. */
export interface MelodyOption {
  value: string;
  label: string;
  choice: MelodyChoice;
  pitch?: Pitch;
}

/** The menu value of a choice. */
export const melodyValue = (c: MelodyChoice): string =>
  c.kind === 'voice' ? `voice:${c.id}` : `line:${c.line}`;

/** A single-voice target's id, or null. */
function oneVoice(m: Pick<TuneMoment, 'target'>): VoiceId | null {
  const t = m.target;
  return t && t !== 'all' && 'voices' in t && Array.isArray(t.voices) && t.voices.length === 1
    ? t.voices[0]
    : null;
}

/**
 * The target a "Highest/Lowest" choice keeps: the tune's own, except that a single-voice target
 * (a note picked here) goes back to that voice's part (all notes without parts).
 */
function lineTarget(piece: Piece, m: Pick<TuneMoment, 'target'>): VoiceSelector | undefined {
  const one = oneVoice(m);
  if (one === null) return m.target;
  const part = partOf(piece.voices.find((v) => v.id === one));
  return part === '' ? undefined : { part };
}

/**
 * The "Melody on" menu (owner, 2026-11-21): the notes sounding at the tune's time, high to low
 * (spelled in the key there; with the part name when the piece has parts), between "Highest of
 * <target>" and "Lowest of <target>". Pitches are where each line is heading as the tune starts,
 * before the tune moves its own line. `current`: the tune's choice (a single-voice target is that
 * note, else its `line`, absent = lowest); a picked voice not sounding gets its own entry.
 */
export function melodyOptions(
  piece: Piece,
  score: CompiledScore,
  m: TuneMoment,
): { options: MelodyOption[]; current: string } {
  const st = readState(piece, score, m.at);
  const key = keyAt(score, m.at);
  const parted = piece.voices.some((v) => partOf(v) !== '');
  const notes: MelodyOption[] = [];
  for (const v of st.active) {
    const voice = score.voices[v];
    const def = piece.voices[v];
    if (!voice || !def) continue;
    // The tune's own line: where it was before the tune's first move.
    const own = voice.segments.find((s) => s.momentId === m.id && s.t0 <= m.at + 1e-9);
    const pitch = own ? own.p0 : st.dest[v];
    const part = partOf(def);
    const label = noteLabel(pitch, key) + (parted ? ` · ${part === '' ? 'Unassigned' : part}` : '');
    notes.push({ value: `voice:${def.id}`, label, choice: { kind: 'voice', id: def.id }, pitch });
  }
  notes.sort((a, b) => b.pitch! - a.pitch! || a.value.localeCompare(b.value));
  const target = lineTarget(piece, m);
  const part = selectorPart(target);
  const of =
    part !== null
      ? ` of ${part === '' ? 'Unassigned' : part}`
      : target === undefined || target === 'all'
        ? ' note'
        : ' of the target';
  const line = (l: TuneLine, word: string): MelodyOption => ({
    value: melodyValue({ kind: 'line', line: l }),
    label: word + of,
    choice: { kind: 'line', line: l },
  });
  const options = [line('high', 'Highest'), ...notes, line('low', 'Lowest')];
  const one = oneVoice(m);
  const current = melodyValue(
    one !== null ? { kind: 'voice', id: one } : { kind: 'line', line: m.line ?? 'low' },
  );
  if (one !== null && !options.some((o) => o.value === current)) {
    const def = piece.voices.find((v) => v.id === one);
    options.splice(options.length - 1, 0, {
      value: current,
      label: `${def?.name ?? one} (not sounding)`,
      choice: { kind: 'voice', id: one },
    });
  }
  return { options, current };
}

/**
 * The fields a "Melody on" pick writes: a note sets the target to its voice (`line` removed); a
 * line keeps the target (a picked note's goes back to its part) and sets `line` ('low', the
 * default, is left out).
 */
export function melodyPatch(
  piece: Piece,
  m: TuneMoment,
  c: MelodyChoice,
): { target: VoiceSelector | undefined; line: TuneLine | undefined } {
  if (c.kind === 'voice') return { target: { voices: [c.id] }, line: undefined };
  return { target: lineTarget(piece, m), line: c.line === 'high' ? 'high' : undefined };
}

/**
 * The tune's notes moved from a line at `from` to one at `to` (owner, 2026-11-21: "changing what
 * note a tune is on should move the tune to that melody"). When both are tones of `key`, every
 * note moves by the same number of scale steps (an accidental or cents keep their offset from the
 * scale tone below; `keyOf` gives the key at note k, default `key`); otherwise by semitones. A
 * note outside `range` folds by octaves into it. Same pitch: the notes unchanged (same array).
 */
export function shiftMelody(
  notes: readonly TuneNote[],
  from: Pitch,
  to: Pitch,
  key: Key,
  range: readonly [Pitch, Pitch],
  keyOf: (k: number) => Key = () => key,
): readonly TuneNote[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return notes;
  const diatonic = isScaleTone(from, key) && isScaleTone(to, key);
  const steps = diatonic ? scaleDegreeIndex(to, key) - scaleDegreeIndex(from, key) : 0;
  const [lo, hi] = range[0] <= range[1] ? range : [range[1], range[0]];
  return notes.map((n, k) => {
    if (isRest(n)) return n;
    let p: Pitch;
    if (diatonic) {
      const kk = keyOf(k);
      const base = snapDown(n.pitch, kk);
      p = stepByScale(base, steps, kk) + (n.pitch - base);
    } else p = n.pitch + (to - from);
    // Fold into the range (an octave at a time; a range under an octave keeps the nearest fold).
    while (p > hi && p - 12 >= lo) p -= 12;
    while (p < lo && p + 12 <= hi) p += 12;
    p = clampPitch(Math.round(p * 1e6) / 1e6);
    return p === n.pitch ? n : { ...n, pitch: p };
  });
}

/** The scale tone at or below `p`. */
function snapDown(p: Pitch, key: Key): Pitch {
  const s = snapToScale(p, key);
  return s <= p + 1e-9 ? s : stepByScale(s, -1, key);
}

/**
 * The fields a "Melody on" pick writes (`melodyPatch`) plus the notes moved to the new line
 * (`shiftMelody`): from the line playing the tune now to the one that plays it after the pick
 * (found by compiling the pick, so Highest/Lowest land where the compiler puts them). `notes` is
 * left out when they don't change.
 */
export function melodyMove(
  piece: Piece,
  score: CompiledScore,
  m: TuneMoment,
  c: MelodyChoice,
): { target: VoiceSelector | undefined; line: TuneLine | undefined; notes?: TuneNote[] } {
  const patch = melodyPatch(piece, m, c);
  if (m.notes.length === 0) return patch;
  const old = tuneLineAt(piece, score, m);
  const now = lineAfter(piece, m, patch);
  if (!now || now.voice === undefined || now.voice === old.voice) return patch;
  const starts = tuneNoteStarts(m);
  // Sounding pitches (revision 10), written back un-transposed.
  const shift = tuneShiftIn(score, m);
  const sounding = shiftTuneNotes(m.notes, shift);
  const moved = shiftMelody(sounding, old.pitch, now.pitch, keyAt(score, m.at), now.range, (k) =>
    keyAt(score, starts[k]),
  );
  return moved === sounding ? patch : { ...patch, notes: shiftTuneNotes(moved, -shift).slice() };
}

/** The line (voice index) that would play tune `m` after choice `c`; undefined if none. */
export function melodyVoice(piece: Piece, m: TuneMoment, c: MelodyChoice): number | undefined {
  if (c.kind === 'voice') {
    const i = piece.voices.findIndex((v) => v.id === c.id);
    return i < 0 ? undefined : i;
  }
  return lineAfter(piece, m, melodyPatch(piece, m, c))?.voice;
}

/** `tuneLineAt` for the tune with `patch` applied (compiled); null if it doesn't compile. */
function lineAfter(
  piece: Piece,
  m: TuneMoment,
  patch: ReturnType<typeof melodyPatch>,
): ReturnType<typeof tuneLineAt> | null {
  const picked = patchMoment(piece, m.id, patch);
  const pm = picked.moments.find((x) => x.id === m.id) as TuneMoment | undefined;
  if (!pm) return null;
  try {
    return tuneLineAt(picked, compile(picked), pm);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Random melody and inserted notes (owner, 2026-11-21)
// ---------------------------------------------------------------------------------------------

/** A new tune's length: two bars with a tempo (`view.meter` beats a bar, else 4), else 4 s. */
export function newTuneLength(view: Pick<ViewSettings, 'gridBpm' | 'meter'> | undefined): Seconds {
  const beat = tuneBeat(view);
  const meter = view?.meter;
  const bar = typeof meter === 'number' && meter > 0 ? meter : 4;
  return beat ? roundUs(2 * bar * beat) : 4;
}

/** Fallback range for a line the piece doesn't define. */
const ANY_RANGE: [Pitch, Pitch] = [36, 96];

/**
 * The line a tune plays on and where it is as the tune starts: the line the compile moved for
 * its first note (its pitch before that move), else the sounding line `line` picks ('high': the
 * top, else the lowest; a single-voice target: that voice), else C4. With the voice's range.
 */
export function tuneLineAt(
  piece: Piece,
  score: CompiledScore,
  m: Pick<TuneMoment, 'id' | 'at' | 'target' | 'line'>,
): { voice?: number; pitch: Pitch; range: [Pitch, Pitch] } {
  const rangeOf = (v: number): [Pitch, Pitch] => piece.voices[v]?.range ?? ANY_RANGE;
  for (const v of score.voices) {
    const s = v.segments.find((x) => x.momentId === m.id);
    if (s) return { voice: v.index, pitch: s.p0, range: rangeOf(v.index) };
  }
  const read = Math.min(m.at, Math.max(0, score.duration - 0.01));
  const st = readState(piece, score, read);
  const one = oneVoice(m);
  let best: { v: number; p: Pitch } | null = null;
  for (const v of st.active) {
    const p = st.dest[v];
    if (!Number.isFinite(p)) continue;
    if (one !== null) {
      if (piece.voices[v]?.id === one) best = { v, p };
      continue;
    }
    if (best === null || (m.line === 'high' ? p > best.p : p < best.p)) best = { v, p };
  }
  return best
    ? { voice: best.v, pitch: best.p, range: rangeOf(best.v) }
    : { pitch: 60, range: ANY_RANGE };
}

/**
 * A random melody for tune `m` (seeded, core `randomTune`): in the key at its time, from its
 * line's pitch, inside the line's range, as long as the tune is now (a new or empty tune: two bars
 * or 4 s), ending on a tone of the harmony at its end.
 */
export function randomMelody(
  piece: Piece,
  score: CompiledScore,
  m: Pick<TuneMoment, 'id' | 'at' | 'notes' | 'target' | 'line' | 'writtenIn'>,
  seed: number,
): TuneNote[] {
  const len = tuneEnd(m) - m.at;
  const total = len > 1e-9 ? len : newTuneLength(piece.view);
  const line = tuneLineAt(piece, score, m);
  const notes = randomTune({
    seed,
    key: keyAt(score, m.at),
    start: line.pitch,
    range: line.range,
    total,
    beat: tuneBeat(piece.view),
    endPcs: chordAt(score, m.at + total)?.pcs,
  });
  // Drawn at sounding pitches; written back un-transposed (revision 10).
  return shiftTuneNotes(notes, -tuneShiftIn(score, m));
}

/**
 * A note at `pitch` inserted into the tune at time `t` (double-click on the score):
 * - inside note k: k keeps the part before t, the new note gets the rest;
 * - on a note's start (within MIN_TUNE_LEN): the new note takes that note's first half;
 * - at or after the end: appended at t, the last note stretched to t (no hole), `len` long;
 * - before `at`: prepended from t to `at`, and `at` moves to t.
 * An empty tune becomes the one note at t. Returns the new notes, `at` and the new note's index;
 * null when nothing fits (a note too short to halve).
 */
export function insertTuneNote(
  m: Pick<TuneMoment, 'at' | 'notes'>,
  t: Seconds,
  pitch: Pitch,
  len: Seconds,
): { at: Seconds; notes: TuneNote[]; index: number } | null {
  if (!Number.isFinite(t) || !Number.isFinite(pitch)) return null;
  t = roundUs(Math.max(0, t));
  const p = clampPitch(pitch);
  const fresh = (l: Seconds): TuneNote => ({ pitch: p, len: Math.max(MIN_TUNE_LEN, roundUs(l)) });
  const n = m.notes.length;
  if (n === 0) return { at: t, notes: [fresh(len)], index: 0 };
  const S = tuneNoteStarts(m);
  const end = S[n];
  if (t > end - MIN_TUNE_LEN) {
    const notes = m.notes.slice();
    const last = notes[n - 1];
    if (t > end) notes[n - 1] = { ...last, len: roundUs(t - S[n - 1]) };
    return { at: m.at, notes: [...notes, fresh(len)], index: n };
  }
  if (t <= m.at - MIN_TUNE_LEN) {
    return { at: t, notes: [fresh(m.at - t), ...m.notes], index: 0 };
  }
  // The note holding t; a start within MIN_TUNE_LEN counts as that note's start.
  let k = 0;
  while (k < n - 1 && S[k + 1] <= t + MIN_TUNE_LEN - 1e-9) k++;
  const old = m.notes[k];
  const notes = m.notes.slice();
  if (t - S[k] < MIN_TUNE_LEN) {
    if (old.len < 2 * MIN_TUNE_LEN) return null;
    const half = roundUs(old.len / 2);
    notes.splice(k, 1, { pitch: p, len: half }, { ...old, len: roundUs(old.len - half) });
    return { at: m.at, notes, index: k };
  }
  const before = roundUs(t - S[k]);
  notes.splice(k, 1, { ...old, len: before }, { pitch: p, len: roundUs(old.len - before) });
  return { at: m.at, notes, index: k + 1 };
}
