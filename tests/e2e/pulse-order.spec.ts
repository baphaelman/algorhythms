/**
 * Pulse mode Custom order (PLAN.md §6.2 `pulse`, revision 10): choose it, type `1 3 2 4`, an
 * inline error for bad input, undo; the lane keeps the accent drawing. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  mode?: string;
  order?: number[];
}

interface Hook {
  editor: { select(ids: string[]): void; undo(): boolean };
  store: { getState(): { piece: { moments: M[] } } };
}

const pulseOf = (page: Page): Promise<M> =>
  page.evaluate(() =>
    (window.__algorhythms as unknown as Hook).store
      .getState()
      .piece.moments.find((m) => m.id === 'pulse1')!,
  );

test('Custom order: type an order, see an error for bad input, undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      end: unknown;
    };
    p.moments = [
      {
        id: 'start0',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [48, 55, 60, 64] },
        voicing: 'even',
        assign: 'ordered',
      },
      {
        id: 'pulse1',
        type: 'pulse',
        at: 4,
        until: 8,
        step: 0.5,
        pattern: [1, 0.5],
        decay: 0.3,
        floor: 0,
        mode: 'together',
      },
    ];
    p.end = { at: 16, fade: 1 };
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.select(['pulse1']));
  await page.getByTestId('insp-texture-more').locator('summary').click();
  const insp = page.getByTestId('inspector');
  await expect(insp.getByTestId('insp-pulse-order')).toHaveCount(0);

  await insp.getByTestId('insp-pulse-mode').getByRole('button', { name: 'Custom order' }).click();
  const field = insp.getByTestId('insp-pulse-order');
  await expect(field).toHaveValue('1 2 3 4');
  expect(await pulseOf(page)).toMatchObject({ mode: 'order', order: [1, 2, 3, 4] });

  await field.fill('1 3 2 4');
  await field.press('Enter');
  expect((await pulseOf(page)).order).toEqual([1, 3, 2, 4]);

  // Bad input: an inline error, nothing committed (Enter or blur).
  await field.fill('1 0 x');
  await expect(insp.getByTestId('insp-pulse-order-feedback')).not.toBeEmpty();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.press('Enter');
  await field.blur();
  expect((await pulseOf(page)).order).toEqual([1, 3, 2, 4]);

  // The lane bar still draws the accent cycle.
  await expect(
    page.getByTestId('lane').locator('[data-moment="pulse1"] .lane-art.lane-pulse'),
  ).toHaveCount(1);

  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo());
  expect((await pulseOf(page)).order).toEqual([1, 2, 3, 4]);
  await expect(field).toHaveValue('1 2 3 4');
});
