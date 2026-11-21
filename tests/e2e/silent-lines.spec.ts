/**
 * Silent lines vanish (PLAN.md §10, revision 9; R9-5): a `level` moment to 0 takes a line's
 * pixels off the score, a level ramp up draws it with rising opacity, and selecting the level
 * moment (or hovering the silent line) shows a dotted trace. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface V {
  start: number;
  pps: number;
  pLo: number;
  pHi: number;
  padT: number;
  padB: number;
  height: number;
}

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Four held voices (C3 G3 C4 E4); `moments` act on E4 (pool index 3). */
async function open(page: Page, moments: Record<string, unknown>[]): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((ms) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      start: { voice: string; pitch: number }[];
      moments: unknown[];
      key: unknown;
      end: unknown;
    };
    p.start = [48, 55, 60, 64].map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
    p.moments = ms.map((m) => ({ ...m, target: { voices: [p.voices[3].id] } }));
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 20, fade: 1 };
    h.actions.loadPiece(p);
  }, moments);
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await frames(page);
}

/**
 * Line contrast at piece time t and pitch p: the largest channel difference from the paper within
 * ±2 px of the line, over `span` px to the right (1 = one column).
 */
async function contrast(page: Page, t: number, p: number, span = 1): Promise<number> {
  await frames(page);
  return page.evaluate(
    ({ t, p, span }) => {
      const v = (window.__algorhythms!.frameStats as unknown as { view: V }).view;
      const c = document.querySelector<HTMLCanvasElement>('#score')!;
      const g = c.getContext('2d')!;
      const dpr = c.width / c.getBoundingClientRect().width;
      const x = Math.round((t - v.start) * v.pps * dpr);
      const y = Math.round(
        (v.padT + ((v.pHi - p) / (v.pHi - v.pLo)) * (v.height - v.padT - v.padB)) * dpr,
      );
      const r = Math.round(2 * dpr);
      const paper = g.getImageData(x, y + Math.round(10 * dpr), 1, 1).data;
      const d = g.getImageData(x, y - r, Math.max(1, Math.round(span * dpr)), 2 * r + 1).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4)
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(d[i + k] - paper[k]));
      return max;
    },
    { t, p, span },
  );
}

test('a level moment to 0 takes the line off the score', async ({ page }) => {
  await open(page, []);
  const before = await contrast(page, 10.5, 64);
  expect(before).toBeGreaterThan(30);
  await open(page, [{ id: 'lv', type: 'level', at: 2, gain: 0, over: 0 }]);
  expect(await contrast(page, 10.5, 64)).toBeLessThan(8);
  // The other lines are untouched; before the moment the line is still there.
  expect(await contrast(page, 10.5, 60)).toBeGreaterThan(30);
  expect(await contrast(page, 1.5, 64)).toBeGreaterThan(30);
});

test('a level ramp up from 0 draws the line with rising opacity', async ({ page }) => {
  await open(page, [
    { id: 'z', type: 'level', at: 0, gain: 0, over: 0 },
    { id: 'up', type: 'level', at: 2, gain: 1, over: 12 },
  ]);
  const c = [];
  for (const t of [1.5, 4.5, 8.5, 12.5, 16.5]) c.push(await contrast(page, t, 64));
  expect(c[0]).toBeLessThan(8);
  for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
  expect(c[4]).toBeGreaterThan(30);
});

test('selecting the level moment, or hovering the silent line, shows a dotted trace', async ({
  page,
}) => {
  await open(page, [{ id: 'lv', type: 'level', at: 2, gain: 0, over: 0 }]);
  expect(await contrast(page, 8.2, 64, 20)).toBeLessThan(8);
  await page.evaluate(() => window.__algorhythms!.actions.select(['lv']));
  const traced = await contrast(page, 8.2, 64, 20);
  expect(traced).toBeGreaterThan(15);
  // Faint and dotted: some columns of the strip are bare.
  const cols = [];
  for (let k = 0; k < 12; k++) cols.push(await contrast(page, 8.2 + k * 0.02, 64));
  expect(Math.min(...cols)).toBeLessThan(traced);
  await page.evaluate(() => window.__algorhythms!.actions.select([]));
  expect(await contrast(page, 8.2, 64, 20)).toBeLessThan(8);

  // Hover finds the silent line, shows its readout and its trace.
  const box = (await page.locator('#score').boundingBox())!;
  const at = await page.evaluate(() => {
    const v = (window.__algorhythms!.frameStats as unknown as { view: V }).view;
    return {
      x: (10.5 - v.start) * v.pps,
      y: v.padT + ((v.pHi - 64) / (v.pHi - v.pLo)) * (v.height - v.padT - v.padB),
    };
  });
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await expect(page.getByTestId('score-hover')).toBeVisible();
  await expect(page.getByTestId('score-hover')).toContainText('E4');
  await expect.poll(() => contrast(page, 8.2, 64, 20)).toBeGreaterThan(15);
});
