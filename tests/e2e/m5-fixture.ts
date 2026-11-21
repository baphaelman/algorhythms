import { expect, type Page } from '@playwright/test';
import './app-hook';

/**
 * Shared setup for the M5 specs (multi-select, copy-paste, piano-ruler, freeze): Tidewater Hymn's
 * voices with three moments (a chord at 2, a unison at 6, a walk 10–14) and a 60 BPM grid.
 */

export interface M {
  id: string;
  type: string;
  at: number;
  until?: number;
  seed?: number;
  count?: number;
  notes?: { kind: string; pitches?: number[] };
  frozenFrom?: unknown;
  fixed?: unknown[];
}

interface EditorHook {
  editor: {
    undo(): boolean;
    redo(): boolean;
    select(ids: string[]): void;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
}

export const moments = (page: Page): Promise<M[]> =>
  page.evaluate(
    () => (window.__algorhythms!.store.getState().piece as unknown as { moments: M[] }).moments,
  );
export const byId = async (page: Page, id: string): Promise<M | undefined> =>
  (await moments(page)).find((m) => m.id === id);
export const selection = (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().selection,
  );
export const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().undoLabel,
  );
export const undo = (page: Page) =>
  page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());
export const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as EditorHook).editor.select(i), ids);

export const item = (page: Page, id: string) => page.locator(`[data-moment="${id}"]`);

/** Centre of an item's marker in page pixels. */
export async function markerAt(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await item(page, id).locator('.lane-marker').boundingBox();
  if (!box) throw new Error(`no marker for ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Lane pixels per second, from the chord (2 s) and unison (6 s) markers. */
export async function lanePps(page: Page): Promise<number> {
  const a = await markerAt(page, 'aaaaaa');
  const b = await markerAt(page, 'bbbbbb');
  return (b.x - a.x) / 4;
}

/** Opens the fixture piece. `snap`: Snap to beats on. */
export async function openFixture(page: Page, snap = false): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((snapBeats) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
      moments: ({ type: string; at: number } & Record<string, unknown>)[];
    };
    // Keep the opening moments at 0 (they establish the notes).
    const opening = p.moments.filter((m) => m.at === 0 && m.type !== 'key');
    p.moments = [
      ...opening,
      {
        id: 'aaaaaa',
        type: 'chord',
        at: 2,
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'even',
        assign: 'ordered',
        glide: { length: 1, stagger: 0 },
      },
      {
        id: 'bbbbbb',
        type: 'unison',
        at: 6,
        pitch: 'center',
        octaves: false,
        glide: { length: 2, stagger: 0 },
      },
      {
        id: 'cccccc',
        type: 'walk',
        at: 10,
        until: 14,
        grid: 0.5,
        density: 0.6,
        steps: [-1, 1],
        stepGlide: 0.1,
      },
    ];
    p.end = { at: 20, fade: 1 };
    p.view = { ...p.view, gridBpm: 60, snapBeats, window: 20 };
    h.actions.loadPiece(p);
  }, snap);
  await expect(item(page, 'cccccc')).toHaveCount(1);
}

/** Two animation frames (the lane lays out per frame). */
export const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
