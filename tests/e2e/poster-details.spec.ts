/**
 * The poster workspace's details (PLAN.md §15 M14, the owner's notes; M14 P6): a switch's
 * disclosure styles its group in place (remembered); Full revert in the right panel's bar resets the poster as
 * one undo step; the background gradient's handles on the artboard (linear ends and stops,
 * radial centre), each drag one undo step and shown in the PNG.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import './app-hook';
import { chooseSegment, clickExportForDownload, setRange } from './export-diag';
import { openPoster, workspace } from './export-open';

const posterOf = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(
      JSON.stringify(
        (window.__algorhythms!.store.getState().piece as { poster?: unknown }).poster ?? null,
      ),
    ),
  );

/** The artboard's pixels, summed by channel (changes when anything drawn changes). */
const artboardSum = (page: Page) =>
  page.getByTestId('preview-canvas').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7;
    return s;
  });

const pulseSize = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __algorhythms: {
            posterWorkspace: {
              getState(): { layout: { marks: { pulseMarks: { size: number } } } | null };
            };
          };
        }
      ).__algorhythms.posterWorkspace.getState().layout?.marks.pulseMarks.size ?? null,
  );

/** A PNG's pixels (r, g, b) at fractions of its size, decoded in the page. */
async function pngAt(page: Page, bytes: Buffer, points: [number, number][]) {
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      return pts.map(([x, y]) => {
        const d = g.getImageData(
          Math.round(x * (bmp.width - 1)),
          Math.round(y * (bmp.height - 1)),
          1,
          1,
        ).data;
        return [d[0], d[1], d[2]];
      });
    },
    [bytes.toString('base64'), points] as const,
  );
}

async function exportPng(page: Page): Promise<Buffer> {
  const dl = await clickExportForDownload(page);
  expect(dl.suggestedFilename()).toMatch(/\.png$/);
  return readFileSync(await dl.path());
}

const reddish = ([r, g, b]: number[]) => r > 150 && r > g + 60 && r > b + 60;
const bluish = ([r, g, b]: number[]) => b > 150 && b > r + 60 && b > g + 60;
const greenish = ([r, g, b]: number[]) => g > 120 && g > r + 40 && g > b + 40;

async function hex(page: Page, testId: string, value: string): Promise<void> {
  const f = page.getByTestId(`${testId}-hex`);
  await f.fill(value);
  await f.press('Enter');
}

/** Drags handle `testId` by (dx, dy) page px. */
async function dragBy(page: Page, testId: string, dx: number, dy: number): Promise<void> {
  const b = (await page.getByTestId(testId).boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

/** Drags handle `testId` to fractions (fx, fy) of the artboard. */
async function dragTo(page: Page, testId: string, fx: number, fy: number): Promise<void> {
  const a = (await page.getByTestId('preview-canvas').boundingBox())!;
  const b = (await page.getByTestId(testId).boundingBox())!;
  await dragBy(
    page,
    testId,
    a.x + fx * a.width - (b.x + b.width / 2),
    a.y + fy * a.height - (b.y + b.height / 2),
  );
}

const undo = (page: Page) => workspace(page).getByTestId('undo').click();
const redo = (page: Page) => workspace(page).getByTestId('redo').click();

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'editing: once per engine');
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect.poll(() => pulseSize(page)).not.toBeNull();
});

test("a switch's disclosure styles its group in place; remembered; one undo step", async ({
  page,
}) => {
  const sw = page.getByTestId('look-pulse');
  if (!(await sw.isChecked())) await sw.click();
  const btn = page.getByTestId('details-pulseMarks');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('details-panel-pulseMarks')).toHaveCount(0);
  // Keyboard: Enter opens it.
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByTestId('details-panel-pulseMarks');
  await expect(panel).toBeVisible();
  await expect(btn).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!);
  // The same fields as selecting the group: Length, Width, Opacity, Colour.
  for (const f of ['size', 'width', 'opacity', 'colour'])
    await expect(panel.getByTestId(`det-pulseMarks-${f}`)).toHaveCount(1);

  const before = await artboardSum(page);
  await setRange(page, 'det-pulseMarks-size', 300);
  await expect.poll(() => pulseSize(page)).toBe(3);
  expect((await posterOf(page)).groups.pulseMarks.size).toBe(3);
  await expect.poll(() => artboardSum(page)).not.toBe(before);
  // The selection panel shows the same value.
  await page.locator('[data-testid=layer-group][data-group=pulseMarks] .ws-layer-name').click();
  await expect(page.getByTestId('sel-size')).toHaveValue('300');

  await undo(page);
  await expect.poll(() => pulseSize(page)).toBe(1);
  await expect.poll(() => artboardSum(page)).toBe(before);

  // The open disclosures are remembered for this viewer.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect(page.getByTestId('details-pulseMarks')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('details-panel-pulseMarks')).toBeVisible();
  await page.getByTestId('details-pulseMarks').click();
  await expect(page.getByTestId('details-panel-pulseMarks')).toHaveCount(0);

  // Labels and lines: each switch has one too.
  await page.getByTestId('details-guideLabels').click();
  await expect(
    page.getByTestId('details-panel-guideLabels').getByTestId('det-guideLabels-size'),
  ).toBeVisible();
});

test('Full revert stays visible, resets to the default poster and undoes in one step', async ({
  page,
}) => {
  await setRange(page, 'margin-all', 12);
  await page.getByTestId('rows-by').getByLabel('By sections', { exact: true }).click();
  await page.getByTestId('details-pulseMarks').click();
  await setRange(page, 'det-pulseMarks-width', 200);
  await expect.poll(async () => (await posterOf(page))?.groups?.pulseMarks?.width).toBe(2);
  const edited = await posterOf(page);
  expect(edited.rowsBy).toBe('sections');

  // Scrolled to the panel's end, the bar is still on screen, and the top bar has no Revert.
  await page.getByTestId('poster-options').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId('look-reset')).toBeInViewport();
  await expect(page.getByTestId('poster-savebar')).toBeInViewport();
  await expect(page.getByTestId('ws-bar').getByTestId('poster-revert')).toHaveCount(0);
  const full = page.getByTestId('poster-full-revert');
  await expect(full).toBeInViewport();
  await full.click();
  expect(await posterOf(page)).toEqual({ look: { theme: 'light' } });
  await expect(page.getByTestId('poster-reverted')).toContainText('Reverted');
  await expect(page.getByTestId('poster-revert-undo')).toBeFocused();
  // The panel shows the defaults again.
  await expect(page.getByTestId('rows-by').getByLabel('Equal', { exact: true })).toBeChecked();
  await expect(page.getByTestId('margin-all')).toHaveValue('6');

  // One step back.
  await page.getByTestId('poster-revert-undo').click();
  expect(await posterOf(page)).toEqual(edited);
  await expect(
    page.getByTestId('rows-by').getByLabel('By sections', { exact: true }),
  ).toBeChecked();
  await expect(page.getByTestId('poster-full-revert')).toBeFocused();
  // Redo reverts again; the workspace's Undo takes it back too.
  await redo(page);
  expect(await posterOf(page)).toEqual({ look: { theme: 'light' } });
  await expect(page.getByTestId('poster-full-revert')).toBeDisabled();
  await undo(page);
  expect(await posterOf(page)).toEqual(edited);
});

test('Save makes a save point, Revert returns to it, each undoes', async ({ page }) => {
  const save = page.getByTestId('poster-save');
  const revert = page.getByTestId('poster-revert');
  // Nothing to revert yet: the poster is as it was when the workspace opened.
  await expect(revert).toBeDisabled();
  await setRange(page, 'margin-all', 12);
  const one = await posterOf(page);
  await expect(revert).toBeEnabled();
  await expect(save).toHaveText('Save');
  await save.click();
  await expect(save).toHaveText('Saved');
  await expect(save).toBeDisabled();
  await expect(revert).toBeDisabled();
  // Save is one undo step.
  await undo(page);
  await expect(save).toHaveText('Save');
  expect(await posterOf(page)).toEqual(one);
  await redo(page);
  await expect(save).toHaveText('Saved');

  // Edit past the save point; Revert returns to it, as one step.
  await page.getByTestId('rows-by').getByLabel('By sections', { exact: true }).click();
  await expect(save).toHaveText('Save');
  await revert.click();
  expect(await posterOf(page)).toEqual(one);
  await expect(save).toHaveText('Saved');
  await undo(page);
  expect((await posterOf(page)).rowsBy).toBe('sections');
  await redo(page);
  expect(await posterOf(page)).toEqual(one);

  // Full revert goes past the save point to the defaults; Revert then returns to it.
  await page.getByTestId('poster-full-revert').click();
  expect(await posterOf(page)).toEqual({ look: { theme: 'light' } });
  await revert.click();
  expect(await posterOf(page)).toEqual(one);
});

test('a selection takes the whole right panel; the save bar stays; clearing returns the poster options', async ({
  page,
}) => {
  await expect(page.getByTestId('poster-options')).toBeVisible();
  await page.locator('[data-testid=layer-group][data-group=pulseMarks] .ws-layer-name').click();
  await expect(page.getByTestId('selection-title')).toContainText('Pulse marks');
  await expect(page.getByTestId('poster-options')).toHaveCount(0);
  await expect(page.getByTestId('poster-savebar')).toBeInViewport();
  await page.getByRole('button', { name: 'Clear the selection' }).click();
  await expect(page.getByTestId('poster-options')).toBeVisible();
  await expect(page.getByTestId('selection-panel')).toHaveCount(0);
  await expect(page.getByTestId('poster-savebar')).toBeInViewport();
});

test('gradient handles: linear ends and stops, the radial centre; one undo step each; in the PNG', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chooseSegment(page, 'look-bg', 'Gradient');
  await chooseSegment(page, 'bg-shape', 'Linear');
  await setRange(page, 'bg-angle', 90);
  await hex(page, 'bg-stop-0', '#ff0000');
  await hex(page, 'bg-stop-1', '#0000ff');
  await expect(page.getByTestId('gradient-handles')).toHaveAttribute('data-shape', 'linear');

  // The end (right edge) dragged to the bottom: 90° → 180°, red at the top, blue at the bottom.
  await dragTo(page, 'gradient-end', 0.5, 1);
  await expect(page.getByTestId('bg-angle')).toHaveValue('180');
  await undo(page);
  await expect(page.getByTestId('bg-angle')).toHaveValue('90');
  await redo(page);
  await expect(page.getByTestId('bg-angle')).toHaveValue('180');
  let px = await pngAt(page, await exportPng(page), [
    [0.5, 0.002],
    [0.5, 0.998],
  ]);
  expect(reddish(px[0]), String(px[0])).toBe(true);
  expect(bluish(px[1]), String(px[1])).toBe(true);

  // A green stop in the middle, dragged towards the start: green near the top.
  await setRange(page, 'bg-angle', 90);
  await page.getByTestId('bg-stop-add').click();
  await hex(page, 'bg-stop-2', '#00ff00');
  await expect(page.getByTestId('bg-stop-2-at')).toHaveValue('50');
  await dragTo(page, 'gradient-stop-2', 0.1, 0.5);
  await expect
    .poll(async () => Number(await page.getByTestId('bg-stop-2-at').inputValue()))
    .toBeLessThan(13);
  expect(Number(await page.getByTestId('bg-stop-2-at').inputValue())).toBeGreaterThan(7);
  await expect(page.getByTestId('bg-angle')).toHaveValue('90');
  await undo(page);
  await expect(page.getByTestId('bg-stop-2-at')).toHaveValue('50');
  await redo(page);
  px = await pngAt(page, await exportPng(page), [[0.1, 0.002]]);
  expect(greenish(px[0]), String(px[0])).toBe(true);

  // Radial: the centre dragged to the top left; red there, blue in the far corner.
  await chooseSegment(page, 'bg-shape', 'Radial');
  await expect(page.getByTestId('gradient-handles')).toHaveAttribute('data-shape', 'radial');
  await page.getByTestId('bg-stop-2-remove').click();
  await dragTo(page, 'gradient-centre', 0.15, 0.2);
  await expect.poll(async () => Number(await page.getByTestId('bg-cx').inputValue())).toBe(15);
  await expect(page.getByTestId('bg-cy')).toHaveValue('20');
  await undo(page);
  await expect(page.getByTestId('bg-cx')).toHaveValue('50');
  await redo(page);
  await expect(page.getByTestId('bg-cx')).toHaveValue('15');
  px = await pngAt(page, await exportPng(page), [
    [0.15, 0.2],
    [0.998, 0.998],
  ]);
  expect(reddish(px[0]), String(px[0])).toBe(true);
  expect(bluish(px[1]), String(px[1])).toBe(true);

  // The handles are page elements, never drawn: hidden by their switch, the artboard is the same.
  const sum = await artboardSum(page);
  await page.getByTestId('bg-handles').click();
  await expect(page.getByTestId('gradient-handles')).toHaveCount(0);
  expect(await artboardSum(page)).toBe(sum);
});
