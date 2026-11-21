/**
 * Next-move suggestions (PLAN.md §11.3 revisions 6–7): the "Next" strip shows 3–4 moves for the
 * end of the piece's last moment, whatever the playhead or selection; a click appends one there
 * (one undo entry, extending an explicit end), and selects it; hovering previews it.
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
  shown: boolean;
  from: number;
}
/** The preview debug state (not in the e2e Hook type). */
const previewOf = (page: Page): Promise<PreviewState> =>
  page.evaluate(() => {
    const p = (
      window.__algorhythms as unknown as {
        preview: { label: string | null; ghost: object | null; from: number };
      }
    ).preview;
    return { label: p.label, shown: p.ghost !== null, from: p.from };
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

/** The strip's time. */
const stripT = async (page: Page): Promise<number> =>
  Number(await page.getByTestId('suggestions').getAttribute('data-t'));
/** Waits for the strip to be at the loaded piece's end: after the unison's glide (2 s + 0.5 s). */
const atUnisonEnd = async (page: Page): Promise<void> => {
  await expect
    .poll(async () => {
      const t = await stripT(page);
      return t > 2.4 && t < 5;
    })
    .toBe(true);
};

test('the strip is at the end of the last moment; click appends there; undo removes', async ({
  page,
}) => {
  await open(page);
  const strip = page.getByTestId('suggestions');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Next');
  await expect(strip).toContainText('at end');

  // After the unison's glide (at 2 s), not at the playhead or the selection.
  await atUnisonEnd(page);
  const t = await stripT(page);
  await seek(page, 1);
  await page.evaluate(() => window.__algorhythms!.actions.select(['spl001']));
  await page.waitForTimeout(400);
  expect(await stripT(page)).toBe(t);
  const items = strip.locator('[data-suggestion]');
  await expect.poll(() => items.count()).toBeGreaterThanOrEqual(3);
  await expect(items.first()).toHaveText(/Open to /);

  const before = await moments(page);
  await items.first().click();
  const after = await moments(page);
  expect(after).toHaveLength(before.length + 1);
  const added = after.find((m) => !before.some((b) => b.id === m.id))!;
  expect(added.at).toBeCloseTo(t, 3);
  expect((await editorOf(page)).selection).toEqual([added.id]);
  // The strip moves on to the new end.
  await expect.poll(() => stripT(page)).toBeGreaterThan(t);
  expect((await editorOf(page)).undoLabel).toMatch(/^Open to /);

  await page.keyboard.press('ControlOrMeta+z');
  expect(await moments(page)).toEqual(before);
});

test('appending past an explicit end extends the piece', async ({ page }) => {
  await open(page);
  await atUnisonEnd(page);
  const t = await stripT(page);
  await page.evaluate((end) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      end: Record<string, unknown>;
    };
    p.end = { ...p.end, at: end };
    h.actions.loadPiece(p);
  }, t + 0.5);
  const first = page.getByTestId('suggestions').locator('[data-suggestion="0"]');
  await expect(first).toBeVisible();
  await first.click();
  const end = await page.evaluate(
    () =>
      (window.__algorhythms!.store.getState().piece as unknown as { end: { at: number } }).end.at,
  );
  expect(end).toBeGreaterThanOrEqual(t + 4);
  const diags = await page.evaluate(() =>
    (
      window.__algorhythms!.store.getState().compiled as unknown as {
        diagnostics: { code: string }[];
      }
    ).diagnostics.map((d) => d.code),
  );
  expect(diags).not.toContain('after-end');
});

test('hovering a suggestion previews it silently without touching the piece', async ({ page }) => {
  await open(page);
  await seek(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.audio))
    .toBe('ready');
  const piece = await page.evaluate(() => window.__algorhythms!.store.getState().piece);
  await atUnisonEnd(page);
  const t = await stripT(page);
  const first = page.getByTestId('suggestions').locator('[data-suggestion="0"]');
  await expect(first).toBeVisible();
  const label = await first.getAttribute('data-label');
  await first.hover();
  await expect.poll(async () => (await previewOf(page)).label).toBe(label);
  await expect.poll(async () => (await previewOf(page)).shown).toBe(true);
  expect((await previewOf(page)).from).toBeCloseTo(t, 3);
  // Silent (owner 2026-11-21): the engine is not playing.
  expect(await page.evaluate(() => window.__algorhythms!.engine()?.isPlaying ?? false)).toBe(false);

  await page.mouse.move(2, 400);
  await expect.poll(async () => (await previewOf(page)).label).toBeNull();
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().piece)).toEqual(piece);
});
