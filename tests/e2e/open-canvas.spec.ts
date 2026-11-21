/**
 * Open-ended canvas (PLAN.md §11.3 revision 7): the view pans past the piece's end and shows the
 * bar grid there; adding a moment past the end extends the piece; the ruler's end handle sets
 * `end.at` (one undo entry), and a double-click makes the end automatic again.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

/** A split at 0, a unison at 2 s (0.5 s glide), an explicit end at 30 s, a 20 s window. */
async function open(page: Page): Promise<void> {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
      end: Record<string, unknown>;
    };
    p.view = { ...p.view, window: 20 };
    delete p.view.gridBpm;
    delete p.view.loop;
    p.end = { ...p.end, at: 30 };
    p.moments = [
      { id: 'spl001', type: 'split', at: 0, count: 4, voicing: 'even' },
      {
        id: 'uni001',
        type: 'unison',
        at: 2,
        pitch: 'center',
        octaves: false,
        glide: { length: 0.5, stagger: 0 },
      },
    ];
    h.actions.loadPiece(p);
  });
  await page.locator('body').click({ position: { x: 2, y: 2 } });
}

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.__algorhythms!.store.getState();
    const f = window.__algorhythms!.frameStats;
    return {
      duration: s.compiled.duration,
      endAt: (s.piece as unknown as { end: { at?: number } }).end.at,
      moments: s.piece.moments.length,
      start: f.start,
      window: f.window,
    };
  });

/** Screen x of piece time `t` on the current frame, and a y inside the ruler's seek area. */
async function axis(page: Page) {
  await frames(page);
  const f = await state(page);
  const canvas = (await page.locator('#score').boundingBox())!;
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  return {
    x: (t: number) => canvas.x + ((t - f.start) / f.window) * canvas.width,
    y: ruler.y + ruler.height - 8,
  };
}

test('the view pans past the end, shows the bar grid there, and keeps working', async ({
  page,
}) => {
  await open(page);
  const canvas = (await page.locator('#score').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  // Horizontal scroll pans: well past the 30 s end.
  for (let i = 0; i < 12; i++) await page.mouse.wheel(400, 0);
  await expect.poll(async () => (await state(page)).start).toBeGreaterThan(32);
  const s = await state(page);
  expect(s.duration).toBeCloseTo(30, 3);
  expect(s.window).toBeCloseTo(20, 3);

  // The empty canvas past the end still draws bars (default 60 bpm 4/4: a bar every 4 s).
  const px = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#score')!;
    const g = c.getContext('2d')!;
    const f = window.__algorhythms!.frameStats;
    const dpr = c.width / c.getBoundingClientRect().width;
    const w = c.getBoundingClientRect().width;
    const h = c.getBoundingClientRect().height;
    const y = Math.round(h * 0.5 * dpr);
    const bar = Math.ceil(f.start / 4 + 0.5) * 4;
    const xAt = (t: number) => Math.floor((Math.round(((t - f.start) / f.window) * w) + 0.5) * dpr);
    const at = (x: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { bar: at(xAt(bar)), gap: at(xAt(bar + 0.5)) };
  });
  expect(px.bar).not.toEqual(px.gap);
  await expect(page.getByTestId('ruler-bars')).toBeVisible();

  // Panning back and zooming still work out here; Fit frames the piece again.
  const before = (await state(page)).start;
  await page.mouse.wheel(-400, 0);
  await expect.poll(async () => (await state(page)).start).toBeLessThan(before);
  await page.getByTestId('zoom-out').click();
  await expect.poll(async () => (await state(page)).window).toBeGreaterThan(20);
  await page.getByTestId('zoom-fit').click();
  await expect.poll(async () => state(page)).toMatchObject({ start: 0 });
  expect((await state(page)).window).toBeCloseTo(30, 3);
  // Zoom out goes past Fit (the open canvas).
  await page.getByTestId('zoom-out').click();
  await expect.poll(async () => (await state(page)).window).toBeGreaterThan(30);
});

test('a ruler click past the end puts the playhead there; Add extends the piece', async ({
  page,
}) => {
  await open(page);
  await seek(page, 25);
  const canvas = (await page.locator('#score').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  // Seeking to 25 s leaves the view at [10, 30]; pan 15 s right (horizontal scroll, px / pps).
  await expect.poll(async () => (await state(page)).start).toBeCloseTo(10, 3);
  await page.mouse.wheel((15 * canvas.width) / 20, 0);
  await expect.poll(async () => (await state(page)).start).toBeCloseTo(25, 0);
  const ax = await axis(page);
  await page.mouse.click(ax.x(38), ax.y);
  const now = async () => Number(await page.getByTestId('ruler').getAttribute('aria-valuenow'));
  await expect.poll(now).toBeGreaterThan(36);
  const t = await now();
  expect(t).toBeLessThan(40);

  await page.getByTestId('palette').locator('[data-moment="chord"]').click();
  await expect.poll(async () => (await state(page)).moments).toBe(3);
  const s = await state(page);
  // The chord's glide plus the 4 s tail: the end moved out from 30 s.
  expect(s.endAt).toBeGreaterThan(t + 4);
  expect(s.duration).toBeCloseTo(s.endAt!, 3);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).endAt).toBe(30);
});

test('dragging the end handle sets the end; undo restores; double-click is automatic', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('zoom-out').click();
  await page.getByTestId('zoom-out').click();
  const end = page.getByTestId('ruler-end');
  await expect(end).toHaveAttribute('data-t', '30');
  await expect(end).toHaveAttribute('data-auto', 'false');

  const ax = await axis(page);
  await page.mouse.move(ax.x(30), ax.y);
  await page.mouse.down();
  await page.mouse.move(ax.x(34), ax.y, { steps: 6 });
  await page.keyboard.down('Alt');
  await page.mouse.move(ax.x(36), ax.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await state(page)).endAt).toBeGreaterThan(35);
  const s = await state(page);
  expect(s.endAt).toBeLessThan(37);
  expect(s.duration).toBeCloseTo(s.endAt!, 3);
  // The drag did not seek.
  expect(Number(await page.getByTestId('ruler').getAttribute('aria-valuenow'))).toBeLessThan(1);
  await expect(end).toHaveAttribute('data-t', String(s.endAt));

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).endAt).toBe(30);

  // Double-click: back to automatic (the last activity + 4 s).
  const ax2 = await axis(page);
  await page.mouse.dblclick(ax2.x(30), ax2.y);
  await expect.poll(async () => (await state(page)).endAt).toBeUndefined();
  await expect(end).toHaveAttribute('data-auto', 'true');
  expect((await state(page)).duration).toBeLessThan(10);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).endAt).toBe(30);
});
