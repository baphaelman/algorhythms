/**
 * Pulse editing (PLAN.md §6.2 `pulse`, §11.3; R9-7): the palette entry (greyed from silence,
 * hover ghost, drop on a beat), the lane region (accent cycle drawn, move and end drags snapping
 * to beats, Alt free) and the inspector (region, beat values, pattern cells, decay, floor, mode,
 * re-strike), with undo and a share link. Chromium only.
 */

import { shot } from './shots';
import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  until?: number;
  step?: number;
  pattern?: number[];
  decay?: number;
  floor?: number;
  mode?: string;
  strike?: boolean;
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

const hook = (page: Page) => ({
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

const pulseOf = async (page: Page, id = 'pulse1'): Promise<M> =>
  (await hook(page).moments()).find((m) => m.id === id)!;

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/**
 * Four notes in C major from 0 and a pulse 4..8 (0.5 s steps, [1, 0.5]); `bpm` 60 makes a beat
 * 1 s, null: no tempo. `silent`: no moments at all.
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
              notes: { kind: 'pitches', pitches: [48, 55, 60, 64] },
              voicing: 'even',
              assign: 'ordered',
            },
            {
              id: 'pulse1',
              type: 'pulse',
              at: 4,
              until: 8,
              step: 0.5,
              pattern: [1, 0.5],
              decay: 0.3,
              floor: 0,
              mode: 'together',
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

/** Score px per second, the canvas's left edge and the view start. */
async function axis(page: Page): Promise<{ pps: number; left: number; start: number }> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats);
  const box = (await page.locator('#score').boundingBox())!;
  return { pps: box.width / s.window, left: box.x, start: s.start };
}

const item = (page: Page, id = 'pulse1') =>
  page.getByTestId('lane').locator(`[data-moment="${id}"]`);
const inspector = (page: Page) => page.getByTestId('inspector');

async function center(page: Page, sel: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(sel).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Drags from `from` by `dx` px, with Alt held mid-drag if asked. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, alt = false) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y, { steps: 5 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

test('palette: greyed from silence with the reason; hover shows a pulse ghost; click adds one', async ({
  page,
}) => {
  await open(page, null, true);
  const btn = page.getByTestId('palette').locator('[data-moment="pulse"]');
  await expect(btn).toHaveAttribute('data-no-effect', 'true');
  await expect(btn).toHaveAttribute('title', /Texture: No effect here: .+/);
  await expect(btn).toHaveAttribute('aria-keyshortcuts', 'T');

  await open(page, null);
  await seek(page, 10);
  await expect(btn).not.toHaveAttribute('data-no-effect', /.*/);
  const ghost = page.getByTestId('lane-ghost');
  await btn.hover();
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-type', 'pulse');
  expect(Number(await ghost.getAttribute('data-at'))).toBeCloseTo(10, 3);
  // The ghost draws the accent cycle in its bar.
  await expect(ghost.locator('.lane-art.lane-pulse')).toHaveCount(1);
  const { pps } = await axis(page);
  const ghostLen = (await ghost.locator('.lane-bar').boundingBox())!.width / pps;
  await page.mouse.move(5, 5);
  await expect(ghost).toBeHidden();

  await btn.click();
  const added = (await hook(page).moments()).find((m) => m.type === 'pulse' && m.id !== 'pulse1')!;
  expect(added.at).toBeCloseTo(10, 3);
  // Texture's default (§6.4): an Arpeggio to the end of the chord block under it, as the ghost.
  expect(added.mode).toBe('updown');
  expect(Math.abs(added.until! - added.at - ghostLen)).toBeLessThan(0.2);
  await expect(inspector(page).getByRole('heading')).toContainText('Texture');
  // The T key adds one too.
  await seek(page, 2);
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('t');
  expect((await hook(page).moments()).filter((m) => m.type === 'pulse')).toHaveLength(3);
});

test('lane: the region shows its accent cycle; moving and resizing snap to beats, Alt is free', async ({
  page,
}) => {
  await open(page, 60);
  await expect(item(page)).toHaveAttribute('data-type', 'pulse');
  await expect(item(page)).toHaveAttribute('aria-label', /pulse at 4 s, 4 s long/);
  const bar = item(page).locator('.lane-bar');
  await expect(bar.locator('.lane-art.lane-pulse')).toHaveCount(1);
  const { pps } = await axis(page);
  expect((await bar.boundingBox())!.width).toBeCloseTo(4 * pps, -1);

  // Move by 1.3 s: lands on the beat at 5 (until follows to 9).
  await dragBy(page, await center(page, '[data-moment="pulse1"] .lane-marker'), 1.3 * pps);
  let m = await pulseOf(page);
  expect(m.at).toBeCloseTo(5, 6);
  expect(m.until).toBeCloseTo(9, 6);
  expect(await hook(page).undoLabel()).toBe('Move moment');

  // Drag the end by +1.4 s: until snaps to the beat at 10.
  await hook(page).select(['pulse1']);
  await item(page).hover();
  const end = await center(page, '[data-moment="pulse1"] .lane-end');
  await dragBy(page, end, 1.4 * pps);
  m = await pulseOf(page);
  expect(m.at).toBeCloseTo(5, 6);
  expect(m.until).toBeCloseTo(10, 6);
  expect(await hook(page).undoLabel()).toBe('Change region');

  // Alt: free.
  await item(page).hover();
  await dragBy(page, await center(page, '[data-moment="pulse1"] .lane-end'), 0.6 * pps, true);
  m = await pulseOf(page);
  expect(Math.abs(m.until! - 10.6)).toBeLessThan(0.05);

  await hook(page).undo();
  await hook(page).undo();
  m = await pulseOf(page);
  expect([m.at, m.until]).toEqual([5, 9]);
});

test('palette drop lands on a beat', async ({ page }) => {
  await open(page, 60);
  const { pps, left, start } = await axis(page);
  const lane = (await page.locator('.lane-track').boundingBox())!;
  const btn = (await page.getByTestId('palette').locator('[data-moment="pulse"]').boundingBox())!;
  const x = left + (11.3 - start) * pps;
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.mouse.down();
  await page.mouse.move(x - 4, lane.y + lane.height / 2, { steps: 8 });
  await page.mouse.move(x, lane.y + lane.height / 2, { steps: 3 });
  await page.mouse.up();
  const added = (await hook(page).moments()).find((m) => m.type === 'pulse' && m.id !== 'pulse1')!;
  expect(added.at).toBeCloseTo(11, 6);
  // Eighths at 60 bpm, to the end of the chord block under it (§6.4 Texture default).
  expect(added.step).toBeCloseTo(0.5, 6);
  expect(added.until).toBeCloseTo(16, 6);
});

test('inspector: every field edits the pulse, one undo entry each; a share link keeps them', async ({
  page,
  context,
}) => {
  await open(page, 60);
  await hook(page).select(['pulse1']);
  const insp = inspector(page);
  await expect(insp.getByRole('heading')).toContainText('Texture');
  await insp.getByTestId('insp-texture-more').locator('summary').click();
  // No transition for a pulse; together has no seed.
  await expect(insp.getByTestId('insp-transition')).toHaveCount(0);
  await expect(insp.getByTestId('insp-seed')).toHaveCount(0);

  // Region.
  const region = insp.getByTestId('insp-pulse-region');
  await region.fill('6');
  await region.press('Enter');
  expect((await pulseOf(page)).until).toBeCloseTo(10, 6);
  expect(await hook(page).undoLabel()).toBe('Edit texture length');

  // Beat values (a tempo: 1 s a beat): 1/8 is pressed; 1/16 writes 0.25 s.
  const beats = insp.getByTestId('insp-pulse-beats');
  await expect(beats.getByRole('button', { name: '1/8', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await beats.getByRole('button', { name: '1/16', exact: true }).click();
  expect((await pulseOf(page)).step).toBeCloseTo(0.25, 6);
  await expect(insp.getByTestId('insp-pulse-step')).toHaveValue('0.25');

  // Pattern cells: a press near the bottom of cell 2 sets a low accent; keys adjust; + step.
  const cells = insp.getByTestId('pulse-cell');
  await expect(cells).toHaveCount(2);
  const c2 = (await cells.nth(1).boundingBox())!;
  await page.mouse.click(c2.x + c2.width / 2, c2.y + c2.height * 0.75);
  expect((await pulseOf(page)).pattern![1]).toBeCloseTo(0.25, 1);
  expect(await hook(page).undoLabel()).toBe('Edit accent');
  await expect(cells.nth(1)).toBeFocused();
  await page.keyboard.press('Home');
  expect((await pulseOf(page)).pattern).toEqual([1, 0]);
  await expect(cells.nth(1)).toHaveAttribute('aria-valuetext', 'rest');
  await page.keyboard.press('ArrowLeft');
  await expect(cells.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  expect((await pulseOf(page)).pattern).toEqual([0.95, 0]);
  await insp.getByTestId('pulse-add-step').click();
  expect((await pulseOf(page)).pattern).toEqual([0.95, 0, 0.5]);
  await insp.getByTestId('pulse-remove-step').click();
  await insp.getByTestId('pulse-remove-step').click();
  expect((await pulseOf(page)).pattern).toEqual([0.95]);
  await expect(insp.getByTestId('pulse-remove-step')).toBeDisabled();
  await insp.getByTestId('pulse-add-step').click();
  await insp.getByTestId('pulse-add-step').click();

  // Decay, floor, mode, re-strike.
  const decay = insp.getByTestId('insp-pulse-decay');
  await decay.fill('0.15');
  await decay.press('Enter');
  const floor = insp.getByTestId('insp-pulse-floor');
  await floor.fill('20');
  await floor.press('Enter');
  await insp.getByTestId('insp-pulse-mode').getByRole('button', { name: 'Up-down' }).click();
  await insp.getByTestId('insp-pulse-strike').uncheck();
  let m = await pulseOf(page);
  expect(m).toMatchObject({ decay: 0.15, floor: 0.2, mode: 'updown', strike: false });
  // Random order shows the seed.
  await insp.getByTestId('insp-pulse-mode').getByRole('button', { name: 'Random' }).click();
  await expect(insp.getByTestId('insp-seed')).toBeVisible();
  expect(await hook(page).undoLabel()).toBe('Change pulse mode');
  await hook(page).undo();
  expect((await pulseOf(page)).mode).toBe('updown');

  // The Time field moves the whole region.
  const at = insp.getByTestId('insp-at');
  await at.fill('3');
  await at.press('Enter');
  m = await pulseOf(page);
  expect([m.at, m.until]).toEqual([3, 9]);

  await shot(page, 'pulse-inspector-lane.png');
  await shot(insp, 'pulse-inspector.png');

  // A share link carries every edit.
  const link = await page.evaluate(() => {
    const h = window.__algorhythms!;
    return h.encodeShareLink(h.store.getState().piece);
  });
  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const back = await pulseOf(fresh);
  expect(back).toEqual(m);
});
