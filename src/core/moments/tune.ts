/**
 * `tune` (§6.2, revision 9): a melody on one line. The compiler runs one note at a time, at its
 * start (compile.ts `onTune`); each is a pin-like move of the tune's line, which may cross other
 * lines (unordered, exempt from the crossing guarantee like `pin`).
 */

import type { Seconds, TuneMoment } from '../types';
import { IntentKind, type MomentPlan } from './types';

/** Why a tune can't run (`tune-invalid`), or null. An empty tune is valid (it does nothing). */
export function tuneProblem(m: TuneMoment): string | null {
  if (!Array.isArray(m.notes)) return 'A tune needs a list of notes.';
  for (const n of m.notes) {
    if (!n || typeof n !== 'object' || !(typeof n.pitch === 'number' && Number.isFinite(n.pitch)))
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

/** Note k of tune `m` on line `voice`. */
export function tuneNotePlan(m: TuneMoment, k: number, voice: number): MomentPlan {
  return { ordered: false, intents: [{ voice, to: m.notes[k].pitch, kind: IntentKind.Move }] };
}
