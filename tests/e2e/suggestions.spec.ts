/**
 * M4.5-13 next-move suggestions (PLAN.md §11.3 revision 6): the "Next" strip shows 3–4 moves for
 * the time after the selected moment (or the playhead); a click adds one (one undo entry) and
 * selects it; hovering previews it.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

/** Four voices split apart at 0 s, a unison at 2 s (0.5 s glide); no grid. */
async function open(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    const view = { ...p.view };
    delete view.gridBpm;
    p.view = view;
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

interface PreviewState {
  label: string | null;
  playing: boolean;
  from: number;
}
/** The preview debug state (not in the e2e Hook type). */
const previewOf = (page: Page): Promise<PreviewState> =>
  page.evaluate(() => {
    const p = (window.__algorhythms as unknown as { preview: PreviewState }).preview;
    return { label: p.label, playing: p.playing, from: p.from };
  });

const moments = (page: Page) =>
  page.evaluate(() =>
    window.__algorhythms!.store.getState().piece.moments.map((m) => ({ id: m.id, at: m.at })),
  );
/** Selection and undo label (the editor hook is not in the e2e Hook type). */
const editorOf = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      editor: { state: { getState(): { selection: string[]; undoLabel: string } } };
    };
    const s = h.editor.state.getState();
    return { selection: s.selection, undoLabel: s.undoLabel };
  });

test('the strip follows the selection; click adds and selects, undo removes', async ({ page }) => {
  await open(page);
  const strip = page.getByTestId('suggestions');
  await expect(strip).toBeVisible();

  // Nothing selected: at the playhead (1 s, voices apart).
  await seek(page, 1);
  await expect(strip).toHaveAttribute('data-t', '1');
  const items = strip.locator('[data-suggestion]');
  await expect.poll(() => items.count()).toBeGreaterThanOrEqual(3);

  // The unison selected: after its end, the suggestions open it into a chord.
  await page.evaluate(() => window.__algorhythms!.actions.select(['uni001']));
  await expect.poll(async () => Number(await strip.getAttribute('data-t'))).toBeGreaterThan(2.4);
  await expect(items.first()).toHaveText(/Open to /);
  const t = Number(await strip.getAttribute('data-t'));

  const before = await moments(page);
  await items.first().click();
  const after = await moments(page);
  expect(after).toHaveLength(before.length + 1);
  const added = after.find((m) => !before.some((b) => b.id === m.id))!;
  expect(added.at).toBeCloseTo(t, 3);
  expect((await editorOf(page)).selection).toEqual([added.id]);
  // The strip moves on to after the new moment.
  await expect.poll(async () => Number(await strip.getAttribute('data-t'))).toBeGreaterThan(t);
  expect((await editorOf(page)).undoLabel).toMatch(/^Open to /);

  await page.keyboard.press('ControlOrMeta+z');
  expect(await moments(page)).toEqual(before);
});

test('hovering a suggestion previews it without touching the piece', async ({ page }) => {
  await open(page);
  await seek(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.audio))
    .toBe('ready');
  const piece = await page.evaluate(() => window.__algorhythms!.store.getState().piece);
  await expect(page.getByTestId('suggestions')).toHaveAttribute('data-t', '1');
  const first = page.getByTestId('suggestions').locator('[data-suggestion="0"]');
  await expect(first).toBeVisible();
  const label = await first.getAttribute('data-label');
  await first.hover();
  await expect.poll(async () => (await previewOf(page)).label).toBe(label);
  await expect.poll(async () => (await previewOf(page)).playing).toBe(true);
  await expect.poll(async () => (await previewOf(page)).from).toBe(1);

  await page.mouse.move(2, 400);
  await expect.poll(async () => (await previewOf(page)).label).toBeNull();
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().piece)).toEqual(piece);
});
