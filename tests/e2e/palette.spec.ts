/**
 * M4f moment palette and editor keys (PLAN.md §11.3): palette clicks and the letters add at the
 * playhead (letters at the time under the pointer over the score, owner 2026-11-23), ⌘/Ctrl+letter
 * does not, Delete removes the selection, undo restores it.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

interface M {
  id: string;
  type: string;
  at: number;
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(() => {
    const p = window.__algorhythms!.store.getState().piece as unknown as { moments: M[] };
    return p.moments.map(({ id, type, at }) => ({ id, type, at }));
  });

/** Opens the app on the default piece without a grid, playhead at 10 s. */
async function openNoGrid(page: Page): Promise<void> {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = h.store.getState().piece as unknown as { view: Record<string, unknown> };
    const view = { ...p.view };
    delete view.gridBpm;
    h.actions.loadPiece({ ...p, view });
  });
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('time')).toHaveText('00:10.0');
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

test('palette click adds a moment at the playhead', async ({ page }) => {
  await openNoGrid(page);
  const palette = page.getByTestId('palette');
  // The rows' palette (§6.4, M10 acceptance): six short labels, explanations in tooltips only;
  // a card may name its result under its label (M13, "→ Dm7").
  await expect(palette.getByRole('button')).toHaveText([
    /Chord(→ .+)?$/,
    /Texture(→ .+)?$/,
    /Melody(→ .+)?$/,
    /Level(→ .+)?$/,
    /Sound(→ .+)?$/,
    /Key(→ .+)?$/,
  ]);
  await expect(palette.getByRole('button').first()).toHaveAttribute('title', /\(C\)$/);
  for (const [i, k] of ['C', 'T', 'M', 'L', 'S', 'K'].entries())
    await expect(palette.getByRole('button').nth(i)).toHaveAttribute('aria-keyshortcuts', k);
  for (const gone of [
    'note',
    'pin',
    'unison',
    'split',
    'merge',
    'shift',
    'spread',
    'walk',
    'progression',
  ])
    await expect(palette.locator(`[data-moment="${gone}"]`)).toHaveCount(0);
  const before = await moments(page);
  await palette.locator('[data-moment="chord"]').click();
  const ms = (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
  expect(ms).toHaveLength(1);
  expect(ms[0].type).toBe('chord');
  expect(ms[0].at).toBeCloseTo(10, 3);
});

test('Add is exactly at the playhead line, not snapped to the bar grid (revision 7)', async ({
  page,
}) => {
  await openNoGrid(page);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      view: Record<string, unknown>;
    };
    p.view = { ...p.view, gridBpm: 60 };
    h.actions.loadPiece(p);
  });
  await seek(page, 3.3);
  const before = await moments(page);
  await page.getByTestId('palette').locator('[data-moment="chord"]').click();
  const added = (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
  expect(added).toHaveLength(1);
  expect(added[0].at).toBeCloseTo(3.3, 3);
});

test('Add and Next are separate, labelled groups with their own styles', async ({ page }) => {
  await openNoGrid(page);
  const add = page.getByTestId('palette');
  const next = page.getByTestId('suggestions');
  await expect(add).toContainText(/Add\s*at playhead/i);
  await expect(next).toContainText(/Next\s*at end/i);
  const style = (sel: string) =>
    page.evaluate((q) => {
      const cs = getComputedStyle(document.querySelector(q)!);
      return { border: cs.borderTopStyle, bg: cs.backgroundColor };
    }, sel);
  const a = await style('[data-testid="palette"]');
  const n = await style('[data-testid="suggestions"]');
  expect(a.border).toBe('solid');
  expect(n.border).not.toBe('dashed');
  expect(n.bg).not.toBe(a.bg);
  // Side by side when they fit (build-log "Compact view bar"), else Next below; never overlapping.
  const ab = (await add.boundingBox())!;
  const nb = (await next.boundingBox())!;
  expect(nb.x >= ab.x + ab.width - 1 || nb.y >= ab.y + ab.height - 1).toBe(true);
});

test('letters add each type; modified letters do not', async ({ page }) => {
  await openNoGrid(page);
  const keys: [string, string][] = [
    ['c', 'chord'],
    ['t', 'pulse'],
    ['m', 'tune'],
    ['l', 'level'],
    ['s', 'timbre'],
    ['k', 'key'],
  ];
  for (const [k, type] of keys) {
    const before = await moments(page);
    await page.keyboard.press(k);
    const after = await moments(page);
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((m) => !before.some((b) => b.id === m.id))!;
    expect(added.type).toBe(type);
    expect(added.at).toBeCloseTo(10, 3);
    // Delete it again, so the next type sees the same state (a spread on a unison does nothing).
    await page.keyboard.press('Delete');
    expect(await moments(page)).toHaveLength(before.length);
  }
  // The old letters add nothing (I pin, §11.3 rev 14; U P W R E O B, §6.4).
  const n = (await moments(page)).length;
  for (const k of ['i', 'u', 'p', 'w', 'r', 'e', 'o', 'b']) await page.keyboard.press(k);
  for (const combo of ['Control+c', 'Meta+c', 'Shift+s']) {
    await page.keyboard.press(combo);
  }
  expect(await moments(page)).toHaveLength(n);
});

test('a letter adds at the time under the pointer over the score, else at the playhead', async ({
  page,
}) => {
  await openNoGrid(page); // playhead at 10 s, no grid: snaps only to note changes within 8 px
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  const box = (await page.locator('#score').boundingBox())!;
  const pps = box.width / s.window;
  const xAt = (t: number) => box.x + (t - s.start) * pps;
  const t = Math.round((s.start + s.window * 0.8) * 10) / 10;
  expect(Math.abs(t - 10) * pps).toBeGreaterThan(100); // well away from the playhead
  const y = box.y + box.height / 2;
  const addWith = async (combo: string): Promise<M> => {
    const before = await moments(page);
    await page.keyboard.press(combo);
    const added = (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
    expect(added).toHaveLength(1);
    return added[0];
  };

  await page.mouse.move(xAt(t), y);
  const snapped = await addWith('c');
  expect(snapped.type).toBe('chord');
  expect(Math.abs(snapped.at - t)).toBeLessThanOrEqual(8 / pps + 1e-3); // a drop's snap reach
  // Its lane marker sits under the pointer.
  const marker = (await page
    .locator(`.lane-item[data-moment="${snapped.id}"] .lane-marker`)
    .boundingBox())!;
  expect(Math.abs(marker.x + marker.width / 2 - xAt(snapped.at))).toBeLessThan(3);
  await page.keyboard.press('Delete');

  // Alt: free time, exactly under the pointer (to a pixel).
  const t2 = t - 1.37;
  await page.mouse.move(xAt(t2), y);
  const free = await addWith('Alt+c');
  expect(free.type).toBe('chord');
  expect(Math.abs(free.at - t2)).toBeLessThanOrEqual(1 / pps + 1e-3);
  await page.keyboard.press('Delete');

  // The pointer over the inspector: at the playhead.
  const insp = (await page.getByTestId('inspector').boundingBox())!;
  await page.mouse.move(insp.x + insp.width / 2, insp.y + insp.height / 2);
  const atHead = await addWith('c');
  expect(atHead.at).toBeCloseTo(10, 3);
});

test('Delete removes the selection, undo restores it, Escape clears it', async ({ page }) => {
  await openNoGrid(page);
  const base = await moments(page);
  const added = async () =>
    (await moments(page)).filter((m) => !base.some((b) => b.id === m.id)).map((m) => m.type);
  await page.keyboard.press('c');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('l');
  expect(await added()).toEqual(['chord', 'level']);
  const two = await moments(page);

  await page.keyboard.press('Delete');
  expect(await added()).toEqual(['chord']);
  expect(await moments(page)).toHaveLength(two.length - 1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await moments(page)).toEqual(two);

  // Undo restored the selection (the level); Escape clears it, so Backspace deletes nothing.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  expect(await moments(page)).toEqual(two);
});
