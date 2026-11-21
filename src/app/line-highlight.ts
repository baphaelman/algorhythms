/**
 * A line the editor points at from outside the score (owner, 2026-11-21: hovering a tune's
 * "Melody on" option highlights that line). While set, the score loop (./loop.ts) highlights that
 * whole line instead of the selection's segments.
 */

export const lineHighlight = {
  /** Pool index of the line, or -1 for none. */
  voice: -1,
};

/** Highlights line `voice` (undefined or < 0: none). */
export function setLineHighlight(voice: number | undefined): void {
  lineHighlight.voice = voice !== undefined && voice >= 0 ? voice : -1;
}
