/**
 * Per-voice overrides (PLAN.md §11.3 "Every dot is draggable", revision 6): pure helpers for
 * dot drags and the inspector's list.
 */

import type { Moment, Pitch, Seconds, VoiceOverride } from '../../core/types';

/** `list` with voice `voice`'s entry merged with `patch` (added if absent; one entry per voice). */
export function withOverride(
  list: readonly VoiceOverride[] | undefined,
  voice: number,
  patch: { pitch?: Pitch; end?: Seconds },
): VoiceOverride[] {
  const out = (list ?? []).filter((o) => o.voice !== voice);
  const old = (list ?? []).filter((o) => o.voice === voice);
  const merged: VoiceOverride = { voice };
  for (const o of [...old, patch]) {
    if (o.pitch !== undefined) merged.pitch = o.pitch;
    if (o.end !== undefined) merged.end = o.end;
  }
  out.push(merged);
  return out.sort((a, b) => a.voice - b.voice);
}

/** `list` without voice `voice`'s entry; undefined when nothing is left (removes the field). */
export function withoutOverride(
  list: readonly VoiceOverride[] | undefined,
  voice: number,
): VoiceOverride[] | undefined {
  const out = (list ?? []).filter((o) => o.voice !== voice);
  return out.length > 0 ? out : undefined;
}

/** A dragged arrival as an override `end`: seconds after the moment's `at`, ≥ 0, to the ms. */
export function arrivalEnd(m: Moment, t: Seconds): Seconds {
  return Math.max(0, Math.round((t - m.at) * 1000) / 1000);
}
