/**
 * M6 master FX and strike partials in the Sound drawer (PLAN.md §8.6, §11.3, §15 M6): a master
 * drag is one undo entry; the delay time reads in beats with a tempo and snaps to note values
 * (Alt free); Reset puts a section's defaults back; a strike partial is added and undone.
 * Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';
import { shot } from './shots';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

type Json = Record<string, unknown>;
interface Mix {
  reverb: { size: number; decay: number; damping: number; preDelay: number; returnLevel: number };
  delay: { time: number; feedback: number; returnLevel: number };
}
interface PieceLite {
  mix: Mix;
  timbres: Record<
    string,
    Json & { strikePartials?: { ratio: number; amp: number; decay: number }[] }
  >;
}
const piece = (page: Page) =>
  page.evaluate(() => window.__algorhythms!.store.getState().piece as unknown as PieceLite);
const editor = (page: Page) => page.evaluate(() => window.__algorhythms!.editor.state.getState());
const blurAndUndo = async (page: Page): Promise<void> => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
};

/** Drags a horizontal range input from 10 % to `to` of its width, in a few moves. */
async function drag(page: Page, testId: string, to: number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  for (const f of [0.3, 0.5, to]) {
    await page.mouse.move(box.x + box.width * f, y, { steps: 3 });
  }
  await page.mouse.up();
}

async function openSound(page: Page, example: string, tab: 'timbre' | 'master'): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`./?example=${example}`);
  await expect(page.getByTestId('play')).toBeVisible();
  await page.getByTestId('sound-toggle').click();
  await expect(page.getByTestId('sound-tab-timbre')).toHaveAttribute('aria-selected', 'true');
  if (tab === 'master') {
    await page.getByTestId('sound-tab-master').click();
    await expect(page.getByTestId('master')).toBeVisible();
    await expect(page.getByTestId('sound-timbre')).toBeHidden();
  }
}

const DEFAULT_REVERB = { size: 0.7, decay: 3.2, damping: 0.45, preDelay: 0.02, returnLevel: 0.35 };
const DEFAULT_DELAY = { time: 0.375, feedback: 0.35, returnLevel: 0 };

test('drag reverb decay: one undo entry; Reset puts the defaults back', async ({ page }) => {
  await openSound(page, 'tidewater-hymn', 'master');
  const before = await piece(page);
  await expect(page.getByTestId('master')).toContainText('limiter is always on');
  await expect(page.getByTestId('mx-limiter')).toHaveText('-1 dBFS');

  await drag(page, 'mx-rev-decay', 0.85);
  const dragged = (await piece(page)).mix;
  expect(dragged.reverb.decay).toBeGreaterThan(before.mix.reverb.decay);
  expect(String(dragged.reverb.decay).length).toBeLessThan(6);
  expect({ ...dragged.reverb, decay: before.mix.reverb.decay }).toEqual(before.mix.reverb);
  await expect(page.getByTestId('mx-rev-decay-out')).toHaveText(
    `${Number(dragged.reverb.decay.toFixed(dragged.reverb.decay >= 10 ? 1 : 3))} s`,
  );
  expect((await editor(page)).undoLabel).toBe('Reverb decay');
  await shot(page.getByTestId('sound-drawer'), 'sound-fx.png');
  await blurAndUndo(page);
  expect((await piece(page)).mix).toEqual(before.mix);

  // Reset: the defaults, one entry; disabled once at the defaults.
  await drag(page, 'mx-rev-damping', 0.9);
  await drag(page, 'mx-rev-size', 0.2);
  const reset = page.getByTestId('mx-reverb-reset');
  await expect(reset).toBeEnabled();
  await reset.click();
  expect((await piece(page)).mix.reverb).toEqual(DEFAULT_REVERB);
  await expect(reset).toBeDisabled();
  await blurAndUndo(page);
  expect((await piece(page)).mix.reverb.size).not.toBe(DEFAULT_REVERB.size);
});

test('delay time in beats with a tempo, snapped to note values, Alt free', async ({ page }) => {
  // Kite Day: 100 bpm (a beat is 0.6 s), delay 0.45 s.
  await openSound(page, 'kite-day', 'master');
  const out = page.getByTestId('mx-dly-time-out');
  await expect(out).toHaveText('dotted 1/8 · 0.75 beats · 0.45 s');

  await drag(page, 'mx-dly-time', 0.8);
  const t = (await piece(page)).mix.delay.time;
  expect([0.15, 0.3, 0.45, 0.6, 0.9, 1.2]).toContain(t);
  await expect(out).toContainText(' beat');

  // Alt: free values.
  await page.keyboard.down('Alt');
  await drag(page, 'mx-dly-time', 0.62);
  await page.keyboard.up('Alt');
  const free = (await piece(page)).mix.delay.time;
  expect([0.15, 0.3, 0.45, 0.6, 0.9, 1.2]).not.toContain(free);

  // Reset the delay section: the defaults (0.375 s = 0.625 beats here).
  await page.getByTestId('mx-delay-reset').click();
  expect((await piece(page)).mix.delay).toEqual(DEFAULT_DELAY);
  await expect(out).toHaveText('0.63 beats · 0.375 s');
});

test('add a strike partial, edit it, undo', async ({ page }) => {
  await openSound(page, 'tidewater-hymn', 'timbre');
  const name = await page.getByTestId('sound-timbre').inputValue();
  const before = (await piece(page)).timbres[name];
  const list = page.getByTestId('strike-partials');
  await list.locator('summary').click();
  const n = before?.strikePartials?.length ?? 0;

  await page.getByTestId('strike-add').click();
  const added = (await piece(page)).timbres[name].strikePartials!;
  expect(added).toHaveLength(n + 1);
  const ratio = page.getByTestId(`strike-${n + 1}-ratio`);
  await ratio.fill('3.5');
  await ratio.press('Enter');
  expect((await piece(page)).timbres[name].strikePartials![n].ratio).toBe(3.5);

  await blurAndUndo(page);
  expect((await piece(page)).timbres[name].strikePartials).toEqual(added);
  await expect(ratio).toHaveValue(String(added[n].ratio));
  await page.keyboard.press('ControlOrMeta+z');
  expect((await piece(page)).timbres[name]).toEqual(before);
});
