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

/** Tick times (multiples of `step`) within [start, start + window]. */
export function tickTimes(start: Seconds, window: Seconds, step: Seconds): Seconds[] {
  const out: Seconds[] = [];
  const k0 = Math.ceil(start / step - 1e-9);
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

/** Beat spacing for a BPM grid, or null when there is no grid or beats would be under `minPx`. */
export function beatPx(bpm: number | undefined, pps: number, minPx = 4): number | null {
  if (!bpm || !(bpm > 0)) return null;
  const px = (60 / bpm) * pps;
  return px >= minPx ? px : null;
}
