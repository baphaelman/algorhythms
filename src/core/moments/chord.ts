/**
 * `chord` (§6.2): moves the targeted voices to a voicing of `notes` (§7.3) by voice leading
 * (§7.2). Without `count` the voice count is unchanged. A chord or degrees chord takes free octaves
 * of its chord tones in the lines' range before two lines share a note (owner, 2026-11-21,
 * `distinctTargets`); explicit pitch lists double as written (the lines then merge).
 *
 * With `count` (revision 6) the active count becomes `count` in the same moment:
 * - more: dormant voices are born as in a split (§7.4; `voiceWithBirths`): the chord is voiced for
 *   the targeted voices plus the newborns, which take the targets the others leave and fork from
 *   the nearest sounding targeted voice. With fewer distinct notes than voices the extras take free
 *   octaves inside the register before any unison (PLAN §11.3 rev 7). Too few dormant voices:
 *   truncated (`pool-exhausted`).
 * - fewer: the outermost targeted voices die as in a merge (`which: 'outer'`); the chord is voiced
 *   for the survivors, and each dying voice glides to the target of its nearest surviving order
 *   neighbour (`absorbers`; an untargeted survivor's target is where it is heading), then fades
 *   over the glide length, following that survivor's later moves. At least one targeted voice
 *   survives (`count-limited`).
 */

import { assignFree, assignOrdered } from '../voice-leading';
import { pitchesWithPcs } from '../scales';
import { fillOctaves, pitchClasses, voiceNotes } from '../voicing';
import type { ChordMoment, Pitch } from '../types';
import { chordByVoice } from './chord-by-voice';
import { absorbers, chooseDying } from './merge';
import { untargeted, voiceWithBirths } from './split';
import { IntentKind, type MomentEnv, type MomentPlan, unionRange } from './types';

export function chordMoment(m: ChordMoment, env: MomentEnv): MomentPlan | null {
  const byVoice = chordByVoice(m, env);
  if (byVoice) return byVoice;
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

/** Explicit pitch lists (and `current`) stay as written: their unisons merge (owner, 2026-11-21). */
const literal = (m: ChordMoment): boolean =>
  m.notes.kind === 'pitches' || m.notes.kind === 'current';

/**
 * Free octaves before merging lines (owner, 2026-11-21), on the voicing's targets `q` for k lines:
 * missing targets (fewer notes than lines) first take free octaves of the targets in the lines'
 * own range (`fillOctaves`, which may lie outside an explicit register); then a target that an
 * untargeted line holds, or that an earlier target already takes, moves to the free chord tone
 * in range nearest it (ties: lower); still missing ones take the free chord tones nearest the
 * targets. A slash bass stays the lowest note. What finds no free pitch stays, and merges.
 */
function distinctTargets(
  m: ChordMoment,
  env: MomentEnv,
  q: readonly Pitch[],
  k: number,
  perVoice: boolean,
  range: readonly [Pitch, Pitch],
  sounding: readonly Pitch[],
): Pitch[] {
  const slash = m.notes.kind === 'chord' && m.notes.symbol.includes('/');
  const floor = slash && q.length > 0 ? q[0] : -Infinity;
  const out =
    q.length < k && !perVoice ? fillOctaves(q, k, range[0], range[1], floor, sounding) : q.slice();
  if (m.notes.kind === 'pitches') return out;
  const pc = pitchClasses(m.notes, env.key, []);
  if (!pc.ok) return out;
  const cands = pitchesWithPcs(pc.pcs, range[0], range[1]).filter((p) => p > floor);
  const same = (a: Pitch, b: Pitch): boolean => Math.abs(a - b) < 1e-9;
  const free = (x: Pitch): boolean =>
    !sounding.some((p) => same(p, x)) && !out.some((p) => same(p, x));
  const nearestFree = (x: Pitch): Pitch => {
    let best = NaN;
    for (const c of cands)
      if (free(c) && (best !== best || Math.abs(c - x) < Math.abs(best - x))) best = c;
    return best;
  };
  if (out.length <= k) {
    for (let j = 0; j < out.length; j++) {
      const x = out[j];
      if (!sounding.some((p) => same(p, x)) && !out.slice(0, j).some((p) => same(p, x))) continue;
      if (j === 0 && slash) continue;
      const y = nearestFree(x);
      if (y === y) out[j] = y;
    }
  }
  while (!perVoice && out.length > 0 && out.length < k) {
    let best = NaN;
    for (const x of out) {
      const y = nearestFree(x);
      if (y === y && (best !== best || Math.abs(y - x) < Math.abs(best - x))) best = y;
    }
    if (best !== best) break;
    out.push(best);
  }
  return out.sort((a, b) => a - b);
}

/** The chord voiced for `vs` (sorted by committed destination), with no births or deaths. */
function voiceChord(
  m: ChordMoment,
  env: MomentEnv,
  vs: readonly number[],
  dying: readonly number[] = [],
): MomentPlan | null {
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
  const q = literal(m)
    ? voiced.targets
    : distinctTargets(
        m,
        env,
        voiced.targets,
        vs.length,
        voiced.perVoice,
        unionRange(env, vs),
        untargeted(env, [...vs, ...dying]),
      );
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
    octaves: true,
    sounding: untargeted(env, vs),
  });
  if (!voiced.ok) {
    env.diag('error', voiced.code, voiced.message);
    return null;
  }
  const free = m.assign === 'free';
  const k = vs.length + births;
  const targets = literal(m)
    ? voiced.targets
    : distinctTargets(
        m,
        env,
        voiced.targets,
        k,
        voiced.perVoice,
        unionRange(env, [...vs, ...newborns]),
        untargeted(env, vs),
      );
  return {
    ordered: !free,
    intents: voiceWithBirths(env, vs, p, newborns, { ...voiced, targets }, free),
  };
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
    [...dying],
  );
  if (!plan) return null;
  const target = new Map<number, Pitch>();
  for (const it of plan.intents) target.set(it.voice, it.to);
  const fade = env.glide.length;
  const into = absorbers(env, dying);
  for (const v of vs) {
    if (!dying.has(v)) continue;
    const s = into.get(v) ?? -1;
    const to = s >= 0 ? (target.get(s) ?? env.dest(s)) : env.dest(v);
    plan.intents.push({ voice: v, to, kind: IntentKind.Death, fade, into: s });
  }
  return plan;
}
