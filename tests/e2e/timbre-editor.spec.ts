/**
 * M6-c timbre editor (PLAN.md §11.3 Sound drawer, §15 M6): drag a slider (one undo entry, the
 * built-in untouched), save the timbre as a preset file and load one into the notes, exactly.
 * Chromium only.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import './app-hook';
import { shot } from './shots';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

type Json = Record<string, unknown>;
interface PieceLite {
  voices: { id: string; timbre: string }[];
  timbres: Record<string, Json>;
}
const piece = (page: Page) =>
  page.evaluate(() => window.__algorhythms!.store.getState().piece as unknown as PieceLite);
const blurAndUndo = async (page: Page): Promise<void> => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
};

/** Drags a horizontal range input from 10 % to `to` of its width, in a few moves. */
async function drag(page: Page, testId: string, to: number): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  for (const f of [0.3, 0.5, to]) {
    await page.mouse.move(box.x + box.width * f, y, { steps: 3 });
  }
  await page.mouse.up();
}

test('edit a timbre with a slider, undo it, save and load a preset', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();

  const before = await piece(page);
  await page.getByTestId('sound-toggle').click();
  const drawer = page.getByTestId('sound-drawer');
  await expect(drawer).toBeVisible();
  const name = await page.getByTestId('sound-timbre').inputValue();
  expect(name).toBe(before.voices[0].timbre);
  // One bottom drawer at a time.
  await page.getByTestId('voices-toggle').click();
  await expect(drawer).toBeHidden();
  await page.getByTestId('sound-toggle').click();
  await expect(page.getByTestId('voices-drawer')).toBeHidden();
  const harmonics = await drawer.locator('[data-testid^="harmonic-"]').count();
  expect(harmonics).toBeGreaterThan(0);

  // A drag: live, one undo entry.
  await drag(page, 'ts-vib-depth', 0.8);
  const dragged = (await piece(page)).timbres[name] as { vibrato: { depthCents: number } };
  expect(dragged.vibrato.depthCents).toBeGreaterThan(40);
  await expect(page.getByTestId('ts-vib-depth-out')).toHaveText(`${dragged.vibrato.depthCents} ct`);
  await blurAndUndo(page);
  expect((await piece(page)).timbres[name]).toEqual(before.timbres[name]);

  // Keyboard steps on a partial, then turn FM on: edits the piece's copy.
  await page.getByTestId('harmonic-1').focus();
  await page.keyboard.press('ArrowDown');
  await page.getByTestId('ts-fm-on').check();
  await expect(page.getByTestId('ts-fm-ratio')).toBeEnabled();
  await drag(page, 'ts-fm-index', 0.4);
  const edited = (await piece(page)).timbres[name];
  expect(edited.fm).toBeTruthy();
  await shot(drawer, 'timbre-editor.png');

  // Save: the file holds exactly the piece's timbre.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('preset-save').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${name}.algorhythms-timbre.json`);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8')) as Json;
  expect(saved).toMatchObject({ format: 'algorhythms-timbre', version: 1, name });
  expect(saved.timbre).toEqual(edited);

  // Load a changed copy into all notes, under its own name: exact, and one undo entry.
  const file = {
    ...saved,
    name: 'test pad',
    timbre: { ...(saved.timbre as Json), accent: 0.77, stretch: 0.015 },
  };
  await page.getByTestId('preset-target').selectOption('all');
  await page.getByTestId('preset-file-input').setInputFiles({
    name: 'test pad.algorhythms-timbre.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.getByTestId('sound-timbre')).toHaveValue('test pad');
  const loaded = await piece(page);
  expect(loaded.timbres['test pad']).toEqual(file.timbre);
  expect(loaded.voices.every((v) => v.timbre === 'test pad')).toBe(true);
  await blurAndUndo(page);
  const undone = await piece(page);
  expect(undone.timbres['test pad']).toBeUndefined();
  expect(undone.voices.map((v) => v.timbre)).toEqual(before.voices.map((v) => v.timbre));

  // A piece file is refused with a notice.
  await page.getByTestId('preset-file-input').setInputFiles({
    name: 'piece.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'algorhythms', version: 2 })),
  });
  await expect(page.getByText(/Could not load piece\.json/)).toBeVisible();
});
