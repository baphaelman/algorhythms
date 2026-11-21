/**
 * Copy, cut and paste of moments (PLAN.md §11.3, M5): ⌘/Ctrl+C, X and V paste at the playhead
 * with new ids and the same relative times, snapped to a beat when Snap to beats is on, as one
 * undo entry, selected; a clip on the system clipboard (another tab) pastes too, other text does
 * not; text fields keep their own paste; the result survives a share link.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';
import { byId, item, moments, openFixture, selection, undo, undoLabel } from './m5-fixture';

/** Fires a `paste` event carrying `text` (what another tab or app put on the clipboard). */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test('copy and paste at the playhead: new ids, same spacing, one undo entry', async ({ page }) => {
  await openFixture(page);
  const before = await moments(page);
  await item(page, 'aaaaaa').click();
  await item(page, 'bbbbbb').click({ modifiers: ['Shift'] });
  await page.keyboard.press('ControlOrMeta+C');
  await expect(page.getByTestId('lane-live')).toContainText('Copied 2 moments');
  await seek(page, 15.3);
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await moments(page)).length).toBe(before.length + 2);
  const sel = await selection(page);
  expect(sel).toHaveLength(2);
  for (const id of sel) expect(before.some((m) => m.id === id)).toBe(false);
  const pasted = await Promise.all(sel.map((id) => byId(page, id)));
  expect(pasted.map((m) => m!.type)).toEqual(['chord', 'unison']);
  expect(pasted[0]!.at).toBeCloseTo(15.3, 6);
  expect(pasted[1]!.at).toBeCloseTo(19.3, 6);
  expect(await undoLabel(page)).toBe('Paste moments');
  await expect(page.getByTestId('lane-live')).toContainText('Pasted 2 moments');
  // The piece grew past its old end to hold the paste.
  await expect(item(page, sel[1])).toHaveCount(1);
  await undo(page);
  expect((await moments(page)).map((m) => m.id)).toEqual(before.map((m) => m.id));
});

test('paste snaps to a beat when Snap to beats is on', async ({ page }) => {
  await openFixture(page, true);
  await item(page, 'bbbbbb').click();
  await page.keyboard.press('ControlOrMeta+C');
  await seek(page, 15.3);
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await selection(page)).length).toBe(1);
  const [id] = await selection(page);
  expect((await byId(page, id))!.at).toBe(15);
});

test('cut removes the selection as one undo entry; paste brings it back elsewhere', async ({
  page,
}) => {
  await openFixture(page);
  await item(page, 'cccccc').click();
  await page.keyboard.press('ControlOrMeta+X');
  await expect.poll(async () => !!(await byId(page, 'cccccc'))).toBe(false);
  expect(await undoLabel(page)).toBe('Cut moment');
  await seek(page, 3);
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await selection(page)).length).toBe(1);
  const walk = (await byId(page, (await selection(page))[0]))!;
  expect(walk.type).toBe('walk');
  expect(walk.at).toBeCloseTo(3, 6);
  expect(walk.until).toBeCloseTo(7, 6);
  await undo(page);
  await undo(page);
  expect((await byId(page, 'cccccc'))!.at).toBe(10);
});

test('a clip from the system clipboard pastes; other text does not', async ({
  page,
  browserName,
}) => {
  // Firefox ignores clipboardData on a synthetic paste event.
  test.skip(browserName !== 'chromium', 'Synthetic paste events need Chromium');
  await openFixture(page);
  await item(page, 'aaaaaa').click();
  const count = (await moments(page)).length;
  await seek(page, 8);
  const clip = JSON.stringify({
    format: 'algorhythms-moments',
    version: 1,
    moments: [
      { id: 'zzzzzz', type: 'level', at: 0, gain: 0.5, over: 1 },
      { id: 'yyyyyy', type: 'level', at: 2, gain: 1, over: 1 },
    ],
  });
  await pasteText(page, clip);
  await expect.poll(async () => (await moments(page)).length).toBe(count + 2);
  const sel = await selection(page);
  expect(sel).not.toContain('zzzzzz');
  expect((await byId(page, sel[0]))!.at).toBeCloseTo(8, 6);
  expect((await byId(page, sel[1]))!.at).toBeCloseTo(10, 6);

  await pasteText(page, 'just some words');
  await expect(page.getByTestId('lane-live')).toContainText('The clipboard holds no moments');
  expect((await moments(page)).length).toBe(count + 2);
});

test('a text field keeps its own copy and paste', async ({ page }) => {
  await openFixture(page);
  await item(page, 'aaaaaa').click();
  const count = (await moments(page)).length;
  const label = page.getByTestId('insp-label');
  await label.focus();
  // A clip pasted into the field is text there, not moments.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData(
      'text/plain',
      JSON.stringify({
        format: 'algorhythms-moments',
        version: 1,
        moments: [{ id: 'zzzzzz', type: 'level', at: 0, gain: 0.5, over: 1 }],
      }),
    );
    document
      .querySelector('[data-testid="insp-label"]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await page.keyboard.press('ControlOrMeta+V');
  await page.waitForTimeout(50);
  expect((await moments(page)).length).toBe(count);
});

test('pasted moments survive a share link', async ({ page }) => {
  await openFixture(page);
  await item(page, 'bbbbbb').click();
  await page.keyboard.press('ControlOrMeta+C');
  await seek(page, 16);
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await selection(page)).length).toBe(1);
  const ats = (await moments(page)).map((m) => m.at);
  const link = await page.evaluate(() =>
    window.__algorhythms!.encodeShareLink(
      window.__algorhythms!.store.getState().piece,
      location.origin + location.pathname,
    ),
  );
  await page.goto(link);
  await expect.poll(async () => (await moments(page)).map((m) => m.at)).toEqual(ats);
});
