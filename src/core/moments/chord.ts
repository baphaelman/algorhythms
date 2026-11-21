/**
 * `chord` (§6.2): moves the targeted voices to a voicing of `notes` (§7.3) by voice leading
 * (§7.2). Without `count` the voice count is unchanged. A chord or degrees chord takes free octaves
 * of its chord tones before two lines share a note (owner, 2026-11-21, `distinctTargets`): inside
 * its register first, then beyond it short of the untargeted lines (integrator, 2026-11-21);
 * explicit pitch lists double as written (the lines then merge).
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

/** Just clear of an untargeted line's pitch (exclusive bounds as inclusive ones). */
const GAP = 1e-6;

/**
 * Where a chord's free octaves may go (integrator, 2026-11-21, "Free octaves stay inside the
 * chord's register"): `inner`, the moment's register within the lines' range, searched first;
 * then `outer`, which adds the room beyond the register between the untargeted neighbours, within
 * the lines' range: below the register, above every untargeted line lower than the register or
 * than the lowest targeted line (`held`: their committed destinations), so no line steps past one
 * to get there; above it, likewise. With no untargeted line, or no explicit register, both are
 * the lines' range (the 29a rule).
 */
function octaveRoom(
  register: readonly [Pitch, Pitch] | undefined,
  range: readonly [Pitch, Pitch],
  sounding: readonly Pitch[],
  held: readonly Pitch[],
): { inner: [Pitch, Pitch]; outer: [Pitch, Pitch] } {
  if (!register || sounding.length === 0)
    return { inner: [range[0], range[1]], outer: [range[0], range[1]] };
  const rl = register[0] < register[1] ? register[0] : register[1];
  const rh = register[0] < register[1] ? register[1] : register[0];
  const lo = rl > range[0] ? rl : range[0];
  const hi = rh < range[1] ? rh : range[1];
  if (lo > hi) return { inner: [range[0], range[1]], outer: [range[0], range[1]] };
  // An untargeted line lower than the register or than the lowest held line bounds the room
  // below; one higher than the register or than the highest held line, the room above.
  let pmin = Infinity;
  let pmax = -Infinity;
  for (const p of held) {
    if (p < pmin) pmin = p;
    if (p > pmax) pmax = p;
  }
  const pl = pmin > lo && pmin !== Infinity ? pmin : lo;
  const ph = pmax < hi && pmax !== -Infinity ? pmax : hi;
  let below = range[0];
  let above = range[1];
  for (const u of sounding) {
    if (u < pl && u + GAP > below) below = u + GAP;
    if (u > ph && u - GAP < above) above = u - GAP;
  }
  return { inner: [lo, hi], outer: [below < lo ? below : lo, above > hi ? above : hi] };
}

/**
 * Free octaves before merging lines (owner, 2026-11-21), on the voicing's targets `q` for k lines:
 * missing targets (fewer notes than lines) first take free octaves of the targets (`fillOctaves`)
 * inside the register, then in the room beyond it short of the untargeted lines (`octaveRoom`);
 * then a target that an untargeted line holds, or that an earlier target already takes, moves to
 * the free chord tone nearest it (ties: lower), inside the register if one is free there, else in
 * that room; still missing ones take the free chord tones nearest the targets, the same way. A
 * slash bass stays the lowest note. What finds no free pitch stays, and merges.
 */
function distinctTargets(
  m: ChordMoment,
  env: MomentEnv,
  q: readonly Pitch[],
  k: number,
  perVoice: boolean,
  range: readonly [Pitch, Pitch],
  sounding: readonly Pitch[],
  held: readonly Pitch[],
): Pitch[] {
  const slash = m.notes.kind === 'chord' && m.notes.symbol.includes('/');
  const floor = slash && q.length > 0 ? q[0] : -Infinity;
  const { inner, outer } = octaveRoom(m.register, range, sounding, held);
  let out = q.slice();
  if (q.length < k && !perVoice) {
    out = fillOctaves(q, k, inner[0], inner[1], floor, sounding);
    if (out.length < k && (outer[0] < inner[0] || outer[1] > inner[1])) {
      // Beyond the register: fillOctaves again on the original notes, with those already added
      // counted as sounding; keep only its additions.
      const more = fillOctaves(q, q.length + k - out.length, outer[0], outer[1], floor, [
        ...sounding,
        ...out,
      ]);
      out = [...out, ...more.filter((p) => !q.includes(p))].sort((a, b) => a - b);
    }
  }
  if (m.notes.kind === 'pitches') return out;
  const pc = pitchClasses(m.notes, env.key, []);
  if (!pc.ok) return out;
  const inside = (p: Pitch): boolean => p >= inner[0] && p <= inner[1];
  const cands = pitchesWithPcs(pc.pcs, outer[0], outer[1]).filter((p) => p > floor);
  const same = (a: Pitch, b: Pitch): boolean => Math.abs(a - b) < 1e-9;
  const free = (x: Pitch): boolean =>
    !sounding.some((p) => same(p, x)) && !out.some((p) => same(p, x));
  const nearestFree = (x: Pitch): Pitch => {
    let best = NaN;
    let bestIn = false;
    for (const c of cands) {
      if (!free(c)) continue;
      const ci = inside(c);
      if (best !== best || better(c, ci, best, bestIn, x)) {
        best = c;
        bestIn = ci;
      }
    }
    return best;
  };
  /** c (inside the register: ci) beats b (bi) as the free note for x: inside first, then nearer. */
  const better = (c: Pitch, ci: boolean, b: Pitch, bi: boolean, x: Pitch): boolean =>
    ci !== bi ? ci : Math.abs(c - x) < Math.abs(b - x);
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
      if (y === y && (best !== best || better(y, inside(y), best, inside(best), x))) best = y;
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
        p,
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
        p,
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
