/**
 * The slice of `window.__algorhythms` (src/app/debug.ts) that the app e2e specs use. Importing this
 * file declares the global for TypeScript; it has no runtime effect.
 */

export interface Hook {
  store: {
    getState(): {
      piece: { meta: { title: string }; voices: unknown[] };
      compiled: { duration: number };
      view: { window: number; colors: string; theme: string; pan: number; hud: boolean };
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
    overview: number;
    reset(): void;
  };
  actions: {
    loadPiece(piece: unknown): void;
    setPiece(piece: unknown): void;
    recompileNow(): unknown;
  };
  encodeShareLink(piece: unknown, base?: string): Promise<string>;
}

declare global {
  interface Window {
    __algorhythms?: Hook;
  }
}
