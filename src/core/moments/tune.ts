/**
 * `tune` (§6.2, revision 9): a melody on one line. The compiler runs one note at a time, at its
 * start (compile.ts `onTune`); each is a pin-like move of the tune's line, which may cross other
 * lines (unordered, exempt from the crossing guarantee like `pin`).
 *
 * Revision 10: rests (`{ rest: true, len }`), re-struck repeated notes (`strike`) and `writtenIn`
 * (the tune follows the key at `at`: `tuneShift`).
 */

import { pitchClassOf } from '../scales';
import type { Key, PitchClass, Seconds, TuneMoment, TuneNote, TuneRest } from '../types';
import { IntentKind, type MomentPlan } from './types';

/** True for a rest (revision 10). */
export function isRest(n: TuneNote): n is TuneRest {
  return n.rest === true;
}

/** Why a tune can't run (`tune-invalid`), or null. An empty tune is valid (it does nothing). */
export function tuneProblem(m: TuneMoment): string | null {
  if (!Array.isArray(m.notes)) return 'A tune needs a list of notes.';
  for (const n of m.notes) {
    if (!n || typeof n !== 'object' || !(isRest(n) || Number.isFinite(n.pitch)))
      return 'Every note of a tune needs a numeric pitch.';
    if (!(typeof n.len === 'number' && Number.isFinite(n.len) && n.len > 0))
      return 'Every note of a tune needs a length > 0.';
  }
  return null;
}

/** Note starts: at, then at + the lengths before each note; the last entry is the tune's end. */
export function tuneStarts(m: TuneMoment): Seconds[] {
  const out: Seconds[] = [m.at];
  let t = m.at;
  for (const n of m.notes) out.push((t += n.len));
  return out;
}

/**
 * Semitones a tune written in `writtenIn` sounds shifted by in `key` (revision 10): the smallest
 * interval from `writtenIn` to the key's tonic, −5…+6 (a tritone goes up). 0 without `writtenIn`.
 */
export function tuneShift(writtenIn: PitchClass | undefined, key: Key): number {
  if (writtenIn === undefined) return 0;
  const d = (((pitchClassOf(key.tonic) - pitchClassOf(writtenIn)) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/** Note k's sounding pitch (`shift` added), or NaN for a rest. */
export function tunePitch(m: TuneMoment, k: number, shift: number): number {
  const n = m.notes[k];
  return isRest(n) ? NaN : n.pitch + shift;
}

/**
 * True when note k re-strikes (revision 10): it repeats the pitch of note k − 1 (no rest between)
 * and the tune's `strike` is not false.
 */
export function tuneRestrikes(m: TuneMoment, k: number): boolean {
  if (m.strike === false || k < 1) return false;
  const a = m.notes[k - 1];
  const b = m.notes[k];
  return !isRest(a) && !isRest(b) && a.pitch === b.pitch;
}

/** Index of the first sounding note (not a rest), or −1. */
export function firstPitched(m: TuneMoment): number {
  return m.notes.findIndex((n) => !isRest(n));
}

/** Note k of tune `m` on line `voice`, at its sounding pitch. */
export function tuneNotePlan(m: TuneMoment, k: number, voice: number, shift = 0): MomentPlan {
  return {
    ordered: false,
    intents: [{ voice, to: tunePitch(m, k, shift), kind: IntentKind.Move }],
  };
}
