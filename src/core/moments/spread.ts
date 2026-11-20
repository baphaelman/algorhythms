/**
 * `spread` (§6.2): p → c + factor·(p − c), then snaps (`scale`: the key in effect, ties down;
 * `chromatic`: nearest semitone, ties down; `none`).
 *
 * A non-negative factor keeps pitch order, so the moment is `ordered`. A negative factor mirrors
 * the voicing, which crosses every pair by design; it is treated like `free` (exempt from the
 * crossing guarantee).
 */

import { snapToScale } from '../scales';
import type { Pitch, SpreadMoment } from '../types';
import { roundTiesDown } from '../voicing';
import { movesTo, type MomentEnv, type MomentPlan } from './types';

export function spreadMoment(m: SpreadMoment, env: MomentEnv): MomentPlan | null {
  const vs = env.targeted;
  if (vs.length === 0) {
    env.diag('info', 'no-targets', 'The spread targets no active voice.');
    return null;
  }
  if (!Number.isFinite(m.factor)) {
    env.diag('error', 'invalid-moment', 'The spread factor is not a number.');
    return null;
  }
  const dests = vs.map((v) => env.dest(v)); // ascending
  let c: Pitch;
  if (m.around === 'mean') {
    let s = 0;
    for (const d of dests) s += d;
    c = s / dests.length;
  } else if (m.around === 'median') {
    const n = dests.length;
    c = n % 2 === 1 ? dests[(n - 1) / 2] : (dests[n / 2 - 1] + dests[n / 2]) / 2;
  } else if (Number.isFinite(m.around)) {
    c = m.around;
  } else {
    env.diag('error', 'invalid-moment', 'The spread centre is not a number.');
    return null;
  }
  const targets = dests.map((d) => {
    const x = c + m.factor * (d - c);
    if (m.snap === 'scale') return snapToScale(x, env.key);
    if (m.snap === 'chromatic') return roundTiesDown(x);
    return x;
  });
  return { ordered: m.factor >= 0, intents: movesTo(vs, targets) };
}
