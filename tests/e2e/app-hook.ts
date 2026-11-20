import type { Page } from '@playwright/test';

/**
 * The slice of `window.__algorhythms` (src/app/debug.ts) that the app e2e specs use. Importing this
 * file declares the global for TypeScript; `seek` is a helper.
 */

export interface Hook {
  store: {
    getState(): {
      piece: { meta: { title: string }; voices: unknown[]; moments: { id: string; at: number }[] };
      compiled: { duration: number };
      view: { window: number; colors: string; theme: string; follow: string; hud: boolean };
      transport: { status: string; scrubbing: boolean; audio: string };
      notices: { kind: string; title: string; lines: string[] }[];
    };
  };
  engine(): { currentTime(): number; isPlaying: boolean } | null;
  analyser(): AnalyserNode | null;
  frameStats: {
    enabled: boolean;
    work: number[];
    interval: number[];
    drawn: number;
    start: number;
    window: number;
    head: number;
    ghost: number;
    reset(): void;
  };
  actions: {
    loadPiece(piece: unknown): void;
    setPiece(piece: unknown): void;
    recompileNow(): unknown;
    select(ids: string[]): void;
    seek(t: number): void;
  };
  encodeShareLink(piece: unknown, base?: string): Promise<string>;
}

/** Moves the playhead to `t` s (the editor layout has no scrubber; the ruler seeks by pointer). */
export async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate((to) => window.__algorhythms!.actions.seek(to), t);
}

declare global {
  interface Window {
    __algorhythms?: Hook;
  }
}
