/**
 * Time ruler maths (PLAN.md §11.2 "Time" row): tick spacing and labels on the shared axis (§10).
 * Pure; `ui/Ruler.tsx` places the ticks.
 */

import type { Seconds } from '../core/types';

/** Candidate label spacings, seconds. */
const STEPS: readonly Seconds[] = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

/** Minimum gap between labelled ticks, px. */
export const MIN_TICK_PX = 64;

/** The smallest step whose ticks sit at least `minPx` apart at `pps` px per second. */
export function rulerStep(pps: number, minPx = MIN_TICK_PX): Seconds {
  for (const s of STEPS) if (s * pps >= minPx) return s;
  return STEPS[STEPS.length - 1]!;
}

/** Tick times (multiples of `step`) within [start, start + window], none before 0 (blank paper). */
export function tickTimes(start: Seconds, window: Seconds, step: Seconds): Seconds[] {
  const out: Seconds[] = [];
  const k0 = Math.max(0, Math.ceil(start / step - 1e-9));
  const end = start + window + 1e-9;
  for (let k = k0; k * step <= end; k++) out.push(Math.round(k * step * 1000) / 1000 + 0);
  return out;
}

/** A tick label: `m:ss`, or `m:ss.s` when the step is under a second. */
export function rulerLabel(t: Seconds, step: Seconds): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  const s = Math.floor(rest / 10);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return step < 1 ? `${base}.${rest % 10}` : base;
}

// ---------------------------------------------------------------------------------------------
// Loop region (§11.3 revision 6)
// ---------------------------------------------------------------------------------------------

/** Height of the ruler's loop band (its top strip), px. */
export const LOOP_BAND_PX = 9;
/** Shortest loop region, seconds. */
export const LOOP_MIN: Seconds = 0.25;
/** How close to a region edge a press grabs it, px. */
export const LOOP_EDGE_PX = 6;
/** Pointer travel before a band press becomes a new region, px. */
export const LOOP_DRAG_PX = 3;

/** A loop span [start, end), seconds. */
export interface LoopSpan {
  start: Seconds;
  end: Seconds;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * A loop drag time (owner, "Mouse-only gaps"): on the beat grid of `bpm` when there is one (to
 * 1 µs, so float noise never shows), else, or when `free` (Alt), rounded to the millisecond.
 * Never below 0. The loop is view state, outside undo.
 */
export function loopTime(t: Seconds, bpm: number | undefined, free: boolean): Seconds {
  const s = Math.max(0, t);
  if (free || !bpm || !(bpm > 0)) return Math.round(s * 1000) / 1000;
  const beat = 60 / bpm;
  return Math.round(Math.round(s / beat) * beat * 1e6) / 1e6;
}

/** The span between two drag times, within [0, duration]; null when shorter than `min`. */
export function loopFromDrag(
  a: Seconds,
  b: Seconds,
  duration: Seconds,
  min: Seconds = LOOP_MIN,
): LoopSpan | null {
  const start = clamp(Math.min(a, b), 0, duration);
  const end = clamp(Math.max(a, b), 0, duration);
  return end - start >= min ? { start, end } : null;
}

/** `span` with one edge moved to `t`: kept at least `min` long and within [0, duration]. */
export function dragLoopEdge(
  span: LoopSpan,
  edge: 'start' | 'end',
  t: Seconds,
  duration: Seconds,
  min: Seconds = LOOP_MIN,
): LoopSpan {
  if (edge === 'start') return { start: clamp(t, 0, Math.max(0, span.end - min)), end: span.end };
  return { start: span.start, end: clamp(t, Math.min(duration, span.start + min), duration) };
}

/** `span` clipped to [0, duration], or null when what is left is shorter than `min` (or invalid). */
export function clampLoop(
  span: LoopSpan | null | undefined,
  duration: Seconds,
  min: Seconds = LOOP_MIN,
): LoopSpan | null {
  if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end)) return null;
  const start = clamp(span.start, 0, duration);
  const end = clamp(span.end, 0, duration);
  return end - start >= min ? { start, end } : null;
}

/** The edge of `span` within `tolPx` of time `t` at `pps` px/s (the nearer one), or null. */
export function loopEdgeAt(
  span: LoopSpan | null | undefined,
  t: Seconds,
  pps: number,
  tolPx: number = LOOP_EDGE_PX,
): 'start' | 'end' | null {
  if (!span) return null;
  const ds = Math.abs(t - span.start) * pps;
  const de = Math.abs(t - span.end) * pps;
  if (ds > tolPx && de > tolPx) return null;
  return ds <= de ? 'start' : 'end';
}
