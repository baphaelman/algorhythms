/**
 * Bounded number fields get sliders (owner 2026-11-21): a chord block's "Notes" (here a legacy
 * split and merge, §6.4) is a slider with the value as a label (no text box); a drag is one undo
 * entry that rewrites the block as a chord. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough for the inspector');

interface EditorHook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { canUndo: boolean; undoLabel: string } };
  };
  store: {
    getState(): {
      piece: { moments: { id: string; type: string; count?: number }[] };
      compiled: { voices: { lives: { born: number; died?: number }[] }[] };
    };
  };
}

/** Tidewater Hymn: a split to 5 notes at 17.689 s (3 sound before it), pool 12. */
const SPLIT = '77O2kG';
const SPLIT_AT = 17.689;
/** Tidewater Hymn: the closing merge to 1 note. */
const MERGE = 'TwMrg1';

const h = (page: Page) =>
  ({
    select: (ids: string[]) =>
      page.evaluate((i) => (window.__algorhythms as unknown as EditorHook).editor.select(i), ids),
    undo: () => page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo()),
    type: (id: string) =>
      page.evaluate(
        (i) =>
          (window.__algorhythms as unknown as EditorHook).store
            .getState()
            .piece.moments.find((m) => m.id === i)?.type,
        id,
      ),
    count: (id: string) =>
      page.evaluate(
        (i) =>
          (window.__algorhythms as unknown as EditorHook).store
            .getState()
            .piece.moments.find((m) => m.id === i)?.count,
        id,
      ),
    /** Lines sounding at t in the compiled score. */
    active: (t: number) =>
      page.evaluate(
        (x) =>
          (window.__algorhythms as unknown as EditorHook).store
            .getState()
            .compiled.voices.filter((v) =>
              v.lives.some((l) => x >= l.born && (l.died === undefined || x < l.died)),
            ).length,
        t,
      ),
    undoState: () =>
      page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.state.getState()),
  }) as const;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test("a split's Notes is a slider; a drag rewrites it as a chord in one undo entry", async ({
  page,
}) => {
  const app = h(page);
  const insp = page.getByTestId('inspector');
  await app.select([SPLIT]);
  await expect(insp.getByRole('heading')).toContainText('Chord');
  const slider = insp.getByTestId('insp-chord-count-slider');
  // A small count: slider and value label, no text box.
  await expect(slider).toHaveAttribute('min', '1');
  await expect(slider).toHaveAttribute('max', '12');
  await expect(insp.getByTestId('insp-chord-count-value')).toHaveText('5');
  await expect(insp.getByRole('textbox', { name: 'Notes' })).toHaveCount(0);
  await expect.poll(() => app.active(SPLIT_AT + 3)).toBe(5);
  // Selecting it changed nothing.
  expect(await app.type(SPLIT)).toBe('split');

  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = box.x + 8 + (box.width - 16) * (4 / 11);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((box.x + box.width - x0) * i) / 10, y);
  await page.mouse.up();

  await expect.poll(() => app.count(SPLIT)).toBe(12);
  expect(await app.type(SPLIT)).toBe('chord');
  await expect(insp.getByTestId('insp-chord-count-value')).toHaveText('12');
  await expect.poll(() => app.active(SPLIT_AT + 3)).toBe(12);
  expect((await app.undoState()).undoLabel).toBe('Edit note count');

  await app.undo();
  expect(await app.type(SPLIT)).toBe('split');
  expect(await app.count(SPLIT)).toBe(5);
  expect((await app.undoState()).canUndo).toBe(false);
  await expect.poll(() => app.active(SPLIT_AT + 3)).toBe(5);
});

test("a merge's Notes slider steps with the arrow keys, one entry per press", async ({ page }) => {
  const app = h(page);
  const insp = page.getByTestId('inspector');
  await app.select([MERGE]);
  const slider = insp.getByTestId('insp-chord-count-slider');
  await expect(slider).toHaveAttribute('min', '1');
  await expect(insp.getByTestId('insp-chord-count-value')).toHaveText('1');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect.poll(() => app.count(MERGE)).toBe(2);
  expect(await app.type(MERGE)).toBe('chord');
  await slider.press('ArrowRight');
  await expect.poll(() => app.count(MERGE)).toBe(3);
  await expect(insp.getByTestId('insp-chord-count-value')).toHaveText('3');
  await app.undo();
  expect(await app.count(MERGE)).toBe(2);
  await app.undo();
  expect(await app.type(MERGE)).toBe('merge');
  expect((await app.undoState()).canUndo).toBe(false);
});

test('a converted continuous field keeps its box beside the slider', async ({ page }) => {
  const app = h(page);
  const insp = page.getByTestId('inspector');
  await app.select([MERGE]);
  // Arrive → Custom: the glide Length is a 0–20 s slider plus the box.
  await insp
    .getByTestId('insp-arrive-mode')
    .getByRole('button', { name: 'Custom', exact: true })
    .click();
  await expect(insp.getByTestId('insp-glide-length-slider')).toHaveAttribute('max', '20');
  await expect(insp.getByTestId('insp-glide-length')).toBeVisible();
});
