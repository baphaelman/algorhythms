/**
 * M4.5-12 context-aware moments (PLAN.md §11.3 revision 6): a no-effect moment is dimmed on the
 * lane with its reason; the palette greys out types with no effect at the playhead; hovering an
 * enabled type previews it without touching the piece or the undo history.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface PreviewState {
  type: string | null;
  playing: boolean;
  count: number;
}
const previewOf = (page: Page): Promise<PreviewState> =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as { preview: PreviewState };
    return { type: h.preview.type, playing: h.preview.playing, count: h.preview.count };
  });
const editorState = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      editor: { state: { getState(): { canUndo: boolean; undoLabel: string } } };
    };
    const s = h.editor.state.getState();
    return { canUndo: s.canUndo, undoLabel: s.undoLabel };
  });

/** Opens a piece: four voices at 0 s, a unison at 2 s and a merge at 10 s (on the unison, so no effect); no grid. */
async function openUnison(page: Page): Promise<void> {
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
      { id: 'mrg001', type: 'merge', at: 10, count: 1, which: 'top', fade: 1 },
    ];
    h.actions.loadPiece(p);
  });
  // A first gesture primes the audio engine.
  await page.locator('body').click({ position: { x: 2, y: 2 } });
}

test('a no-effect moment is dimmed on the lane, with the reason as tooltip and in the inspector', async ({
  page,
}) => {
  await openUnison(page);
  const merge = page.getByTestId('lane').locator('[data-moment="mrg001"]');
  await expect(merge).toHaveAttribute('data-no-effect', 'true');
  await expect(merge).toHaveAttribute('title', /No effect: all voices already on one pitch/);
  await expect(page.getByTestId('lane').locator('[data-moment="uni001"]')).not.toHaveAttribute(
    'data-no-effect',
  );
  await page.evaluate(() => window.__algorhythms!.actions.select(['mrg001']));
  await expect(page.getByTestId('insp-diags').locator('[data-code="no-effect"]')).toHaveText(
    /No effect: all voices already on one pitch/,
  );
});

test('the palette greys out merge on a unison and enables it elsewhere', async ({ page }) => {
  await openUnison(page);
  const palette = page.getByTestId('palette');
  const merge = palette.locator('[data-moment="merge"]');
  await seek(page, 5);
  await expect(merge).toHaveAttribute('aria-disabled', 'true');
  await expect(merge).toHaveAttribute('title', /all voices already on one pitch/);
  await expect(palette.locator('[data-moment="chord"]')).not.toHaveAttribute('aria-disabled');

  // Disabled for click and shortcut at the playhead.
  const n = await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length);
  await merge.click({ force: true }); // aria-disabled: Playwright would wait
  await page.keyboard.press('m');
  expect(
    await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length),
  ).toBe(n);

  // Before the unison the voices are apart: merge is enabled again.
  await seek(page, 1);
  await expect(merge).not.toHaveAttribute('aria-disabled');
  await expect(merge).toHaveAttribute('title', /Fold voices together/);
});

test('hovering an enabled item previews it and leaves the piece and history alone', async ({
  page,
}) => {
  await openUnison(page);
  await seek(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.audio))
    .toBe('ready');
  const piece = await page.evaluate(() => window.__algorhythms!.store.getState().piece);
  const before = await editorState(page);

  const chord = page.getByTestId('palette').locator('[data-moment="chord"]');
  await expect(chord).not.toHaveAttribute('aria-disabled');
  await chord.hover();
  await expect.poll(async () => (await previewOf(page)).type).toBe('chord');
  await expect.poll(async () => (await previewOf(page)).playing).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.engine()?.isPlaying))
    .toBe(true);
  // The store's transport is not playing: the preview is outside it.
  expect(
    await page.evaluate(() => window.__algorhythms!.store.getState().transport.status),
  ).not.toBe('playing');

  // Leaving the item stops it.
  await page.mouse.move(2, 400);
  await expect.poll(async () => (await previewOf(page)).type).toBeNull();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.engine()?.isPlaying))
    .toBe(false);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().piece)).toEqual(piece);
  expect(await editorState(page)).toEqual(before);

  // A disabled item does not preview.
  await seek(page, 5);
  const merge = page.getByTestId('palette').locator('[data-moment="merge"]');
  await expect(merge).toHaveAttribute('aria-disabled', 'true');
  const count = (await previewOf(page)).count;
  await merge.hover();
  await page.waitForTimeout(600);
  expect((await previewOf(page)).count).toBe(count);
});
