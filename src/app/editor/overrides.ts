/**
 * Per-voice overrides (PLAN.md §11.3 "Every dot is draggable", revision 6): pure helpers for
 * dot drags, the inspector's list and per-note weights (revision 8).
 */

import { activeAt, lifeAt, pitchAt, weightTargetAt } from '../../core/query';
import type { CompiledScore, Moment, Pitch, Seconds, VoiceOverride } from '../../core/types';

/** `list` with voice `voice`'s entry merged with `patch` (added if absent; one entry per voice). */
export function withOverride(
  list: readonly VoiceOverride[] | undefined,
  voice: number,
  patch: { pitch?: Pitch; end?: Seconds; weight?: number },
): VoiceOverride[] {
  const out = (list ?? []).filter((o) => o.voice !== voice);
  const old = (list ?? []).filter((o) => o.voice === voice);
  const merged: VoiceOverride = { voice };
  for (const o of [...old, patch]) {
    if (o.pitch !== undefined) merged.pitch = o.pitch;
    if (o.end !== undefined) merged.end = o.end;
    if (o.weight !== undefined) merged.weight = o.weight;
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

/** Editable note weights (revision 8): the inspector's range. */
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 16;

/** The line a moment's note rests on after it, and the weights the inspector edits. */
export interface NoteLine {
  /** Pool index of the line resting on the note (the survivor if lines merged there). */
  voice: number;
  /** The note's weight after the moment (joins on arrival included). */
  weight: number;
  /** What joins on arrival add to the line's own weight: weight − its own weight. */
  joined: number;
}

/**
 * For each of `pitches` (a moment's notes), the line resting on it just after the moment's
 * arrival (its span end), or null if none does (a note folded into range, or not reached).
 */
export function noteLines(
  score: CompiledScore,
  m: Moment,
  pitches: readonly Pitch[],
): (NoteLine | null)[] {
  const end = score.momentSpans.find((s) => s.id === m.id)?.end ?? m.at;
  const t = end + 1e-3;
  const lines: { voice: number; p: number; born: number }[] = [];
  for (const i of activeAt(score, t)) {
    const v = score.voices[i];
    const life = lifeAt(v, t);
    const p = pitchAt(v, t);
    if (!life || p === null) continue;
    // A line fading out after merging is not the note's line.
    if (
      life.died !== undefined &&
      life.died < score.duration &&
      t >= life.died - (life.fadeOut ?? 0)
    )
      continue;
    lines.push({ voice: i, p, born: life.born });
  }
  return pitches.map((p) => {
    let best: { voice: number; born: number } | null = null;
    let bw = -1;
    for (const l of lines) {
      if (Math.abs(l.p - p) > 0.01) continue;
      const w = weightTargetAt(score.voices[l.voice], t);
      if (w > bw) {
        best = l;
        bw = w;
      }
    }
    if (!best) return null;
    const v = score.voices[best.voice];
    const own = weightTargetAt(v, Math.max(m.at, best.born) + 1e-6);
    return { voice: best.voice, weight: bw, joined: Math.max(0, bw - own) };
  });
}

/**
 * The override weight that gives the note `line` the weight `w`: the line's own weight is `w`
 * minus what joins it on arrival, at least WEIGHT_MIN. Rounded to 1e-3.
 */
export function weightForNote(line: NoteLine, w: number): number {
  const own = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w) - line.joined);
  return Math.round(own * 1000) / 1000;
}
