/**
 * Export sections (PLAN.md §12 "Exports you can shape", revision 15): a span of the piece that a
 * video or poster shows instead of the whole. Pure; the app resolves the dialog's choice (whole,
 * loop region, custom) to a span and the renderers take it.
 */

import type { Seconds } from '../core/types';
import { DEFAULT_METER } from './bars';

/** A span of the piece, [start, end] seconds. */
export interface TimeSpan {
  start: Seconds;
  end: Seconds;
}

/** Shortest section, seconds (the camera's shortest window). */
export const MIN_SECTION: Seconds = 2;

/** The bar grid of a piece (`view.gridBpm`, `view.meter`). */
export interface BarGridSpec {
  bpm: number;
  meter?: number;
}

/** One bar's length (s) of a grid; 0 without a usable tempo. */
export function barSeconds(grid?: BarGridSpec): Seconds {
  if (!grid || !Number.isFinite(grid.bpm) || !(grid.bpm > 0)) return 0;
  const meter =
    grid.meter !== undefined && Number.isInteger(grid.meter) && grid.meter >= 1
      ? grid.meter
      : DEFAULT_METER;
  return (60 / grid.bpm) * meter;
}

/** The bar line nearest t (t itself without a grid). */
export function snapToBar(t: Seconds, grid?: BarGridSpec): Seconds {
  const bar = barSeconds(grid);
  return bar > 0 ? Math.round(t / bar) * bar : t;
}

/**
 * The bar line after (dir 1) or before (dir −1) t, strictly (a keyboard step); without a grid,
 * t ± `free` seconds.
 */
export function stepBar(t: Seconds, dir: 1 | -1, grid?: BarGridSpec, free = 1): Seconds {
  const bar = barSeconds(grid);
  if (!(bar > 0)) return t + dir * free;
  const k = t / bar;
  const eps = 1e-6;
  return (dir > 0 ? Math.floor(k + eps) + 1 : Math.ceil(k - eps) - 1) * bar;
}

/**
 * A span inside [0, duration], start before end by at least MIN_SECTION (less only when the
 * piece is shorter); `keep` names the end that stays when the other has to give way.
 */
export function clampSpan(
  span: TimeSpan,
  duration: Seconds,
  keep: 'start' | 'end' = 'start',
): TimeSpan {
  const D = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const min = Math.min(MIN_SECTION, D);
  const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  let a = Math.min(Math.max(0, fin(span.start, 0)), D);
  let b = Math.min(Math.max(0, fin(span.end, D)), D);
  if (keep === 'start') {
    a = Math.min(a, D - min);
    b = Math.max(b, a + min);
  } else {
    b = Math.max(b, min);
    a = Math.min(a, b - min);
  }
  return { start: a, end: b };
}

/** The span is the whole piece (to within a millisecond). */
export function isWholeSpan(span: TimeSpan | undefined, duration: Seconds): boolean {
  return !span || (span.start <= 1e-3 && span.end >= duration - 1e-3);
}

/** `m:ss`, rounded to the second. */
export function clockText(seconds: Seconds): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "0:45–1:30 of 2:28": where a section sits in the piece (the poster's title block). */
export function sectionText(span: TimeSpan, duration: Seconds): string {
  return `${clockText(span.start)}–${clockText(span.end)} of ${clockText(duration)}`;
}
