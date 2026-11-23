/**
 * Multi-select (PLAN.md §11.3, M5): ⌘/Ctrl-click toggles on the lane, a Shift-drag on the lane
 * background draws a marquee (⌘/Ctrl+Shift extends; a plain drag still pans), ⌘/Ctrl+A selects
 * all, and the group moves, nudges and deletes as one undo entry each. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  byId,
  frames,
  item,
  lanePps,
  markerAt,
  moments,
  openFixture,
  selection,
  undo,
  undoLabel,
} from './m5-fixture';
import { shot } from './shots';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

/** A Shift-drag (plus `extra` modifiers) on the lane from `from` to `to`. */
async function marquee(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  extra: string[] = [],
): Promise<void> {
  for (const k of ['Shift', ...extra]) await page.keyboard.down(k);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await page.waitForTimeout(16);
  }
  await expect(page.getByTestId('lane-marquee')).toBeVisible();
  await shot(page, 'm5-lane-marquee.png');
  await page.mouse.up();
  for (const k of ['Shift', ...extra].reverse()) await page.keyboard.up(k);
}

test('⌘/Ctrl-click toggles moments on the lane', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await item(page, 'bbbbbb').click({ modifiers: ['ControlOrMeta'] });
  expect(await selection(page)).toEqual(['aaaaaa', 'bbbbbb']);
  await item(page, 'aaaaaa').click({ modifiers: ['ControlOrMeta'] });
  expect(await selection(page)).toEqual(['bbbbbb']);
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'false');
  await expect(item(page, 'bbbbbb')).toHaveAttribute('aria-pressed', 'true');
});

test('Shift-drag on the lane selects the moments it touches; plain drag pans', async ({ page }) => {
  const k = await lanePps(page);
  const b = await markerAt(page, 'bbbbbb');
  // From the empty Texture row at 18.5 s (past the walk), left and up to the unison's marker on
  // the Chords row. Chord blocks run to the next one (PLAN §6.4), so the left edge stays right of
  // the chord's block, which ends at the unison.
  const texture = (await page.locator('.lane-row[data-row="texture"]').boundingBox())!;
  const from = { x: b.x + 12.5 * k, y: texture.y + texture.height - 3 };
  const to = { x: b.x + 2, y: b.y };
  await marquee(page, from, to);
  expect([...(await selection(page))].sort()).toEqual(['bbbbbb', 'cccccc']);
  await expect(page.getByTestId('lane-marquee')).toBeHidden();
  await expect(page.getByTestId('lane-live')).toContainText('Selected 2 moments');
  // The first selected item has focus, so the arrows nudge the group.
  await expect(item(page, 'bbbbbb')).toBeFocused();

  // ⌘/Ctrl+Shift adds the chord at 2 s: from the empty Texture row up to its marker (right of
  // the opening's block, which ends there).
  const a = await markerAt(page, 'aaaaaa');
  await marquee(
    page,
    { x: a.x + 0.6 * k, y: texture.y + texture.height - 3 },
    { x: a.x + 2, y: a.y },
    ['ControlOrMeta'],
  );
  expect([...(await selection(page))].sort()).toEqual(['aaaaaa', 'bbbbbb', 'cccccc']);

  // A plain drag on the background pans and keeps the selection.
  const before = await markerAt(page, 'aaaaaa');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(from.x - 20 * i, from.y);
  await page.mouse.up();
  await frames(page);
  expect((await markerAt(page, 'aaaaaa')).x).not.toBeCloseTo(before.x, 0);
  expect((await selection(page)).length).toBe(3);
});

test('⌘/Ctrl+A selects all; Delete removes them as one undo entry', async ({ page }) => {
  const all = (await moments(page)).map((m) => m.id);
  await item(page, 'aaaaaa').click();
  await page.keyboard.press('ControlOrMeta+A');
  expect([...(await selection(page))].sort()).toEqual([...all].sort());
  await expect(page.getByTestId('insp-many')).toContainText(`${all.length} moments selected`);
  await page.keyboard.press('Delete');
  expect(await moments(page)).toHaveLength(0);
  expect(await undoLabel(page)).toBe('Delete moments');
  await undo(page);
  expect((await moments(page)).map((m) => m.id)).toEqual(all);
});

test('arrows nudge and a drag moves the whole selection, one undo entry each', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await item(page, 'cccccc').click({ modifiers: ['Shift'] });
  await item(page, 'cccccc').focus();
  await page.keyboard.press('ArrowRight');
  // A 60 BPM grid: one beat.
  expect((await byId(page, 'aaaaaa'))!.at).toBeCloseTo(3, 6);
  expect((await byId(page, 'cccccc'))!.at).toBeCloseTo(11, 6);
  expect((await byId(page, 'cccccc'))!.until).toBeCloseTo(15, 6);
  expect(await undoLabel(page)).toBe('Move moments');
  await undo(page);
  expect((await byId(page, 'aaaaaa'))!.at).toBe(2);
  expect((await byId(page, 'cccccc'))!.at).toBe(10);

  const k = await lanePps(page);
  const a = await markerAt(page, 'aaaaaa');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + (2 * k * i) / 6, a.y);
  await page.mouse.up();
  const da = (await byId(page, 'aaaaaa'))!.at - 2;
  expect(da).toBeGreaterThan(1);
  expect((await byId(page, 'cccccc'))!.at - 10).toBeCloseTo(da, 6);
  expect(await undoLabel(page)).toBe('Move moments');
});

test('⌘/Ctrl-click on a score line toggles its moment', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  // A sounding line at 9 s.
  const point = await page.evaluate(() => {
    const h = window.__algorhythms!;
    const s = h.store.getState() as unknown as {
      compiled: {
        voices: {
          lives: { born: number; died?: number }[];
          segments: { t0: number; t1: number; p0: number }[];
        }[];
      };
    };
    for (const v of s.compiled.voices) {
      if (!v.lives.some((l) => l.born <= 9 && (l.died === undefined || l.died > 9))) continue;
      const seg = v.segments.find((x) => x.t0 <= 9 && x.t1 >= 9);
      if (seg) return { t: 9, p: seg.p0 };
    }
    return null;
  });
  expect(point).not.toBeNull();
  const stats = await page.evaluate(
    () =>
      (
        window.__algorhythms!.frameStats as unknown as {
          view: {
            start: number;
            pps: number;
            pLo: number;
            pHi: number;
            padT: number;
            padB: number;
            height: number;
          };
        }
      ).view,
  );
  const canvas = await page.locator('#score').boundingBox();
  const x = canvas!.x + (point!.t - stats.start) * stats.pps;
  const y =
    canvas!.y +
    stats.padT +
    ((stats.pHi - point!.p) / (stats.pHi - stats.pLo)) * (stats.height - stats.padT - stats.padB);
  // The line here belongs to the chord (the unison leaves it): ⌘/Ctrl-click toggles it off and on.
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(x, y);
  await page.keyboard.up('ControlOrMeta');
  expect(await selection(page)).toEqual([]);
  await page.waitForTimeout(600);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(x, y);
  await page.keyboard.up('ControlOrMeta');
  expect(await selection(page)).toEqual(['aaaaaa']);
  // With the unison selected, ⌘/Ctrl-click adds the chord.
  await item(page, 'bbbbbb').click();
  // Not a double-click on the line (that adds a note).
  await page.waitForTimeout(600);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(x, y);
  await page.keyboard.up('ControlOrMeta');
  expect(await selection(page)).toEqual(['bbbbbb', 'aaaaaa']);
});
