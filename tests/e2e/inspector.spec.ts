/**
 * The inspector (PLAN.md §11.3, M4e). The lane isn't built yet, so moments are selected through
 * the debug hook. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough for the inspector');

interface M {
  id: string;
  type: string;
  seed?: number;
  muted?: boolean;
  notes?: { kind: string; symbol?: string };
  glide?: { length?: number };
}

interface EditorHook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { canUndo: boolean; undoLabel: string } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

const hook = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const h = window.__algorhythms as unknown as EditorHook;
      if (f === 'select') h.editor.select(a[0] as string[]);
      if (f === 'undo') return h.editor.undo();
      return null;
    },
    [fn, args] as const,
  );

const moment = (page: Page, id: string): Promise<M | undefined> =>
  page.evaluate((i) => {
    const h = window.__algorhythms as unknown as EditorHook;
    return h.store.getState().piece.moments.find((m) => m.id === i);
  }, id);

const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().undoLabel,
  );

/** "Drift", a degrees chord in the featured example (Tidewater Hymn). */
const CHORD = 'Zd0uQh';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('shows a hint with nothing selected and shared actions for several', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await expect(insp).toContainText('No moment selected');
  await hook(page, 'select', ['tuOzVd', '77O2kG']);
  await expect(insp).toContainText('2 moments selected');
  await insp.getByRole('button', { name: 'Mute all' }).click();
  expect((await moment(page, 'tuOzVd'))?.muted).toBe(true);
  expect((await moment(page, '77O2kG'))?.muted).toBe(true);
  await hook(page, 'undo');
  expect((await moment(page, 'tuOzVd'))?.muted).toBeUndefined();
});

test('edits a chord symbol, glide length and seed; undo restores', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  await expect(insp.locator('[data-moment-id]')).toHaveAttribute('data-moment-id', CHORD);
  await expect(insp.getByRole('heading')).toContainText('Chord');
  await expect(insp.getByTestId('insp-degrees')).toBeVisible();

  // Switch to a chord symbol.
  await insp.getByTestId('insp-notes-kind').selectOption('chord');
  expect((await moment(page, CHORD))?.notes).toEqual({ kind: 'chord', symbol: 'I' });

  // An invalid symbol shows an error and is not committed.
  const chord = insp.getByTestId('insp-chord');
  await chord.fill('Xq7');
  await expect(insp.getByTestId('insp-chord-feedback')).toHaveClass(/field-error/);
  await chord.press('Enter');
  await expect(chord).toHaveAttribute('aria-invalid', 'true');
  expect((await moment(page, CHORD))?.notes?.symbol).toBe('I');

  // A valid one shows its notes as you type and changes the piece on Enter.
  await chord.fill('Dm9');
  await expect(insp.getByTestId('insp-chord-feedback')).toHaveText('D F A C E');
  await chord.press('Enter');
  await expect.poll(async () => (await moment(page, CHORD))?.notes?.symbol).toBe('Dm9');

  // Glide length.
  const length = insp.getByTestId('insp-glide-length');
  await expect(length).toHaveValue('3.1');
  await length.fill('5.5');
  await length.press('Enter');
  expect((await moment(page, CHORD))?.glide?.length).toBe(5.5);

  // Reroll sets an explicit seed and shows it.
  const seedText = await insp.getByTestId('insp-seed').innerText();
  expect((await moment(page, CHORD))?.seed).toBeUndefined();
  await insp.getByTestId('insp-reroll').click();
  const seed = (await moment(page, CHORD))?.seed;
  expect(typeof seed).toBe('number');
  await expect(insp.getByTestId('insp-seed')).toHaveText(String(seed));
  expect(seedText).toContain('derived');

  // Undo walks back each edit, and the form follows.
  expect(await undoLabel(page)).toBe('Reroll');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.seed).toBeUndefined();
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.glide?.length).toBe(3.1);
  await expect(length).toHaveValue('3.1');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.notes?.symbol).toBe('I');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.notes?.kind).toBe('degrees');
});

test('dragging a number label is one undo entry', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const label = insp.locator('label.scrub-label', { hasText: 'Length' });
  const box = (await label.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 10 + i * 4, y);
  await page.mouse.up();
  const after = (await moment(page, CHORD))?.glide?.length ?? 0;
  expect(after).toBeGreaterThan(3.1);
  expect(await undoLabel(page)).toBe('Edit glide length');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.glide?.length).toBe(3.1);
  expect(
    await page.evaluate(
      () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().canUndo,
    ),
  ).toBe(false);
});

test('keyboard: degree picker toggles with Space', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const deg2 = insp.getByRole('button', { name: /^Degree 2 / });
  await expect(deg2).toHaveAttribute('aria-pressed', 'false');
  await deg2.focus();
  await page.keyboard.press('Space');
  await expect(deg2).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate((id) => {
      const h = window.__algorhythms as unknown as {
        store: {
          getState(): { piece: { moments: { id: string; notes?: { degrees?: number[] } }[] } };
        };
      };
      return h.store.getState().piece.moments.find((m) => m.id === id)?.notes?.degrees;
    }, CHORD),
  ).toEqual([0, 1, 2, 4, 6]);
});
