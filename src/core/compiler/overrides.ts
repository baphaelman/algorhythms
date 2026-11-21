/**
 * Per-voice overrides of a point moment (PLAN.md §11.3 "Every dot is draggable", revision 6):
 * `pitch` replaces that voice's target before planning, `end` sets its arrival after planning.
 * Generic: applied by the compiler to every point moment's plan, so no moment function knows.
 */

import type { Moment, Seconds, VoiceOverride } from '../types';
import { IntentKind, type MomentPlan } from '../moments/types';
import { MIN_GLIDE } from './glide';
import type { PlanResult } from './plan';
import type { VoiceRun } from './voice';

/** The usable overrides of `m` by pool index (later entries win), or null when there are none. */
export function overridesOf(m: Moment, voiceCount: number): Map<number, VoiceOverride> | null {
  const list = m.overrides;
  if (!Array.isArray(list) || list.length === 0) return null;
  let out: Map<number, VoiceOverride> | null = null;
  for (const o of list) {
    const v = o?.voice;
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < voiceCount)) continue;
    const pitch = typeof o.pitch === 'number' && Number.isFinite(o.pitch) ? o.pitch : undefined;
    const end =
      typeof o.end === 'number' && Number.isFinite(o.end) && o.end >= 0 ? o.end : undefined;
    const weight =
      typeof o.weight === 'number' && Number.isFinite(o.weight) && o.weight > 0
        ? o.weight
        : undefined;
    if (pitch === undefined && end === undefined && weight === undefined) continue;
    const prev = out?.get(v);
    (out ??= new Map()).set(v, {
      voice: v,
      pitch: pitch ?? prev?.pitch,
      end: end ?? prev?.end,
      weight: weight ?? prev?.weight,
    });
  }
  return out;
}

/**
 * Applies the pitch overrides to `plan` in place: an intent of that voice gets the pitch; a
 * targeted voice without one gets a move. The plan becomes unordered (hand edits may cross), and
 * an overridden dying voice does not follow its survivor.
 */
export function applyOverridePitches(
  plan: MomentPlan,
  ov: ReadonlyMap<number, VoiceOverride>,
  targeted: readonly number[],
): void {
  plan.ordered = false;
  // A hand-edited dying voice keeps its own path: it does not follow its survivor (M4.5-17).
  for (const it of plan.intents) if (it.kind === IntentKind.Death && ov.has(it.voice)) it.into = -1;
  for (const [v, o] of ov) {
    if (o.pitch === undefined) continue;
    let found = false;
    for (const it of plan.intents) {
      if (it.voice !== v) continue;
      it.to = o.pitch;
      found = true;
    }
    if (!found && targeted.includes(v)) {
      plan.intents.push({ voice: v, to: o.pitch, kind: IntentKind.Move });
    }
  }
}

/**
 * Applies the `end` overrides to the planned moves in place: the move ends at `T + end` (at least
 * MIN_GLIDE after `T`); its start moves earlier only if the glide would be shorter than MIN_GLIDE,
 * never before `T` or (for a voice born by an earlier moment) its birth.
 */
export function applyOverrideEnds(
  res: PlanResult,
  ov: ReadonlyMap<number, VoiceOverride>,
  T: Seconds,
  voices: readonly VoiceRun[],
): void {
  for (const mv of res.moves) {
    const e = ov.get(mv.voice)?.end;
    if (e === undefined) continue;
    const birth = res.births.find((b) => b.voice === mv.voice);
    const end = T + (e > MIN_GLIDE ? e : MIN_GLIDE);
    let t0 = mv.t0;
    if (end - t0 < MIN_GLIDE) {
      const deferred = !birth && voices[mv.voice].pendingBirth;
      if (!deferred) t0 = Math.max(T, end - MIN_GLIDE);
    }
    mv.t0 = t0;
    mv.dur = end - t0 > MIN_GLIDE ? end - t0 : MIN_GLIDE;
    mv.memo = undefined;
    if (birth) birth.t = t0;
  }
}
