/**
 * Snapping and bars (PLAN.md §11.3 revision 7; M4.5-22): a dot dragged sideways near another
 * line's change snaps to it, zoomed in it doesn't; a walk step stays in sync with its walk's other
 * lines; dragging a dot below the view keeps tracking (no jump, no octave fold); bar lines show in
 * the ruler and the score. Chromium only.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  overrides?: { voice: number; pitch?: number; end?: number }[];
  fixed?: { tick: number; voice: string; pitch: number }[];
}

interface Hook {
  editor: { select(ids: string[]): void };
  store: { getState(): { piece: { moments: M[]; voices: { range: [number, number] }[] } } };
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments);
const byId = async (page: Page, id: string): Promise<M> =>
  (await moments(page)).find((m) => m.id === id)!;
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids);
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Four voices in C major: a split at 2 (lands at 4), a shift at 5, a walk 9..13. */
async function open(page: Page, view?: number): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((win) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      moments: unknown[];
      key: unknown;
      end: unknown;
      defaults: { glide: Record<string, unknown> };
      view: Record<string, unknown>;
    };
    // The start is a moment (schema v2): an opening chord at 0.
    const opening = {
      id: 'start0',
      type: 'chord',
      at: 0,
      notes: { kind: 'pitches', pitches: [48, 55, 60, 64] },
      voicing: 'even',
      assign: 'ordered',
    };
    p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0 };
    p.moments = [
      { id: 'split1', type: 'split', at: 2, count: 6, voicing: 'even' },
      { id: 'shift1', type: 'shift', at: 5, by: 2, unit: 'semitones' },
      {
        id: 'walk1',
        type: 'walk',
        at: 9,
        until: 13,
        grid: 1,
        density: 1,
        steps: [-1, 1],
        stepGlide: 0.25,
      },
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 16, fade: 1 };
    delete p.view.gridBpm;
    if (win) p.view.window = win;
    p.moments.unshift(opening);
    h.actions.loadPiece(p);
  }, view);
  await seek(page, 0);
  if (!view) await page.getByTestId('zoom-fit').click();
  await frames(page);
}

async function center(dot: Locator): Promise<{ x: number; y: number }> {
  const b = (await dot.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Score px per second and the canvas box. */
async function axis(page: Page): Promise<{ pps: number; left: number; start: number }> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  const box = (await page.locator('#score').boundingBox())!;
  return { pps: box.width / s.window, left: box.x, start: s.start };
}

/** Drags the last split dot sideways so its arrival lands at `t` s; returns the written `end`. */
async function dragSplitTo(page: Page, t: number): Promise<number | undefined> {
  await select(page, ['split1']);
  const dot = page.getByTestId('arrival-dot').last();
  await expect(dot).toBeVisible();
  const from = await center(dot);
  const a = await axis(page);
  const x = a.left + (t - a.start) * a.pps;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + x) / 2, from.y, { steps: 6 });
  await page.mouse.move(x, from.y, { steps: 6 });
  await page.mouse.up();
  return (await byId(page, 'split1')).overrides?.find((o) => o.end !== undefined)?.end;
}

test('a dot dragged near another line’s change snaps to it', async ({ page }) => {
  await open(page);
  // 5.1 s is a few px from the shift's start at 5 at this zoom.
  const { pps } = await axis(page);
  expect(0.1 * pps).toBeLessThan(8);
  expect(await dragSplitTo(page, 5.1)).toBe(3); // arrival 5 = at 2 + 3
});

test('zoomed in far enough, the same drop stays free', async ({ page }) => {
  await open(page, 6);
  const { pps } = await axis(page);
  expect(0.1 * pps).toBeGreaterThan(12);
  const end = await dragSplitTo(page, 5.1);
  expect(end).toBeDefined();
  expect(Math.abs(end! - 3.1)).toBeLessThan(0.02);
});

test('a walk step dragged slightly stays on its walk’s step times', async ({ page }) => {
  await open(page);
  await select(page, ['walk1']);
  const dot = page.getByTestId('walk-dot').nth(4);
  await expect(dot).toBeVisible();
  const from = await center(dot);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Up a step (forces a write) and a few px sideways.
  await page.mouse.move(from.x + 5, from.y - 8, { steps: 4 });
  await page.mouse.move(from.x + 6, from.y - 12, { steps: 2 });
  await page.mouse.up();
  const w = await byId(page, 'walk1');
  expect(w.fixed?.length).toBeGreaterThan(0);
  expect(w.fixed!.every((f) => Number.isInteger(f.tick))).toBe(true);
});

test('dragging a dot below the view keeps tracking: no jump, no octave fold', async ({ page }) => {
  await open(page);
  await select(page, ['split1']);
  const dot = page.getByTestId('arrival-dot').first();
  await expect(dot).toBeVisible();
  const pitch = Number(await dot.getAttribute('data-pitch'));
  const from = await center(dot);
  const box = (await page.locator('#score').boundingBox())!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const ys: number[] = [];
  for (const y of [from.y + 20, box.y + box.height - 5, box.y + box.height + 60, 840]) {
    await page.mouse.move(from.x, y, { steps: 5 });
    await frames(page);
    ys.push((await center(page.getByTestId('drag-dot'))).y);
  }
  // The ghost moves down and then stays at the edge, never back up, never past the canvas.
  for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1);
  expect(ys[ys.length - 1]).toBeLessThanOrEqual(box.y + box.height);
  expect(Math.abs(ys[3] - ys[2])).toBeLessThanOrEqual(1);
  await page.mouse.up();
  const o = (await byId(page, 'split1')).overrides?.[0];
  expect(o?.pitch).toBeDefined();
  expect(o!.pitch!).toBeLessThan(pitch);
  const range = await page.evaluate(
    (v) => (window.__algorhythms as unknown as Hook).store.getState().piece.voices[v].range,
    o!.voice,
  );
  expect(o!.pitch!).toBeGreaterThanOrEqual(range[0]);
  // The dot lands where it was dropped (no octave fold).
  await expect(
    page.locator(`[data-testid=arrival-dot][data-pitch="${o!.pitch}"]`).first(),
  ).toBeVisible();
});

test('bar lines show in the ruler and the score; tempo and meter change them', async ({ page }) => {
  await open(page);
  await select(page, []);
  const bars = page.getByTestId('ruler-bars');
  await expect(bars).toBeVisible();
  await expect(bars).toHaveAttribute('data-step', '4'); // 60 bpm, 4 beats per bar
  await expect(page.getByTestId('ruler-beats')).toHaveAttribute('data-step', '1');

  // In the score: a bar line at 8 s, above the lines, differs from the paper beside it.
  const px = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#score')!;
    const g = c.getContext('2d')!;
    const s = window.__algorhythms!.frameStats;
    const dpr = c.width / c.getBoundingClientRect().width;
    const w = c.getBoundingClientRect().width;
    const h = c.getBoundingClientRect().height;
    const padT = Math.max(28, h * 0.08);
    const y = Math.round((padT - 3) * dpr);
    const xAt = (t: number) => Math.floor((Math.round(((t - s.start) / s.window) * w) + 0.5) * dpr);
    const at = (x: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { bar: at(xAt(8)), gap: at(xAt(8.5)) };
  });
  expect(px.bar).not.toEqual(px.gap);

  const bpm = page.getByTestId('insp-bpm');
  await bpm.fill('120');
  await bpm.press('Enter');
  const meter = page.getByTestId('insp-meter');
  await meter.fill('3');
  await meter.press('Enter');
  await expect(bars).toHaveAttribute('data-step', '1.5');
  await expect(page.getByTestId('ruler-beats')).toHaveAttribute('data-step', '0.5');
});
