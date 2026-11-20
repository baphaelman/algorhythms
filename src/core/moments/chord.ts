/**
 * `chord` (§6.2): moves the targeted voices to a voicing of `notes` (§7.3) by voice leading
 * (§7.2). Without `count` the voice count is unchanged; fewer notes than voices means doubling.
 *
 * With `count` (revision 6) the active count becomes `count` in the same moment:
 * - more: dormant voices are born as in a split (§7.4; `voiceWithBirths`): the chord is voiced for
 *   the targeted voices plus the newborns, which take the targets the others leave and fork from
 *   the nearest sounding targeted voice. Too few dormant voices: truncated (`pool-exhausted`).
 * - fewer: the outermost targeted voices die as in a merge (`which: 'outer'`); the chord is voiced
 *   for the survivors, and each dying voice glides to the target of its nearest survivor (by
 *   committed destination, ties low; an untargeted survivor's target is where it is heading), then
 *   fades over the glide length. At least one targeted voice survives (`count-limited`).
 */

import { assignFree, assignOrdered } from '../voice-leading';
import { voiceNotes } from '../voicing';
import type { ChordMoment, Pitch } from '../types';
import { chooseDying } from './merge';
import { voiceWithBirths } from './split';
import { IntentKind, type MomentEnv, type MomentPlan, unionRange } from './types';

export function chordMoment(m: ChordMoment, env: MomentEnv): MomentPlan | null {
  if (m.count !== undefined) {
    if (!Number.isFinite(m.count)) {
      env.diag('error', 'invalid-moment', 'The chord count is not a number.');
      return null;
    }
    const diff = Math.max(1, Math.floor(m.count)) - env.active.length;
    if (diff > 0) return withBirths(m, env, diff);
    if (diff < 0) return withDeaths(m, env, -diff);
  }
  return voiceChord(m, env, env.targeted);
}

/** The chord voiced for `vs` (sorted by committed destination), with no births or deaths. */
function voiceChord(m: ChordMoment, env: MomentEnv, vs: readonly number[]): MomentPlan | null {
  if (vs.length === 0) {
    env.diag('info', 'no-targets', 'The chord targets no active voice.');
    return null;
  }
  const p = vs.map((v) => env.dest(v));
  const voiced = voiceNotes({
    notes: m.notes,
    k: vs.length,
    mode: m.voicing ?? 'even',
    register: m.register ?? unionRange(env, vs),
    key: env.key,
    current: env.active.map((v) => env.dest(v)),
    voices: p,
  });
  if (!voiced.ok) {
    env.diag('error', voiced.code, voiced.message);
    return null;
  }
  const q = voiced.targets;
  const free = m.assign === 'free';
  const f = voiced.perVoice ? p.map((_, i) => i) : free ? assignFree(p, q) : assignOrdered(p, q);
  if (q.length > vs.length && !voiced.perVoice) {
    env.diag(
      'info',
      'targets-dropped',
      `${q.length - vs.length} of ${q.length} notes have no voice and were dropped.`,
    );
  }
  return {
    ordered: !free,
    intents: vs.map((voice, i) => ({ voice, to: q[f[i]], kind: IntentKind.Move })),
  };
}

function withBirths(m: ChordMoment, env: MomentEnv, want: number): MomentPlan | null {
  const vs = env.targeted;
  const pool = env.dormant();
  let births = want;
  if (births > pool.length) {
    env.diag(
      'warn',
      'pool-exhausted',
      `The chord needs ${births} new voices but only ${pool.length} are free; it was truncated.`,
    );
    births = pool.length;
  }
  if (births === 0) return voiceChord(m, env, vs);
  const newborns = pool.slice(0, births);
  const p = vs.map((v) => env.dest(v));
  const voiced = voiceNotes({
    notes: m.notes,
    k: vs.length + births,
    mode: m.voicing ?? 'even',
    register: m.register ?? unionRange(env, [...vs, ...newborns]),
    key: env.key,
    current: env.active.map((v) => env.dest(v)),
    voices: p,
  });
  if (!voiced.ok) {
    env.diag('error', voiced.code, voiced.message);
    return null;
  }
  const free = m.assign === 'free';
  return { ordered: !free, intents: voiceWithBirths(env, vs, p, newborns, voiced, free) };
}

function withDeaths(m: ChordMoment, env: MomentEnv, want: number): MomentPlan | null {
  const vs = env.targeted;
  if (vs.length === 0) return voiceChord(m, env, vs);
  let n = want;
  if (n > vs.length - 1) {
    n = vs.length - 1;
    env.diag(
      'info',
      'count-limited',
      `The chord targets ${vs.length} voices, so only ${n} can die; ${env.active.length - n} remain.`,
    );
  }
  if (n <= 0) return voiceChord(m, env, vs);
  const dying = chooseDying(env, vs, 'outer', n);
  const plan = voiceChord(
    m,
    env,
    vs.filter((v) => !dying.has(v)),
  );
  if (!plan) return null;
  const target = new Map<number, Pitch>();
  for (const it of plan.intents) target.set(it.voice, it.to);
  const survivors = env.active.filter((v) => !dying.has(v));
  const fade = env.glide.length;
  for (const v of vs) {
    if (!dying.has(v)) continue;
    const d = env.dest(v);
    let to = d;
    let best = Infinity;
    for (const s of survivors) {
      const dist = Math.abs(env.dest(s) - d);
      if (dist < best) {
        best = dist;
        to = target.get(s) ?? env.dest(s);
      }
    }
    plan.intents.push({ voice: v, to, kind: IntentKind.Death, fade });
  }
  return plan;
}
