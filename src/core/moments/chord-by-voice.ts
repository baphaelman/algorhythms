/**
 * A frozen chord edited with "Keep lines in order" off (PLAN.md §11.3, revision 6): `byVoice`
 * with a `pitches` NoteSet gives pitch i to the i-th targeted voice (by committed destination, low
 * to high), unsorted, so an edited voice keeps its own note and may cross its neighbours. It
 * applies only when the list has one pitch per targeted voice and the chord changes no voice
 * count; otherwise the chord is voiced as usual (the pitches sorted, ordered).
 */

import type { ChordMoment } from '../types';
import { IntentKind, type MomentEnv, type MomentPlan } from './types';

/** The per-voice plan, or null when it does not apply (see above). */
export function chordByVoice(m: ChordMoment, env: MomentEnv): MomentPlan | null {
  if (!m.byVoice || m.notes.kind !== 'pitches') return null;
  const vs = env.targeted;
  const ps = m.notes.pitches;
  if (vs.length === 0 || ps.length !== vs.length || !ps.every(Number.isFinite)) return null;
  if (m.count !== undefined && Math.max(1, Math.floor(m.count)) !== env.active.length) return null;
  return {
    ordered: false,
    intents: vs.map((voice, i) => ({ voice, to: ps[i], kind: IntentKind.Move })),
  };
}
