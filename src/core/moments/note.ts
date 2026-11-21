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
 *
 * Grouped changes (§11.3 revision 7): `changes` applies several changes in one moment. Each
 * matches a different voice (in list order, nearest unmatched voice); with `order` the replaced
 * set is sorted once. A change with `from` = `to` is skipped; one that matches no voice warns.
 */

import { activeAt, keyAt, pitchAt } from '../query';
import { stepByScale } from '../scales';
import type { CompiledScore, NoteChange, NoteMoment, Pitch, Seconds } from '../types';
import { IntentKind, type MomentEnv, type MomentPlan } from './types';

/** How far (semitones) a destination may be from `from` and still be that note. */
export const NOTE_MATCH: Pitch = 0.5;

/** Pitches closer than this are the same note (`from` = `to`). */
const SAME = 1e-6;

/**
 * The changes of note moment `m` (the one place the two forms are read): `changes` when it is
 * non-empty, else `from`/`to` as one change; empty when neither is there.
 */
export function noteChanges(m: NoteMoment): readonly NoteChange[] {
  if (m.changes && m.changes.length > 0) return m.changes;
  if (m.from !== undefined && m.to !== undefined) return [{ from: m.from, to: m.to }];
  return [];
}

/**
 * `m` holding `list`, in the canonical form: one change as `from`/`to`, several as `changes`
 * (the other form's fields removed).
 */
export function withNoteChanges(m: NoteMoment, list: readonly NoteChange[]): NoteMoment {
  const { from: _f, to: _t, changes: _c, ...rest } = m;
  if (list.length === 1) return { ...rest, from: list[0].from, to: list[0].to };
  return { ...rest, changes: list.map((c) => ({ from: c.from, to: c.to })) };
}

function changeIsNoop(c: NoteChange): boolean {
  return Math.abs(c.to - c.from) <= SAME;
}

/** True when a note moment changes nothing by definition (every `from` = its `to`). */
export function noteIsNoop(m: NoteMoment): boolean {
  return noteChanges(m).every(changeIsNoop);
}

/**
 * Index of the entry of `ps` (or of `alt`, the same voices' other pitches) nearest `p` within
 * NOTE_MATCH, skipping entries with `skip[i]` set; −1 if none. Ties: the lower index. NaN entries
 * never match.
 */
export function nearestNote(
  ps: readonly Pitch[],
  p: Pitch,
  alt?: readonly Pitch[],
  skip?: readonly boolean[],
): number {
  let best = -1;
  let dist = NOTE_MATCH;
  for (let i = 0; i < ps.length; i++) {
    if (skip?.[i]) continue;
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

/**
 * Ordered targets of several note changes: `ps` (sorted ascending) with entry `ks[j]` replaced by
 * `tos[j]`, sorted (stable, so equal pitches keep their places). Voice i (in `ps` order) goes to
 * `q[i]`; `at[j]` is the index that carries `tos[j]`.
 */
export function noteTargetsMany(
  ps: readonly Pitch[],
  ks: readonly number[],
  tos: readonly Pitch[],
): { q: Pitch[]; at: number[] } {
  const r = ps.slice();
  for (let j = 0; j < ks.length; j++) r[ks[j]] = tos[j];
  const idx = r.map((_, i) => i).sort((a, b) => r[a] - r[b]);
  const pos = new Array<number>(r.length);
  for (let j = 0; j < idx.length; j++) pos[idx[j]] = j;
  return { q: idx.map((i) => r[i]), at: ks.map((k) => pos[k]) };
}

export function noteMoment(m: NoteMoment, env: MomentEnv, returning = false): MomentPlan | null {
  const list = noteChanges(m);
  if (list.length === 0 || list.some((c) => !Number.isFinite(c.from) || !Number.isFinite(c.to))) {
    env.diag('error', 'invalid-moment', 'The note pitches are not numbers.');
    return null;
  }
  const live = list.filter((c) => !changeIsNoop(c));
  if (live.length === 0) return null;
  // Sorted by destination here (ties: pool index): `env.targeted` may be sorted by another one.
  const vs = env.targeted.slice().sort((a, b) => env.dest(a) - env.dest(b) || a - b);
  const ps = vs.map((v) => env.dest(v));
  const now = vs.map((v) => env.now(v));
  // Each change takes the nearest voice not taken by an earlier one.
  const taken: boolean[] = vs.map(() => false);
  const ks: number[] = [];
  const tos: Pitch[] = [];
  const missing: Pitch[] = [];
  for (const c of live) {
    const k = nearestNote(ps, c.from, now, taken);
    if (k < 0) {
      missing.push(c.from);
      continue;
    }
    taken[k] = true;
    ks.push(k);
    tos.push(c.to);
  }
  if (missing.length > 0) {
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
        `No targeted voice is sounding ${missing.join(', ')} at ${env.t} s.`,
      );
    }
  }
  if (ks.length === 0) return null;
  if (!m.order) {
    // Only the voices sounding the `from`s move; they may cross their neighbours (like a pin).
    // The others keep their destinations (re-planned if this note cancelled their pending moves).
    const to = ps.slice();
    for (let j = 0; j < ks.length; j++) to[ks[j]] = tos[j];
    return {
      ordered: false,
      intents: vs.map((voice, i) => ({ voice, to: to[i], kind: IntentKind.Move })),
      notes: ks.map((k) => ({ intent: k, from: ps[k] })),
    };
  }
  const { q, at } = noteTargetsMany(ps, ks, tos);
  return {
    ordered: true,
    intents: vs.map((voice, i) => ({ voice, to: q[i], kind: IntentKind.Move })),
    notes: ks.map((k, j) => ({ intent: at[j], from: ps[k] })),
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
