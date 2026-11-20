/**
 * Every dot is draggable and Keep lines in order (PLAN.md §11.3 revision 6, §15 M4.5): dragging a
 * split's or shift's arrival dot adds a note moment, a chord dot freezes the chord, hovered dots
 * drag the same way, undo restores; with Keep lines in order off a dragged note crosses its
 * neighbour, with it on it doesn't. Chromium only.
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
      compiled: { voices: { segments: Seg[] }[] };
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

test("dragging a split's arrival dot adds a note moment; undo removes it", async ({ page }) => {
  await select(page, ['split1']);
  const dots = page.getByTestId('arrival-dot');
  await expect(dots.first()).toBeVisible();
  const dot = dots.last();
  const t = Number(await dot.getAttribute('data-t'));
  const pitch = Number(await dot.getAttribute('data-pitch'));
  await dragBy(page, await center(dot), -30);

  const ns = await added(page);
  expect(ns).toHaveLength(1);
  expect(ns[0].at).toBeCloseTo(t, 3);
  expect(ns[0].from).toBeCloseTo(pitch, 6);
  expect(ns[0].to).toBeGreaterThan(pitch);
  expect(await undoLabel(page)).toBe('Add note');
  await undo(page);
  expect(await added(page)).toHaveLength(0);
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
  await dragBy(page, at, -30);
  expect(await added(page)).toHaveLength(1);
  expect(await undoLabel(page)).toBe('Add note');
});

/** Drags the shift's 62 dot (C4 + 2) past its upper neighbour (66); returns the added note. */
async function dragPastNeighbour(page: Page): Promise<M> {
  await select(page, ['shift1']);
  const d62 = page.locator('[data-testid=arrival-dot][data-pitch="62"]');
  const d66 = page.locator('[data-testid=arrival-dot][data-pitch="66"]');
  await expect(d62).toBeVisible();
  const a = await center(d62);
  const b = await center(d66);
  // 4 semitones = a.y − b.y px; go 6 semitones up (to 68 or the scale tone near it).
  await dragBy(page, a, -1.5 * (a.y - b.y));
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
  const n = await dragPastNeighbour(page);
  expect(n.order).toBeUndefined();
  expect(await movers(page, n.id)).toBe(1);
  await expect(page.getByTestId('insp-note-order')).not.toBeChecked();
});

test('with Keep lines in order on it does not cross', async ({ page }) => {
  const toggle = page.getByTestId('keep-order-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const n = await dragPastNeighbour(page);
  expect(n.order).toBe(true);
  expect(await movers(page, n.id)).toBe(2);
  await expect(page.getByTestId('insp-note-order')).toBeChecked();
  // The preference survives a reload.
  await page.reload();
  await expect(page.getByTestId('keep-order-toggle')).toHaveAttribute('aria-pressed', 'true');
});
