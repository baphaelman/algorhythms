/**
 * A small window hook for end-to-end tests (tests/e2e). It exposes the worklet URL exactly as the
 * app resolves it, plus the live analyser while the test tone plays. Placeholder-page only; M3
 * replaces it with whatever the player's tests need.
 */

export interface AlgoRhythmsDebug {
  /** URL passed to audioWorklet.addModule for the test tone. */
  workletUrl: string;
  /** Name of the registered test-tone processor. */
  processorName: string;
  /** The live context while playing. */
  context?: AudioContext;
  /** Analyser tapping the test tone while playing. */
  analyser?: AnalyserNode;
}

declare global {
  interface Window {
    __algorhythms?: AlgoRhythmsDebug;
  }
}

/** Merges fields into the debug hook. */
export function setDebug(patch: Partial<AlgoRhythmsDebug>): void {
  window.__algorhythms = { workletUrl: '', processorName: '', ...window.__algorhythms, ...patch };
}
