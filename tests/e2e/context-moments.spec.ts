/**
 * M4.5-12 context-aware moments (PLAN.md §11.3 revision 6): a no-effect moment is dimmed on the
 * lane with its reason; the palette greys out types with no effect at the playhead; hovering an
 * enabled type previews it silently on the score without touching the piece or the undo history.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface PreviewState {
  type: string | null;
  shown: boolean;
  count: number;
}
const previewOf = (page: Page): Promise<PreviewState> =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      preview: { type: string | null; ghost: object | null; count: number };
    };
    return { type: h.preview.type, shown: h.preview.ghost !== null, count: h.preview.count };
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
  await page.goto('./?example=tidewater-hymn');
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
      ...(p.moments as { id: string }[]).filter((m) => m.id === 'start0'), // the opening (v2)
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
  await expect(merge).toHaveAttribute('title', /No effect: only one note is sounding\./);
  await expect(page.getByTestId('lane').locator('[data-moment="uni001"]')).not.toHaveAttribute(
    'data-no-effect',
  );
  await page.evaluate(() => window.__algorhythms!.actions.select(['mrg001']));
  await expect(page.getByTestId('insp-diags').locator('[data-code="no-effect"]')).toHaveText(
    /No effect: only one note is sounding\./,
  );
});

/** Opens an empty piece (nothing sounds), no grid. */
async function openSilent(page: Page): Promise<void> {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    const view = { ...p.view };
    delete view.gridBpm;
    p.view = view;
    p.moments = [];
    h.actions.loadPiece(p);
  });
  await page.locator('body').click({ position: { x: 2, y: 2 } });
}

test('the palette greys out Texture over silence and enables it once a chord sounds', async ({
  page,
}) => {
  await openSilent(page);
  const palette = page.getByTestId('palette');
  const texture = palette.locator('[data-moment="pulse"]');
  await seek(page, 0);
  await expect(texture).toHaveAttribute('aria-disabled', 'true');
  await expect(texture).toHaveAttribute(
    'title',
    /Texture: No effect here: .*\(drag to another time\)/,
  );
  await expect(palette.locator('[data-moment="chord"]')).not.toHaveAttribute('aria-disabled');

  // Disabled for click, shortcut and hover preview at the playhead.
  const n = await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length);
  await texture.click({ force: true }); // aria-disabled: Playwright would wait
  await page.keyboard.press('t');
  expect(
    await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length),
  ).toBe(n);
  const count = (await previewOf(page)).count;
  await texture.hover();
  await page.waitForTimeout(600);
  expect((await previewOf(page)).count).toBe(count);

  // A chord sounds: Texture is enabled again.
  await page.mouse.move(2, 400);
  await page.keyboard.press('c');
  await expect(texture).not.toHaveAttribute('aria-disabled');
  await expect(texture).toHaveAttribute('title', /How the chords play \(T\)/);
});

test('hovering an enabled item previews it and leaves the piece and history alone', async ({
  page,
}) => {
  await openUnison(page);
  // On the unison (one note): a chord has an effect there.
  await seek(page, 6);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.audio))
    .toBe('ready');
  const piece = await page.evaluate(() => window.__algorhythms!.store.getState().piece);
  const before = await editorState(page);

  const chord = page.getByTestId('palette').locator('[data-moment="chord"]');
  await expect(chord).not.toHaveAttribute('aria-disabled');
  await chord.hover();
  await expect.poll(async () => (await previewOf(page)).type).toBe('chord');
  await expect.poll(async () => (await previewOf(page)).shown).toBe(true);
  // Shown on the score, and heard as a hover audition (M13 "Hover to hear"; was silent).
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.preview))
    .toBeCloseTo(6, 3);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__algorhythms as unknown as { audition: { kind: string | null } }).audition.kind,
      ),
    )
    .toBe('hover');

  // Leaving the item stops it.
  await page.mouse.move(2, 400);
  await expect.poll(async () => (await previewOf(page)).type).toBeNull();
  await expect
    .poll(() => page.evaluate(() => Number.isNaN(window.__algorhythms!.frameStats.preview)))
    .toBe(true);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().piece)).toEqual(piece);
  expect(await editorState(page)).toEqual(before);
});
