/**
 * Tune rests in the output (revision 10). In the simulation a resting line stays active and holds
 * its pitch (it keeps its voice); `finish` cuts its lives here: each rest ends the life piece it
 * starts in with a REST_FADE fade-out, and the line's comeback (a jump, `Frontier.jump`) opens a
 * new piece. Segments inside the gaps are dropped, and one running at a fade's end is cut there.
 */

import { evalSegment } from '../segment';
import type { Life, Seconds, Segment } from '../types';
import type { RestSpan } from './voice';

/** Fade-out at a rest's start (smootherstep, click-free; shorter when the rest is shorter). */
export const REST_FADE = 0.02;
/** Fade-in of a tune note coming in after a rest (it strikes: the DSP's attack starts from 0). */
export const REST_ATTACK = 0.01;
/** Fade-in of a line another moment brings back after a rest (as a silent part coming in). */
export const REST_RETURN_MIN = 0.5;

function cutSegment(s: Segment, d: Seconds): Segment {
  const hold = s.p0 === s.p1 && !s.curve && !s.m0;
  if (hold) return { ...s, t1: d };
  return { ...s, curve: s.curve ?? { t1: s.t1, p1: s.p1 }, t1: d, p1: evalSegment(s, d) };
}

/** Lives and segments with the rests cut out. Inputs are never mutated. */
export function cutRests(
  lives: readonly Life[],
  segs: readonly Segment[],
  rests: readonly RestSpan[],
): { lives: Life[]; segments: Segment[] } {
  const outL: Life[] = [];
  for (const L of lives) {
    const died = L.died ?? Infinity;
    let cur: Life | null = { born: L.born, fadeIn: L.fadeIn };
    if (L.crossIn) cur.crossIn = true;
    for (const r of rests) {
      if (!cur) break;
      if (r.from < cur.born || r.from >= died) continue;
      const room = Number.isFinite(r.to) ? (r.to - r.from) / 2 : Infinity;
      const fade = Math.min(REST_FADE, room, died - r.from);
      if (r.from > cur.born && fade > 0) {
        cur.died = r.from + fade;
        cur.fadeOut = fade;
        outL.push(cur);
      }
      cur = r.to < died ? { born: r.to, fadeIn: r.fadeIn } : null;
    }
    if (cur) {
      if (L.died !== undefined) cur.died = L.died;
      if (L.fadeOut !== undefined) cur.fadeOut = L.fadeOut;
      if (L.crossOut) cur.crossOut = true;
      outL.push(cur);
    }
  }
  const outS: Segment[] = [];
  let j = 0;
  for (const L of outL) {
    const b = L.born;
    const d = L.died ?? Infinity;
    while (j < segs.length && segs[j].t1 <= b) j++;
    for (let k = j; k < segs.length && segs[k].t0 < d; k++) {
      const s = segs[k];
      outS.push(s.t1 > d ? cutSegment(s, d) : s);
    }
  }
  return { lives: outL, segments: outS };
}
