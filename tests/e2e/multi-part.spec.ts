/**
 * PLAN rev 10 (§11.3 Parts): the Part chooser ticks several parts and has an All but these
 * switch; one ticked part writes `{ part }`, several `{ parts }`, the switch `{ exceptParts }`.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface P {
  voices: { id: string; part?: string }[];
  moments: { id: string; target?: unknown }[];
}
interface Hook {
  actions: { loadPiece(p: P): void };
  editor: { select(ids: string[]): void; state: { getState(): { undoLabel: string | null } } };
  store: { getState(): { piece: P } };
}

/** "Drift", a degrees chord in Tidewater Hymn. */
const CHORD = 'Zd0uQh';

const targetOf = (page: Page): Promise<unknown> =>
  page.evaluate(
    (i) =>
      (window.__algorhythms as unknown as Hook).store
        .getState()
        .piece.moments.find((m) => m.id === i)?.target ?? null,
    CHORD,
  );

test('Part chooser: tick two parts, then All but these', async ({ page }) => {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  // Three parts over the pool: Low, Mid, High.
  await page.evaluate((id) => {
    const h = window.__algorhythms as unknown as Hook;
    const p = structuredClone(h.store.getState().piece);
    const names = ['Low', 'Mid', 'High'];
    p.voices.forEach(
      (v, i) => (v.part = names[Math.min(2, Math.floor((3 * i) / p.voices.length))]),
    );
    h.actions.loadPiece(p);
    h.editor.select([id]);
  }, CHORD);

  const insp = page.getByTestId('inspector');
  const chooser = insp.getByTestId('insp-part');
  const chip = (part: string) => chooser.locator(`button[data-part="${part}"]`);
  const except = insp.getByTestId('insp-part-except');
  await expect(chip('')).toHaveAttribute('aria-pressed', 'true');
  await expect(except).toBeDisabled();

  await chip('Low').click();
  expect(await targetOf(page)).toEqual({ part: 'Low' });
  await chip('High').click();
  expect(await targetOf(page)).toEqual({ parts: ['Low', 'High'] });
  await expect(chip('Low')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('High')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('')).toHaveAttribute('aria-pressed', 'false');
  await expect(insp.getByTestId('insp-head-part')).toHaveText(/Low, High/);

  await except.check();
  expect(await targetOf(page)).toEqual({ exceptParts: ['Low', 'High'] });
  await expect(insp.getByTestId('insp-head-part')).toHaveText(/all but Low, High/);
  await expect(page.locator(`.lane-item[data-moment="${CHORD}"]`)).toHaveAttribute(
    'title',
    /Part: all but Low, High/,
  );

  // Each change is one undo entry.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  expect(await targetOf(page)).toEqual({ parts: ['Low', 'High'] });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await targetOf(page)).toEqual({ part: 'Low' });

  // All clears the ticks.
  await chip('').click();
  expect(await targetOf(page)).toBeNull();
});
