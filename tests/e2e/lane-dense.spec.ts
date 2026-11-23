/**
 * Dense pieces on the lane (owner 2026-11-21, PLAN §11.3 "Dense lanes"; the pre-rev-9 Kite Day,
 * 349 moments, kept as tests/golden/v1/kite-day.algorhythms.json and opened as a share link,
 * since the bundled Kite Day is now written with tunes and pulses): rows keep their
 * full height; `level` moments sit on the Level row, `pin` moments are dots on the Chords row
 * (PLAN §6.4, M10b-3); the lane
 * area is capped (default: the score keeps ≥ 55 % of the timeline) and scrolls inside itself; a
 * draggable divider sets the split and is remembered. A sparse piece is unchanged.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import './app-hook';

/** The dense Kite Day as a share link payload. */
const DENSE = deflateRawSync(
  readFileSync(join(import.meta.dirname, '../golden/v1/kite-day.algorhythms.json')),
).toString('base64url');

type Box = { x: number; y: number; width: number; height: number };

const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!;

const selection = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__algorhythms!.editor.state.getState().selection);

/**
 * Per lane row: the item types whose marker centre lies inside it (track coordinates); `wrong`
 * lists items whose `data-row` differs from that row's.
 */
async function typesByRow(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.lane-row[data-row]')].map((r) => ({
      name: r.dataset.row!,
      r: r.getBoundingClientRect(),
    }));
    const out: Record<string, string[]> = {};
    for (const el of document.querySelectorAll<HTMLElement>('.lane-item[data-moment]')) {
      const m = el.querySelector('.lane-marker')!.getBoundingClientRect();
      const y = m.top + m.height / 2;
      const row = rows.find((x) => x.r.height > 0 && y >= x.r.top && y <= x.r.bottom);
      const k = row?.name ?? 'none';
      (out[k] ??= []).push(el.dataset.type!);
      if (row && row.name !== el.dataset.row) (out.wrong ??= []).push(el.dataset.moment!);
    }
    return out;
  });
}

/** Lane items of `type` whose marker lies inside the lane area's visible rectangle, uncovered. */
async function visibleMarkers(
  page: Page,
  type?: string,
): Promise<{ id: string; x: number; y: number }[]> {
  return page.evaluate((type) => {
    const sc = document.querySelector('.lane-scroll')!.getBoundingClientRect();
    const out: { id: string; x: number; y: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.lane-item[data-moment]')) {
      if (type && el.dataset.type !== type) continue;
      const m = el.querySelector('.lane-marker')!.getBoundingClientRect();
      const x = m.left + m.width / 2;
      const y = m.top + m.height / 2;
      if (
        m.top < sc.top ||
        m.bottom > sc.bottom ||
        m.left < sc.left + 60 ||
        m.right > sc.right - 60
      )
        continue;
      if (document.elementFromPoint(x, y)?.closest('[data-moment]') !== el) continue;
      out.push({ id: el.dataset.moment!, x, y });
    }
    return out;
  }, type);
}

async function open(page: Page, example: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(example === 'dense' ? `./#p=${DENSE}` : `./?example=${example}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await expect(page.locator('.lane-track')).toHaveAttribute('data-subrows', /\d+/);
}

for (const [width, height] of [
  [1024, 768],
  [1280, 720],
] as const) {
  test.describe(`Dense Kite Day at ${width}×${height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        try {
          if (!sessionStorage.getItem('lane-dense-kept')) localStorage.clear();
        } catch {
          // storage unavailable: the default split applies anyway
        }
      });
      await open(page, 'dense', width, height);
    });

    test('the score keeps its share; rows keep full height; items go to their kind’s row', async ({
      page,
    }) => {
      const timeline = await box(page.getByTestId('timeline'));
      const stage = await box(page.getByTestId('stage'));
      expect(stage.height / timeline.height).toBeGreaterThanOrEqual(0.5);
      const lane = await box(page.getByTestId('lane'));
      expect(lane.y + lane.height).toBeLessThanOrEqual(timeline.y + timeline.height + 1);
      expect(lane.y + lane.height).toBeLessThanOrEqual(height);
      // No compaction: blocks are full height, with their labels shown.
      await expect(page.locator('.lane-track')).not.toHaveAttribute('data-compact');
      const chord = page.locator('.lane-item[data-type="chord"]').nth(1);
      expect((await box(chord)).height).toBeGreaterThanOrEqual(13);
      await expect(chord.locator('.lane-label')).toBeVisible();

      const rows = await typesByRow(page);
      expect(rows.none ?? []).toEqual([]);
      expect(rows.wrong ?? []).toEqual([]);
      expect(new Set(rows.level)).toEqual(new Set(['level']));
      expect(rows.level.length).toBe(141);
      // Pins are dots on the Chords row; there is no Pins row.
      expect(rows.chords.filter((t) => t === 'pin').length).toBe(165);
      expect(rows.chords.filter((t) => t === 'chord').length).toBe(42);
      expect(rows.chords).not.toContain('level');
      await expect(page.locator('.lane-row[data-row="pins"]')).toHaveCount(0);
      await expect(page.locator('.lane-item[data-type="pin"]').first()).toHaveAttribute('data-dot');
    });

    test('the Level row is reachable by wheel; a level marker selects on click', async ({
      page,
    }) => {
      const sc = page.getByTestId('lane-scroll');
      const scBox = await box(sc);
      const start = await page.evaluate(() => window.__algorhythms!.frameStats.start);
      await page.mouse.move(scBox.x + scBox.width / 2, scBox.y + scBox.height / 2);
      await page.mouse.wheel(0, 600);
      await expect
        .poll(async () => {
          const level = await box(page.locator('.lane-row[data-row="level"]'));
          return level.y + level.height <= scBox.y + scBox.height + 1;
        })
        .toBe(true);
      // A plain vertical wheel does not pan the time axis.
      expect(await page.evaluate(() => window.__algorhythms!.frameStats.start)).toBe(start);
      const items = await visibleMarkers(page, 'level');
      expect(items.length).toBeGreaterThan(0);
      const it = items.at(-1)!;
      const level = await box(page.locator('.lane-row[data-row="level"]'));
      expect(it.y).toBeGreaterThanOrEqual(level.y);
      expect(it.y).toBeLessThanOrEqual(level.y + level.height);
      await page.mouse.click(it.x, it.y);
      await expect.poll(() => selection(page)).toEqual([it.id]);
      // Its label shows while selected.
      await expect(page.locator(`.lane-item[data-moment="${it.id}"] .lane-label`)).toBeVisible();
    });

    test('Shift-wheel over the lane area pans the time axis', async ({ page }) => {
      const scBox = await box(page.getByTestId('lane-scroll'));
      const start = await page.evaluate(() => window.__algorhythms!.frameStats.start);
      await page.mouse.move(scBox.x + scBox.width / 2, scBox.y + scBox.height / 2);
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 300);
      await page.keyboard.up('Shift');
      await expect
        .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start))
        .toBeGreaterThan(start);
    });

    test('selecting a moment elsewhere scrolls its lane item into view', async ({ page }) => {
      // 160 px shorter, so the lanes overflow (since the compact view bar they fit at 1280×720).
      await page.setViewportSize({ width, height: height - 160 });
      const sc = page.getByTestId('lane-scroll');
      await expect
        .poll(() => sc.evaluate((e) => e.scrollHeight - e.clientHeight))
        .toBeGreaterThan(40);
      await sc.evaluate((e) => (e.scrollTop = e.scrollHeight));
      const scBox = await box(sc);
      const hidden = await page.evaluate(() => {
        const r = document.querySelector('.lane-scroll')!.getBoundingClientRect();
        for (const el of document.querySelectorAll<HTMLElement>('.lane-item[data-moment]')) {
          const m = el.querySelector('.lane-marker')!.getBoundingClientRect();
          if (m.bottom < r.top && m.left > r.left && m.right < r.right) return el.dataset.moment!;
        }
        return null;
      });
      expect(hidden).not.toBeNull();
      await page.evaluate((id) => window.__algorhythms!.actions.select([id]), hidden!);
      await expect
        .poll(async () => {
          const m = await box(page.locator(`.lane-item[data-moment="${hidden}"] .lane-marker`));
          return m.y >= scBox.y - 1 && m.y + m.height <= scBox.y + scBox.height + 1;
        })
        .toBe(true);
    });
  });
}

test('the divider drags the split, persists across reload, and resets on double-click', async ({
  page,
}) => {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('lane-dense-kept')) {
        localStorage.clear();
        sessionStorage.setItem('lane-dense-kept', '1');
      }
    } catch {
      // storage unavailable
    }
  });
  await open(page, 'dense', 1024, 700);
  const div = page.getByTestId('lane-divider');
  const sc = page.getByTestId('lane-scroll');
  const h0 = (await box(sc)).height;
  const stage0 = (await box(page.getByTestId('stage'))).height;
  const d = await box(div);
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  // Down: the default lane is near its content height (the lane never grows past its rows), so
  // the first drag shrinks it; "way up" below covers growing.
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2 + 20, { steps: 4 });
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await box(sc)).height).toBeLessThan(h0 - 30);
  const h1 = (await box(sc)).height;
  expect((await box(page.getByTestId('stage'))).height).toBeGreaterThan(stage0 + 30);

  // Way up: the score keeps at least a quarter of the timeline and its 200 px minimum.
  const d1 = await box(div);
  await page.mouse.move(d1.x + 100, d1.y + 5);
  await page.mouse.down();
  await page.mouse.move(d1.x + 100, 0, { steps: 6 });
  await page.mouse.up();
  const timeline = await box(page.getByTestId('timeline'));
  const stageUp = (await box(page.getByTestId('stage'))).height;
  expect(stageUp).toBeGreaterThanOrEqual(timeline.height * 0.25 - 1);
  expect(stageUp).toBeGreaterThanOrEqual(199);
  await expect.poll(async () => (await box(sc)).height).toBeGreaterThan(h1 + 30);
  // Drag back to h1; it survives a reload.
  const d2 = await box(div);
  const hNow = (await box(sc)).height;
  await page.mouse.move(d2.x + 100, d2.y + 5);
  await page.mouse.down();
  await page.mouse.move(d2.x + 100, d2.y + 5 + (hNow - h1), { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await box(sc)).height - h1)).toBeLessThanOrEqual(2);

  // Reload (the link's hash is cleared once it opens, so open it again).
  await open(page, 'dense', 1024, 700);
  await expect.poll(async () => Math.abs((await box(sc)).height - h1)).toBeLessThanOrEqual(2);

  // Keyboard: a focusable separator; ↓ shrinks the lanes.
  await expect(div).toHaveAttribute('role', 'separator');
  await div.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await box(sc)).height).toBeLessThan(h1 - 10);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => Math.abs((await box(sc)).height - h1)).toBeLessThanOrEqual(2);

  // Double-click: back to the default split, which also survives a reload.
  await div.dblclick();
  await expect.poll(async () => Math.abs((await box(sc)).height - h0)).toBeLessThanOrEqual(1);
  // Reload (the link's hash is cleared once it opens, so open it again).
  await open(page, 'dense', 1024, 700);
  await expect.poll(async () => Math.abs((await box(sc)).height - h0)).toBeLessThanOrEqual(1);
});

test('a sparse piece keeps full rows, no Pins row and no lane scrolling', async ({ page }) => {
  await open(page, 'tidewater-hymn', 1024, 768);
  await expect(page.locator('.lane-track')).not.toHaveAttribute('data-compact');
  const sc = page.getByTestId('lane-scroll');
  expect(await sc.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('lane')).not.toHaveAttribute('data-more-below');
  await expect(page.locator('.lane-row[data-row="pins"]')).toHaveCount(0);
  // Labels show as before.
  await expect(page.locator('.lane-item[data-moment] .lane-label').first()).toBeVisible();
});
