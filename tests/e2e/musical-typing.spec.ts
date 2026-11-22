/**
 * Musical typing (PLAN.md §9 "Inputs", §15 M7 acceptance: "while musical typing is on, no editor
 * shortcut fires from a letter key"). With the mode on, every letter (and Shift+letter) plays or
 * is swallowed: the piece, the selection and the undo history stay as they were and no moment is
 * added. With it off (`), a shortcut works again. Also: the indicator and octave, key repeat,
 * window blur, text fields, ⌘/Ctrl shortcuts and Space.
 */

import { expect, test, type Page } from '@playwright/test';
import { openEditor, type LiveWindow } from './live-hook';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

const state = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as LiveWindow).__algorhythms;
    const ed = h.editor.state.getState();
    return {
      piece: JSON.stringify(h.store.getState().piece),
      moments: h.store.getState().piece.moments.length,
      selection: ed.selection.join(','),
      undo: `${ed.canUndo}|${ed.undoLabel}`,
    };
  });

const events = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as LiveWindow).__algorhythms.live
      .engine()
      .events.map((e) => `${e.kind}${e.pitch}`),
  );

const held = (page: Page) =>
  page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.live.inputs.held);

async function openLive(page: Page): Promise<void> {
  await page.getByTestId('live-toggle').click();
  await expect(page.getByTestId('live-drawer')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('typing-toggle')).toHaveAttribute('aria-pressed', 'true');
}

test('while musical typing is on, no editor shortcut fires from a letter key', async ({ page }) => {
  test.setTimeout(90_000);
  await openEditor(page);
  // A selection, so a shortcut that adds (and selects) a moment or clears it would show.
  const first = await page.evaluate(() => {
    const h = (window as unknown as LiveWindow).__algorhythms;
    const id = h.store.getState().piece.moments[1].id;
    h.editor.select([id]);
    return id;
  });
  await openLive(page);
  await expect(page.getByTestId('typing-octave')).toHaveText('C4');
  const before = await state(page);
  expect(before.selection).toBe(first);

  for (const l of 'abcdefghijklmnopqrstuvwxyz') await page.keyboard.press(l);
  for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') await page.keyboard.press(`Shift+${l}`);
  // Z and X moved the octave twice each (down, then up): back at C4.
  await expect(page.getByTestId('typing-octave')).toHaveText('C4');

  const after = await state(page);
  expect(after.moments).toBe(before.moments);
  expect(after.selection).toBe(before.selection);
  expect(after.undo).toBe(before.undo);
  expect(after.piece).toBe(before.piece);
  // The letters played: a (C4) … k (C5) among them, and every key was released.
  const ev = await events(page);
  expect(ev).toContain('on60');
  expect(ev).toContain('on72');
  expect(await held(page)).toEqual([]);

  // Off with ` (still live): the indicator goes and C adds a chord at the playhead again.
  await page.keyboard.press('Backquote');
  await expect(page.getByTestId('typing-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('typing-octave')).toHaveCount(0);
  await page.keyboard.press('c');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LiveWindow).__algorhythms.store.getState().piece.moments.length,
      ),
    )
    .toBe(before.moments + 1);
  expect((await state(page)).selection).not.toBe(first);
});

test('octave keys, key repeat, blur, text fields and modified shortcuts', async ({ page }) => {
  await openEditor(page);
  await openLive(page);

  // X: up an octave; A plays C5.
  await page.keyboard.press('x');
  await expect(page.getByTestId('typing-octave')).toHaveText('C5');
  await page.keyboard.down('a');
  await expect.poll(() => held(page)).toEqual([72]);
  // Held: auto-repeat keydowns do not retrigger.
  await page.keyboard.down('a');
  await page.keyboard.down('a');
  expect((await events(page)).filter((e) => e === 'on72')).toHaveLength(1);
  // An octave change while held releases the note it played.
  await page.keyboard.press('z');
  await page.keyboard.up('a');
  await expect.poll(() => held(page)).toEqual([]);
  await expect(page.getByTestId('typing-octave')).toHaveText('C4');

  // Window blur releases held keys.
  await page.keyboard.down('d');
  await page.keyboard.down('g');
  await expect.poll(() => held(page)).toEqual([64, 67]);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => held(page)).toEqual([]);
  await page.keyboard.up('d');
  await page.keyboard.up('g');

  // Z/X stop at the limits (C1 … C7).
  for (let i = 0; i < 9; i++) await page.keyboard.press('z');
  await expect(page.getByTestId('typing-octave')).toHaveText('C1');
  for (let i = 0; i < 9; i++) await page.keyboard.press('x');
  await expect(page.getByTestId('typing-octave')).toHaveText('C7');

  // A text field types; no note plays.
  const count = (await events(page)).length;
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.testid = 'scratch-input';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.type('asdf');
  await expect(page.getByTestId('scratch-input')).toHaveValue('asdf');
  expect((await events(page)).length).toBe(count);
  await page.evaluate(() => document.querySelector('[data-testid="scratch-input"]')?.remove());

  // ⌘/Ctrl-Z still undoes: add a moment with typing off, back on, then undo it.
  await page.getByTestId('typing-toggle').click();
  const n = await page.evaluate(
    () => (window as unknown as LiveWindow).__algorhythms.store.getState().piece.moments.length,
  );
  await page.keyboard.press('c');
  await page.getByTestId('typing-toggle').click();
  await expect(page.getByTestId('typing-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LiveWindow).__algorhythms.store.getState().piece.moments.length,
      ),
    )
    .toBe(n);

  // Closing the drawer turns the mode off.
  await page.getByTestId('live-toggle').click();
  await expect(page.getByTestId('live-drawer')).toHaveCount(0);
  await expect(page.getByTestId('typing-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('a note key with typing on and the drawer closed opens the Live drawer and plays', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByTestId('play').click(); // a user activation first
  await page.getByTestId('play').click();
  await page.keyboard.press('Backquote');
  await expect(page.getByTestId('typing-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('f');
  await expect(page.getByTestId('live-drawer')).toHaveAttribute('data-running', 'true');
  // Pressed while live mode started: sent once it ran.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.live.engine().held),
    )
    .toEqual([65]);
  await page.keyboard.up('f');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.live.engine().held),
    )
    .toEqual([]);
});
