/**
 * The pace of Compose for me (PLAN.md §11.3 "Compose in New piece", M4.5-28), as pure functions.
 *
 * The composer's pen sweeps the piece once, left to right: a structural step places its moment at
 * the pen, then the pen draws its lines in up to the next moment's time. The pen moves at
 * `PEN_SPEED` seconds of music per second (a 2:30 piece draws in 20 s), faster for long pieces so
 * the pen never takes more than `MAX_PEN_SECONDS`. Steps shown longer than the pen needs (the
 * minimums) add at most `MAX_EXTRA` of the sweep, so a busy piece (Speed Fast) draws its many
 * steps a little quicker. Then the detail sweep (M4.5-38): each detail
 * step is shown for `DETAIL_MS`, the whole sweep for at most `MAX_DETAIL_MS`, its pen at the
 * detail's time.
 */

import type { Composition } from '../core/generate';
import type { Moment, Seconds } from '../core/types';

/** Seconds of music the pen draws per second. */
export const PEN_SPEED = 7.5;
/** The pen's longest sweep, seconds (long pieces draw faster). */
export const MAX_PEN_SECONDS = 40;
/** Shortest time an add step is shown, ms. */
export const MIN_ADD_MS = 150;
/** Time an add step is shown when the next one is at the same time (a chord and its level), ms. */
export const TIE_MS = 50;
/** The most the minimums may add to the pen's sweep, as a share of it. */
export const MAX_EXTRA = 0.4;
/** Time a detail step is shown, ms. */
export const DETAIL_MS = 700;
/** Longest the detail sweep is shown, ms (its steps share it). */
export const MAX_DETAIL_MS = 3000;

/** One step on the build's clock. */
export interface Beat {
  /** Start, ms after the build began. */
  start: number;
  /** How long it is shown, ms. */
  dur: number;
  /** The pen (seconds of music) at the step's start and end. */
  penFrom: Seconds;
  penTo: Seconds;
  /** A step of the detail sweep. */
  detail: boolean;
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
export function composeTimeline(c: Composition<string>): Timeline {
  const { steps } = c;
  const structure = steps.filter((s) => s.phase === 'structure');
  const details = steps.length - structure.length;
  const last = structure.at(-1);
  const sweep = last ? reach(last.moment) : 0;
  const speed = Math.max(PEN_SPEED, sweep / MAX_PEN_SECONDS);
  const spans = structure.map((s, i) => {
    const from = s.moment.at;
    const after = structure[i + 1];
    const to = after ? Math.max(from, after.moment.at) : Math.max(from, reach(s.moment));
    return { from, to, tie: after !== undefined && to - from < 1e-3 };
  });
  const showFor = (x: (typeof spans)[number], f: number): number =>
    x.tie ? f * TIE_MS : Math.max(f * MIN_ADD_MS, ((x.to - x.from) / speed) * 1000);
  // Scaling the minimums by f scales their extra by at most f.
  let pen = 0;
  let extra = 0;
  for (const x of spans) {
    const share = ((x.to - x.from) / speed) * 1000;
    pen += share;
    extra += showFor(x, 1) - share;
  }
  const f = extra > MAX_EXTRA * pen ? (MAX_EXTRA * pen) / extra : 1;

  const beats: Beat[] = [];
  let clock = 0;
  let next = 0;
  for (const s of steps) {
    let dur: number;
    let from: Seconds;
    let to: Seconds;
    if (s.phase === 'structure') {
      const x = spans[next++];
      from = x.from;
      to = x.to;
      dur = showFor(x, f);
    } else {
      from = to = s.moment.at;
      dur = Math.min(DETAIL_MS, MAX_DETAIL_MS / details);
    }
    beats.push({ start: clock, dur, penFrom: from, penTo: to, detail: s.phase === 'detail' });
    clock += dur;
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
