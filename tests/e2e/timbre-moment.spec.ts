/**
 * M6-b3 timbre moment in the editor (PLAN.md §11.2 Effects row, §11.3, §15 M6): add one from the
 * palette, change its preset and fade in the inspector, see its bar on the Effects row (shown only
 * while the piece has one), drag its end, undo it all; renaming the piece's own timbre in the
 * Sound drawer renames its moments, deleting it leaves them `unknown-timbre`. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';
import { shot } from './shots';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  preset?: string;
  fade?: number;
}

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { undoLabel: string } };
  };
  store: { getState(): { piece: { moments: M[]; voices: { timbre: string }[] } } };
}

const H = (page: Page) => ({
  piece: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  undoLabel: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
});

const timbres = async (page: Page): Promise<M[]> =>
  (await H(page).piece()).moments.filter((m) => m.type === 'timbre');

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Score px per second. */
async function pps(page: Page): Promise<number> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  return (await page.locator('#score').boundingBox())!.width / s.window;
}

/** True when the centre of `sel`'s first match lies inside lane row `row`. */
async function inRow(page: Page, sel: string, row: string): Promise<boolean> {
  const r = await page.locator(`[data-row="${row}"]`).boundingBox();
  const m = await page.locator(sel).first().boundingBox();
  if (!r || !m) return false;
  const y = m.y + m.height / 2;
  return y >= r.y && y <= r.y + r.height;
}

test('the palette fits one row at 1280 px with the Sound entry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  const buttons = page.getByTestId('palette').getByRole('button');
  await expect(buttons).toHaveCount(6);
  await expect(page.getByTestId('palette').locator('[data-moment="timbre"]')).toHaveAttribute(
    'aria-keyshortcuts',
    'S',
  );
  const tops = await buttons.evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
});

test('add a timbre change, edit preset and fade, see it on the Effects row, undo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const effects = page.locator('[data-row="effects"]');
  await expect(effects).toBeHidden();
  const before = (await H(page).piece()).voices.map((v) => v.timbre);

  // Palette click at the playhead: a preset the notes don't play, fading over 2 s.
  await seek(page, 10);
  await page.getByTestId('palette').locator('[data-moment="timbre"]').click();
  const [added] = await timbres(page);
  expect(added.at).toBeCloseTo(10, 3);
  expect(added.fade).toBe(2);
  expect(before).not.toContain(added.preset);
  expect(await H(page).undoLabel()).toBe('Add timbre change');
  const insp = page.getByTestId('inspector');
  await expect(insp.getByRole('heading')).toContainText('Sound');

  // Its own row, under Level, labelled with the preset; the bar spans the fade.
  await expect(effects).toBeVisible();
  const item = page.getByTestId('lane').locator(`[data-moment="${added.id}"]`);
  await expect(item).toHaveAttribute('data-lane', 'effects');
  await expect(item.locator('.lane-label')).toHaveText(added.preset!);
  await expect
    .poll(() => inRow(page, `[data-moment="${added.id}"] .lane-marker`, 'effects'))
    .toBe(true);
  const level = (await page.locator('[data-row="level"]').boundingBox())!;
  expect((await effects.boundingBox())!.y).toBeGreaterThanOrEqual(level.y + level.height - 1);
  const k = await pps(page);
  const bar = item.locator('.lane-bar');
  expect((await bar.boundingBox())!.width).toBeCloseTo(2 * k, -1);

  // Inspector: preset menu (piece timbres and built-ins), then the fade.
  const preset = insp.getByTestId('insp-timbre-preset');
  await expect(preset.locator('option[value="bell"]')).toHaveCount(1);
  await expect(preset.locator('option[value="glass"]')).toHaveCount(1);
  await preset.selectOption('bell');
  expect((await timbres(page))[0].preset).toBe('bell');
  expect(await H(page).undoLabel()).toBe('Change timbre');
  await expect(item.locator('.lane-label')).toHaveText('bell');
  const fade = insp.getByTestId('insp-timbre-fade');
  await expect(fade).toHaveValue('2');
  await fade.fill('4');
  await fade.press('Enter');
  expect((await timbres(page))[0].fade).toBe(4);
  await expect.poll(async () => (await bar.boundingBox())!.width).toBeGreaterThan(3.5 * k);
  expect((await bar.boundingBox())!.width).toBeCloseTo(4 * k, -1);
  await shot(page, 'timbre-moment.png');
  // The default target (all notes) shows as All in Advanced; no transition or seed fields.
  await expect(insp.getByTestId('insp-advanced')).toHaveCount(1);
  await expect(insp.getByTestId('insp-seed')).toHaveCount(0);
  await expect(insp.getByTestId('insp-transition')).toHaveCount(0);

  // Drag the bar's end 1 s left: the fade gets shorter (one undo entry).
  await item.hover();
  const end = (await item.locator('.lane-end').boundingBox())!;
  const x = end.x + end.width / 2;
  const y = end.y + end.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - k / 2, y, { steps: 4 });
  await page.mouse.move(x - k, y, { steps: 4 });
  await page.mouse.up();
  expect((await timbres(page))[0].fade).toBeCloseTo(3, 1);
  expect(await H(page).undoLabel()).toBe('Change fade');

  // Undo: fade drag, fade, preset, add. The Effects row goes with the moment.
  for (let i = 0; i < 3; i++) expect(await H(page).undo()).toBe(true);
  expect(await timbres(page)).toEqual([added]);
  expect(await H(page).undo()).toBe(true);
  expect(await timbres(page)).toEqual([]);
  await expect(effects).toBeHidden();
});

test('renaming the piece’s own timbre in the Sound drawer renames its moments; delete leaves them unknown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  // The piece's own `mine` (no note uses it) and a change to it at 10 s.
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      timbres: Record<string, unknown>;
      moments: unknown[];
    };
    p.timbres.mine = structuredClone(Object.values(p.timbres)[0]);
    p.moments.push({ id: 'tmb1', type: 'timbre', at: 10, preset: 'mine', fade: 2 });
    h.actions.loadPiece(p);
  });
  await page.getByTestId('sound-toggle').click();
  await page.getByTestId('sound-timbre').selectOption('mine');
  await expect(page.getByTestId('sound-users')).toHaveText('No notes use it · 1 timbre change');

  // A taken name is refused; Enter on a free one renames the timbre and the moment together.
  await page.getByTestId('sound-rename').click();
  const name = page.getByTestId('sound-name');
  await expect(name).toBeFocused();
  await name.fill('bell');
  await name.press('Enter');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await name.fill('warm pad');
  await name.press('Enter');
  await expect(page.getByTestId('sound-timbre')).toHaveValue('warm pad');
  expect((await timbres(page))[0].preset).toBe('warm pad');
  expect(await H(page).undoLabel()).toBe('Rename timbre');
  await expect(page.getByTestId('lane').locator('[data-moment="tmb1"] .lane-label')).toHaveText(
    'warm pad',
  );
  expect(await H(page).undo()).toBe(true);
  expect((await timbres(page))[0].preset).toBe('mine');

  // Delete: the moment stays and reports its missing timbre.
  await page.getByTestId('sound-timbre').selectOption('mine');
  await page.getByTestId('sound-delete').click();
  expect(await H(page).undoLabel()).toBe('Delete timbre');
  expect((await timbres(page))[0].preset).toBe('mine');
  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.select(['tmb1']));
  await expect(
    page.getByTestId('insp-diags').locator('[data-code="unknown-timbre"]'),
  ).toBeVisible();
  await expect(page.getByTestId('insp-timbre-preset')).toHaveValue('mine');
  await expect(page.getByTestId('insp-timbre-preset').locator('option:checked')).toHaveText(
    'mine (missing)',
  );
});
