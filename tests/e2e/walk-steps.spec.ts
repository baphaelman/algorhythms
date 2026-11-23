/**
 * Walk step editing (PLAN.md §6.2 Frozen walks, §10 Drawing rules 7, §11.3 Walk; M4.5-7): the
 * inspector's Steps list, freezing on the first move, undo, save/load, and step dots. Chromium only.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough for the inspector');

/** The walk and a chord in the featured example (Tidewater Hymn). */
const WALK = '6nVoFa';
const CHORD = 'Zd0uQh';

interface StepRec {
  momentId: string;
  tick: number;
  voice: string;
  t: number;
  to: number;
}
interface Note {
  tick: number;
  voice: string;
  pitch: number;
}
interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    redo(): boolean;
    state: { getState(): { canUndo: boolean; undoLabel: string } };
  };
  store: {
    getState(): {
      piece: { moments: { id: string; fixed?: Note[] }[] };
      compiled: { walkSteps: StepRec[] };
    };
  };
  actions: { loadPiece(p: unknown): void };
}

const h = (page: Page) => ({
  select: (ids: string[]) =>
    page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  redo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.redo()),
  undoLabel: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
  canUndo: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.state.getState().canUndo),
  fixed: () =>
    page.evaluate(
      (id) =>
        (window.__algorhythms as unknown as Hook).store
          .getState()
          .piece.moments.find((m) => m.id === id)?.fixed,
      WALK,
    ),
  steps: () =>
    page.evaluate(
      (id) =>
        (window.__algorhythms as unknown as Hook).store
          .getState()
          .compiled.walkSteps.filter((s) => s.momentId === id),
      WALK,
    ),
});

const pitches = (steps: StepRec[]) => steps.map((s) => [s.tick, s.voice, s.to]);

const rowOf = (page: Page, s: { tick: number | string; voice: string }) =>
  page
    .getByTestId('inspector')
    .locator(`[data-testid=walk-step][data-tick="${s.tick}"][data-voice="${s.voice}"]`);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

/** Opens the texture block's More (the walk's fields), if closed. */
async function openMore(page: Page): Promise<void> {
  const more = page.getByTestId('inspector').getByTestId('insp-texture-more');
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
}

test('▲ on a generated walk freezes it and moves one note; one undo; save and load', async ({
  page,
}) => {
  const a = h(page);
  const insp = page.getByTestId('inspector');
  await a.select([WALK]);
  await openMore(page);
  const before = await a.steps();
  expect(before.length).toBeGreaterThan(3);
  await expect(insp.getByTestId('walk-step')).toHaveCount(before.length);
  expect(await a.fixed()).toBeUndefined();

  // A note of the highest voice, well below its range top (84): raising it can't be blocked.
  const highest = before.reduce((x, y) => (y.to > x.to ? y : x)).voice;
  const top = before.filter((s) => s.voice === highest && s.to <= 79).at(-1)!;
  const isTop = (n: { tick: number; voice: string }) =>
    n.tick === top.tick && n.voice === top.voice;
  const row = rowOf(page, top);
  await row.scrollIntoViewIfNeeded();
  await row.getByTestId('walk-step-up').click();
  await expect(row).toHaveClass(/\bon\b/);
  expect(await a.undoLabel()).toBe('Freeze walk and move step');
  await expect(insp.getByTestId('insp-walk-frozen')).toBeVisible();

  const fixed = (await a.fixed()) ?? [];
  expect(fixed).toHaveLength(before.length);
  for (const n of fixed) {
    const b = before.find((s) => s.tick === n.tick && s.voice === n.voice)!;
    if (isTop(n)) expect(n.pitch).toBeGreaterThan(b.to);
    else expect(n.pitch).toBe(b.to);
  }
  const moved = fixed.find(isTop)!.pitch;
  // Compiled: only that step's pitch changed.
  await expect
    .poll(async () => pitches(await a.steps()))
    .toEqual(before.map((s) => [s.tick, s.voice, isTop(s) ? moved : s.to]));

  // A later ▲ moves the same note again, as its own entry.
  await row.getByTestId('walk-step-up').click();
  expect(await a.undoLabel()).toBe('Move walk step');
  expect((await a.fixed())?.find(isTop)?.pitch).toBeGreaterThan(moved);
  await a.undo();
  expect((await a.fixed())?.find(isTop)?.pitch).toBe(moved);

  // One undo restores the unfrozen walk.
  await a.undo();
  expect(await a.fixed()).toBeUndefined();
  expect(await a.canUndo()).toBe(false);
  await expect(insp.getByTestId('insp-walk-frozen')).toHaveCount(0);
  await expect.poll(async () => pitches(await a.steps())).toEqual(pitches(before));

  // Save as file, then open it again: the frozen walk survives.
  await a.redo();
  const saved = await a.fixed();
  expect(saved).toHaveLength(before.length);
  await page.getByTestId('menu-button').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('save-file').click(),
  ]);
  const json = readFileSync(await file.path(), 'utf8');
  const doc = JSON.parse(json) as { moments: { id: string; fixed?: Note[] }[] };
  expect(doc.moments.find((m) => m.id === WALK)?.fixed).toEqual(saved);

  await page.evaluate((id) => {
    const hk = window.__algorhythms as unknown as Hook;
    const p = structuredClone(hk.store.getState().piece);
    p.moments = p.moments.map((m) => (m.id === id ? { ...m, fixed: undefined } : m));
    hk.actions.loadPiece(p);
  }, WALK);
  expect(await a.fixed()).toBeUndefined();
  await page.getByTestId('file-input').setInputFiles({
    name: 'frozen.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });
  await expect.poll(() => a.fixed()).toEqual(saved);
  await a.select([WALK]);
  await openMore(page);
  await expect(insp.getByTestId('insp-walk-frozen')).toBeVisible();
  await expect.poll(async () => (await a.steps()).find(isTop)?.to).toBe(moved);
});

test('walk step dots and rows select each other', async ({ page }) => {
  const a = h(page);
  const insp = page.getByTestId('inspector');
  await expect(page.getByTestId('walk-dots')).toHaveCount(0);
  await a.select([WALK]);
  await openMore(page);
  const dots = page.getByTestId('walk-dot');
  await expect(dots).toHaveCount((await a.steps()).length);
  // The walk starts at 1:39; Fit shows the whole piece.
  await expect(dots.filter({ visible: true })).toHaveCount(0);
  await page.getByTestId('zoom-fit').click();

  // Dot → row.
  // Dots may overlap at Fit; the last one is on top.
  const dot = dots.filter({ visible: true }).last();
  const ref = {
    tick: Number(await dot.getAttribute('data-tick')),
    voice: (await dot.getAttribute('data-voice'))!,
  };
  await dot.click();
  await expect(dot).toHaveAttribute('data-selected', 'true');
  await expect(rowOf(page, ref)).toHaveClass(/\bon\b/);
  await expect(rowOf(page, ref).locator('.step-pick')).toHaveAttribute('aria-pressed', 'true');
  await expect(insp.locator('[data-testid=walk-step].on')).toHaveCount(1);
  expect(await a.canUndo()).toBe(false);

  // Row → dot.
  const other = insp.getByTestId('walk-step').first();
  await other.locator('.step-pick').click();
  const t = await other.getAttribute('data-tick');
  const v = (await other.getAttribute('data-voice'))!;
  await expect(page.locator('[data-testid=walk-dot][data-selected]')).toHaveCount(1);
  await expect(
    page.locator(`[data-testid=walk-dot][data-tick="${t}"][data-voice="${v}"]`),
  ).toHaveAttribute('data-selected', 'true');

  // Selecting another moment removes the dots and the step selection.
  await a.select([CHORD]);
  await expect(page.getByTestId('walk-dots')).toHaveCount(0);
  await a.select([WALK]);
  await openMore(page);
  await expect(insp.locator('[data-testid=walk-step].on')).toHaveCount(0);
});
