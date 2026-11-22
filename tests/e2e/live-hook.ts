import type { Page } from '@playwright/test';

/** The live slice of `window.__algorhythms` (src/app/debug.ts) the M7-b specs use. */
export interface LiveHook {
  store: {
    getState(): {
      piece: { moments: { id: string; type: string }[]; mix: { normalise?: string } };
      transport: { status: string; audio: string };
    };
  };
  engine(): unknown;
  editor: {
    state: { getState(): { selection: string[]; canUndo: boolean; undoLabel: string } };
    select(ids: string[]): void;
  };
  frameStats: { liveSamples: number; drawn: number };
  live: {
    engine(): {
      active: boolean;
      held: number[];
      events: { kind: string; pitch: number; velocity: number }[];
      settings: Record<string, unknown>;
      bendSemitones: number;
    };
    ui: {
      getState(): {
        open: boolean;
        running: boolean;
        typing: boolean;
        octave: number;
        panel: Record<string, unknown>;
        midi: { status: string; devices: { id: string; name: string }[]; selected: string };
      };
    };
    inputs: { held: number[] };
    midi: {
      connect(access?: () => Promise<unknown>): Promise<void>;
      disconnect(): void;
    };
  };
}

/** `window` with the hook, for casts inside `page.evaluate`. */
export type LiveWindow = { __algorhythms: LiveHook };

/** Opens the app on Tidewater Hymn in the editor layout. */
export async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await page.waitForFunction(() => '__algorhythms' in window);
  await page.getByTestId('play').waitFor();
}
