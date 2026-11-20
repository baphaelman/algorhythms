/**
 * `merge` (§6.2, §7.4): lowers the active count to `count`. The dying voices are chosen among the
 * targeted ones by `which`; each glides to the committed destination of its nearest surviving
 * neighbour (any active survivor; ties: the lower one), then fades out over `fade` and becomes
 * dormant. With no survivors left, the dying voices fade where they are.
 */

import { Purpose } from '../rng';
import type { MergeMoment } from '../types';
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
  const a = vs.length;
  const idx = vs.map((_, i) => i);
  const mid = (a - 1) / 2;
  let chosen: number[];
  switch (m.which) {
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
  const dying = new Set(chosen.map((i) => vs[i]));
  const survivors = env.active.filter((v) => !dying.has(v));
  const fade = Number.isFinite(m.fade) && m.fade > 0 ? m.fade : 0;
  const intents: Intent[] = [];
  for (const v of vs) {
    if (!dying.has(v)) continue;
    const d = env.dest(v);
    let to = d;
    let best = Infinity;
    for (const s of survivors) {
      const dist = Math.abs(env.dest(s) - d);
      if (dist < best) {
        best = dist;
        to = env.dest(s);
      }
    }
    intents.push({ voice: v, to, kind: IntentKind.Death, fade });
  }
  return { ordered: true, intents };
}
