/**
 * `merge` (§6.2, §7.4): lowers the active count to `count`. The dying voices are chosen among the
 * targeted ones by `which`; each glides to the committed destination of its nearest surviving
 * neighbour (`absorbers`), then fades out over `fade` and becomes dormant. With no survivors
 * left, the dying voices fade where they are.
 */

import { Purpose } from '../rng';
import type { MergeMoment, MergeWhich } from '../types';
import { IntentKind, type Intent, type MomentEnv, type MomentPlan } from './types';

export function mergeMoment(m: MergeMoment, env: MomentEnv): MomentPlan | null {
  if (!Number.isFinite(m.count)) {
    env.diag('error', 'invalid-moment', 'The merge count is not a number.');
    return null;
  }
  const vs = env.targeted;
  let n = env.active.length - Math.max(0, Math.floor(m.count));
  if (n <= 0) {
    env.diag('info', 'merge-nothing', `Only ${env.active.length} voices are active; none die.`);
    return null;
  }
  if (n > vs.length) n = vs.length;
  if (n === 0) {
    env.diag('info', 'no-targets', 'The merge targets no active voice.');
    return null;
  }
  const dying = chooseDying(env, vs, m.which, n);
  const fade = Number.isFinite(m.fade) && m.fade > 0 ? m.fade : 0;
  const intents: Intent[] = [];
  const into = absorbers(env, dying);
  for (const v of vs) {
    if (!dying.has(v)) continue;
    const s = into.get(v) ?? -1;
    const to = s >= 0 ? env.dest(s) : env.dest(v);
    intents.push({ voice: v, to, kind: IntentKind.Death, fade, into: s });
  }
  return { ordered: true, intents };
}

/**
 * The survivor each dying voice merges into (−1: none left): its nearest surviving neighbour in
 * the order of the active voices (by committed destination, ties: pool index) among those of its
 * part, the closer of the one below and the one above (ties: below). Taking an order neighbour, not just the nearest
 * pitch, keeps lines apart when survivors share a pitch but move to different targets (a chord
 * with `count`): the dying voice then ends where its neighbour ends, never past it.
 */
export function absorbers(env: MomentEnv, dying: ReadonlySet<number>): Map<number, number> {
  const act = env.active;
  const out = new Map<number, number>();
  for (let i = 0; i < act.length; i++) {
    const v = act[i];
    if (!dying.has(v)) continue;
    // Revision 9: only a survivor of its own part (lines in different parts never merge).
    const part = env.part(v);
    const skip = (u: number): boolean => dying.has(u) || env.part(u) !== part;
    let lo = i - 1;
    while (lo >= 0 && skip(act[lo])) lo--;
    let hi = i + 1;
    while (hi < act.length && skip(act[hi])) hi++;
    const d = env.dest(v);
    const below = lo >= 0 ? act[lo] : -1;
    const above = hi < act.length ? act[hi] : -1;
    if (below < 0) out.set(v, above);
    else if (above < 0) out.set(v, below);
    else out.set(v, env.dest(above) - d < d - env.dest(below) ? above : below);
  }
  return out;
}

/** The n voices of `vs` (sorted by committed destination) that die, by `which` (§6.2 merge). */
export function chooseDying(
  env: MomentEnv,
  vs: readonly number[],
  which: MergeWhich,
  n: number,
): Set<number> {
  const a = vs.length;
  const idx = vs.map((_, i) => i);
  const mid = (a - 1) / 2;
  let chosen: number[];
  switch (which) {
    case 'top':
      chosen = idx.slice(a - n);
      break;
    case 'bottom':
      chosen = idx.slice(0, n);
      break;
    case 'inner':
      chosen = idx
        .slice()
        .sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y)
        .slice(0, n);
      break;
    case 'outer':
      chosen = idx
        .slice()
        .sort((x, y) => Math.abs(y - mid) - Math.abs(x - mid) || x - y)
        .slice(0, n);
      break;
    default: {
      const r = vs.map((v) => env.rand(v, 0, Purpose.MergeWhich));
      chosen = idx
        .slice()
        .sort((x, y) => r[x] - r[y] || vs[x] - vs[y])
        .slice(0, n);
    }
  }
  return new Set(chosen.map((i) => vs[i]));
}
