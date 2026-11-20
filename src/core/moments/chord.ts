/**
 * `chord` (§6.2): moves the targeted voices to a voicing of `notes` (§7.3) by voice leading
 * (§7.2). The voice count is unchanged; fewer notes than voices means doubling.
 */

import { assignFree, assignOrdered } from '../voice-leading';
import { voiceNotes } from '../voicing';
import type { ChordMoment } from '../types';
import { IntentKind, type MomentEnv, type MomentPlan, unionRange } from './types';

export function chordMoment(m: ChordMoment, env: MomentEnv): MomentPlan | null {
  const vs = env.targeted;
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
  const q = voiced.targets;
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
