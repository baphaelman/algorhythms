/**
 * `pin` (§6.2): moves one voice to an exact pitch. The hand-editing escape hatch: it ignores
 * `target`, may cross other voices, and is exempt from the crossing guarantee (§7.2).
 */

import type { PinMoment } from '../types';
import { IntentKind, type MomentEnv, type MomentPlan } from './types';

export function pinMoment(m: PinMoment, env: MomentEnv): MomentPlan | null {
  const v = env.indexOf(m.voice);
  if (v < 0) {
    env.diag('error', 'unknown-voice', `Pin: there is no voice '${m.voice}'.`);
    return null;
  }
  if (!env.targeted.includes(v)) {
    env.diag('error', 'pin-inactive', `Pin: voice '${m.voice}' is not active at ${m.at} s.`);
    return null;
  }
  if (!Number.isFinite(m.pitch)) {
    env.diag('error', 'invalid-moment', 'The pin pitch is not a number.');
    return null;
  }
  return { ordered: false, intents: [{ voice: v, to: m.pitch, kind: IntentKind.Move }] };
}
