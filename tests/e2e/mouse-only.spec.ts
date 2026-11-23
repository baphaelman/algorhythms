/**
 * M4 manual checks on the M4.5 editor (PLAN.md §15 M4 and M4.5 "M4 checks still pass"; audit gap
 * 6): a piece built with the mouse alone from New → Empty. A chord dragged from the palette (the
 * first moment, so at 0:00), its
 * chord changed in the inspector, a second chord (palette click at the playhead) and a texture
 * (palette drag, then Wander), a dot dragged, a loop region, Play, Export WAV. The score changes at each step; undo
 * walks back through them and redo forward again. Then, playing, edit → swap latency of inspector
 * clicks (the `edit-latency.spec` hooks). Chromium only.
 *
 * No key is pressed: undo and redo use the transport's Undo and Redo buttons.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parseWavHeader } from '../../src/audio/wav';
import { installLatencyHooks, median, summary, timeClicks } from './latency-hook';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

const BUDGET_MS = 50;
const DEV_CEILING_MS = 150;

interface M {
  id: string;
  type: string;
  at: number;
  notes?: { kind: string; degrees?: number[]; symbol?: string; pitches?: number[] };
  overrides?: unknown[];
  count?: number;
}

/** How many lines sound at `t` in the compiled score. */
const linesAt = (page: Page, t: number): Promise<number> =>
  page.evaluate(
    (t) =>
      (
        window.__algorhythms!.store.getState().compiled as unknown as {
          voices: { lives: { born: number; died?: number }[] }[];
        }
      ).voices.filter((v) => v.lives.some((l) => l.born <= t && (l.died ?? Infinity) > t)).length,
    t,
  );

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(() => window.__algorhythms!.store.getState().piece.moments as unknown as M[]);
/** The score part of the piece (what undo restores): its moments, as JSON. */
const scoreJson = async (page: Page): Promise<string> => JSON.stringify(await moments(page));
const added = async (page: Page, before: M[]): Promise<M[]> =>
  (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
const loop = (page: Page) =>
  page.evaluate(
    () =>
      (
        window.__algorhythms!.store.getState().piece as unknown as {
          view: { loop?: { start: number; end: number; on?: boolean } };
        }
      ).view.loop ?? null,
  );
/** The undo modifier the tooltips show. */
const modKey = (page: Page): Promise<string> =>
  page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'));
const canUndo = (page: Page) =>
  page.evaluate(() => window.__algorhythms!.editor.state.getState().canUndo);

/** The transport's time readout, in seconds. */
const shownTime = async (page: Page): Promise<number> => {
  const [m, s] = (await page.getByTestId('time').textContent())!.split(':');
  return Number(m) * 60 + Number(s);
};

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Screen x of piece time `t` on the score canvas, and the ruler's loop band y. */
async function axis(page: Page) {
  await frames(page);
  const f = await page.evaluate(() => ({
    start: window.__algorhythms!.frameStats.start,
    window: window.__algorhythms!.frameStats.window,
  }));
  const canvas = (await page.locator('#score').boundingBox())!;
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  return {
    x: (t: number) => canvas.x + ((t - f.start) / f.window) * canvas.width,
    y: canvas.y + canvas.height / 2,
    band: ruler.y + 5,
    middle: ruler.y + ruler.height - 6,
  };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** Drags palette button `type` onto the score at time `t`. */
async function dropFromPalette(page: Page, type: string, t: number): Promise<void> {
  const ax = await axis(page);
  const canvas = (await page.locator('#score').boundingBox())!;
  await page
    .getByTestId('palette')
    .locator(`[data-moment="${type}"]`)
    .dragTo(page.locator('#score'), {
      targetPosition: { x: ax.x(t) - canvas.x, y: canvas.height / 2 },
    });
}

/** Selects a moment by clicking its marker on the lane. */
async function clickLane(page: Page, id: string): Promise<void> {
  await page.getByTestId('lane').locator(`[data-moment="${id}"] .lane-marker`).click();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.editor.state.getState().selection))
    .toEqual([id]);
}

const keyChords = (page: Page) =>
  page
    .getByTestId('inspector')
    .getByTestId('insp-chord-picker')
    .getByRole('group', { name: 'From the key' })
    .getByRole('button');

// @perf: it ends with the edit → swap latency budget.
test(
  'a piece by mouse alone: New → Empty, palette, inspector, dots, loop, play, WAV; undo walks back; edits swap fast',
  {
    tag: '@perf',
  },
  async ({ page }, info) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./?example=tidewater-hymn');
    await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);

    // Each step's score, for the undo walk.
    const states: string[] = [];
    const step = async () => states.push(await scoreJson(page));

    // 1. New → Empty: no moments, silent.
    await page.getByTestId('menu-button').click();
    await page.getByTestId('new-piece').click();
    await expect.poll(async () => (await moments(page)).length).toBe(0);
    expect(await canUndo(page)).toBe(false);
    await step();

    // 2. Drag a chord from the palette onto the score at ~5 s: the first moment lands at 0:00.
    let before = await moments(page);
    await dropFromPalette(page, 'chord', 5);
    await expect.poll(async () => (await added(page, before)).length).toBe(1);
    const [chord] = await added(page, before);
    expect(chord.type).toBe('chord');
    expect(chord.at).toBe(0);
    // The drop selects it.
    await expect
      .poll(() => page.evaluate(() => window.__algorhythms!.editor.state.getState().selection))
      .toEqual([chord.id]);
    // From silence it brings in a triad: three lines, a chord name.
    await expect.poll(() => linesAt(page, chord.at + 2)).toBe(3);
    const label = page.getByTestId('lane').locator(`[data-moment="${chord.id}"] .lane-label`);
    await expect(label).toHaveText(/(^|· )[A-G]/); // a numeral symbol reads "i · Am"
    await expect(label).not.toContainText('unison');
    await step();

    // 3. Change its chord in the inspector by clicking a chord from the key.
    await clickLane(page, chord.id);
    const picks = keyChords(page);
    await expect(picks.first()).toBeVisible();
    const notes0 = JSON.stringify(chord.notes);
    await picks.nth(3).click();
    await expect
      .poll(async () => JSON.stringify((await moments(page)).find((m) => m.id === chord.id)!.notes))
      .not.toBe(notes0);
    await step();

    // 4. A second chord: click the ruler at ~10 s to seek, then the palette's Chord (adds at the
    // playhead).
    let ax = await axis(page);
    await page.mouse.click(ax.x(10), ax.middle);
    await expect.poll(() => shownTime(page)).toBeCloseTo(10, 0);
    before = await moments(page);
    await page.getByTestId('palette').locator('[data-moment="chord"]').click();
    await expect.poll(async () => (await added(page, before)).length).toBe(1);
    const [split] = await added(page, before);
    expect(split.type).toBe('chord');
    expect(Math.abs(split.at - 10)).toBeLessThan(0.5);
    await step();

    // 5. A texture (an Arpeggio pulse), dragged from the palette to ~15 s.
    before = await moments(page);
    await dropFromPalette(page, 'pulse', 15);
    await expect.poll(async () => (await added(page, before)).length).toBe(1);
    const [walk] = await added(page, before);
    expect(walk.type).toBe('pulse');
    expect(Math.abs(walk.at - 15)).toBeLessThan(0.5);
    await step();
    // Its texture: Wander (a walk, same id).
    await page
      .getByTestId('insp-texture')
      .getByRole('button', { name: 'Wander', exact: true })
      .click();
    await expect
      .poll(async () => (await moments(page)).find((m) => m.id === walk.id)?.type)
      .toBe('walk');
    await step();

    // 6. Drag one of the second chord's dots up: it edits that chord, adds nothing.
    await clickLane(page, split.id);
    const dot = page.getByTestId('chord-dot').last();
    await expect(dot).toBeVisible();
    const b = (await dot.boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const n0 = (await moments(page)).length;
    const split0 = JSON.stringify((await moments(page)).find((m) => m.id === split.id));
    await drag(page, from, { x: from.x, y: from.y - 40 });
    await expect
      .poll(async () => JSON.stringify((await moments(page)).find((m) => m.id === split.id)))
      .not.toBe(split0);
    expect((await moments(page)).length).toBe(n0);
    await step();

    // 7. A loop region: drag the ruler's loop band from ~2 s to ~12 s.
    ax = await axis(page);
    await drag(page, { x: ax.x(2), y: ax.band }, { x: ax.x(12), y: ax.band });
    await expect.poll(() => loop(page)).not.toBeNull();
    const region = (await loop(page))!;
    expect(region.start).toBeCloseTo(2, 0);
    expect(region.end).toBeCloseTo(12, 0);
    // No grid here: both edges are rounded to the millisecond.
    for (const t of [region.start, region.end]) expect(Math.round(t * 1000) / 1000).toBe(t);
    expect(await canUndo(page)).toBe(true); // the edits before; the loop added no entry
    await expect(page.getByTestId('loop-toggle')).toBeEnabled();

    // 8. Play: time runs, and stays in the loop region.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.__algorhythms!.engine()?.isPlaying === true);
    const now = () => page.evaluate(() => window.__algorhythms!.engine()!.currentTime());
    const t0 = await now();
    await expect.poll(now, { timeout: 15_000 }).not.toBe(t0);
    const t1 = await now();
    expect(t1).toBeGreaterThanOrEqual(region.start - 0.1);
    expect(t1).toBeLessThanOrEqual(region.end + 0.1);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForFunction(() => window.__algorhythms!.engine()?.isPlaying === false);

    // 9. Export a WAV from the menu.
    await page.getByTestId('menu-button').click();
    await page.getByTestId('open-export').click();
    const dialog = page.getByTestId('export-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('export-run')).toBeEnabled();
    await dialog.getByTestId('export-format').getByLabel('WAV', { exact: true }).check();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByTestId('export-run').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    const hdr = parseWavHeader(new Uint8Array(readFileSync(await download.path())));
    expect(hdr.channels).toBe(2);
    const D = await page.evaluate(() => window.__algorhythms!.store.getState().compiled.duration);
    expect(hdr.frames / hdr.sampleRate).toBeGreaterThan(D - 0.5);
    await page
      .getByRole('dialog', { name: 'Export' })
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(dialog).toBeHidden();

    // 10. The Undo button walks back through every step to the empty piece; Redo comes forward
    // again. Each tooltip names its entry; a button is disabled when its history is empty. The
    // loop region is view state: undo leaves it alone.
    const undoBtn = page.getByTestId('undo');
    const redoBtn = page.getByTestId('redo');
    expect(await scoreJson(page)).toBe(states.at(-1));
    await expect(redoBtn).toBeDisabled();
    await expect(redoBtn).toHaveAttribute('title', 'Nothing to redo');
    for (let i = states.length - 2; i >= 0; i--) {
      const label = await page.evaluate(
        () => window.__algorhythms!.editor.state.getState().undoLabel,
      );
      expect(label).not.toBe('');
      await expect(undoBtn).toHaveAttribute('title', `Undo ${label} (${await modKey(page)}Z)`);
      await undoBtn.click();
      await expect.poll(() => scoreJson(page), `undo to step ${i + 1}`).toBe(states[i]);
    }
    expect(await canUndo(page)).toBe(false);
    await expect(undoBtn).toBeDisabled();
    await expect(undoBtn).toHaveAttribute('title', 'Nothing to undo');
    expect(await loop(page)).toEqual(region);
    for (let i = 1; i < states.length; i++) {
      await expect(redoBtn).toHaveAttribute('title', /^Redo \S/);
      await redoBtn.click();
      await expect.poll(() => scoreJson(page), `redo to step ${i + 1}`).toBe(states[i]);
    }
    await expect(redoBtn).toBeDisabled();
    const loopAfter = await loop(page);

    // 11. Playing, inspector clicks reach the worklet fast (edit-latency.spec's hooks).
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.__algorhythms!.engine()?.isPlaying === true);
    await page.waitForTimeout(1000);
    await installLatencyHooks(page);
    await clickLane(page, chord.id);
    await expect(keyChords(page).first()).toBeVisible();
    const uiChord = await timeClicks(page, 8, (i) =>
      keyChords(page)
        .nth(i % 2 === 0 ? 1 : 4)
        .click(),
    );
    await clickLane(page, walk.id);
    await page.getByTestId('insp-texture-more').locator('summary').click();
    const chip = page
      .getByTestId('inspector')
      .getByTestId('insp-walk-steps')
      .getByRole('button', { name: '+3' });
    await expect(chip).toBeEnabled();
    const uiWalk = await timeClicks(page, 8, () => chip.click());
    expect(await page.evaluate(() => window.__algorhythms!.engine()!.isPlaying)).toBe(true);

    const result = { clickChord: summary(uiChord), clickWalk: summary(uiWalk), loopAfter };
    console.log(
      `[${info.project.name}] mouse-only session, edit → swap: ${JSON.stringify(result)}`,
    );
    info.annotations.push({ type: 'edit-latency', description: JSON.stringify(result) });
    const budget = info.project.name.endsWith('-dev') ? DEV_CEILING_MS : BUDGET_MS;
    expect(median(uiChord), 'clickChord median (ms)').toBeLessThanOrEqual(budget);
    expect(median(uiWalk), 'clickWalk median (ms)').toBeLessThanOrEqual(budget);
    expect(errors).toEqual([]);
  },
);
