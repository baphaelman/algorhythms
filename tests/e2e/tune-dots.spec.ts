/**
 * Tune dots and typed notes (PLAN.md §6.2 `tune`; R9-8): a dot per note at its start; dragging
 * one moves its pitch (snapped to the key) and its start (snapped to beats, Alt free); dot and
 * inspector row select each other; arrow keys on a focused dot; the typed-notes field (beats or
 * seconds, inline errors, Enter or blur); the merge's Fade label. Undo and share links. Chromium.
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
}

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    redo(): boolean;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

const H = (page: Page) => ({
  moments: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments),
  select: (ids: string[]) =>
    page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  undoLabel: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
});

const tuneOf = async (page: Page): Promise<M> =>
  (await H(page).moments()).find((m) => m.id === 'tune1')!;
const pitches = async (page: Page) => (await tuneOf(page)).notes!.map((n) => n.pitch);
const lens = async (page: Page) => (await tuneOf(page)).notes!.map((n) => n.len);

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);

/**
 * Four notes in C major from 0, a tune at 4 (C4 1 s, D4 1 s, E4 2 s) on the lowest line and a
 * merge at 12; `bpm` 60 makes a beat 1 s, null: no tempo. The tune is selected.
 */
async function open(page: Page, bpm: number | null): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((tempo) => {
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
    p.moments = [
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
      { id: 'merge1', type: 'merge', at: 12, count: 2, which: 'top', fade: 1 },
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 16, fade: 1 };
    delete p.view.gridBpm;
    delete p.view.snapBeats;
    if (tempo !== null) p.view.gridBpm = tempo;
    h.actions.loadPiece(p);
  }, bpm);
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await H(page).select(['tune1']);
  await frames(page);
}

const dots = (page: Page) => page.getByTestId('tune-dot');
const rows = (page: Page) => page.getByTestId('inspector').getByTestId('tune-note');

async function pps(page: Page): Promise<number> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  return (await page.locator('#score').boundingBox())!.width / s.window;
}

async function centre(page: Page, k: number): Promise<{ x: number; y: number }> {
  await frames(page);
  const b = (await dots(page).nth(k).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(page: Page, k: number, dx: number, dy: number, alt = false): Promise<void> {
  const from = await centre(page, k);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

test('a dot per note at its start; drag: pitch snaps to the key, start to beats, Alt free', async ({
  page,
}) => {
  await open(page, 60);
  await expect(dots(page)).toHaveCount(3);
  await expect(dots(page).nth(1)).toHaveAttribute('data-t', '5.000');
  await expect(dots(page).nth(1)).toHaveAttribute('data-pitch', '62');
  await expect(dots(page).nth(2)).toHaveAttribute('aria-label', 'Tune note 3, E4 at 0:06.00');
  const scale = await pps(page);
  await shot(page, 'tune-dots.png');

  // Up: a pitch in the key, higher than D4; the lengths stay.
  await drag(page, 1, 0, -40);
  const p1 = (await pitches(page))[1];
  expect(p1).toBeGreaterThan(62);
  expect(C_MAJOR.has(p1 % 12)).toBe(true);
  expect(await lens(page)).toEqual([1, 1, 2]);
  expect(await H(page).undoLabel()).toBe('Move tune note');
  // The dot stays selected and its row shows it.
  await expect(dots(page).nth(1)).toHaveAttribute('data-picked', 'true');
  await expect(rows(page).nth(1)).toHaveAttribute('data-picked', 'true');
  await H(page).undo();
  expect(await pitches(page)).toEqual([60, 62, 64]);

  // Sideways: note 3's start +0.8 s snaps to the beat at 7; its end stays at 8.
  await drag(page, 2, 0.8 * scale, 0);
  expect(await lens(page)).toEqual([1, 2, 1]);
  expect(await pitches(page)).toEqual([60, 62, 64]);
  // Alt: free (−0.4 s from 7).
  await drag(page, 2, -0.4 * scale, 0, true);
  const l = await lens(page);
  expect(Math.abs(l[1] - 1.6)).toBeLessThan(0.05);
  expect(l[0] + l[1] + l[2]).toBeCloseTo(4, 6);
  // The first note's start moves the tune.
  await drag(page, 0, -1.1 * scale, 0);
  const m = await tuneOf(page);
  expect(m.at).toBe(3);
  expect(m.notes![0].len).toBe(2);
  await shot(page, 'tune-dots-dragged.png');
  await H(page).undo();
  await H(page).undo();
  await H(page).undo();
  expect(await lens(page)).toEqual([1, 1, 2]);
  expect((await tuneOf(page)).at).toBe(4);
});

test('dot and row select each other; arrows on a focused dot', async ({ page }) => {
  await open(page, 60);
  // A click on the dot: selected, focused, its row highlighted.
  const c = await centre(page, 1);
  await page.mouse.click(c.x, c.y);
  await expect(dots(page).nth(1)).toHaveAttribute('data-picked', 'true');
  await expect(dots(page).nth(1)).toBeFocused();
  await expect(rows(page).nth(1)).toHaveAttribute('data-picked', 'true');
  await expect(rows(page).nth(0)).not.toHaveAttribute('data-picked', /.*/);

  // ↑: a scale step (D4 → E4); Alt+↑: a semitone (E4 → F4); ↓ back to E4.
  await page.keyboard.press('ArrowUp');
  expect(await pitches(page)).toEqual([60, 64, 64]);
  expect(await H(page).undoLabel()).toBe('Move tune note');
  await page.keyboard.press('Alt+ArrowUp');
  expect(await pitches(page)).toEqual([60, 65, 64]);
  await page.keyboard.press('ArrowDown');
  expect(await pitches(page)).toEqual([60, 64, 64]);
  // →: the start a beat later, kept 0.05 s before the next note; ←: a beat earlier.
  await page.keyboard.press('ArrowRight');
  expect(await lens(page)).toEqual([1.95, 0.05, 2]);
  await page.keyboard.press('ArrowLeft');
  expect(await lens(page)).toEqual([0.95, 1.05, 2]);
  await expect(dots(page).nth(1)).toBeFocused();
  await expect(rows(page).nth(1)).toHaveAttribute('data-picked', 'true');
  // The playhead did not move (the dot took the arrows).
  await expect(page.getByTestId('time')).toHaveText(/^00:00\.0/);

  // A row picks its dot.
  await rows(page).nth(2).getByTestId('tune-note-pick').click();
  await expect(dots(page).nth(2)).toHaveAttribute('data-picked', 'true');
  await expect(dots(page).nth(1)).not.toHaveAttribute('data-picked', /.*/);
  await expect(rows(page).nth(2)).toHaveAttribute('data-picked', 'true');
  await shot(page, 'tune-dot-row.png');
});

test('typed notes: beats with a tempo, errors inline, Enter or blur, undo, share link', async ({
  page,
  context,
}) => {
  await open(page, 120);
  const field = page.getByTestId('tune-text');
  const fb = page.getByTestId('tune-text-feedback');
  // 120 bpm: a beat is 0.5 s.
  await expect(field).toHaveValue('C4 2, D4 2, E4 4');

  await field.fill('F#5 2, E5 1, D5 1.5, Bb4 0.5');
  await field.press('Enter');
  expect(await tuneOf(page)).toMatchObject({
    notes: [
      { pitch: 78, len: 1 },
      { pitch: 76, len: 0.5 },
      { pitch: 74, len: 0.75 },
      { pitch: 70, len: 0.25 },
    ],
  });
  expect(await H(page).undoLabel()).toBe('Type tune notes');
  // Shown spelled in the key (C major spells 70 as A#).
  await expect(field).toHaveValue('F#5 2, E5 1, D5 1.5, A#4 0.5');
  await expect(rows(page)).toHaveCount(4);
  await expect(dots(page)).toHaveCount(4);

  // Bad input: an error, nothing changes, also on blur.
  const before = await tuneOf(page);
  await field.fill('F#5 2, H5 1');
  await field.press('Enter');
  await expect(fb).toHaveText(/Note 2: “H5” is not a note name/);
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('inspector').getByRole('heading').click();
  expect(await tuneOf(page)).toEqual(before);
  await shot(page, 'tune-typed-error.png');

  // Blur commits valid text.
  await field.fill('A4 1, B4 1, C5 2');
  await page.getByTestId('inspector').getByRole('heading').click();
  expect(await pitches(page)).toEqual([69, 71, 72]);
  expect(await lens(page)).toEqual([0.5, 0.5, 1]);
  await H(page).undo();
  expect(await pitches(page)).toEqual([78, 76, 74, 70]);
  await expect(field).toHaveValue('F#5 2, E5 1, D5 1.5, A#4 0.5');
  await shot(page.getByTestId('inspector'), 'tune-typed.png');

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

test('typed notes in seconds without a tempo; a merge edits as a chord block', async ({
  page,
}) => {
  await open(page, null);
  const field = page.getByTestId('tune-text');
  await expect(field).toHaveValue('C4 1, D4 1, E4 2');
  await field.fill('E4 0.75, Eb4 .25');
  await field.press('Enter');
  expect(await tuneOf(page)).toMatchObject({
    notes: [
      { pitch: 64, len: 0.75 },
      { pitch: 63, len: 0.25 },
    ],
  });
  await field.fill('E4 0');
  await field.press('Enter');
  await expect(page.getByTestId('tune-text-feedback')).toHaveText(/at least 0\.05 s/);

  // ← on a dot moves its start by 0.1 s without a tempo.
  const c = await centre(page, 1);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('ArrowLeft');
  expect(await lens(page)).toEqual([0.65, 0.35]);

  // A merge is a Chords block (§6.4): its Notes: n, no merge Fade.
  await H(page).select(['merge1']);
  await expect(page.getByTestId('inspector').getByRole('heading')).toContainText('Chord');
  await expect(page.getByTestId('insp-chord-count-slider')).toBeVisible();
});

/** Screen point for piece time `t` and pitch `p` (pitch from the tune dots' C4 and E4). */
async function at(page: Page, t: number, p: number): Promise<{ x: number; y: number }> {
  await frames(page);
  const f = await page.evaluate(() => window.__algorhythms!.frameStats);
  const box = (await page.locator('#score').boundingBox())!;
  const c4 = await centre(page, 0);
  const e4 = await centre(page, 2);
  return {
    x: box.x + ((t - f.start) / f.window) * box.width,
    y: c4.y + ((p - 60) * (e4.y - c4.y)) / 4,
  };
}

test('tune selected: a double-click adds a note (split inside a note, append after the end)', async ({
  page,
}) => {
  await open(page, 60);
  const sel = () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().selection,
    );
  // Inside E4 (6–8 s) at 7.2 s, on the G4 line: snaps to the beat at 7; E4 keeps 6–7.
  let q = await at(page, 7.2, 67);
  await page.mouse.dblclick(q.x, q.y);
  expect(await pitches(page)).toEqual([60, 62, 64, 67]);
  expect(await lens(page)).toEqual([1, 1, 1, 1]);
  expect(await H(page).undoLabel()).toBe('Add tune note');
  expect(await sel()).toEqual(['tune1']);
  await expect(dots(page)).toHaveCount(4);
  // After the end (8 s), at 10.3 s on F4: appended at 10, the last note stretched to it, a beat.
  q = await at(page, 10.3, 65);
  await page.mouse.dblclick(q.x, q.y);
  expect(await pitches(page)).toEqual([60, 62, 64, 67, 65]);
  expect(await lens(page)).toEqual([1, 1, 1, 3, 1]);
  // Before the start (4 s), at 2 s on B3: prepended, the tune starts at 2.
  q = await at(page, 2, 59);
  await page.mouse.dblclick(q.x, q.y);
  expect(await pitches(page)).toEqual([59, 60, 62, 64, 67, 65]);
  expect((await tuneOf(page)).at).toBe(2);
  expect((await lens(page))[0]).toBe(2);
  // No note point was added.
  expect((await H(page).moments()).some((m) => m.type === 'note')).toBe(false);
  await shot(page, 'tune-double-click.png');
  await H(page).undo();
  await H(page).undo();
  await H(page).undo();
  expect(await pitches(page)).toEqual([60, 62, 64]);
  expect((await tuneOf(page)).at).toBe(4);
});

test('no tune selected: a double-click on a line still adds a note point', async ({ page }) => {
  await open(page, 60);
  const q = await at(page, 10.2, 67);
  await H(page).select([]);
  await frames(page);
  await page.mouse.move(q.x, q.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(q.x, q.y - 10, { steps: 4 });
  await page.mouse.move(q.x, q.y - 25, { steps: 4 });
  await page.mouse.up({ clickCount: 2 });
  expect((await H(page).moments()).filter((m) => m.type === 'note')).toHaveLength(1);
  expect(await H(page).undoLabel()).toBe('Add note');
  expect(await pitches(page)).toEqual([60, 62, 64]);
});
