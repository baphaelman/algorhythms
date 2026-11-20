/**
 * `note` (§6.2, revision 6): a note point. The sounding note `from` becomes `to`. By default
 * (`order` unset or false) only the voice sounding `from` moves, and it may cross its neighbours.
 * With `order: true` the target set is the targeted voices' destinations with ONE instance of
 * `from` replaced by `to`, reached by ordered voice leading (§7.2). Sorting the new set and assigning in order moves only the voices
 * between `from`'s and `to`'s places: if `to` stays between its neighbours only that voice moves;
 * if it passes neighbours they each shift one place, so no lines cross. Several voices on `from`:
 * still only one note changes.
 *
 * `from` matches the voice nearest it within NOTE_MATCH, by destination or by the pitch sounding
 * at t, whichever is nearer (a line double-clicked mid-glide; ties: the lower voice); none →
 * `warn` (`note-not-sounding`), no plan. That voice's destination is the note replaced. `from` = `to` → no plan (the compiler reports
 * `no-effect`). The return (`back`) is scheduled by the compiler, which runs this function again
 * with `from` and `to` swapped and `returning` set; if a later moment moved the note away by then,
 * the return is skipped (`info`).
 */

import { activeAt, keyAt, pitchAt } from '../query';
import { stepByScale } from '../scales';
import type { CompiledScore, NoteMoment, Pitch, Seconds } from '../types';
import { IntentKind, type MomentEnv, type MomentPlan } from './types';

/** How far (semitones) a destination may be from `from` and still be that note. */
export const NOTE_MATCH: Pitch = 0.5;

/** Pitches closer than this are the same note (`from` = `to`). */
const SAME = 1e-6;

/** True when a note moment changes nothing by definition (`from` = `to`). */
export function noteIsNoop(m: NoteMoment): boolean {
  return Math.abs(m.to - m.from) <= SAME;
}

/**
 * Index of the entry of `ps` (or of `alt`, the same voices' other pitches) nearest `p` within
 * NOTE_MATCH; −1 if none. Ties: the lower index. NaN entries never match.
 */
export function nearestNote(ps: readonly Pitch[], p: Pitch, alt?: readonly Pitch[]): number {
  let best = -1;
  let dist = NOTE_MATCH;
  for (let i = 0; i < ps.length; i++) {
    const a = Math.abs(ps[i] - p);
    const b = alt ? Math.abs(alt[i] - p) : Infinity;
    const d = b < a ? b : a;
    if (d < dist || (d === dist && best < 0)) {
      best = i;
      dist = d;
    }
  }
  return best;
}

/**
 * The ordered targets of a note move: `ps` (sorted ascending) with entry k replaced by `to`,
 * sorted. Voice i (in `ps` order) goes to `q[i]`; `at` is the index that carries `to`.
 */
export function noteTargets(
  ps: readonly Pitch[],
  k: number,
  to: Pitch,
): { q: Pitch[]; at: number } {
  const q = ps.slice();
  q[k] = to;
  // Only q[k] is out of place: bubble it into order.
  let i = k;
  while (i > 0 && q[i - 1] > q[i]) {
    q[i] = q[i - 1];
    q[i - 1] = to;
    i--;
  }
  while (i + 1 < q.length && q[i + 1] < q[i]) {
    q[i] = q[i + 1];
    q[i + 1] = to;
    i++;
  }
  return { q, at: i };
}

export function noteMoment(m: NoteMoment, env: MomentEnv, returning = false): MomentPlan | null {
  if (!Number.isFinite(m.from) || !Number.isFinite(m.to)) {
    env.diag('error', 'invalid-moment', 'The note pitches are not numbers.');
    return null;
  }
  if (noteIsNoop(m)) return null;
  // Sorted by destination here (ties: pool index): `env.targeted` may be sorted by another one.
  const vs = env.targeted.slice().sort((a, b) => env.dest(a) - env.dest(b) || a - b);
  const ps = vs.map((v) => env.dest(v));
  const k = nearestNote(
    ps,
    m.from,
    vs.map((v) => env.now(v)),
  );
  if (k < 0) {
    if (returning) {
      env.diag(
        'info',
        'note-back-skipped',
        'The note no longer sounds when it should return (a later moment moved it); it stays.',
      );
    } else {
      env.diag(
        'warn',
        'note-not-sounding',
        `No targeted voice is sounding ${m.from} at ${env.t} s.`,
      );
    }
    return null;
  }
  if (!m.order) {
    // Only the voice sounding `from` moves; it may cross its neighbours (like a pin). The others
    // keep their destinations (re-planned if this note cancelled their pending moves).
    return {
      ordered: false,
      intents: vs.map((voice, i) => ({
        voice,
        to: i === k ? m.to : ps[i],
        kind: IntentKind.Move,
      })),
      note: { intent: k, from: ps[k] },
    };
  }
  const { q, at } = noteTargets(ps, k, m.to);
  return {
    ordered: true,
    intents: vs.map((voice, i) => ({ voice, to: q[i], kind: IntentKind.Move })),
    note: { intent: at, from: ps[k] },
  };
}

/**
 * Fields of a new note moment at t (palette and add shortcuts, §11.3): `from` = the sounding pitch
 * nearest the middle of the sounding voices (ties: the lower), `to` = one scale step up in the key
 * in effect. Nothing sounding: from 60.
 */
export function defaultNoteFields(score: CompiledScore, t: Seconds): { from: Pitch; to: Pitch } {
  const ps: Pitch[] = [];
  for (const v of activeAt(score, t)) {
    const p = pitchAt(score.voices[v], t);
    if (p !== null) ps.push(p);
  }
  let from = 60;
  if (ps.length > 0) {
    ps.sort((a, b) => a - b);
    const mid = (ps[0] + ps[ps.length - 1]) / 2;
    from = ps[0];
    for (const p of ps) if (Math.abs(p - mid) < Math.abs(from - mid)) from = p;
  }
  return { from, to: stepByScale(from, 1, keyAt(score, t)) };
}
