/**
 * Score selection and grouped note changes (PLAN.md §11.3 revision 7; M4.5-23): a background drag
 * draws a rectangle that selects dots, dragging one selected dot moves them all (one undo entry),
 * Shift-click adds and removes dots, a click on a line selects its moment, a click on empty
 * background seeks without playing; two note adds at one time are one "Shift" moment, and dragging
 * one of its dots sideways splits it again. Chromium only.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  from?: number;
  to?: number;
  changes?: { from: number; to: number }[];
  overrides?: { voice: number; pitch?: number; end?: number }[];
}

interface EditorHook {
  editor: {
    undo(): boolean;
    select(ids: string[]): void;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
  store: {
    getState(): { piece: { moments: M[] }; transport: { status: string } };
  };
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).store.getState().piece.moments,
  );
const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().undoLabel,
  );
const selection = (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().selection,
  );
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as EditorHook).editor.select(i), ids);
const undo = (page: Page) =>
  page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());
const status = (page: Page) =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).store.getState().transport.status,
  );
const byId = async (page: Page, id: string): Promise<M> =>
  (await moments(page)).find((m) => m.id === id)!;
const notes = async (page: Page): Promise<M[]> =>
  (await moments(page)).filter((m) => m.type === 'note');

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Four voices (C3 G3 C4 E4) in C major; a shift +2 semitones at 2 (arrives at 4). */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      start: { voice: string; pitch: number }[];
      moments: unknown[];
      key: unknown;
      end: unknown;
      defaults: { glide: Record<string, unknown> };
    };
    p.start = [48, 55, 60, 64].map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
    p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0 };
    p.moments = [{ id: 'shift1', type: 'shift', at: 2, by: 2, unit: 'semitones' }];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 20, fade: 1 };
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
}

async function center(dot: Locator): Promise<{ x: number; y: number }> {
  const b = (await dot.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Screen px per second of the score. */
async function pps(page: Page): Promise<number> {
  await frames(page);
  const w = await page.evaluate(() => window.__algorhythms!.frameStats.window);
  const box = (await page.locator('#score').boundingBox())!;
  return box.width / w;
}

/** The shift's dots (low to high), shown by selecting it, and their centres. */
async function shiftDots(page: Page): Promise<{ x: number; y: number }[]> {
  await select(page, ['shift1']);
  const dots = page.getByTestId('arrival-dot');
  await expect(dots).toHaveCount(4);
  await frames(page);
  const out = [];
  for (let i = 0; i < 4; i++) out.push(await center(dots.nth(i)));
  return out.sort((a, b) => b.y - a.y);
}

async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/** A double-click at p, then a vertical drag by dy (adds a note point). */
async function doubleDrag(page: Page, p: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(p.x, p.y + dy / 2, { steps: 4 });
  await page.mouse.move(p.x, p.y + dy, { steps: 4 });
  await page.mouse.up({ clickCount: 2 });
}

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('a background rectangle selects two dots; dragging one moves both as one undo', async ({
  page,
}) => {
  const [d0, d1, d2] = await shiftDots(page);
  // From below-left of the lowest dot to between the second and third.
  await drag(page, { x: d0.x - 20, y: d0.y + 12 }, { x: d0.x + 20, y: (d1.y + d2.y) / 2 });
  const picked = page.locator('[data-testid=arrival-dot][data-picked=true]');
  await expect(picked).toHaveCount(2);
  await expect(page.getByTestId('marquee')).toBeHidden();
  // Up by about two semitones.
  const g = await center(picked.first());
  await drag(page, g, { x: g.x, y: g.y - (d0.y - d1.y) / 3 });
  await expect.poll(async () => (await byId(page, 'shift1')).overrides?.length).toBe(2);
  const shift = await byId(page, 'shift1');
  expect(shift.overrides!.every((o) => o.pitch !== undefined)).toBe(true);
  await expect.poll(() => undoLabel(page)).toBe('Move notes');
  // Both stay selected where they landed.
  await expect(picked).toHaveCount(2);
  await undo(page);
  expect((await byId(page, 'shift1')).overrides).toBeUndefined();
});

test('Shift-click adds and removes dots; Escape clears them', async ({ page }) => {
  const [d0, d1] = await shiftDots(page);
  const picked = page.locator('[data-testid=arrival-dot][data-picked=true]');
  await page.mouse.click(d0.x, d0.y);
  await expect(picked).toHaveCount(1);
  await page.keyboard.down('Shift');
  await page.mouse.click(d1.x, d1.y);
  await expect(picked).toHaveCount(2);
  await page.mouse.click(d0.x, d0.y);
  await page.keyboard.up('Shift');
  await expect(picked).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(picked).toHaveCount(0);
});

test('a click on a line selects its moment; on empty background it seeks and does not play', async ({
  page,
}) => {
  const [d0] = await shiftDots(page);
  await select(page, []);
  const k = await pps(page);
  // The lowest line holds C♯3+1 after the shift (its section belongs to the shift).
  await page.mouse.click(d0.x + 4 * k, d0.y);
  await expect.poll(() => selection(page)).toEqual(['shift1']);
  expect(await status(page)).not.toBe('playing');

  const box = (await page.locator('#score').boundingBox())!;
  const start = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  const x = box.x + 10 * k - start * k;
  await page.mouse.click(x, box.y + 4);
  await expect(page.getByTestId('time')).toHaveText('00:10.0');
  await frames(page);
  expect(await status(page)).not.toBe('playing');
  expect(await selection(page)).toEqual(['shift1']);
});

test('two note adds at one time are one Shift moment; dragging one apart splits it', async ({
  page,
}) => {
  const [d0, d1] = await shiftDots(page);
  await select(page, []);
  const k = await pps(page);
  const x = d0.x + 5 * k;
  await doubleDrag(page, { x, y: d0.y }, -30);
  await expect.poll(async () => (await notes(page)).length).toBe(1);
  await doubleDrag(page, { x, y: d1.y }, -30);
  await expect.poll(async () => (await notes(page))[0]?.changes?.length).toBe(2);
  const [shift] = await notes(page);
  expect(await notes(page)).toHaveLength(1);
  expect(shift.changes!.every((c) => c.to > c.from)).toBe(true);
  expect(await undoLabel(page)).toBe('Add note');
  await expect(page.locator(`.lane-item[data-moment="${shift.id}"] .lane-label`)).toHaveText(
    'Shift',
  );
  // One row per change in the inspector.
  await expect(page.getByTestId('insp-note-move')).toHaveCount(2);

  // Drag the upper change's dot sideways (Alt: free) by 2 s: it becomes its own moment.
  const dots = page.getByTestId('note-dot');
  await expect(dots).toHaveCount(2);
  await frames(page);
  const ds = [await center(dots.nth(0)), await center(dots.nth(1))].sort((a, b) => a.y - b.y);
  await page.keyboard.down('Alt');
  await drag(page, ds[0], { x: ds[0].x + 2 * k, y: ds[0].y });
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await notes(page)).length).toBe(2);
  const after = await notes(page);
  expect(after.every((m) => m.changes === undefined && m.from !== undefined)).toBe(true);
  expect(Math.abs(after[1].at - after[0].at - 2)).toBeLessThan(0.05);
  await undo(page);
  expect(await notes(page)).toHaveLength(1);
});

test('a plain background drag does not pan; Space-drag pans and does not play', async ({
  page,
}) => {
  await page.getByTestId('window-slider').fill('300');
  await seek(page, 10);
  await frames(page);
  const start = () => page.evaluate(() => window.__algorhythms!.frameStats.start);
  const box = (await page.locator('#score').boundingBox())!;
  const y = box.y + 4;
  const s0 = await start();
  await drag(page, { x: box.x + 300, y }, { x: box.x + 500, y });
  await frames(page);
  expect(await start()).toBe(s0);
  await page.mouse.move(box.x + 300, y);
  await page.keyboard.down(' ');
  await drag(page, { x: box.x + 300, y }, { x: box.x + 500, y });
  await page.keyboard.up(' ');
  await frames(page);
  expect(await start()).toBeLessThan(s0 - 0.5);
  expect(await status(page)).not.toBe('playing');
  // Space alone still plays.
  await page.keyboard.press(' ');
  await expect.poll(() => status(page)).toBe('playing');
});
