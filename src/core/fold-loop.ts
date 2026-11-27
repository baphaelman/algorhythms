/**
 * The closed loop for Next (PLAN.md M13 "Next", from Night Sleeper): down a major third, down a
 * major third, upside down, up a major third. The two planes land in the key a major sixth down;
 * folding about an axis that keeps the starting key lifts that a major third (core/fold.ts), and
 * the last plane brings it home. The whole loop is one fold of the start chord about a pitch
 * that keeps the key, so it ends on the start chord exactly when that chord's pitch classes read
 * the same about it (Am7 or C6 in C major, a 6/9 chord, stacked fourths about the axis).
 *
 * Offered where the voicing allows it:
 * - the key has a fold that keeps it (every diatonic mode, not harmonic minor);
 * - the chord has three or more distinct notes, all in the key;
 * - it ends where it started: the same pitch classes, its centre within a whole step;
 * - every step stays inside every line's range, so no plane folds an octave.
 * Each card is the next step: Next reads the moments before it (levels, timbres, keys, pulses and
 * tunes don't count) to see how far the loop has got. Pure.
 */

import { foldAxes, mirrorSums } from './fold';
import { mod } from './math';
import { sanitizeRange } from './compiler/range';
import { scalePcs } from './scales';
import type { Glide, Moment, Piece, Pitch, Seconds, ShiftMoment, SpreadMoment } from './types';
import type { StateAt } from './effect';

/** The loop's plane, in semitones. */
const THIRD = 4;
/** Planes keep their intervals all the way (no stagger). */
const PLANE_GLIDE: Partial<Glide> = { length: 3, stagger: 0, jitter: 0 };
/** Cross at one point: every line passes the axis at once. */
export const CROSS_GLIDE: Partial<Glide> = { length: 4, stagger: 0, jitter: 0 };
/** Moment types that don't move the loop's lines. */
const SKIP: ReadonlySet<Moment['type']> = new Set(['level', 'timbre', 'key', 'pulse', 'tune']);

export type LoopDraft =
  Omit<ShiftMoment, 'id' | 'at' | 'seed'> | Omit<SpreadMoment, 'id' | 'at' | 'seed'>;

export interface LoopStep {
  /** 1..4. */
  step: number;
  label: string;
  tooltip: string;
  moment: LoopDraft;
}

const isDown = (m: Moment): boolean =>
  m.type === 'shift' && m.unit === 'semitones' && m.by === -THIRD;
const isFold = (m: Moment): m is SpreadMoment =>
  m.type === 'spread' && m.factor === -1 && typeof m.around === 'number';

/** Steps of the loop already taken by the moments before `at` (0..3), and the fold's axis. */
function progress(piece: Piece, at: Seconds): { done: number; axis?: Pitch } {
  const before = piece.moments
    .filter((m) => !m.muted && m.at < at - 1e-9 && !SKIP.has(m.type))
    .sort((a, b) => a.at - b.at);
  const [c, b, a] = [before.at(-3), before.at(-2), before.at(-1)];
  if (a && isFold(a) && b && isDown(b) && c && isDown(c))
    return { done: 3, axis: a.around as Pitch };
  if (a && isDown(a) && b && isDown(b)) return { done: 2 };
  if (a && isDown(a)) return { done: 1 };
  return { done: 0 };
}

const TOOLTIP = 'Closed loop: down a third, down a third, upside down, up a third';

/**
 * The loop's next step at `at` for the lines of `st` (the state by lines there), or null when the
 * voicing doesn't allow it (see the module comment).
 */
export function loopStep(piece: Piece, st: StateAt, at: Seconds): LoopStep | null {
  const n = st.active.length;
  if (n < 3) return null;
  const key = st.key;
  if (mirrorSums(key).length === 0) return null;
  const { done, axis: foldAxis } = progress(piece, at);
  const now = st.active.map((v) => st.dest[v]);
  const ranges = st.active.map((v) => sanitizeRange(piece.voices[v]?.range));
  // The start chord, line by line (the fold reverses the lines' order).
  let home: Pitch[];
  let a: Pitch;
  if (done === 3) {
    a = foldAxis!;
    home = now.map((p) => 2 * a - p + 2 * THIRD);
  } else {
    home = now.map((p) => p + done * THIRD);
    let mean = 0;
    for (const p of home) mean += p;
    mean /= n;
    const ax = foldAxes(key, mean - 6);
    if (!ax) return null;
    a = ax.keep;
  }
  if (home.some((p) => !Number.isInteger(p))) return null;
  const pcsOf = (ps: readonly Pitch[]) =>
    [...new Set(ps.map((p) => mod(p, 12)))].sort((x, y) => x - y);
  const homePcs = pcsOf(home);
  if (homePcs.length < 3 || new Set(home).size < 3) return null;
  const scale = new Set(scalePcs(key));
  if (homePcs.some((pc) => !scale.has(pc))) return null;
  const end = home.map((p) => 2 * a + 3 * THIRD - p);
  const endPcs = pcsOf(end);
  if (endPcs.length !== homePcs.length || endPcs.some((pc, i) => pc !== homePcs[i])) return null;
  let mh = 0;
  let me = 0;
  for (let i = 0; i < n; i++) {
    mh += home[i];
    me += end[i];
  }
  if (Math.abs(me - mh) / n > 2 + 1e-9) return null;
  // Each line's pitches after each step still to come (line i: `now[i]` today).
  const steps: ((p: Pitch) => Pitch)[] = [
    (p) => p - THIRD,
    (p) => p - THIRD,
    (p) => 2 * a - p,
    (p) => p + THIRD,
  ];
  for (let i = 0; i < n; i++) {
    let p = now[i];
    for (let s = done; s < 4; s++) {
      p = steps[s](p);
      if (p < ranges[i][0] || p > ranges[i][1]) return null;
    }
  }
  const step = done + 1;
  const tooltip = `${TOOLTIP} (${step} of 4)`;
  if (done === 2)
    return {
      step,
      label: `Upside down (loop ${step}/4)`,
      tooltip,
      moment: { type: 'spread', factor: -1, around: a, snap: 'chromatic', glide: CROSS_GLIDE },
    };
  const by = done === 3 ? THIRD : -THIRD;
  return {
    step,
    label: `${done === 3 ? 'Up' : 'Down'} a third (loop ${step}/4)`,
    tooltip,
    moment: { type: 'shift', by, unit: 'semitones', glide: PLANE_GLIDE },
  };
}
