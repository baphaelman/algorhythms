/**
 * R9-6 parts UI (PLAN.md §11.3 revision 9): build parts in the Notes drawer, choose a part in the
 * inspector, rename it (targets follow, one undo entry) and set a whole-part timbre.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface V {
  id: string;
  timbre: string;
  part?: string;
}
interface Hook {
  editor: { select(ids: string[]): void; undo(): boolean };
  store: { getState(): { piece: { voices: V[]; moments: { id: string; target?: unknown }[] } } };
}

const voices = (page: Page): Promise<V[]> =>
  page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.voices);
const targetOf = (page: Page, id: string): Promise<unknown> =>
  page.evaluate(
    (i) =>
      (window.__algorhythms as unknown as Hook).store
        .getState()
        .piece.moments.find((m) => m.id === i)?.target ?? null,
    id,
  );
const select = (page: Page, id: string) =>
  page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select([i]), id);
const undo = async (page: Page): Promise<void> => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
};

/** "Drift", a degrees chord in Tidewater Hymn. */
const CHORD = 'Zd0uQh';

test('parts: build, choose in the inspector, rename, whole-part timbre', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const insp = page.getByTestId('inspector');

  // No parts: no Part chooser, no Part column.
  await select(page, CHORD);
  await expect(insp.getByTestId('insp-part')).toHaveCount(0);
  await page.getByTestId('voices-toggle').click();
  const drawer = page.getByTestId('voices-drawer');
  await expect(drawer.getByTestId('part-group')).toHaveCount(0);

  // New part puts every note in Part 1; the last two move to a new part, Part 2.
  const vs = await voices(page);
  const [a, b] = [vs.at(-2)!.id, vs.at(-1)!.id];
  await drawer.getByTestId('new-part').click();
  await expect(drawer.getByTestId('part-group')).toHaveCount(1);
  await drawer.getByTestId(`part-${a}`).selectOption({ label: 'New part…' });
  await drawer.getByTestId(`part-${b}`).selectOption('Part 2');
  const groups = drawer.getByTestId('part-group');
  await expect(groups).toHaveCount(2);
  const p2 = drawer.locator('[data-testid="part-group"][data-part="Part 2"]');
  await expect(p2.locator('tr[data-voice]')).toHaveCount(2);
  expect((await voices(page)).filter((v) => v.part === 'Part 2').map((v) => v.id)).toEqual([a, b]);

  // Inspector: choose Part 2; header and lane tooltip name it.
  const chooser = insp.getByTestId('insp-part');
  const chip = (part: string) => chooser.locator(`button[data-part="${part}"]`);
  await expect(chip('')).toHaveAttribute('aria-pressed', 'true');
  await chip('Part 2').click();
  expect(await targetOf(page, CHORD)).toEqual({ part: 'Part 2' });
  await expect(insp.getByTestId('insp-head-part')).toHaveText(/Part 2/);
  await expect(page.locator(`.lane-item[data-moment="${CHORD}"]`)).toHaveAttribute(
    'title',
    /Part: Part 2/,
  );
  // Core's diagnostics for the part-targeted moment (no-effect reasons included) reach the UI.
  const diags = await page.evaluate(
    (i) =>
      (
        window.__algorhythms as unknown as {
          store: {
            getState(): { compiled: { diagnostics: { momentId?: string; code: string }[] } };
          };
        }
      ).store
        .getState()
        .compiled.diagnostics.filter((d) => d.momentId === i)
        .map((d) => d.code),
    CHORD,
  );
  await expect(insp.locator('[data-testid="insp-diags"] li')).toHaveCount(diags.length);
  const lane = page.locator(`.lane-item[data-moment="${CHORD}"]`);
  if (diags.includes('no-effect')) await expect(lane).toHaveAttribute('data-no-effect', 'true');
  else await expect(lane).not.toHaveAttribute('data-no-effect');

  // Rename: the target follows, and one undo restores both.
  const name = p2.getByTestId('part-name');
  await name.fill('Bass');
  await name.press('Enter');
  await expect(drawer.locator('[data-part="Bass"]').first()).toBeVisible();
  expect(await targetOf(page, CHORD)).toEqual({ part: 'Bass' });
  await expect(chip('Bass')).toHaveAttribute('aria-pressed', 'true');
  await expect(insp.getByTestId('insp-head-part')).toHaveText(/Bass/);
  await undo(page);
  expect(await targetOf(page, CHORD)).toEqual({ part: 'Part 2' });
  expect((await voices(page)).filter((v) => v.part === 'Part 2')).toHaveLength(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await targetOf(page, CHORD)).toEqual({ part: 'Bass' });

  // Whole-part timbre: only Bass changes; the all-notes menu then reads Mixed.
  const bass = drawer.locator('[data-testid="part-group"][data-part="Bass"]');
  const before = await voices(page);
  const other = before.at(-1)!.timbre === 'organ' ? 'reed' : 'organ';
  await bass.getByTestId('part-timbre').selectOption(other);
  const after = await voices(page);
  expect(after.filter((v) => v.part === 'Bass').every((v) => v.timbre === other)).toBe(true);
  expect(after.filter((v) => v.part !== 'Bass')).toEqual(before.filter((v) => v.part !== 'Bass'));
  await expect(drawer.getByTestId('timbre-all')).toHaveValue('\u0000mixed');
  await undo(page);
  expect(await voices(page)).toEqual(before);

  // "All" writes the default target.
  await chip('').click();
  expect(await targetOf(page, CHORD)).toBeNull();
  await expect(insp.getByTestId('insp-head-part')).toHaveCount(0);

  // Deleting a targeted part asks inline, then retargets its moments by pick.
  await chip('Bass').click();
  await bass.getByTestId('part-delete').click();
  await expect(drawer.getByRole('alert')).toContainText('1 moment targets Bass');
  await drawer.getByTestId('part-delete-confirm').click();
  expect(await targetOf(page, CHORD)).toEqual({ voices: [a, b] });
  await expect(groups).toHaveCount(2); // Part 1 and Unassigned
});
