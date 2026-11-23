/**
 * "Land at the marker" (PLAN.md §5 `glide.land`, §11.3 "Land on the beat"; R9-9): the inspector's
 * Transition section has a toggle that writes `glide.land` (showing the effective value, with the
 * piece default underneath); a landing moment's bar on the Transitions row ends at its marker, in
 * the real lane, the tooltip, drag previews and palette ghosts. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  glide?: { land?: boolean; length?: number };
}

interface Hook {
  editor: { select(ids: string[]): void };
  store: { getState(): { piece: { moments: M[] } } };
}

const moment = (page: Page, id: string): Promise<M> =>
  page.evaluate(
    (i) =>
      (window.__algorhythms as unknown as Hook).store
        .getState()
        .piece.moments.find((m) => m.id === i)!,
    id,
  );
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids);
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** An opening chord and two chord changes at 10 and 20 s; glides of 2 s, no stagger or jitter. */
async function open(page: Page, landDefault: boolean): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((land) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      key: unknown;
      end: unknown;
      defaults: { glide: Record<string, unknown> };
      view: Record<string, unknown>;
    };
    const chord = (id: string, at: number, pitches: number[]) => ({
      id,
      type: 'chord',
      at,
      notes: { kind: 'pitches', pitches },
      voicing: 'even',
      assign: 'ordered',
    });
    p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0 };
    if (land) p.defaults.glide.land = true;
    else delete p.defaults.glide.land;
    p.moments = [
      chord('start0', 0, [48, 55, 60, 64]),
      chord('c1', 10, [50, 57, 62, 65]),
      chord('c2', 20, [48, 55, 60, 64]),
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 32, fade: 1 };
    delete p.view.gridBpm;
    h.actions.loadPiece(p);
  }, landDefault);
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await frames(page);
}

/** Score px per second (the lane shares the score's axis). */
async function pps(page: Page): Promise<number> {
  await frames(page);
  const s = await page.evaluate(() => window.__algorhythms!.frameStats.window);
  return (await page.locator('#score').boundingBox())!.width / s;
}

interface Geo {
  /** The marker's centre x and the bar's left and right edges. */
  marker: number;
  left: number;
  right: number;
}

async function geo(page: Page, id: string): Promise<Geo> {
  const item = page.locator(`[data-moment="${id}"]`);
  const m = (await item.locator('.lane-marker').boundingBox())!;
  const b = (await item.locator('.lane-bar').boundingBox())!;
  return { marker: m.x + m.width / 2, left: b.x, right: b.x + b.width };
}

/** Polls until the bar of `id` ends at its marker (`lands`) or starts there. */
async function expectBar(page: Page, id: string, lands: boolean): Promise<Geo> {
  await expect
    .poll(async () => {
      const g = await geo(page, id);
      return lands
        ? Math.abs(g.right - g.marker) < 1.5 && g.right - g.left > 5
        : Math.abs(g.left - g.marker) < 1.5 && g.right - g.left > 5;
    })
    .toBe(true);
  return geo(page, id);
}

const landBox = (page: Page) => page.getByTestId('insp-land');
const arriveChip = (page: Page, name: string) =>
  page.getByTestId('insp-arrive-mode').getByRole('button', { name, exact: true });

test('the Transition toggle writes glide.land; the bar ends at the marker, and flips back', async ({
  page,
}) => {
  await open(page, false);
  const px = await pps(page);
  await select(page, ['c1']);
  await expect(landBox(page)).toBeVisible();
  await expect(landBox(page)).not.toBeChecked();
  await expect(page.getByTestId('insp-land-note')).toBeHidden();
  // Off: the bar starts at the marker and runs 2 s after it.
  let g = await expectBar(page, 'c1', false);
  expect(Math.abs(g.right - g.left - 2 * px)).toBeLessThan(2);

  await landBox(page).check();
  expect((await moment(page, 'c1')).glide?.land).toBe(true);
  g = await expectBar(page, 'c1', true);
  expect(Math.abs(g.right - g.left - 2 * px)).toBeLessThan(2);
  // The inspector and the tooltip say the notes arrive on the marker.
  await expect(page.getByTestId('insp-land-note')).toContainText('arrive on the marker');
  await expect(page.getByTestId('insp-land-note')).toContainText('8 s');
  await expect(page.locator('[data-moment="c1"]')).toHaveAttribute(
    'title',
    /Notes arrive on the marker; the glide starts at 8 s/,
  );
  await expect(page.locator('[data-moment="c1"]')).toHaveAttribute('data-land', 'true');
  // c2 is untouched.
  expect((await moment(page, 'c2')).glide).toBeUndefined();

  await landBox(page).uncheck();
  const after = await moment(page, 'c1');
  expect(after.glide?.land).toBeUndefined();
  await expectBar(page, 'c1', false);
  await expect(page.locator('[data-moment="c1"]')).not.toHaveAttribute('title', /arrive/);
});

test('a land moment that waits for an earlier one: its bar and note start where it glides', async ({
  page,
}) => {
  // Build log "Land always arrives": b (land at 12.5, glide 4) would start at 8.5, but a (at 10,
  // glide 2) decides inside that lead-in, so b glides from a's arrival (12).
  await open(page, false);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as { moments: unknown[] };
    const chord = (id: string, at: number, pitches: number[], glide?: object) => ({
      id,
      type: 'chord',
      at,
      notes: { kind: 'pitches', pitches },
      voicing: 'even',
      assign: 'ordered',
      ...(glide ? { glide } : {}),
    });
    p.moments = [
      chord('start0', 0, [48, 55, 60, 64]),
      chord('a', 10, [50, 57, 62, 65]),
      chord('b', 12.5, [48, 55, 60, 64], { land: true, length: 4 }),
    ];
    h.actions.setPiece(p);
  });
  const px = await pps(page);
  const g = await expectBar(page, 'b', true);
  expect(Math.abs(g.right - g.left - 0.5 * px)).toBeLessThan(2);
  await expect(page.locator('[data-moment="b"]')).toHaveAttribute(
    'title',
    /the glide starts at 12 s/,
  );
  // A chord block that lands shows Arrive: Land (its Transition sits under Custom).
  await select(page, ['b']);
  await expect(arriveChip(page, 'Land')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('insp-transition')).toHaveCount(0);
});

test('with land in the piece defaults the toggle shows on, and an override turns one moment off', async ({
  page,
}) => {
  await open(page, true);
  await select(page, ['c1']);
  await expect(arriveChip(page, 'Land')).toHaveAttribute('aria-pressed', 'true');
  await expectBar(page, 'c1', true);
  await expectBar(page, 'c2', true);

  // Arrive → Custom stops landing and shows the Transition.
  await arriveChip(page, 'Custom').click();
  expect((await moment(page, 'c1')).glide?.land).toBe(false);
  await expect(landBox(page)).not.toBeChecked();
  await expectBar(page, 'c1', false);
  await expectBar(page, 'c2', true);

  // Back on: equal to the default again, so nothing is stored.
  await landBox(page).check();
  expect((await moment(page, 'c1')).glide).toBeUndefined();
  await expectBar(page, 'c1', true);
});

test('a drag preview keeps the bar ending at the marker, and the end handle sits on its start', async ({
  page,
}) => {
  await open(page, true);
  const px = await pps(page);
  const item = page.locator('[data-moment="c1"]');
  const m = (await item.locator('.lane-marker').boundingBox())!;
  const x = m.x + m.width / 2;
  const y = m.y + m.height / 2;
  const before = await moment(page, 'c1');

  // Move the moment: at every step of the drag the bar still ends at the marker.
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const dx of [20, 60, 100]) {
    await page.mouse.move(x + dx, y, { steps: 4 });
    await frames(page);
    const g = await geo(page, 'c1');
    expect(Math.abs(g.right - g.marker)).toBeLessThan(1.5);
    expect(g.right - g.left).toBeGreaterThan(2 * px - 2);
    expect(g.marker).toBeGreaterThan(x + dx - 3);
  }
  await page.mouse.up();
  expect((await moment(page, 'c1')).at).toBeGreaterThan(before.at + 1);
  await expectBar(page, 'c1', true);

  // Dragging the handle on the bar's start to the left lengthens the glide; the end stays.
  await page.locator('[data-moment="c1"]').click();
  const bar = await geo(page, 'c1');
  const handle = page.locator('[data-moment="c1"] .lane-end');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  expect(Math.abs(hb.x + hb.width / 2 - bar.left)).toBeLessThan(6);
  const hx = hb.x + hb.width / 2;
  const hy = hb.y + hb.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 30, hy, { steps: 5 });
  await frames(page);
  const mid = await geo(page, 'c1');
  expect(Math.abs(mid.right - bar.right)).toBeLessThan(1.5);
  expect(Math.abs(bar.left - mid.left - 30)).toBeLessThan(2.5);
  await page.mouse.up();
  const len = (await moment(page, 'c1')).glide?.length ?? 0;
  expect(Math.abs(len - (2 + 30 / px))).toBeLessThan(0.1);
  const end = await expectBar(page, 'c1', true);
  expect(Math.abs(end.right - end.left - len * px)).toBeLessThan(3);
});

test('a palette preview (hover) of a landing moment ends its ghost bar at the ghost marker', async ({
  page,
}) => {
  await open(page, true);
  await seek(page, 26);
  const chord = page.getByTestId('palette').locator('[data-moment="chord"]');
  await chord.hover();
  const ghost = page.getByTestId('lane-ghost');
  await expect(ghost).toBeVisible();
  await expect.poll(async () => Number(await ghost.getAttribute('data-at'))).toBeCloseTo(26, 2);
  const m = (await ghost.locator('.lane-marker').boundingBox())!;
  await expect
    .poll(async () => {
      const b = (await ghost.locator('.lane-bar').boundingBox())!;
      return Math.abs(b.x + b.width - (m.x + m.width / 2)) < 1.5 && b.width > 5;
    })
    .toBe(true);
});
