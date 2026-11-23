/**
 * M10b-3: the lane's rows and blocks (PLAN §6.4). Key, Chords, Texture, Melody, Level and Sound
 * rows with headers; part rows under their group; legacy moments as Chords blocks running to the
 * next block; note and pin moments as dots that select, drag in time and delete.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

type Box = { x: number; y: number; width: number; height: number };

async function open(page: Page, example: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`./?example=${example}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await expect(page.locator('.lane-row').first()).toBeVisible();
}

/** Adds `extra` moments to the open piece and sets a 20 s window from 0. */
async function addMoments(page: Page, extra: unknown[]): Promise<void> {
  await page.evaluate((extra) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      view: Record<string, unknown>;
    };
    p.moments = [...p.moments, ...extra];
    p.view = { ...p.view, window: 20, gridBpm: 60 };
    h.actions.loadPiece(p);
  }, extra);
}

const headers = (page: Page): Promise<string[]> =>
  page.locator('.lane-row .lane-row-name').allTextContents();

/** Every lane item whose marker centre is not inside the row its `data-row`/`data-part` names. */
const misplaced = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.lane-item[data-moment]')) {
      const part = el.dataset.part;
      const sel =
        `.lane-row[data-row="${el.dataset.row}"]` +
        (part !== undefined ? `[data-part="${CSS.escape(part)}"]` : ':not([data-part])');
      const row = document.querySelector(sel);
      const m = el.querySelector('.lane-marker')!.getBoundingClientRect();
      const y = m.top + m.height / 2;
      const r = row?.getBoundingClientRect();
      if (!r || y < r.top || y > r.bottom) out.push(`${el.dataset.moment} (${el.dataset.type})`);
    }
    return out;
  });

test('six rows with headers, each block on its own row', async ({ page }) => {
  await open(page, 'tidewater-hymn');
  // Tidewater has keys, chords, a walk and levels: no Melody or Sound row yet.
  expect(await headers(page)).toEqual(['Key', 'Chords', 'Texture', 'Level']);
  await addMoments(page, [
    {
      id: 'tun001',
      type: 'tune',
      at: 3,
      notes: [
        { pitch: 67, len: 1 },
        { pitch: 69, len: 1 },
      ],
    },
    { id: 'tmb001', type: 'timbre', at: 5, preset: 'glass', fade: 2 },
  ]);
  await expect
    .poll(() => headers(page))
    .toEqual(['Key', 'Chords', 'Texture', 'Melody', 'Level', 'Sound']);
  const rows = page.locator('.lane-row');
  expect(await rows.evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.row))).toEqual([
    'key',
    'chords',
    'texture',
    'melody',
    'level',
    'sound',
  ]);
  // Rows stack top to bottom without gaps.
  const boxes = await rows.evaluateAll((es) => es.map((e) => e.getBoundingClientRect().toJSON()));
  for (let i = 1; i < boxes.length; i++)
    expect(Math.abs(boxes[i].top - boxes[i - 1].bottom)).toBeLessThanOrEqual(1);
  expect(await misplaced(page)).toEqual([]);
  await expect(page.locator('[data-moment="tun001"]')).toHaveAttribute('data-row', 'melody');
  await expect(page.locator('[data-moment="tmb001"]')).toHaveAttribute('data-row', 'sound');
  await expect(page.locator('[data-moment="tmb001"] .lane-label')).toHaveText('glass');
});

test('legacy moments are Chords blocks running to the next block', async ({ page }) => {
  await open(page, 'the-cartographers-rain');
  await page.getByTestId('zoom-fit').click();
  for (const type of ['unison', 'split', 'merge', 'chord']) {
    const items = page.locator(`.lane-item[data-type="${type}"]`);
    expect(await items.count(), type).toBeGreaterThan(0);
    for (const row of await items.evaluateAll((es) =>
      es.map((e) => (e as HTMLElement).dataset.row),
    ))
      expect(row, type).toBe('chords');
  }
  await expect(page.locator('.lane-item[data-type="walk"]').first()).toHaveAttribute(
    'data-row',
    'texture',
  );
  expect(await misplaced(page)).toEqual([]);
  // Blocks on one sub-row chain: each band ends where the next block on it starts.
  const bands = await page.evaluate(() => {
    const out: { sub: string; x: number; right: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      '.lane-item[data-row="chords"]:not([data-dot])',
    )) {
      const b = el.querySelector('.lane-band')!.getBoundingClientRect();
      out.push({ sub: el.dataset.sub!, x: b.left, right: b.right });
    }
    return out;
  });
  const sub0 = bands.filter((b) => b.sub === '0').sort((a, b) => a.x - b.x);
  expect(sub0.length).toBeGreaterThan(3);
  let touching = 0;
  for (let i = 1; i < sub0.length; i++) {
    expect(sub0[i].x).toBeGreaterThanOrEqual(sub0[i - 1].right - 1);
    if (Math.abs(sub0[i].x - sub0[i - 1].right) <= 1) touching++;
  }
  expect(touching).toBeGreaterThan(2);
  // Clicking a block's band (not its marker) selects it.
  const split = page.locator('.lane-item[data-type="split"]').first();
  const band = (await split.locator('.lane-band').boundingBox())!;
  await page.mouse.click(band.x + band.width - 6, band.y + band.height / 2);
  await expect(split).toHaveAttribute('aria-pressed', 'true');
});

test('a piece with parts gets part rows under their group', async ({ page }) => {
  await open(page, 'kite-day');
  const groups = await page.locator('.lane-row[data-group] .lane-row-group').allTextContents();
  expect(groups.length).toBeGreaterThan(1);
  for (const g of groups) expect(['Texture', 'Melody', 'Level', 'Sound']).toContain(g);
  // Part rows carry their part; Key and Chords are shared.
  await expect(page.locator('.lane-row[data-row="key"]')).not.toHaveAttribute('data-part');
  await expect(page.locator('.lane-row[data-row="chords"]')).not.toHaveAttribute('data-part');
  const melody = page.locator('.lane-row[data-row="melody"][data-part="Melody"]');
  await expect(melody).toHaveCount(1);
  await expect(melody.locator('.lane-row-name')).toContainText('Melody');
  expect(await misplaced(page)).toEqual([]);
  // A tune on the Melody part sits on that row.
  const tune = page.locator('.lane-item[data-type="tune"][data-part="Melody"]').first();
  await expect(tune).toHaveAttribute('data-row', 'melody');
});

test('a note is a dot: it selects, drags in time and deletes', async ({ page }) => {
  await open(page, 'tidewater-hymn');
  await addMoments(page, [{ id: 'not001', type: 'note', at: 4, from: 57, to: 59 }]);
  const dot = page.locator('[data-moment="not001"]');
  await expect(dot).toHaveAttribute('data-dot');
  await expect(dot).toHaveAttribute('data-row', 'chords');
  await expect(page.locator('.lane-row[data-row="pins"]')).toHaveCount(0);
  const chords = (await page.locator('.lane-row[data-row="chords"]').boundingBox()) as Box;
  const m = (await dot.locator('.lane-marker').boundingBox()) as Box;
  expect(m.y).toBeGreaterThanOrEqual(chords.y);
  // On top of the row, above the blocks.
  const blockYs = await page
    .locator('.lane-item[data-row="chords"]:not([data-dot]) .lane-marker')
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().top));
  expect(m.y + m.height).toBeLessThanOrEqual(Math.min(...blockYs) + 1);
  // A round marker, no band, no glide strip.
  expect(await dot.locator('.lane-marker').evaluate((e) => getComputedStyle(e).borderRadius)).toBe(
    '50%',
  );
  await expect(dot.locator('.lane-band')).toBeHidden();

  await dot.locator('.lane-marker').click();
  await expect(dot).toHaveAttribute('aria-pressed', 'true');
  // Drag right by about 2 s (Alt after the press: free, not a duplicate).
  const pps = await page.evaluate(() => {
    const f = window.__algorhythms!.frameStats;
    return document.getElementById('score')!.getBoundingClientRect().width / f.window;
  });
  const x = m.x + m.width / 2;
  const y = m.y + m.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.down('Alt');
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (2 * pps * i) / 5, y);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const at = () =>
    page.evaluate(
      () =>
        (
          window.__algorhythms!.store.getState().piece as unknown as {
            moments: { id: string; at: number }[];
          }
        ).moments.find((x) => x.id === 'not001')?.at,
    );
  await expect.poll(at).toBeGreaterThan(5.5);
  expect((await at())!).toBeLessThan(6.5);
  // Still a dot on the Chords row.
  await expect(dot).toHaveAttribute('data-row', 'chords');
  await dot.focus();
  await page.keyboard.press('Delete');
  await expect(dot).toHaveCount(0);
});
