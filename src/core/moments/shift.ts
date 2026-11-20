/**
 * `shift` (§6.2): transposes the targeted voices by semitones, or by scale steps in the key in
 * effect (off-scale pitches snap first, §7.8). Order-preserving, so `ordered`.
 */

import { stepByScale } from '../scales';
import type { ShiftMoment } from '../types';
import { movesTo, type MomentEnv, type MomentPlan } from './types';

export function shiftMoment(m: ShiftMoment, env: MomentEnv): MomentPlan | null {
  const vs = env.targeted;
  if (vs.length === 0) {
    env.diag('info', 'no-targets', 'The shift targets no active voice.');
    return null;
  }
  if (!Number.isFinite(m.by)) {
    env.diag('error', 'invalid-moment', 'The shift amount is not a number.');
    return null;
  }
  const targets = vs.map((v) => {
    const d = env.dest(v);
    return m.unit === 'scaleSteps' ? stepByScale(d, m.by, env.key) : d + m.by;
  });
  return { ordered: true, intents: movesTo(vs, targets) };
}
