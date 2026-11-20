/**
 * Loop region (PLAN.md §11.3 revision 6, §15 M4.5): dragging the ruler's loop band (or Shift-
 * dragging the ruler) sets a region shaded over the timeline; its edges drag; playback wraps
 * inside it; the transport toggle and `\` turn it off and on without losing it; double-clicking
 * the band clears it; it is saved with the piece.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

interface Region {
  start: number;
  end: number;
  on?: boolean;
}

async function openApp(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const region = (page: Page) =>
  page.evaluate(
    () =>
      (
        window.__algorhythms!.store.getState().piece as unknown as {
          view: { loop?: { start: number; end: number; on?: boolean } };
        }
      ).view.loop ?? null,
  );

/** Screen x of piece time `t`, and the y of the loop band and of the ruler's middle. */
async function axis(page: Page) {
  await frames(page);
  const f = await page.evaluate(() => ({
    start: window.__algorhythms!.frameStats.start,
    window: window.__algorhythms!.frameStats.window,
  }));
  const canvas = (await page.locator('#score').boundingBox())!;
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  return {
    x: (t: number) => canvas.x + ((t - f.start) / f.window) * canvas.width,
    band: ruler.y + 5,
    middle: ruler.y + ruler.height - 6,
  };
}

async function drag(page: Page, x0: number, x1: number, y: number, shift = false): Promise<void> {
  await page.mouse.move(x0, y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

/** Drags out [a, b] seconds on the band (the examples open with a 20 s window at 0). */
async function dragRegion(page: Page, a: number, b: number, shift = false): Promise<void> {
  const ax = await axis(page);
  await drag(page, ax.x(a), ax.x(b), shift ? ax.middle : ax.band, shift);
}

const near = (r: Region | null, start: number, end: number) => {
  expect(r).not.toBeNull();
  expect(r!.start).toBeCloseTo(start, 0);
  expect(r!.end).toBeCloseTo(end, 0);
};

test('dragging the loop band sets a shaded region; its edges drag; double-click clears it', async ({
  page,
}) => {
  await openApp(page);
  await expect(page.getByTestId('loop-toggle')).toBeDisabled();
  await expect(page.getByTestId('loop-region')).toBeHidden();

  await dragRegion(page, 3, 8);
  const r = await region(page);
  near(r, 3, 8);
  expect(r!.on).toBe(true);
  // The band drag did not seek.
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().transport.status)).toBe(
    'idle',
  );
  await expect(page.getByTestId('loop-toggle')).toHaveAttribute('aria-pressed', 'true');

  // Shaded across the ruler, the score and the rows, at the region's x.
  const shade = page.getByTestId('loop-region');
  await expect(shade).toBeVisible();
  await expect(shade).toHaveAttribute('data-on', 'true');
  const ax = await axis(page);
  const box = (await shade.boundingBox())!;
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  const lane = (await page.getByTestId('lane').boundingBox())!;
  expect(Math.abs(box.x - ax.x(r!.start))).toBeLessThan(2);
  expect(Math.abs(box.x + box.width - ax.x(r!.end))).toBeLessThan(2);
  expect(box.y).toBeLessThanOrEqual(ruler.y + 1);
  expect(box.y + box.height).toBeGreaterThanOrEqual(lane.y + lane.height - 1);

  // Drag the end edge from 8 s to 11 s, then the start edge from 3 s to 1 s.
  await drag(page, ax.x(r!.end), ax.x(11), ax.band);
  near(await region(page), 3, 11);
  await drag(page, ax.x((await region(page))!.start), ax.x(1), ax.band);
  near(await region(page), 1, 11);

  // A plain click on the band changes nothing; a double-click clears.
  await page.mouse.click(ax.x(15), ax.band);
  near(await region(page), 1, 11);
  await page.mouse.dblclick(ax.x(5), ax.band);
  expect(await region(page)).toBeNull();
  await expect(shade).toBeHidden();
  await expect(page.getByTestId('loop-toggle')).toBeDisabled();
});

test('Shift-drag on the ruler sets a region; playback wraps inside it', async ({ page }) => {
  await openApp(page);
  await dragRegion(page, 4, 6, true);
  const r = (await region(page))!;
  near(r, 4, 6);
  await seek(page, r.start);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => window.__algorhythms?.engine()?.isPlaying === true, null, {
    timeout: 10_000,
  });
  // Sample the playhead for about two and a half loops.
  const samples = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        const t0 = performance.now();
        const tick = (): void => {
          out.push(window.__algorhythms!.engine()?.currentTime() ?? -1);
          if (performance.now() - t0 < 5500) setTimeout(tick, 40);
          else resolve(out);
        };
        tick();
      }),
  );
  const shown = samples.slice(5);
  expect(Math.min(...shown)).toBeGreaterThanOrEqual(r.start - 0.05);
  expect(Math.max(...shown)).toBeLessThanOrEqual(r.end + 0.05);
  let wraps = 0;
  for (let i = 1; i < shown.length; i++) if (shown[i]! < shown[i - 1]! - 0.5) wraps++;
  expect(wraps).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().transport.status)).toBe(
    'playing',
  );
});

test('the Loop toggle and \\ turn looping off and on, keeping the region', async ({ page }) => {
  await openApp(page);
  await dragRegion(page, 2, 5);
  const toggle = page.getByTestId('loop-toggle');
  const shade = page.getByTestId('loop-region');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(shade).toHaveAttribute('data-on', 'false');
  let r = await region(page);
  near(r, 2, 5);
  expect(r!.on).toBe(false);

  await page.keyboard.press('Backslash');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  r = await region(page);
  near(r, 2, 5);
  expect(r!.on).toBe(true);
  await page.keyboard.press('Backslash');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // Off: playback runs past the region's end.
  await seek(page, 4);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.engine()?.currentTime() ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(5.5);
});

test('the region is saved with the piece and reopened', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium is enough here');
  await openApp(page);
  await dragRegion(page, 6, 9);
  await page.getByTestId('loop-toggle').click();
  const saved = (await region(page))!;
  await page.getByTestId('menu-button').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('save-file').click(),
  ]);
  const text = readFileSync(await file.path()).toString('utf8');
  expect(JSON.parse(text).view.loop).toEqual(saved);

  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as { view: { loop?: unknown } };
    delete p.view.loop;
    h.actions.loadPiece(p);
  });
  expect(await region(page)).toBeNull();
  await page.getByTestId('file-input').setInputFiles({
    name: 'looped.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect.poll(() => region(page)).toEqual(saved);
  await expect(page.getByTestId('loop-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('loop-region')).toHaveAttribute('data-on', 'false');
});

test('undo of an edit keeps the loop region', async ({ page }) => {
  await openApp(page);
  const count = () =>
    page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length);
  const before = await count();
  await seek(page, 12);
  await page.keyboard.press('l');
  await expect.poll(count).toBe(before + 1);
  await dragRegion(page, 13, 15);
  near(await region(page), 13, 15);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(count).toBe(before);
  near(await region(page), 13, 15);
});
