/**
 * The video workspace's timeline (PLAN.md §15 M15 "Panels"): one time axis under the preview
 * holding the section's in and out handles, the camera keys, and the opening and ending cards.
 * The axis is the whole piece on the score's clock, widened to take the opening before 0 and the
 * ending after the piece's end. Pure (no DOM).
 */

import type { TimeSpan } from '../render/section';

/** The timeline's span on the score's clock (s). */
export interface TimelineAxis {
  from: number;
  to: number;
}

/** The video's clock as `clockNow` gives it: its range, and the section it plays. */
export interface VideoClock {
  from: number;
  to: number;
  span: TimeSpan;
}

/** The whole piece, widened to the video's clock (the lead-in before, the end card after). */
export function timelineAxis(
  duration: number,
  clock?: Pick<VideoClock, 'from' | 'to'>,
): TimelineAxis {
  const D = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const from = Math.min(0, clock?.from ?? 0);
  const to = Math.max(D, clock?.to ?? D, from + 0.1);
  return { from, to };
}

/** Where score time t sits on the axis, 0..1 (clamped). */
export function axisFraction(axis: TimelineAxis, t: number): number {
  const w = axis.to - axis.from;
  if (!(w > 0) || !Number.isFinite(t)) return 0;
  return Math.min(1, Math.max(0, (t - axis.from) / w));
}

/** The score time at fraction x of the axis (clamped to it). */
export function axisTime(axis: TimelineAxis, x: number): number {
  const f = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
  return axis.from + f * (axis.to - axis.from);
}

/** A CSS percentage for t on the axis, "12.500%". */
export const axisPct = (axis: TimelineAxis, t: number): string =>
  `${(axisFraction(axis, t) * 100).toFixed(3)}%`;

/** A card on the timeline: what it is and its stretch on the score's clock. */
export interface TimelineCard {
  id: 'opening' | 'ending';
  label: string;
  start: number;
  end: number;
}

/** Shorter stretches than this (s) are no card. */
const CARD_MIN = 0.05;

/**
 * The opening card (the lead-in and title before the section) and the ending card (the end card
 * and ring-out after it), as the clock holds them; none when the video has no such stretch.
 */
export function timelineCards(clock: VideoClock): TimelineCard[] {
  const out: TimelineCard[] = [];
  if (clock.span.start - clock.from > CARD_MIN) {
    out.push({ id: 'opening', label: 'Opening', start: clock.from, end: clock.span.start });
  }
  if (clock.to - clock.span.end > CARD_MIN) {
    out.push({ id: 'ending', label: 'Ending', start: clock.span.end, end: clock.to });
  }
  return out;
}

/** Which handle a press at score time t grabs: the nearer one ('start' on a tie). */
export function nearerHandle(span: TimeSpan, t: number): 'start' | 'end' {
  return Math.abs(t - span.end) < Math.abs(t - span.start) ? 'end' : 'start';
}

/** The frame's box (CSS px): as large as fits `avail`, at the video's aspect; at least 1 px. */
export function previewFit(
  avail: { w: number; h: number },
  aspect: number,
): { w: number; h: number } {
  const w = Math.max(1, Math.floor(Math.min(avail.w, avail.h * aspect)));
  return { w, h: Math.max(1, Math.round(w / aspect)) };
}
