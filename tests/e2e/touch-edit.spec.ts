/**
 * Touch editing on a tablet (PLAN.md §11.3b, §15 M5 "adding, moving, editing and deleting moments
 * works by touch alone"): a touch-only context (`hasTouch`, 1180×820, no mouse or keys used).
 * Palette tap adds at the playhead; tap selects; drag moves (with a finger-sized threshold);
 * a span end drags; the inspector edits by tap; long press opens the menu (Duplicate, Delete,
 * Snap, Ends set stagger, Select more); dots drag; a tap on a line shows its readout; pinch zooms
 * and two fingers pan. Gestures: ./touch (CDP touches on Chromium, synthetic touch pointers
 * elsewhere; WebKit runs on CI).
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';
import { fingerTap, installTouch, longPress, touchDrag, twoFinger, type Pt } from './touch';

test.use({ hasTouch: true, isMobile: false, viewport: { width: 1180, height: 820 } });

interface M {
  id: string;
  type: string;
  at: number;
  seed?: number;
  frozenFrom?: unknown;
  glide?: { length?: number; stagger?: number; ease?: unknown };
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(
    () => (window.__algorhythms!.store.getState().piece as unknown as { moments: M[] }).moments,
  );
const byId = async (page: Page, id: string): Promise<M | undefined> =>
  (await moments(page)).find((m) => m.id === id);
const selection = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__algorhythms!.editor.state.getState().selection);
const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(() => window.__algorhythms!.editor.state.getState().undoLabel);
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const item = (page: Page, id: string) => page.locator(`.lane-track [data-moment="${id}"]`);

async function centre(page: Page, selector: string): Promise<Pt> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`nothing at ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
const marker = (page: Page, id: string) =>
  centre(page, `.lane-track [data-moment="${id}"] .lane-marker`);

/** Lane pixels per second, from two markers 4 s apart. */
async function pps(page: Page): Promise<number> {
  return ((await marker(page, 'bbbbbb')).x - (await marker(page, 'aaaaaa')).x) / 4;
}

async function open(page: Page, snapBeats = false): Promise<void> {
  await installTouch(page);
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'full');
  await page.evaluate((snapBeats) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    p.moments = [
      {
        id: 'aaaaaa',
        type: 'chord',
        at: 2,
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'even',
        assign: 'ordered',
        glide: { length: 1, stagger: 0 },
      },
      {
        id: 'bbbbbb',
        type: 'unison',
        at: 6,
        pitch: 'center',
        octaves: false,
        glide: { length: 2, stagger: 0 },
      },
      {
        id: 'cccccc',
        type: 'chord',
        at: 12,
        notes: { kind: 'degrees', degrees: [1, 3, 5] },
        voicing: 'even',
        assign: 'ordered',
        glide: { length: 1, stagger: 0 },
      },
    ];
    p.end = { at: 20, fade: 1 };
    p.view = { ...p.view, gridBpm: 60, snapBeats, window: 20 };
    h.actions.loadPiece(p);
  }, snapBeats);
  await expect(page.locator('.lane-track [data-moment]')).toHaveCount(3);
  await frames(page);
}

test('a palette tap adds a moment at the playhead; tapping an item selects it', async ({
  page,
}) => {
  await open(page);
  await seek(page, 9);
  await page.getByTestId('palette').locator('button[data-moment="chord"]').tap();
  await expect.poll(async () => (await moments(page)).length).toBe(4);
  const added = (await moments(page)).find((m) => !['aaaaaa', 'bbbbbb', 'cccccc'].includes(m.id))!;
  expect(added.at).toBeCloseTo(9, 1);
  await fingerTap(page, await marker(page, 'cccccc'));
  await expect(item(page, 'cccccc')).toHaveAttribute('aria-pressed', 'true');
  expect(await selection(page)).toEqual(['cccccc']);
  // The inspector opened on it, and is edited by tap.
  const curve = page
    .getByTestId('insp-transition')
    .getByRole('button', { name: 'Linear', exact: true });
  await curve.tap();
  await expect.poll(async () => (await byId(page, 'cccccc'))?.glide?.ease).toBe('linear');
  await page.getByTestId('undo').tap();
  await expect.poll(async () => (await byId(page, 'cccccc'))?.glide?.ease).toBeUndefined();
});

test('a finger drag moves a moment; a small wobble is still a tap; undo by tap', async ({
  page,
}) => {
  await open(page);
  const k = await pps(page);
  const a = await marker(page, 'aaaaaa');
  // 6 px of finger wobble: a tap (selects, moves nothing).
  await touchDrag(page, a, { x: a.x + 6, y: a.y + 2 }, 3);
  await expect.poll(() => selection(page)).toEqual(['aaaaaa']);
  expect((await byId(page, 'aaaaaa'))!.at).toBe(2);
  await touchDrag(page, a, { x: a.x + 1.8 * k, y: a.y });
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.at).toBeCloseTo(3.8, 1);
  expect(await undoLabel(page)).toBe('Move moment');
  await page.getByTestId('undo').tap();
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.at).toBe(2);
});

test('dragging a span end changes the glide length; "Ends set stagger" changes the stagger', async ({
  page,
}) => {
  await open(page);
  const k = await pps(page);
  const end = await centre(page, '.lane-track [data-moment="bbbbbb"] .lane-end');
  await touchDrag(page, end, { x: end.x + 1.5 * k, y: end.y });
  await expect
    .poll(async () => (await byId(page, 'bbbbbb'))!.glide?.length ?? 0)
    .toBeCloseTo(3.5, 1);
  // Long press: the menu; latch "Ends set stagger".
  await longPress(page, await marker(page, 'bbbbbb'));
  const menu = page.getByTestId('touch-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('touch-stagger').tap();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('touch-mods').locator('[data-mod="stagger"]')).toBeVisible();
  const end2 = await centre(page, '.lane-track [data-moment="bbbbbb"] .lane-end');
  await touchDrag(page, end2, { x: end2.x + 1 * k, y: end2.y });
  await expect
    .poll(async () => (await byId(page, 'bbbbbb'))!.glide?.stagger ?? 0)
    .toBeGreaterThan(0.5);
  expect((await byId(page, 'bbbbbb'))!.glide?.length).toBeCloseTo(3.5, 1);
  // The chip turns it off.
  await page.getByTestId('touch-mods').locator('[data-mod="stagger"]').tap();
  await expect(page.getByTestId('touch-mods')).toHaveCount(0);
});

test('long press: Duplicate, then Delete, by touch alone', async ({ page }) => {
  await open(page);
  await longPress(page, await marker(page, 'cccccc'));
  const menu = page.getByTestId('touch-menu');
  await expect(menu).toBeVisible();
  expect(await selection(page)).toEqual(['cccccc']);
  // The finger's release did not pick an item.
  expect((await moments(page)).length).toBe(3);
  await menu.getByTestId('touch-duplicate').tap();
  await expect.poll(async () => (await moments(page)).length).toBe(4);
  const copy = (await moments(page)).find((m) => !['aaaaaa', 'bbbbbb', 'cccccc'].includes(m.id))!;
  expect(copy.type).toBe('chord');
  expect(copy.at).toBeGreaterThan(12);
  expect(typeof copy.seed).toBe('number');
  expect(await selection(page)).toEqual([copy.id]);
  await expect(item(page, copy.id)).toBeVisible();
  await longPress(page, await marker(page, copy.id));
  await menu.getByTestId('touch-delete').tap();
  await expect.poll(async () => (await moments(page)).length).toBe(3);
  await expect(page.getByTestId('lane-live')).toContainText('Deleted 1 moment');
  // A tap outside closes the menu without acting.
  await longPress(page, await marker(page, 'aaaaaa'));
  await expect(menu).toBeVisible();
  const score = (await page.locator('#score').boundingBox())!;
  await fingerTap(page, { x: score.x + score.width - 30, y: score.y + 20 });
  await expect(menu).toBeHidden();
  expect((await moments(page)).length).toBe(3);
});

test('Snap off in the menu stands in for Alt', async ({ page }) => {
  await open(page, true);
  const k = await pps(page);
  const a = await marker(page, 'aaaaaa');
  await touchDrag(page, a, { x: a.x + 1.4 * k, y: a.y });
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.at).toBe(3);
  await page.getByTestId('undo').tap();
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.at).toBe(2);
  await longPress(page, await marker(page, 'aaaaaa'));
  const snap = page.getByTestId('touch-free');
  await expect(snap).toHaveAttribute('aria-checked', 'true');
  await snap.tap();
  await expect(page.getByTestId('touch-mods').locator('[data-mod="free"]')).toBeVisible();
  const a2 = await marker(page, 'aaaaaa');
  await touchDrag(page, a2, { x: a2.x + 1.4 * k, y: a2.y });
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.at).toBeCloseTo(3.4, 1);
});

test('Select more: taps add to the selection and a lane drag draws the marquee', async ({
  page,
}) => {
  await open(page);
  await longPress(page, await marker(page, 'aaaaaa'));
  await page.getByTestId('touch-add').tap();
  await fingerTap(page, await marker(page, 'cccccc'));
  await expect.poll(() => selection(page)).toEqual(['aaaaaa', 'cccccc']);
  await fingerTap(page, await marker(page, 'aaaaaa'));
  await expect.poll(() => selection(page)).toEqual(['cccccc']);
  // Marquee over the first two items' markers.
  const a = await marker(page, 'aaaaaa');
  const b = await marker(page, 'bbbbbb');
  const track = (await page.locator('.lane-track').boundingBox())!;
  // From below the rows (the piece key's label sits on the top row) up over both markers.
  const bottom = track.y + track.height - 3;
  await touchDrag(page, { x: a.x - 20, y: bottom }, { x: b.x + 20, y: a.y - 4 });
  await expect
    .poll(async () => [...(await selection(page))].sort())
    .toEqual(['aaaaaa', 'bbbbbb', 'cccccc']);
});

test('a chord dot drags by touch; a tap on a line shows its readout', async ({ page }) => {
  await open(page);
  await fingerTap(page, await marker(page, 'aaaaaa'));
  const dot = page.getByTestId('chord-dot').first();
  await expect(dot).toBeVisible();
  const d = (await dot.boundingBox())!;
  const p = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
  await touchDrag(page, p, { x: p.x, y: p.y - 40 });
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.frozenFrom).toBeDefined();
  expect(await undoLabel(page)).toBe('Freeze chord and move note');
  await page.getByTestId('undo').tap();
  await expect.poll(async () => (await byId(page, 'aaaaaa'))!.frozenFrom).toBeUndefined();
  // Tap the held line well right of its dot (clear of the dot's finger-sized target).
  const d2 = (await dot.boundingBox())!;
  await fingerTap(page, { x: d2.x + d2.width / 2 + 60, y: d2.y + d2.height / 2 });
  const tip = page.getByTestId('score-hover');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Hz');
});

test('pinch zooms the time window; two fingers pan it', async ({ page }) => {
  await open(page);
  const box = (await page.locator('#score').boundingBox())!;
  const y = box.y + box.height / 2;
  const cx = box.x + box.width / 2;
  const w0 = await page.evaluate(() => window.__algorhythms!.frameStats.window);
  await twoFinger(
    page,
    { x: cx - 60, y },
    { x: cx + 60, y },
    { x: cx - 180, y },
    { x: cx + 180, y },
  );
  await frames(page);
  const w1 = await page.evaluate(() => window.__algorhythms!.frameStats.window);
  expect(w1).toBeLessThan(w0 * 0.6);
  const s0 = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  await twoFinger(
    page,
    { x: cx - 100, y },
    { x: cx + 100, y },
    { x: cx - 300, y },
    { x: cx - 100, y },
  );
  await frames(page);
  const s1 = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  // Fingers moved left by 200 px: later time comes into view.
  expect(s1 - s0).toBeGreaterThan(0.5 * (200 / box.width) * w1);
  expect(await moments(page)).toHaveLength(3);
});

test("on the score: a long press opens the line's moment menu; a double tap adds a note", async ({
  page,
}) => {
  await open(page);
  await fingerTap(page, await marker(page, 'aaaaaa'));
  const d = (await page.getByTestId('chord-dot').first().boundingBox())!;
  await fingerTap(page, await marker(page, 'cccccc'));
  // A point on a line of chord aaaaaa, between its arrival and the unison at 6 s.
  const k = await pps(page);
  const p = { x: d.x + d.width / 2 + 1.5 * k, y: d.y + d.height / 2 };
  await longPress(page, p);
  await expect(page.getByTestId('touch-menu')).toBeVisible();
  expect(await selection(page)).toEqual(['aaaaaa']);
  await page.getByTestId('touch-menu').getByTestId('touch-delete').tap();
  await expect.poll(async () => (await moments(page)).length).toBe(2);
  await page.getByTestId('undo').tap();
  await expect.poll(async () => (await moments(page)).length).toBe(3);
  await fingerTap(page, { x: p.x, y: p.y });
  await fingerTap(page, { x: p.x + 3, y: p.y + 2 });
  await expect
    .poll(async () => (await moments(page)).filter((m) => m.type === 'note').length)
    .toBe(1);
});
