/**
 * Tune editing (PLAN.md §6.2 `tune`, §11.3; R9-7): the palette entry (greyed with no sounding
 * line, hover ghost), the lane region (notes drawn, move and end drags snapping to beats, Alt free)
 * and the inspector (glide and land, the note list: names, lengths in beats or seconds, ▲/▼,
 * add, remove), with undo and a share link. Chromium only.
 */

import { shot } from './shots';
import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface Note {
  pitch: number;
  len: number;
}
interface M {
  id: string;
  type: string;
  at: number;
  notes?: Note[];
  glide?: { length?: number; land?: boolean };
}

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    redo(): boolean;
    state: { getState(): { undoLabel: string } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

const hook = (page: Page) => ({
  moments: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments),
  select: (ids: string[]) =>
    page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  redo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.redo()),
  undoLabel: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
});

const tuneOf = async (page: Page, id = 'tune1'): Promise<M> =>
  (await hook(page).moments()).find((m) => m.id === id)!;
const pitches = async (page: Page): Promise<number[]> =>
  (await tuneOf(page)).notes!.map((n) => n.pitch);
const lens = async (page: Page): Promise<number[]> => (await tuneOf(page)).notes!.map((n) => n.len);

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/**
 * Four notes in C major from 0 and a tune at 4 (C4 1 s, D4 1 s, E4 2 s), targeting the lowest
 * line; `bpm` 60 makes a beat 1 s, null: no tempo. `silent`: no moments at all.
 */
async function open(page: Page, bpm: number | null, silent = false): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(
    ([tempo, empty]) => {
      const h = window.__algorhythms!;
      const p = structuredClone(h.store.getState().piece) as unknown as {
        moments: unknown[];
        key: unknown;
        end: unknown;
        defaults: { glide: Record<string, unknown> };
        view: Record<string, unknown>;
      };
      p.defaults.glide = { ...p.defaults.glide, length: 1, stagger: 0, jitter: 0 };
      delete p.defaults.glide.land;
      p.moments = empty
        ? []
        : [
            {
              id: 'start0',
              type: 'chord',
              at: 0,
              notes: { kind: 'pitches', pitches: [48, 55, 64, 67] },
              voicing: 'even',
              assign: 'ordered',
            },
            {
              id: 'tune1',
              type: 'tune',
              at: 4,
              notes: [
                { pitch: 60, len: 1 },
                { pitch: 62, len: 1 },
                { pitch: 64, len: 2 },
              ],
            },
          ];
      p.key = { tonic: 'C', scale: 'major' };
      p.end = { at: 16, fade: 1 };
      delete p.view.gridBpm;
      delete p.view.snapBeats;
      if (tempo !== null) p.view.gridBpm = tempo;
      h.actions.loadPiece(p);
    },
    [bpm, silent] as [number | null, boolean],
  );
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await frames(page);
}

async function axis(page: Page): Promise<{ pps: number; left: number; start: number }> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  const box = (await page.locator('#score').boundingBox())!;
  return { pps: box.width / s.window, left: box.x, start: s.start };
}

const item = (page: Page, id = 'tune1') =>
  page.getByTestId('lane').locator(`[data-moment="${id}"]`);
const inspector = (page: Page) => page.getByTestId('inspector');

async function center(page: Page, sel: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(sel).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function dragBy(page: Page, from: { x: number; y: number }, dx: number, alt = false) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y, { steps: 5 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

test('palette: greyed with no sounding line; hover shows a tune ghost with its notes; M adds one', async ({
  page,
}) => {
  await open(page, null, true);
  const btn = page.getByTestId('palette').locator('[data-moment="tune"]');
  await expect(btn).toHaveAttribute('data-no-effect', 'true');
  await expect(btn).toHaveAttribute('title', /Melody: No effect here: .+/);
  await expect(btn).toHaveAttribute('aria-keyshortcuts', 'M');

  await open(page, 60);
  await seek(page, 10);
  await expect(btn).not.toHaveAttribute('data-no-effect', /.*/);
  const ghost = page.getByTestId('lane-ghost');
  await btn.hover();
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-type', 'tune');
  expect(Number(await ghost.getAttribute('data-at'))).toBeCloseTo(10, 3);
  // A melody fitted to the chord there (M10b-5): to the end of its block, 1 to 8 bars; a dash
  // per note.
  const meter = await page.evaluate(
    () =>
      (window.__algorhythms!.store.getState().piece as unknown as { view: { meter?: number } }).view
        .meter ?? 4,
  );
  expect(await ghost.locator('.lane-art.lane-tune > span').count()).toBeGreaterThan(2);
  const { pps } = await axis(page);
  const ghostWidth = (await ghost.locator('.lane-bar').boundingBox())!.width;
  await page.mouse.move(5, 5);
  await expect(ghost).toBeHidden();

  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('m');
  const added = (await hook(page).moments()).find((m) => m.type === 'tune' && m.id !== 'tune1')!;
  expect(added.at).toBeCloseTo(10, 3);
  expect(added.notes!.length).toBeGreaterThan(2);
  const total = added.notes!.reduce((a, n) => a + n.len, 0);
  expect(total).toBeGreaterThanOrEqual(meter - 1e-6);
  expect(total).toBeLessThanOrEqual(8 * meter + 1e-6);
  expect(ghostWidth).toBeCloseTo(total * pps, -1);
  expect((added as { fit?: unknown }).fit).toBeDefined();
  for (const n of added.notes!) expect([0, 2, 4, 5, 7, 9, 11]).toContain(n.pitch % 12);
  await expect(inspector(page).getByRole('heading')).toContainText('Melody');
});

test('lane: the region spans the notes; moving and the end (last note) snap to beats, Alt is free', async ({
  page,
}) => {
  await open(page, 60);
  await expect(item(page)).toHaveAttribute('aria-label', /tune at 4 s, 4 s long, 3 notes/);
  const bar = item(page).locator('.lane-bar');
  await expect(bar.locator('.lane-art.lane-tune > span')).toHaveCount(3);
  const { pps } = await axis(page);
  expect((await bar.boundingBox())!.width).toBeCloseTo(4 * pps, -1);

  await dragBy(page, await center(page, '[data-moment="tune1"] .lane-marker'), 2.2 * pps);
  expect((await tuneOf(page)).at).toBeCloseTo(6, 6);
  expect(await lens(page)).toEqual([1, 1, 2]);

  // The end handle changes the last note: +0.8 s snaps to the beat (10 → 11).
  await dragBy(page, await center(page, '[data-moment="tune1"] .lane-end'), 0.8 * pps);
  expect(await lens(page)).toEqual([1, 1, 3]);
  expect(await hook(page).undoLabel()).toBe('Change last note length');
  // Alt: free.
  await dragBy(page, await center(page, '[data-moment="tune1"] .lane-end'), -0.4 * pps, true);
  expect(Math.abs((await lens(page))[2] - 2.6)).toBeLessThan(0.05);
  await hook(page).undo();
  await hook(page).undo();
  expect(await lens(page)).toEqual([1, 1, 2]);
});

test('inspector: notes in beats with a tempo; ▲/▼, lengths, add, remove, glide; undo each', async ({
  page,
  context,
}) => {
  await open(page, 120);
  await hook(page).select(['tune1']);
  const insp = inspector(page);
  await expect(insp.getByRole('heading')).toContainText('Melody');
  const rows = insp.getByTestId('tune-note');
  await expect(rows).toHaveCount(3);
  await expect(rows.getByTestId('tune-note-name')).toHaveText(['C4', 'D4', 'E4']);
  // 120 bpm: 1 s is two beats.
  await expect(insp.getByTestId('insp-tune-notes')).toContainText('lengths in beats');
  await expect(rows.nth(0).getByTestId('tune-note-len')).toHaveValue('2');
  await expect(rows.nth(2).getByTestId('tune-note-len')).toHaveValue('4');

  // ▲ on the second note: D4 → E4 (one scale step); ▼ on the third: E4 → D4.
  await rows.nth(1).getByTestId('tune-note-up').click();
  expect(await pitches(page)).toEqual([60, 64, 64]);
  expect(await hook(page).undoLabel()).toBe('Move tune note');
  await rows.nth(2).getByTestId('tune-note-down').click();
  expect(await pitches(page)).toEqual([60, 64, 62]);
  await expect(rows.getByTestId('tune-note-name')).toHaveText(['C4', 'E4', 'D4']);

  // Length: type 1 beat for the first note (0.5 s); ↑ adds a quarter beat.
  const len0 = rows.nth(0).getByTestId('tune-note-len');
  await len0.fill('1');
  await len0.press('Enter');
  expect((await lens(page))[0]).toBeCloseTo(0.5, 6);
  expect(await hook(page).undoLabel()).toBe('Edit note length');
  await len0.press('ArrowUp');
  expect((await lens(page))[0]).toBeCloseTo(0.625, 6);
  // Later notes start earlier: the second row's start follows.
  await expect(rows.nth(1).locator('.step-t')).toHaveText('0:04.63');

  // Add (a scale step above the last, same length) and remove.
  await insp.getByTestId('tune-add').click();
  expect(await pitches(page)).toEqual([60, 64, 62, 64]);
  expect((await lens(page))[3]).toBe(2);
  await rows.nth(0).getByTestId('tune-note-remove').click();
  expect(await pitches(page)).toEqual([64, 62, 64]);
  expect(await hook(page).undoLabel()).toBe('Remove tune note');
  await hook(page).undo();
  expect(await pitches(page)).toEqual([60, 64, 62, 64]);
  await hook(page).redo();
  expect(await pitches(page)).toEqual([64, 62, 64]);

  // Glide: the tune's own default (0.1 s), no stagger or order; land per note.
  const tr = insp.getByTestId('insp-transition');
  await expect(tr.getByTestId('insp-glide-length')).toHaveValue('0.1');
  await expect(tr.getByTestId('insp-glide-stagger')).toHaveCount(0);
  await expect(tr.getByRole('group', { name: 'Order' })).toHaveCount(0);
  const glide = tr.getByTestId('insp-glide-length');
  await glide.fill('0.05');
  await glide.press('Enter');
  await tr.getByTestId('insp-land').check();
  await expect(tr.getByTestId('insp-land-note')).toHaveText(/Each note arrives on its start/);
  expect((await tuneOf(page)).glide).toEqual({ length: 0.05, land: true });

  await shot(page, 'tune-inspector-lane.png');
  await shot(insp, 'tune-inspector.png');

  const m = await tuneOf(page);
  const link = await page.evaluate(() => {
    const h = window.__algorhythms!;
    return h.encodeShareLink(h.store.getState().piece);
  });
  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await tuneOf(fresh)).toEqual(m);
});

test('New melody: fitted notes as long as the tune, in key; one undo entry', async ({ page }) => {
  await open(page, 60);
  await hook(page).select(['tune1']);
  const insp = inspector(page);
  const auditions = () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as { audition: { count: number } }).audition.count,
    );
  const before = await auditions();
  await insp.getByTestId('tune-random').click();
  const a = (await tuneOf(page)).notes!;
  expect(a.map((n) => n.pitch)).not.toEqual([60, 62, 64]);
  expect(a.reduce((s, n) => s + n.len, 0)).toBeCloseTo(4, 6);
  for (const n of a) expect([0, 2, 4, 5, 7, 9, 11]).toContain(n.pitch % 12);
  // Beats at 60 bpm: 1/8, 1/4, dotted 1/4 or 1/2 (the last may be longer).
  for (const n of a.slice(0, -1)) expect([0.5, 1, 1.5, 2]).toContain(n.len);
  expect(await hook(page).undoLabel()).toBe('New melody');
  expect((await tuneOf(page)) as { fit?: unknown }).toHaveProperty('fit');
  await expect(insp.getByTestId('tune-note')).toHaveCount(a.length);
  await expect.poll(auditions).toBeGreaterThan(before);
  // Each press rolls again.
  await insp.getByTestId('tune-random').click();
  expect((await tuneOf(page)).notes).not.toEqual(a);
  await hook(page).undo();
  expect((await tuneOf(page)).notes).toEqual(a);
  await hook(page).undo();
  expect(await pitches(page)).toEqual([60, 62, 64]);
});

test('Fit to chords: on redraws the melody; a note edit turns it off', async ({ page }) => {
  await open(page, 60);
  await hook(page).select(['tune1']);
  const insp = inspector(page);
  const fit = insp.getByTestId('tune-fit');
  await expect(fit).not.toBeChecked();
  await fit.click();
  await expect(fit).toBeChecked();
  expect(await hook(page).undoLabel()).toBe('Fit to chords');
  const a = (await tuneOf(page)).notes!;
  expect(a.map((n) => n.pitch)).not.toEqual([60, 62, 64]);
  await insp.getByTestId('tune-note').first().getByTestId('tune-note-up').click();
  await expect(fit).not.toBeChecked();
  expect((await tuneOf(page)).notes!.slice(1)).toEqual(a.slice(1));
  await hook(page).undo();
  await expect(fit).toBeChecked();
  expect((await tuneOf(page)).notes).toEqual(a);
});

test('without a tempo, lengths are in seconds', async ({ page }) => {
  await open(page, null);
  await hook(page).select(['tune1']);
  const insp = inspector(page);
  await expect(insp.getByTestId('insp-tune-notes')).toContainText('lengths in seconds');
  const len2 = insp.getByTestId('tune-note').nth(2).getByTestId('tune-note-len');
  await expect(len2).toHaveValue('2');
  await len2.fill('0.75');
  await len2.press('Enter');
  expect((await lens(page))[2]).toBe(0.75);
});

test('Melody on: pick a sounding note, the tune moves to its line; highest; undo', async ({
  page,
}) => {
  await open(page, null);
  await hook(page).select(['tune1']);
  const menu = inspector(page).getByTestId('insp-melody-on');
  const options = inspector(page).getByTestId('insp-melody-option');
  await expect(menu).toHaveAttribute('data-value', 'line:low');
  await expect(menu).toHaveText(/Lowest note/);
  await menu.click();
  await expect(options).toHaveText(['Highest note', 'G4', 'E4', 'G3', 'C3', 'Lowest note']);
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(menu).toBeFocused();
  // Escape closed the menu only: the tune is still selected.
  await expect(menu).toBeVisible();
  const pick = async (text: string): Promise<string> => {
    await menu.click();
    const o = options.filter({ hasText: text }).first();
    const v = (await o.getAttribute('data-value'))!;
    await o.click();
    await expect(options).toHaveCount(0);
    return v;
  };
  /** The voice index playing the tune (its compiled segments). */
  const line = () =>
    page.evaluate(() => {
      const s = (
        window.__algorhythms as unknown as {
          store: {
            getState(): {
              compiled: { voices: { index: number; segments: { momentId?: string }[] }[] };
            };
          };
        }
      ).store.getState().compiled;
      return s.voices.find((v) => v.segments.some((g) => g.momentId === 'tune1'))?.index;
    });
  const field = async (k: string): Promise<unknown> =>
    ((await tuneOf(page)) as unknown as Record<string, unknown>)[k];
  const before = await line();
  // On C3 the tune is C4 D4 E4 (an octave above the line). Picking E4 moves it 9 scale steps.
  expect(await pitches(page)).toEqual([60, 62, 64]);
  const e4 = await pick('E4');
  expect(await field('target')).toEqual({ voices: [e4.slice('voice:'.length)] });
  expect(await hook(page).undoLabel()).toBe('Change melody line');
  await expect(menu).toHaveAttribute('data-value', e4);
  expect(await pitches(page)).toEqual([76, 77, 79]);
  await expect.poll(line).not.toBe(before);
  const onE4 = await line();

  // Highest (G4, two steps up), by keyboard.
  await menu.focus();
  await page.keyboard.press('ArrowDown');
  await expect(inspector(page).getByTestId('insp-melody-list')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(options.first()).toHaveClass(/active/);
  await page.keyboard.press('Enter');
  expect(await field('line')).toBe('high');
  expect(await field('target')).toBeUndefined();
  expect(await pitches(page)).toEqual([79, 81, 83]);
  await expect.poll(line).not.toBe(onE4);

  await hook(page).undo();
  await expect(menu).toHaveAttribute('data-value', e4);
  expect(await pitches(page)).toEqual([76, 77, 79]);
  await expect.poll(line).toBe(onE4);
  await hook(page).undo();
  await expect(menu).toHaveAttribute('data-value', 'line:low');
  expect(await field('target')).toBeUndefined();
  expect(await field('line')).toBeUndefined();
  expect(await pitches(page)).toEqual([60, 62, 64]);
  await expect.poll(line).toBe(before);
});

test('Melody on: an option under the pointer or the arrows highlights its line', async ({
  page,
}) => {
  await open(page, null);
  await hook(page).select(['tune1']);
  const menu = inspector(page).getByTestId('insp-melody-on');
  const list = inspector(page).getByTestId('insp-melody-list');
  const options = inspector(page).getByTestId('insp-melody-option');
  /** The whole line the score last drew highlighted (-1: none). */
  const lit = () => page.evaluate(() => window.__algorhythms!.frameStats.highlightVoice);
  /** A voice's pool index by id. */
  const indexOf = (id: string) =>
    page.evaluate(
      (v) =>
        (
          window.__algorhythms as unknown as {
            store: { getState(): { piece: { voices: { id: string }[] } } };
          }
        ).store
          .getState()
          .piece.voices.findIndex((x) => x.id === v),
      id,
    );
  const voiceOf = async (text: string): Promise<number> =>
    indexOf((await options.filter({ hasText: text }).first().getAttribute('data-value'))!.slice(6));
  await expect.poll(lit).toBe(-1);
  await menu.click();
  // Opening points at the current choice (Lowest: the C3 line).
  const c3 = await voiceOf('C3');
  await expect.poll(lit).toBe(c3);
  const g3 = await voiceOf('G3');
  await options.filter({ hasText: 'G3' }).hover();
  await expect.poll(lit).toBe(g3);
  await options.filter({ hasText: 'Highest' }).hover();
  await expect.poll(lit).toBe(await voiceOf('G4'));
  // Leaving the list clears it; the arrows point again.
  await page.mouse.move(5, 5);
  await expect.poll(lit).toBe(-1);
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveClass(/active/);
  await expect.poll(lit).toBe(await voiceOf('G4'));
  await expect(list).toHaveAttribute('aria-activedescendant', /.+/);
  // Closing clears it and changes nothing.
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect.poll(lit).toBe(-1);
  expect(await pitches(page)).toEqual([60, 62, 64]);
});
