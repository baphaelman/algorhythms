/**
 * Establishing moments (PLAN.md §11.3 "The start is a moment", revision 7; schema v2, M4.5-27).
 *
 * There is no starting state: a `chord` (with notes other than `current`) or a `unison` that comes
 * when nothing is sounding brings its voices in directly on their notes, with no glide (so does a
 * `tune` on a `{ part }` target, below). Every other point moment, walk and level has nothing to
 * act on there (`no-effect`).
 *
 * - **Voices.** A `{ voices }` target brings in those voices, in the listed order; any other
 *   target brings in dormant pool voices in pool order.
 * - **How many.** A chord's `count` (listed voices first, then other free ones); else every
 *   listed voice of a `{ voices }` target; else one per note (the pitch list's length, or the chord's pitch classes). A unison: every listed voice,
 *   else one (it is one note either way). Too few free voices: truncated (`pool-exhausted`).
 * - **Notes.** A chord with `byVoice` and one pitch per voice gives pitch i to voice i. Otherwise
 *   the chord is voiced as for newborns (its voicing over its register, free octaves before
 *   unisons) and the targets go low to high to the voices in pool order. Without a register it is
 *   voiced in a window of 12 + 3k semitones around the middle of the voices' ranges (k notes),
 *   not over the whole range, and `even` voices `close` there, so every chord tone sounds. A unison sits on
 *   its pitch; `center` is the middle of the first voice's range snapped to the key, `tonic` the
 *   key's tonic nearest that middle.
 *
 * - **Tunes** (composing.md §3 #4; only on a `{ part }` target, `bringsIn`): one voice (the first
 *   free one of the part) on the tune's first note; the compiler plays the rest on it.
 *
 * The plan's intents are births with no parent (−1), in the order the compiler brings the voices
 * in; voices sent to one pitch become one line (distinct notes, revision 8).
 *
 * The same plans bring a silent part in later in the piece (`{ part }` target, nothing of the part
 * sounding, other lines sounding): compile.ts `entersSilent`. Those births fade in on their notes
 * as a chord `count`'s parentless births do (no glide).
 */

import { pitchClassOf, snapToScale } from '../scales';
import { isRest, tuneShift } from './tune';
import type { ChordMoment, Moment, Pitch, TuneMoment, UnisonMoment } from '../types';
import { roundTiesDown, voiceNotes, pitchClasses } from '../voicing';
import { distinctTargets } from './chord';
import { IntentKind, unionRange, type MomentEnv, type MomentPlan } from './types';

/** True for moments that can start the sound from silence: a chord with notes, and a unison. */
export function isEstablishing(m: Moment): m is ChordMoment | UnisonMoment {
  return (m.type === 'chord' && m.notes?.kind !== 'current') || m.type === 'unison';
}

/**
 * True for moments that can bring a silent part in (composing.md §3 #4, 2026-11-22): the
 * establishing ones, and a tune with notes.
 */
export function bringsIn(m: Moment): m is ChordMoment | UnisonMoment | TuneMoment {
  return isEstablishing(m) || (m.type === 'tune' && Array.isArray(m.notes) && m.notes.length > 0);
}

/** The voices a `{ voices }` target lists (known, dormant, first mention), or null for others. */
function listed(m: Moment, env: MomentEnv): number[] | null {
  const t = m.target;
  if (!(t && typeof t === 'object' && 'voices' in t && Array.isArray(t.voices))) return null;
  const free = new Set(env.dormant());
  const out: number[] = [];
  for (const id of t.voices) {
    const v = env.indexOf(id);
    if (v < 0) env.diag('warn', 'unknown-voice', `The target names no voice '${id}'.`);
    else if (free.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** How many notes a chord's NoteSet names (its pitches, or its distinct pitch classes). */
function noteCount(m: ChordMoment, env: MomentEnv): number {
  if (m.notes.kind === 'pitches') return m.notes.pitches.length;
  if (m.notes.kind === 'current') return 0;
  const pc = pitchClasses(m.notes, env.key, []);
  return pc.ok ? pc.pcs.length : 0;
}

/** The voices to bring in: `want` of the candidates, or fewer with `pool-exhausted`. */
function take(cands: readonly number[], want: number, env: MomentEnv): number[] {
  if (want > cands.length) {
    env.diag(
      'warn',
      'pool-exhausted',
      `The moment needs ${want} voices but only ${cands.length} are free; it was truncated.`,
    );
  }
  return cands.slice(0, Math.max(0, want));
}

/** The establishing plan of `m` from silence, or null when it brings nothing in. */
export function establishPlan(m: Moment, env: MomentEnv): MomentPlan | null {
  if (m.type === 'chord') return establishChord(m, env);
  if (m.type === 'unison') return establishUnison(m, env);
  if (m.type === 'tune') return establishTune(m, env);
  return null;
}

function establishChord(m: ChordMoment, env: MomentEnv): MomentPlan | null {
  if (m.notes.kind === 'current') return null;
  if (m.count !== undefined && !Number.isFinite(m.count)) {
    env.diag('error', 'invalid-moment', 'The chord count is not a number.');
    return null;
  }
  const own = listed(m, env);
  const want =
    m.count !== undefined ? Math.max(1, Math.floor(m.count)) : own ? own.length : noteCount(m, env);
  // A count beyond the listed voices brings in other free voices too (count = lines after it).
  const cands = own
    ? m.count !== undefined
      ? [...own, ...env.dormant().filter((v) => !own.includes(v))]
      : own
    : env.dormant();
  const vs = take(cands, want, env);
  if (vs.length === 0) return null;
  const ps = m.notes.kind === 'pitches' ? m.notes.pitches : null;
  if (m.byVoice && ps && ps.length === vs.length && ps.every(Number.isFinite)) {
    return { ordered: false, intents: vs.map((voice, i) => birth(voice, ps[i])) };
  }
  const voiced = voiceNotes({
    notes: m.notes,
    k: vs.length,
    // Without a register, `even` voices close around the middle, so a triad has all its notes.
    mode: !m.register && (m.voicing ?? 'even') === 'even' ? 'close' : (m.voicing ?? 'even'),
    register: m.register ?? openingRegister(unionRange(env, vs), vs.length),
    key: env.key,
    current: [],
    voices: [],
    octaves: m.notes.kind !== 'pitches',
  });
  if (!voiced.ok) {
    env.diag('error', voiced.code, voiced.message);
    return null;
  }
  // Free octaves before unisons, as any chord (explicit pitch lists stay as written).
  const q = (
    m.notes.kind === 'pitches'
      ? voiced.targets.slice()
      : distinctTargets(
          m,
          env,
          voiced.targets,
          vs.length,
          voiced.perVoice,
          unionRange(env, vs),
          [],
          [],
        )
  ).sort((a, b) => a - b);
  if (q.length === 0) return null;
  if (q.length > vs.length) {
    env.diag(
      'info',
      'targets-dropped',
      `${q.length - vs.length} of ${q.length} notes have no voice and were dropped.`,
    );
  }
  // Fewer notes than voices (a short pitch list): the extras double the notes evenly.
  const pool = vs.slice().sort((a, b) => a - b);
  const intents = pool.map((voice, i) =>
    birth(voice, q.length >= pool.length ? q[i] : q[Math.floor((i * q.length) / pool.length)]),
  );
  return { ordered: true, intents };
}

/** The default register of an opening chord of k notes: see the module comment. */
function openingRegister(range: readonly [Pitch, Pitch], k: number): [Pitch, Pitch] {
  const span = 12 + 3 * k;
  if (range[1] - range[0] <= span) return [range[0], range[1]];
  const lo = Math.round((range[0] + range[1] - span) / 2);
  return [lo, lo + span];
}

function establishUnison(m: UnisonMoment, env: MomentEnv): MomentPlan | null {
  const own = listed(m, env);
  const vs = own ?? env.dormant().slice(0, 1);
  if (vs.length === 0) {
    if (!own) take([], 1, env);
    return null;
  }
  const r = env.range(vs[0]);
  const middle = (r[0] + r[1]) / 2;
  let pitch: Pitch;
  if (m.pitch === 'center') {
    pitch = snapToScale(roundTiesDown(middle), env.key);
  } else if (m.pitch === 'tonic') {
    const pc = pitchClassOf(env.key.tonic);
    pitch = pc + 12 * roundTiesDown((middle - pc) / 12);
  } else if (Number.isFinite(m.pitch)) {
    pitch = m.pitch;
  } else {
    env.diag('error', 'invalid-moment', 'The unison pitch is not a number.');
    return null;
  }
  return { ordered: true, intents: vs.map((voice) => birth(voice, pitch)) };
}

/** A tune: one line (the first listed voice, else the first free one) on its first note. */
function establishTune(m: TuneMoment, env: MomentEnv): MomentPlan | null {
  // The first note: a leading rest (revision 10) waits, the compiler brings the line in later.
  const first = Array.isArray(m.notes) ? m.notes[0] : undefined;
  if (!first || isRest(first) || !Number.isFinite(first.pitch)) return null;
  const own = listed(m, env);
  const vs = own ?? env.dormant();
  if (vs.length === 0) {
    if (!own) take([], 1, env);
    return null;
  }
  return {
    ordered: true,
    intents: [birth(vs[0], first.pitch + tuneShift(m.writtenIn, env.key))],
  };
}

const birth = (voice: number, to: Pitch) => ({
  voice,
  to,
  kind: IntentKind.Birth,
  parent: -1,
});
