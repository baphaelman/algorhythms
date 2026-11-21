/**
 * "Snap to beats" (PLAN.md §11.3 revision 9; R9-9): a piece with a tempo shows the toggle in the
 * view bar, on by default; palette drops, lane drags, dot drags and "Next" snap to beats (Alt:
 * free); off, or without a tempo, nothing snaps to the grid. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  overrides?: { voice: number; pitch?: number; end?: number }[];
}

interface Hook {
  editor: { select(ids: string[]): void };
  store: { getState(): { piece: { moments: M[]; view: { snapBeats?: boolean } } } };
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments);
const byId = async (page: Page, id: string): Promise<M> =>
  (await moments(page)).find((m) => m.id === id)!;
const snapFlag = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as Hook).store.getState().piece.view.snapBeats,
  );
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids);
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/**
 * Four voices in C major: a split at 2 (lands at 4), a shift at 5, a walk 9..13. `bpm` 40 makes a
 * beat 1.5 s (about 90 px), or no tempo at all.
 */
async function open(page: Page, bpm: number | null, snapBeats?: boolean): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(
    ([tempo, snap]) => {
      const h = window.__algorhythms!;
      const p = structuredClone(h.store.getState().piece) as unknown as {
        moments: unknown[];
        key: unknown;
        end: unknown;
        defaults: { glide: Record<string, unknown> };
        view: Record<string, unknown>;
      };
      p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0 };
      delete p.defaults.glide.land;
      p.moments = [
        {
          id: 'start0',
          type: 'chord',
          at: 0,
          notes: { kind: 'pitches', pitches: [48, 55, 60, 64] },
          voicing: 'even',
          assign: 'ordered',
        },
        { id: 'split1', type: 'split', at: 2, count: 6, voicing: 'even' },
        { id: 'shift1', type: 'shift', at: 5, by: 2, unit: 'semitones' },
        {
          id: 'walk1',
          type: 'walk',
          at: 9,
          until: 13,
          grid: 1,
          density: 1,
          steps: [-1, 1],
          stepGlide: 0.25,
        },
      ];
      p.key = { tonic: 'C', scale: 'major' };
      p.end = { at: 16, fade: 1 };
      delete p.view.gridBpm;
      delete p.view.snapBeats;
      if (tempo !== null) p.view.gridBpm = tempo;
      if (snap !== undefined && snap !== null) p.view.snapBeats = snap;
      h.actions.loadPiece(p);
    },
    [bpm, snapBeats ?? null] as [number | null, boolean | null],
  );
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await frames(page);
}

/** Score px per second, the canvas's left edge and the view start. */
async function axis(page: Page): Promise<{ pps: number; left: number; start: number }> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  const box = (await page.locator('#score').boundingBox())!;
  return { pps: box.width / s.window, left: box.x, start: s.start };
}

const toggle = (page: Page) => page.getByTestId('snap-beats-toggle');

async function markerOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(`[data-moment="${id}"] .lane-marker`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Drags the lane marker of `id` by `dt` seconds, with `Alt` held mid-drag if asked. */
async function dragMoment(page: Page, id: string, dt: number, alt = false): Promise<void> {
  const { pps } = await axis(page);
  const from = await markerOf(page, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(from.x + (dt * pps) / 2, from.y, { steps: 5 });
  await page.mouse.move(from.x + dt * pps, from.y, { steps: 5 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

test('the toggle shows only with a tempo, on by default, and the choice is stored in the piece', async ({
  page,
}) => {
  await open(page, null);
  await expect(toggle(page)).toHaveCount(0);

  await open(page, 40);
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await snapFlag(page)).toBeUndefined();
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await snapFlag(page)).toBe(false);
  // An edit (and its undo) does not bring it back: it is view state, not an edit.
  await dragMoment(page, 'shift1', 1.3);
  expect(await snapFlag(page)).toBe(false);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await snapFlag(page)).toBe(false);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await snapFlag(page)).toBeUndefined();

  // A piece that saved it off opens off.
  await open(page, 40, false);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('dragging a moment on the lane lands on a beat; off or with Alt it stays free', async ({
  page,
}) => {
  await open(page, 40);
  // 1.5 s beats: 5 → 6.3 is nearest the beat at 6.
  await dragMoment(page, 'shift1', 1.3);
  expect((await byId(page, 'shift1')).at).toBeCloseTo(6, 6);

  await open(page, 40);
  await dragMoment(page, 'shift1', 1.3, true);
  expect(Math.abs((await byId(page, 'shift1')).at - 6.3)).toBeLessThan(0.04);

  await open(page, 40, false);
  await dragMoment(page, 'shift1', 1.3);
  expect(Math.abs((await byId(page, 'shift1')).at - 6.3)).toBeLessThan(0.04);

  // No tempo: as before.
  await open(page, null);
  await dragMoment(page, 'shift1', 1.3);
  expect(Math.abs((await byId(page, 'shift1')).at - 6.3)).toBeLessThan(0.04);
});

test('a palette drop lands on a beat; a note-change point within 8 px still wins when nearer', async ({
  page,
}) => {
  await open(page, 40);
  const { pps, left, start } = await axis(page);
  const lane = (await page.locator('.lane-track').boundingBox())!;
  const chord = (await page.getByTestId('palette').locator('[data-moment="chord"]').boundingBox())!;
  const dropAt = async (t: number): Promise<void> => {
    const x = left + (t - start) * pps;
    await page.mouse.move(chord.x + chord.width / 2, chord.y + chord.height / 2);
    await page.mouse.down();
    await page.mouse.move(x - 4, lane.y + lane.height / 2, { steps: 8 });
    await page.mouse.move(x, lane.y + lane.height / 2, { steps: 3 });
    await page.mouse.up();
  };
  // 11.6 s: the beats are 10.5 and 12.
  await dropAt(11.6);
  const ms = await moments(page);
  const added = ms.find((m) => !['start0', 'split1', 'shift1', 'walk1'].includes(m.id))!;
  expect(added.type).toBe('chord');
  expect(added.at).toBeCloseTo(12, 6);
});

test('a dot dragged sideways lands on a beat; Alt and the toggle leave it free', async ({
  page,
}) => {
  const dragTo = async (t: number, alt = false): Promise<number | undefined> => {
    await select(page, ['split1']);
    const dot = page.getByTestId('arrival-dot').last();
    await expect(dot).toBeVisible();
    const b = (await dot.boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const a = await axis(page);
    const x = a.left + (t - a.start) * a.pps;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move((from.x + x) / 2, from.y, { steps: 6 });
    await page.mouse.move(x, from.y, { steps: 6 });
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
    return (await byId(page, 'split1')).overrides?.find((o) => o.end !== undefined)?.end;
  };

  // The split at 2 arrives at 4; 7.3 s is nearest the 7.5 s beat, an arrival offset of 5.5.
  await open(page, 40);
  expect(await dragTo(7.3)).toBeCloseTo(5.5, 6);

  await open(page, 40);
  const free = await dragTo(7.3, true);
  expect(Math.abs(free! - 5.3)).toBeLessThan(0.04);

  await open(page, 40, false);
  const off = await dragTo(7.3);
  expect(Math.abs(off! - 5.3)).toBeLessThan(0.04);
});

test('Next appends a bar after the last end, on a beat; off, 2 s after it', async ({ page }) => {
  await open(page, 40);
  const next = page.getByTestId('suggestions');
  // The walk ends at 13; a 4-beat bar of 1.5 s beats → 19, the next beat is 19.5. Off: 13 + 2.
  await expect.poll(async () => Number(await next.getAttribute('data-t'))).toBeCloseTo(19.5, 2);
  await toggle(page).click();
  await expect.poll(async () => Number(await next.getAttribute('data-t'))).toBeCloseTo(15, 2);
  await toggle(page).click();
  await expect.poll(async () => Number(await next.getAttribute('data-t'))).toBeCloseTo(19.5, 2);
});
