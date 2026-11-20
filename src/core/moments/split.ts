/**
 * `split` (§6.2, §7.4): raises the active count to `count` by births from dormant pool voices.
 *
 * The targeted voices and the newborns are voiced together (`notes`, default `current`). The
 * targeted voices take an order-preserving injective subset of the targets (§7.2, the prototype's
 * `retarget`); the targets left over go to the newborns, lowest pool index first, in ascending
 * order. Each newborn's parent is the sounding targeted voice whose committed destination is
 * nearest its target (ties: the lower voice); the compiler starts it on the parent's pitch at the
 * parent's departure (§7.4). With too few dormant voices the split is truncated (`pool-exhausted`).
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
  });
  if (!voiced.ok) {
    env.diag('error', voiced.code, voiced.message);
    return null;
  }
  return { ordered: true, intents: voiceWithBirths(env, vs, p, newborns, voiced, false) };
}

/**
 * The split rule (§7.4), shared with chord `count`: the targeted voices `vs` (sorted; committed
 * destinations `p`) take an injective subset of the targets (order-preserving, or Hungarian when
 * `free`), or double them (surjective) when there are fewer; the newborns take the leftover
 * targets in ascending order (doubling evenly when too few), each parented by the sounding
 * targeted voice nearest its target (ties: the lower one).
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
  newborns.forEach((voice, i) => {
    const to = birthTargets[i];
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
    intents.push({ voice, to, kind: IntentKind.Birth, parent });
  });
  return intents;
}
