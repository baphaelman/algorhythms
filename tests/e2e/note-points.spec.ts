/**
 * Note points (PLAN.md §11.3 revision 6, §15 M4.5): double-clicking a line (or clicking it with N
 * held) and dragging adds a `note` moment, one undo entry; the chord label follows; ▲/▼ step
 * `to`; "Return after" writes `back`. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface Note {
  id: string;
  type: string;
  at: number;
  from: number;
  to: number;
  back?: number;
}

interface EditorHook {
  editor: {
    undo(): boolean;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
  store: {
    getState(): {
      piece: { moments: Note[] };
      compiled: { harmony?: { momentId: string; label: string }[] };
      transport: { status: string };
    };
  };
}

const state = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as EditorHook;
    const s = h.store.getState();
    return {
      moments: s.piece.moments,
      status: s.transport.status,
      undoLabel: h.editor.state.getState().undoLabel,
      selection: h.editor.state.getState().selection,
    };
  });

const notes = async (page: Page) => (await state(page)).moments.filter((m) => m.type === 'note');

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Four held voices (C3 G3 C4 E4) in C major for 40 s, a 60 BPM grid, the playhead at 0. */
async function openHeld(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      start: { voice: string; pitch: number }[];
      moments: unknown[];
      key: unknown;
      end: unknown;
      view: { gridBpm?: number };
    };
    p.start = [48, 55, 60, 64].map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
    p.moments = [];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 40, fade: 2 };
    p.view = { ...p.view, gridBpm: 60 };
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
}

/** Screen position of the C4 line at piece time `t` (found with the hover readout). */
async function lineC4(page: Page, t: number): Promise<{ x: number; y: number }> {
  await frames(page);
  const f = await page.evaluate(() => ({
    start: window.__algorhythms!.frameStats.start,
    window: window.__algorhythms!.frameStats.window,
  }));
  const box = (await page.locator('#score').boundingBox())!;
  const x = box.x + ((t - f.start) / f.window) * box.width;
  const tip = page.getByTestId('score-hover');
  for (let y = box.y + 6; y < box.y + box.height - 6; y += 3) {
    await page.mouse.move(x, y);
    await frames(page);
    if ((await tip.isVisible()) && /· C4 ·/.test((await tip.textContent()) ?? '')) {
      return { x, y };
    }
  }
  throw new Error('C4 line not found');
}

test('double-click a line and drag adds a note point; undo removes it', async ({ page }) => {
  await openHeld(page);
  const { x, y } = await lineC4(page, 10.2);
  const insp = page.getByTestId('inspector');

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(x, y - 20, { steps: 4 });
  await page.mouse.move(x, y - 40, { steps: 4 });
  await page.mouse.up({ clickCount: 2 });

  const ns = await notes(page);
  expect(ns).toHaveLength(1);
  const n = ns[0];
  expect(n.at).toBeCloseTo(10, 6); // snapped to the grid
  expect(n.from).toBeCloseTo(60, 6);
  expect(n.to).toBeGreaterThan(60);
  expect(Number.isInteger(n.to)).toBe(true);
  const s = await state(page);
  expect(s.undoLabel).toBe('Add note');
  expect(s.selection).toEqual([n.id]);
  // The double-click's first click does not leave the piece playing.
  expect(s.status).not.toBe('playing');

  // The inspector shows from → to and the chord before → after; the label follows.
  await expect(insp.getByTestId('insp-note-from')).toHaveText('C4');
  const before = insp.getByTestId('insp-note-chord-before');
  const after = insp.getByTestId('insp-note-chord-after');
  await expect(after).not.toHaveText('—');
  expect(await after.textContent()).not.toBe(await before.textContent());
  const label = await page.evaluate(
    (id) =>
      (window.__algorhythms as unknown as EditorHook).store
        .getState()
        .compiled.harmony?.find((h) => h.momentId === id)?.label,
    n.id,
  );
  await expect(after).toHaveText(label!);
  await expect(page.getByTestId('note-dot')).toBeVisible();

  // One undo entry removes the add and the drag.
  await page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());
  expect(await notes(page)).toHaveLength(0);
});

test('N + click adds a note point; ▲/▼ step it; Return after writes back', async ({ page }) => {
  await openHeld(page);
  const { x, y } = await lineC4(page, 5);
  await page.keyboard.down('n');
  await page.mouse.click(x, y);
  await page.keyboard.up('n');
  let [n] = await notes(page);
  expect(n.at).toBeCloseTo(5, 6);
  expect(n.from).toBeCloseTo(60, 6);
  expect(n.to).toBeCloseTo(60, 6);
  expect((await state(page)).status).not.toBe('playing');

  // ▲ key, then the inspector's ▼ and ▲ (C4 → D4 → C4 → D4).
  await page.keyboard.press('ArrowUp');
  [n] = await notes(page);
  expect(n.to).toBe(62);
  const insp = page.getByTestId('inspector');
  await expect(insp.getByTestId('insp-note-to')).toHaveText('D4');
  await insp.getByTestId('insp-note-down').click();
  await expect(insp.getByTestId('insp-note-to')).toHaveText('C4');
  await insp.getByTestId('insp-note-up').click();
  await expect(insp.getByTestId('insp-note-to')).toHaveText('D4');

  // Return after: on writes back, the slider edits it, off removes the field.
  const ret = insp.getByTestId('insp-note-return');
  await ret.check();
  [n] = await notes(page);
  expect(n.back).toBe(1);
  await insp.getByTestId('insp-note-back').fill('2.5');
  await insp.getByTestId('insp-note-back').press('Enter');
  await expect.poll(async () => (await notes(page))[0].back).toBe(2.5);
  // The note returns: C4 sounds again after the return.
  const back = await page.evaluate(() => {
    const s = window.__algorhythms!.store.getState() as unknown as {
      compiled: { voices: { segments: { t1: number; p1: number; momentId?: string }[] }[] };
    };
    return s.compiled.voices
      .flatMap((v) => v.segments)
      .filter((g) => g.momentId)
      .map((g) => g.p1);
  });
  expect(back).toContain(62);
  expect(back.at(-1)).toBe(60);
  await ret.uncheck();
  [n] = await notes(page);
  expect('back' in n).toBe(false);
});
