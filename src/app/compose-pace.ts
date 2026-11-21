/**
 * The pace of Compose for me (PLAN.md §11.3 "Compose in New piece", M4.5-28), as pure functions.
 *
 * The composer's pen sweeps the piece left to right: an add step places its moment at the pen,
 * then the pen draws its lines in up to the next moment's time. The pen moves at `PEN_SPEED`
 * seconds of music per second (a 2:30 piece draws in 20 s), faster for long pieces so the pen never
 * takes more than `MAX_PEN_SECONDS`. An edit step (an adjustment pass) holds the pen for `EDIT_MS`,
 * a whole pass for at most `MAX_PASS_MS`.
 */

import type { ComposePass, ComposeStep, Composition } from '../core/generate';
import type { Moment, Seconds } from '../core/types';

/** Seconds of music the pen draws per second. */
export const PEN_SPEED = 7.5;
/** The pen's longest sweep, seconds (long pieces draw faster). */
export const MAX_PEN_SECONDS = 40;
/** Shortest time an add step is shown, ms. */
export const MIN_ADD_MS = 250;
/** Time an edit step is shown, ms. */
export const EDIT_MS = 450;
/** Longest an adjustment pass is shown, ms (its edits share it). */
export const MAX_PASS_MS = 3000;

/** One step on the build's clock. */
export interface Beat {
  /** Start, ms after the build began. */
  start: number;
  /** How long it is shown, ms. */
  dur: number;
  /** The pen (seconds of music) at the step's start and end. */
  penFrom: Seconds;
  penTo: Seconds;
}

/** The build's clock: one beat per step, and the total, ms. */
export interface Timeline {
  beats: Beat[];
  total: number;
}

/** Where a moment's lines stop changing: its glide's length and stagger, plus a tail. */
function reach(m: Moment): Seconds {
  const g = m.glide ?? {};
  return m.at + (g.length ?? 2) + (g.stagger ?? 0) + 4;
}

/** The timeline for `c`'s steps. */
export function composeTimeline(c: Composition): Timeline {
  const { steps } = c;
  const adds = steps.filter((s): s is Extract<ComposeStep, { kind: 'add' }> => s.kind === 'add');
  const passSize = new Map<ComposePass, number>();
  for (const s of steps)
    if (s.kind === 'edit') passSize.set(s.pass, (passSize.get(s.pass) ?? 0) + 1);
  const last = adds.at(-1);
  const sweep = last ? reach(last.moment) : 0;
  const speed = Math.max(PEN_SPEED, sweep / MAX_PEN_SECONDS);

  const beats: Beat[] = [];
  let clock = 0;
  let pen = 0;
  let nextAdd = 0;
  for (const s of steps) {
    let dur: number;
    let to = pen;
    if (s.kind === 'add') {
      nextAdd++;
      pen = s.moment.at;
      const next = adds[nextAdd];
      to = next ? Math.max(pen, next.moment.at) : Math.max(pen, reach(s.moment));
      dur = Math.max(MIN_ADD_MS, ((to - pen) / speed) * 1000);
    } else {
      dur = Math.min(EDIT_MS, MAX_PASS_MS / (passSize.get(s.pass) ?? 1));
    }
    beats.push({ start: clock, dur, penFrom: pen, penTo: to });
    clock += dur;
    pen = to;
  }
  return { beats, total: clock };
}

/** How many steps are applied `ms` into the build (a step applies when its beat starts). */
export function stepsAt(tl: Timeline, ms: number): number {
  if (ms >= tl.total) return tl.beats.length;
  let lo = 0;
  let hi = tl.beats.length;
  // The number of beats with start <= ms.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.beats[mid].start <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The pen `ms` into the build (Infinity once it is done: every line drawn). */
export function penAt(tl: Timeline, ms: number): Seconds {
  if (ms >= tl.total) return Infinity;
  const k = stepsAt(tl, ms);
  if (k === 0) return 0;
  const b = tl.beats[k - 1];
  const f = b.dur > 0 ? Math.min(1, (ms - b.start) / b.dur) : 1;
  return b.penFrom + (b.penTo - b.penFrom) * f;
}
