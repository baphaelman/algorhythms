/**
 * `split` (§6.2, §7.4): raises the active count to `count` by births from dormant pool voices.
 *
 * The targeted voices and the newborns are voiced together (`notes`, default `current`). The
 * targeted voices take an order-preserving injective subset of the targets (§7.2, the prototype's
 * `retarget`); the targets left over go to the newborns, lowest pool index first, in ascending
 * order. With fewer distinct notes than voices, the extras take free octaves of the notes before
 * any unison (`octaves`, PLAN §11.3 rev 7). Each newborn's parent is the nearer (by committed
 * destination; ties: the lower) of the sounding targeted voices whose targets are next below and above its own, so no line crosses
 * (M4.5-17); the compiler starts it on the parent's pitch at the parent's departure (§7.4). With
 * too few dormant voices the split is truncated (`pool-exhausted`).
 */

import { assignFree, assignOrdered } from '../voice-leading';
import { evenIndices, voiceNotes } from '../voicing';
import type { Pitch, SplitMoment } from '../types';
import { IntentKind, type Intent, type MomentEnv, type MomentPlan, unionRange } from './types';

export function splitMoment(m: SplitMoment, env: MomentEnv): MomentPlan | null {
  if (!Number.isFinite(m.count)) {
    env.diag('error', 'invalid-moment', 'The split count is not a number.');
    return null;
  }
  const vs = env.targeted;
  let births = Math.floor(m.count) - env.active.length;
  const pool = births > 0 ? env.dormant() : [];
  if (births > pool.length) {
    env.diag(
      'warn',
      'pool-exhausted',
      `The split needs ${births} new voices but only ${pool.length} are free; it was truncated.`,
    );
    births = pool.length;
  }
  if (births <= 0) {
    env.diag(
      'info',
      'split-no-births',
      `${env.active.length} voices are already active, so the split adds none.`,
    );
    if (!m.notes) return null;
    births = 0;
  }
  const newborns = pool.slice(0, births);
  const k = vs.length + newborns.length;
  if (k === 0) {
    env.diag('info', 'no-targets', 'The split has no voices to voice.');
    return null;
  }
  const p = vs.map((v) => env.dest(v));
  const voiced = voiceNotes({
    notes: m.notes ?? { kind: 'current' },
    k,
    mode: m.voicing ?? 'even',
    register: unionRange(env, [...vs, ...newborns]),
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
  return { ordered: true, intents: voiceWithBirths(env, vs, p, newborns, voiced, false) };
}

/** Committed destinations of the active voices outside `vs` (they keep sounding). */
export function untargeted(env: MomentEnv, vs: readonly number[]): Pitch[] {
  const out: Pitch[] = [];
  for (const v of env.active) if (!vs.includes(v)) out.push(env.dest(v));
  return out;
}

/**
 * The split rule (§7.4), shared with chord `count`: the targeted voices `vs` (sorted; committed
 * destinations `p`) take an injective subset of the targets (order-preserving, or Hungarian when
 * `free`), or double them (surjective) when there are fewer; the newborns take the leftover
 * targets in ascending order (doubling evenly when too few), each parented by a sounding targeted
 * voice near its target: an order neighbour (`orderParent`), or under `free` the nearest.
 */
export function voiceWithBirths(
  env: MomentEnv,
  vs: readonly number[],
  p: readonly Pitch[],
  newborns: readonly number[],
  voiced: { targets: Pitch[]; perVoice: boolean },
  free: boolean,
): Intent[] {
  const q = voiced.targets;
  const intents: Intent[] = [];

  // Existing voices.
  let leftover: Pitch[];
  if (vs.length === 0) {
    leftover = q.slice();
  } else if (q.length >= vs.length) {
    const f = voiced.perVoice ? p.map((_, i) => i) : free ? assignFree(p, q) : assignOrdered(p, q);
    const used = new Uint8Array(q.length);
    vs.forEach((voice, i) => {
      used[f[i]] = 1;
      intents.push({ voice, to: q[f[i]], kind: IntentKind.Move });
    });
    leftover = q.filter((_, j) => !used[j]);
  } else {
    const f = free ? assignFree(p, q) : assignOrdered(p, q); // surjective: doubling
    vs.forEach((voice, i) => intents.push({ voice, to: q[f[i]], kind: IntentKind.Move }));
    leftover = [];
  }

  // Newborns take the leftover targets; with too few candidates they double evenly.
  let birthTargets: Pitch[];
  if (leftover.length >= newborns.length) {
    birthTargets = leftover.slice(0, newborns.length);
  } else {
    const extra = newborns.length - leftover.length;
    const fill =
      q.length >= extra
        ? evenIndices(q.length, extra).map((i) => q[i])
        : Array.from({ length: extra }, (_, i) => q[i % q.length]);
    birthTargets = [...leftover, ...fill].sort((a, b) => a - b);
  }
  // Order neighbours exist when the existing voices' targets keep their order (`nearest`
  // voicing too: each voice's nearest candidate rises with its pitch).
  const tv = intents.map((it) => it.to);
  let ordered = !free && vs.some((v) => env.sounding(v));
  for (let j = 1; ordered && j < tv.length; j++) if (tv[j] < tv[j - 1]) ordered = false;
  newborns.forEach((voice, i) => {
    const to = birthTargets[i];
    const parent = ordered ? orderParent(env, vs, p, tv, to) : nearestParent(env, vs, p, to);
    intents.push({ voice, to, kind: IntentKind.Birth, parent });
  });
  return intents;
}

/**
 * The sounding voice of `vs` whose committed destination is nearest `to` (ties: lower); with none
 * sounding, the nearest sounding active voice (§7.4: "the active voice nearest to the birth
 * target"), so a newborn never appears from nowhere while something sounds; −1 if nothing does.
 */
function nearestParent(
  env: MomentEnv,
  vs: readonly number[],
  p: readonly Pitch[],
  to: Pitch,
): number {
  let parent = -1;
  let best = Infinity;
  for (let j = 0; j < vs.length; j++) {
    if (!env.sounding(vs[j])) continue;
    const d = Math.abs(p[j] - to);
    if (d < best) {
      best = d;
      parent = vs[j];
    }
  }
  if (parent >= 0) return parent;
  for (const v of env.active) {
    if (!env.sounding(v)) continue;
    const d = Math.abs(env.dest(v) - to);
    if (d < best) {
      best = d;
      parent = v;
    }
  }
  return parent;
}

/**
 * Under ordered voice leading (M4.5-17): the parent is one of the newborn's order neighbours, the
 * targeted voices whose targets `tv` (non-decreasing, parallel to `vs`) lie next below and next
 * above `to`, whichever is nearer by committed destination (ties: below). A newborn forked from
 * a voice further away would start on the far side of a neighbour and cross it. A neighbour
 * that is not sounding yet (a pending birth) passes to the next sounding voice outward; with
 * none on either side, the nearest sounding voice.
 */
function orderParent(
  env: MomentEnv,
  vs: readonly number[],
  p: readonly Pitch[],
  tv: readonly Pitch[],
  to: Pitch,
): number {
  let lo = -1;
  while (lo + 1 < vs.length && tv[lo + 1] <= to) lo++;
  let hi = vs.length;
  while (hi - 1 >= 0 && tv[hi - 1] >= to) hi--;
  while (lo >= 0 && !env.sounding(vs[lo])) lo--;
  while (hi < vs.length && !env.sounding(vs[hi])) hi++;
  if (lo < 0 && hi >= vs.length) return nearestParent(env, vs, p, to);
  if (lo < 0) return vs[hi];
  if (hi >= vs.length) return vs[lo];
  return Math.abs(p[hi] - to) < Math.abs(p[lo] - to) ? vs[hi] : vs[lo];
}
