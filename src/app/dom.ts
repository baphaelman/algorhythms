/**
 * Elements the animation loop writes to directly (PLAN.md §11.3a): the time readout, scrubber,
 * key/voice status and level meter. React components register them with `ref` callbacks; the loop
 * and the engine's meter callback write `textContent`, `value` and `style` without re-rendering.
 */

export interface LiveElements {
  time: HTMLElement | null;
  duration: HTMLElement | null;
  scrub: HTMLInputElement | null;
  status: HTMLElement | null;
  meter: HTMLElement | null;
  /** The editor's DOM playhead (`ui/Playhead.tsx`); while set, the canvas draws none. */
  playhead: HTMLElement | null;
}

/** The registry. Components assign into it from ref callbacks. */
export const live: LiveElements = {
  time: null,
  duration: null,
  scrub: null,
  status: null,
  meter: null,
  playhead: null,
};

/** Writes text only when it changed (avoids layout work on identical frames). */
export function writeText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Level 0..1 for a linear peak: -60 dBFS maps to 0, 0 dBFS to 1. */
export function meterLevel(peak: number): number {
  if (!(peak > 1e-3)) return 0;
  return Math.min(1, Math.max(0, 1 + (20 * Math.log10(peak)) / 60));
}

/** Sets the meter bar (direct style write). */
export function writeMeter(peak: number): void {
  const el = live.meter;
  if (el) el.style.transform = `scaleX(${meterLevel(peak).toFixed(3)})`;
}
