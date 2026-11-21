/**
 * Every dot is draggable (PLAN.md §11.3 revision 6, §15 M4.5; M4.5-20): dragging a dot moves it
 * (vertically its pitch, sideways its arrival) by editing its moment, never adding one: a split's
 * dot writes an override, a chord dot freezes the chord, hover dots drag the same way, undo
 * restores. Note points (double-click) with Keep lines in order off cross, on don't; inside a walk
 * a double-click adds a step. Chromium only.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  from?: number;
  to?: number;
  order?: boolean;
  frozenFrom?: unknown;
  byVoice?: boolean;
  overrides?: { voice: number; pitch?: number; end?: number }[];
  fixed?: unknown[];
}

interface StepRec {
  momentId: string;
  tick: number;
  voice: string;
  t: number;
  from: number;
  to: number;
}

interface Seg {
  p0: number;
  p1: number;
  momentId?: string;
}

interface EditorHook {
  editor: {
    undo(): boolean;
    select(ids: string[]): void;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
  store: {
    getState(): {
      piece: { moments: M[] };
      compiled: { voices: { segments: Seg[] }[]; walkSteps: StepRec[] };
    };
  };
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).store.getState().piece.moments,
  );
const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().undoLabel,
  );
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as EditorHook).editor.select(i), ids);
const undo = (page: Page) =>
  page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());
/** How many voices moment `id` moves. */
const movers = (page: Page, id: string): Promise<number> =>
  page.evaluate(
    (i) =>
      (window.__algorhythms as unknown as EditorHook).store
        .getState()
        .compiled.voices.filter((v) => v.segments.some((s) => s.momentId === i && s.p0 !== s.p1))
        .length,
    id,
  );
const added = async (page: Page): Promise<M[]> =>
  (await moments(page)).filter((m) => m.type === 'note');

/** Four voices (C3 G3 C4 E4) in C major; a shift +2 at 2, a split at 12, a chord at 22. */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      start: { voice: string; pitch: number }[];
      moments: unknown[];
      key: unknown;
      end: unknown;
      defaults: { glide: Record<string, unknown> };
    };
    p.start = [48, 55, 60, 64].map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
    p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0 };
    p.moments = [
      { id: 'shift1', type: 'shift', at: 2, by: 2, unit: 'semitones' },
      { id: 'split1', type: 'split', at: 12, count: 6, voicing: 'even' },
      {
        id: 'chord1',
        type: 'chord',
        at: 22,
        notes: { kind: 'chord', symbol: 'Am' },
        voicing: 'even',
        assign: 'ordered',
      },
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 34, fade: 2 };
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
}

async function center(dot: Locator): Promise<{ x: number; y: number }> {
  const b = (await dot.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function dragBy(page: Page, from: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await open(page);
});

const byId = async (page: Page, id: string): Promise<M> =>
  (await moments(page)).find((m) => m.id === id)!;

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Screen px per second of the score. */
async function pps(page: Page): Promise<number> {
  await frames(page);
  const w = await page.evaluate(() => window.__algorhythms!.frameStats.window);
  const box = (await page.locator('#score').boundingBox())!;
  return box.width / w;
}

/** A double-click at p (the first click's play/pause is undone), then a drag by dy. */
async function doubleDrag(page: Page, p: { x: number; y: number }, dy = 0): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  if (dy !== 0) {
    await page.mouse.move(p.x, p.y + dy / 2, { steps: 4 });
    await page.mouse.move(p.x, p.y + dy, { steps: 4 });
  }
  await page.mouse.up({ clickCount: 2 });
}

test("dragging a split's dot vertically moves that note in place; undo restores", async ({
  page,
}) => {
  await select(page, ['split1']);
  const dots = page.getByTestId('arrival-dot');
  await expect(dots.first()).toBeVisible();
  const dot = dots.last();
  const t = await dot.getAttribute('data-t');
  const pitch = Number(await dot.getAttribute('data-pitch'));
  const from = await center(dot);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Up a little (the top voice's range ends at 84).
  await page.mouse.move(from.x, from.y - 6, { steps: 4 });
  await page.mouse.move(from.x, from.y - 12, { steps: 4 });
  await frames(page);
  // Mid-drag the dot tracks the pointer vertically and stays put horizontally.
  const mid = await center(page.getByTestId('drag-dot'));
  expect(Math.abs(mid.x - from.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(mid.y - (from.y - 12))).toBeLessThanOrEqual(8);
  await page.mouse.up();

  expect(await added(page)).toHaveLength(0);
  const split = await byId(page, 'split1');
  expect(split.overrides).toHaveLength(1);
  expect(split.overrides![0].pitch).toBeGreaterThan(pitch);
  expect(split.overrides![0].end).toBeUndefined();
  expect(await undoLabel(page)).toBe('Move split note');
  // After the drop the dot is at the same time, on its new pitch.
  const moved = page.locator(
    `[data-testid=arrival-dot][data-t="${t}"][data-pitch="${split.overrides![0].pitch}"]`,
  );
  await expect(moved).toBeVisible();
  expect(Math.abs((await center(moved)).x - from.x)).toBeLessThanOrEqual(2);
  await undo(page);
  expect((await byId(page, 'split1')).overrides).toBeUndefined();
});

test("dragging a split's dot sideways sets that voice's arrival; the dot follows", async ({
  page,
}) => {
  await select(page, ['split1']);
  const dot = page.getByTestId('arrival-dot').last();
  await expect(dot).toBeVisible();
  const t = Number(await dot.getAttribute('data-t'));
  const pitch = Number(await dot.getAttribute('data-pitch'));
  const from = await center(dot);
  const px = await pps(page);
  await page.keyboard.down('Alt'); // free time (no grid snap)
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y, { steps: 4 });
  await page.mouse.move(from.x + 60, from.y, { steps: 4 });
  await frames(page);
  const ghost = await center(page.getByTestId('drag-dot'));
  expect(Math.abs(ghost.x - (from.x + 60))).toBeLessThanOrEqual(2);
  expect(Math.abs(ghost.y - from.y)).toBeLessThanOrEqual(2);
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const ov = (await byId(page, 'split1')).overrides!;
  expect(ov).toHaveLength(1);
  expect(ov[0].pitch).toBeUndefined();
  expect(12 + ov[0].end!).toBeCloseTo(t + 60 / px, 1);
  const moved = page.locator(`[data-testid=arrival-dot][data-pitch="${pitch}"]`).last();
  await expect
    .poll(async () => Math.abs((await center(moved)).x - (from.x + 60)))
    .toBeLessThanOrEqual(2);
});

test('dragging a chord dot freezes the chord; undo restores it', async ({ page }) => {
  await select(page, ['chord1']);
  const dot = page.getByTestId('chord-dot').first();
  await expect(dot).toBeVisible();
  await dragBy(page, await center(dot), -30);
  const chord = (await moments(page)).find((m) => m.id === 'chord1')!;
  expect(chord.frozenFrom).toBeDefined();
  expect(await undoLabel(page)).toBe('Freeze chord and move note');
  await undo(page);
  expect((await moments(page)).find((m) => m.id === 'chord1')!.frozenFrom).toBeUndefined();
});

test("hovering near an arrival shows that moment's dots, and they drag too", async ({ page }) => {
  await select(page, ['shift1']);
  const dot = page.getByTestId('arrival-dot').first();
  await expect(dot).toBeVisible();
  const at = await center(dot);
  await select(page, []);
  await expect(page.getByTestId('arrival-dot')).toHaveCount(0);
  const hover = page.locator('[data-testid=hover-dot]:visible');
  await page.mouse.move(at.x + 20, at.y + 40);
  await expect(hover).toHaveCount(0);
  await page.mouse.move(at.x + 3, at.y + 2, { steps: 3 });
  await expect(hover).toHaveCount(4);
  await expect(hover.first()).toHaveAttribute('data-moment', 'shift1');
  // Clicking (no drag) selects the moment; nothing is recorded.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().selection,
      ),
    )
    .toEqual(['shift1']);
  await select(page, []);
  await page.mouse.move(at.x + 20, at.y + 40);
  await page.mouse.move(at.x + 1, at.y + 1, { steps: 3 });
  await expect(hover).toHaveCount(4);
  // A hover dot drags in place too: it follows the pointer vertically only.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y - 30, { steps: 6 });
  await frames(page);
  const mid = await center(page.getByTestId('drag-dot'));
  expect(Math.abs(mid.x - at.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(mid.y - (at.y - 30))).toBeLessThanOrEqual(8);
  await page.mouse.up();
  await expect(page.getByTestId('drag-dot')).toBeHidden();
  expect(await added(page)).toHaveLength(0);
  expect((await byId(page, 'shift1')).overrides).toHaveLength(1);
  expect(await undoLabel(page)).toBe('Move shift note');
  // The inspector lists the override; Clear removes it.
  const insp = page.getByTestId('inspector');
  await expect(insp.getByTestId('insp-override')).toHaveCount(1);
  await insp.getByTestId('insp-overrides-clear').click();
  expect((await byId(page, 'shift1')).overrides).toBeUndefined();
  await expect(insp.getByTestId('insp-overrides')).toHaveCount(0);
});

/** Double-clicks the shift's 62 line (C4 + 2) and drags it past its upper neighbour (66). */
async function notePastNeighbour(page: Page): Promise<M> {
  await select(page, ['shift1']);
  const d62 = page.locator('[data-testid=arrival-dot][data-pitch="62"]');
  const d66 = page.locator('[data-testid=arrival-dot][data-pitch="66"]');
  await expect(d62).toBeVisible();
  const a = await center(d62);
  const b = await center(d66);
  // On the 62 line 2 s after it lands; 4 semitones = a.y − b.y px; go 6 semitones up.
  await doubleDrag(page, { x: a.x + 2 * (await pps(page)), y: a.y }, -1.5 * (a.y - b.y));
  const ns = await added(page);
  expect(ns).toHaveLength(1);
  expect(ns[0].from).toBeCloseTo(62, 6);
  expect(ns[0].to).toBeGreaterThan(66);
  return ns[0];
}

test('with Keep lines in order off (default) a dragged note crosses its neighbour', async ({
  page,
}) => {
  const toggle = page.getByTestId('keep-order-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const n = await notePastNeighbour(page);
  expect(n.order).toBeUndefined();
  expect(await movers(page, n.id)).toBe(1);
  await expect(page.getByTestId('insp-note-order')).not.toBeChecked();
});

test('with Keep lines in order on it does not cross', async ({ page }) => {
  const toggle = page.getByTestId('keep-order-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const n = await notePastNeighbour(page);
  expect(n.order).toBe(true);
  expect(await movers(page, n.id)).toBe(2);
  await expect(page.getByTestId('insp-note-order')).toBeChecked();
  // The preference survives a reload.
  await page.reload();
  await expect(page.getByTestId('keep-order-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('double-clicking a walk line between steps adds a step (freezing the walk); undo', async ({
  page,
}) => {
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as { moments: unknown[] };
    p.moments.push({
      id: 'walk1',
      type: 'walk',
      at: 25,
      until: 33,
      grid: 1,
      density: 0.35,
      steps: [-1, 1],
      stepGlide: 0.25,
    });
    h.actions.loadPiece(p);
  });
  await page.getByTestId('zoom-fit').click();
  await select(page, ['walk1']);
  const steps = () =>
    page.evaluate(() =>
      (window.__algorhythms as unknown as EditorHook).store
        .getState()
        .compiled.walkSteps.filter((s) => s.momentId === 'walk1'),
    );
  const before = await steps();
  expect(before.length).toBeGreaterThan(1);
  // A step followed by a gap of ≥ 2 s on the same voice: its line holds there.
  const gapAfter = (s: StepRec) => {
    const next = before.find((x) => x.voice === s.voice && x.t > s.t);
    return (next?.t ?? 33) - s.t;
  };
  const s = before.find((x) => x.to !== x.from && gapAfter(x) >= 2)!;
  expect(s).toBeDefined();
  const dot = page.locator(
    `[data-testid=walk-dot][data-tick="${s.tick}"][data-voice="${s.voice}"]`,
  );
  await expect(dot).toBeVisible();
  const c = await center(dot);
  await doubleDrag(page, { x: c.x + 1 * (await pps(page)), y: c.y });
  const walk = await byId(page, 'walk1');
  expect(walk.fixed).toBeDefined();
  await expect.poll(async () => (await steps()).length).toBe(before.length + 1);
  expect(await added(page)).toHaveLength(0);
  expect(await undoLabel(page)).toBe('Freeze walk and add step');
  await expect(page.getByTestId('walk-dot')).toHaveCount(before.length + 1);
  await undo(page);
  expect((await byId(page, 'walk1')).fixed).toBeUndefined();
  await expect.poll(async () => (await steps()).length).toBe(before.length);
});
