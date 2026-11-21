/**
 * Screen-reader announcements for edits made outside the lane (§11.5 "An ARIA live region
 * announces moment moves and edits"): copy, cut, paste, select all, the piano ruler. Writes the
 * lane's polite live region.
 */

let flip = false;

/** Announces `text` (a repeated message is still announced). */
export function announce(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-testid="lane-live"]');
  if (!el) return;
  flip = !flip;
  el.textContent = flip ? text : `${text}\u00a0`;
}

/** "1 moment" / "3 moments". */
export function momentsText(n: number): string {
  return `${n} ${n === 1 ? 'moment' : 'moments'}`;
}
