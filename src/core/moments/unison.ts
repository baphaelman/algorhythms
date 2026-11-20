/**
 * `unison` (§6.2): all targeted voices go to one pitch, or with `octaves` each to the nearest
 * octave of that pitch's class.
 *
 * - `pitch: 'center'`: the middle of the targeted voices' committed destinations,
 *   (lowest + highest)/2, snapped to the key in effect (ties down).
 * - `pitch: 'tonic'`: the tonic of the key in effect, in the octave nearest that middle (ties
 *   down).
 */

import { pitchClassOf, snapToScale } from '../scales';
import type { Pitch, UnisonMoment } from '../types';
import { roundTiesDown } from '../voicing';
import { movesTo, type MomentEnv, type MomentPlan } from './types';

export function unisonMoment(m: UnisonMoment, env: MomentEnv): MomentPlan | null {
  const vs = env.targeted;
  if (vs.length === 0) {
    env.diag('info', 'no-targets', 'The unison targets no active voice.');
    return null;
  }
  const dests = vs.map((v) => env.dest(v));
  const middle = (dests[0] + dests[dests.length - 1]) / 2;
  let pitch: Pitch;
  if (m.pitch === 'center') {
    pitch = snapToScale(middle, env.key);
  } else if (m.pitch === 'tonic') {
    const pc = pitchClassOf(env.key.tonic);
    pitch = pc + 12 * roundTiesDown((middle - pc) / 12);
  } else if (Number.isFinite(m.pitch)) {
    pitch = m.pitch;
  } else {
    env.diag('error', 'invalid-moment', 'The unison pitch is not a number.');
    return null;
  }
  const targets = m.octaves
    ? dests.map((d) => pitch + 12 * roundTiesDown((d - pitch) / 12))
    : dests.map(() => pitch);
  return { ordered: true, intents: movesTo(vs, targets) };
}
