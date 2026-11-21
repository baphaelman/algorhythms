/**
 * Line sections (PLAN.md §11.3 revision 7 "Score selection"): clicking a line selects the moment
 * that owns that part of it. Pure.
 */

import { lifeAt, segmentIndexAt } from '../../core/query';
import type { CompiledScore, MomentId, Seconds } from '../../core/types';

/**
 * The moment owning voice `voice`'s line at `t`: the moment of the segment there, or for a hold
 * (which no moment produced) that of the latest earlier move in the same life; an establishing
 * moment owns the hold it opens (M4.5-27). Null when none (no line).
 */
export function sectionOwner(score: CompiledScore, voice: number, t: Seconds): MomentId | null {
  const v = score.voices[voice];
  if (!v) return null;
  const life = lifeAt(v, t);
  if (!life) return null;
  for (let i = segmentIndexAt(v, t); i >= 0; i--) {
    const s = v.segments[i];
    if (s.t1 < life.born) break;
    if (s.momentId !== undefined) return s.momentId;
  }
  return null;
}
