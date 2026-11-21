/**
 * M4.5 lane rows (PLAN.md §11.2, §15 M4.5): Moments, Transitions and Level share the score's time
 * axis. A moment's marker, its transition bar's start and its glide's start on the lines sit
 * within 1 px at any zoom while following; the Level row reflects a level moment; dragging the
 * lane background pans (and turns Follow off during playback).
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

const DURATION_END = 40;

/** A 40 s piece with a moment every 1.5 s (glides and staggers vary) and a 60 BPM grid. */
async function load(page: Page, extra: unknown[] = [], many = true): Promise<void> {
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(
    ({ extra, many, end }) => {
      const h = window.__algorhythms!;
      const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
        view: Record<string, unknown>;
      };
      const ms: unknown[] = [];
      const n = many ? 16 : 0;
      for (let i = 0; i < n; i++) {
        const at = 1 + i * 1.5;
        ms.push(
          i % 3 === 2
            ? {
                id: `u${String(i).padStart(5, '0')}`,
                type: 'unison',
                at,
                pitch: 'center',
                octaves: false,
                glide: { length: 0.6, stagger: 0.2 },
              }
            : {
                id: `c${String(i).padStart(5, '0')}`,
                type: 'chord',
                at,
                notes: { kind: 'degrees', degrees: i % 2 ? [1, 3, 5] : [0, 2, 4, 7] },
                voicing: 'even',
                assign: 'ordered',
                glide: { length: 0.5 + (i % 4) * 0.3, stagger: (i % 3) * 0.15 },
              },
        );
      }
      p.moments = [...ms, ...extra];
      p.end = { at: end, fade: 1 };
      p.view = { ...p.view, gridBpm: 60, window: 20 };
      h.actions.loadPiece(p);
    },
    { extra, many, end: DURATION_END },
  );
  await expect(page.getByTestId('lane').locator('[data-moment]')).toHaveCount(
    (many ? 16 : 0) + extra.length,
  );
}

/** Sets the visible window (s) through the zoom slider (log scale, 2 s … whole piece). */
async function setWindow(page: Page, w: number): Promise<void> {
  const D = await page.evaluate(() => window.__algorhythms!.store.getState().compiled.duration);
  const k = Math.log(w / 2) / Math.log(D / 2);
  await page.getByTestId('window-slider').fill(String(Math.round(k * 1000)));
}

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        const step = (k: number): void => {
          if (k <= 0) r();
          else requestAnimationFrame(() => step(k - 1));
        };
        step(n);
      }),
    n,
  );

async function play(page: Page): Promise<void> {
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.__algorhythms?.engine()?.isPlaying === true, null, {
    timeout: 10_000,
  });
}

interface Seg {
  t0: number;
  momentId?: string;
}

/**
 * For each moment in view, in one synchronous read: the marker's centre, the bar's left edge and
 * the x of its earliest segment on the score canvas (from the frame's camera), in page px.
 */
const measure = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms!;
    const f = h.frameStats;
    const compiled = h.store.getState().compiled as unknown as {
      voices: { segments: Seg[] }[];
    };
    const canvas = document.getElementById('score')!;
    const r = canvas.getBoundingClientRect();
    const pps = r.width / f.window;
    const out: { id: string; marker: number; bar: number; line: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-moment]')) {
      const id = el.dataset.moment!;
      let t0 = Infinity;
      for (const v of compiled.voices)
        for (const s of v.segments) if (s.momentId === id && s.t0 < t0) t0 = s.t0;
      if (!Number.isFinite(t0)) continue;
      const line = r.left + (t0 - f.start) * pps;
      if (line < r.left + 2 || line > r.right - 2) continue;
      const m = el.querySelector('.lane-marker')!.getBoundingClientRect();
      const bar = el.querySelector('.lane-bar')!.getBoundingClientRect();
      out.push({ id, marker: m.left + m.width / 2, bar: bar.left, line });
    }
    return { start: f.start, items: out };
  });

test('marker, transition bar start and glide start align within 1 px at several zooms while following', async ({
  page,
}) => {
  await load(page);
  await play(page);
  // Seek to 15 s so Smooth is following at every zoom below.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start))
    .toBeGreaterThan(5);
  const starts = new Set<number>();
  let checked = 0;
  for (const w of [3, 6, 12, 25]) {
    await setWindow(page, w);
    for (let k = 0; k < 3; k++) {
      await frames(page, 6);
      const { start, items } = await measure(page);
      starts.add(start);
      for (const it of items) {
        expect(Math.abs(it.marker - it.line), `marker ${it.id} @${w}s`).toBeLessThanOrEqual(1);
        expect(Math.abs(it.bar - it.line), `bar ${it.id} @${w}s`).toBeLessThanOrEqual(1);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(8);
  // The view was moving (following) while we measured.
  expect(starts.size).toBeGreaterThan(3);
});

test('the Level row reflects a level moment', async ({ page }) => {
  await load(page, [{ id: 'lvl001', type: 'level', at: 6, gain: 0.5, over: 2 }], false);
  await expect(page.locator('[data-moment="lvl001"] .lane-label')).toHaveText('level 50%');
  await expect(page.locator('[data-moment="lvl001"] .lane-bar-text')).toHaveText('2.0 s');

  /** The curve's y (px, larger = quieter) at time t. */
  const yAt = (t: number) =>
    page.evaluate((t) => {
      const line = document.querySelector('[data-testid="lane-level"] polyline')!;
      const pts = line
        .getAttribute('points')!
        .trim()
        .split(/\s+/)
        .map((p) => p.split(',').map(Number));
      const D = window.__algorhythms!.store.getState().compiled.duration;
      const pps = pts[pts.length - 1][0] / D;
      const x = t * pps;
      const i = pts.findIndex((p) => p[0] > x);
      const [a, b] = [pts[i - 1], pts[i]];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }, t);

  const before = await yAt(3);
  const mid = await yAt(7);
  const after = await yAt(12);
  expect(mid).toBeGreaterThan(before + 2);
  expect(after).toBeGreaterThan(mid + 2);
  // Half the level: halfway down the curve's height.
  expect(after - before).toBeGreaterThan(6);

  // Removing the moment flattens the curve again.
  await page.locator('[data-moment="lvl001"]').click();
  await page.keyboard.press('Delete');
  await expect.poll(() => yAt(12)).toBeCloseTo(before, 1);
});

test('dragging the lane background pans; during playback it turns Follow off', async ({ page }) => {
  await load(page);
  await setWindow(page, 8);
  await frames(page);
  const track = (await page.locator('.lane-track').boundingBox())!;
  const y = track.y + track.height - 6; // the Level row, clear of items
  const pps = await page.evaluate(
    () =>
      document.getElementById('score')!.getBoundingClientRect().width /
      window.__algorhythms!.frameStats.window,
  );

  // Paused: the view moves with the pointer.
  const s0 = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  await page.mouse.move(track.x + 600, y);
  await page.mouse.down();
  await page.mouse.move(track.x + 500, y, { steps: 5 });
  await page.mouse.move(track.x + 400, y, { steps: 5 });
  await page.mouse.up();
  await frames(page);
  const s1 = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  expect(s1 - s0).toBeCloseTo(200 / pps, 1);

  // Playing with Smooth follow: a background drag turns Follow off and the view stays put.
  await play(page);
  await expect(page.locator('[data-follow="smooth"]')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(track.x + 400, y);
  await page.mouse.down();
  await page.mouse.move(track.x + 300, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('[data-follow="off"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().view.follow)).toBe('off');
  const a = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  await page.waitForTimeout(400);
  await frames(page);
  const b = await page.evaluate(() => window.__algorhythms!.frameStats.start);
  expect(b).toBe(a);
  expect(await page.evaluate(() => window.__algorhythms!.engine()?.isPlaying)).toBe(true);
});

test('overlapping moments stack in sub-rows; the lane grows; bars stay with their markers', async ({
  page,
}) => {
  const chord = (id: string, at: number, length: number) => ({
    id,
    type: 'chord',
    at,
    notes: { kind: 'degrees', degrees: [0, 2, 4] },
    voicing: 'even',
    glide: { length, stagger: 0 },
  });
  await load(page, [], false);
  await setWindow(page, 20);
  await frames(page);
  const h0 = (await page.locator('.lane-track').boundingBox())!.height;
  await load(
    page,
    [
      chord('stk001', 4, 6),
      { id: 'stk002', type: 'level', at: 4, gain: 0.5, over: 4 },
      { id: 'stk003', type: 'shift', at: 5, steps: 1, glide: { length: 2, stagger: 0 } },
      chord('stk004', 30, 1),
    ],
    false,
  );
  await setWindow(page, 20);
  await frames(page, 4);
  const box = async (id: string, part: string) =>
    (await page.locator(`[data-moment="${id}"] ${part}`).boundingBox())!;
  const ids = ['stk001', 'stk002', 'stk003'];
  const markers = await Promise.all(ids.map((id) => box(id, '.lane-marker')));
  const labels = await Promise.all(ids.map((id) => box(id, '.lane-label')));
  const bars = await Promise.all(ids.map((id) => box(id, '.lane-bar')));
  // Three distinct sub-rows, in piece order; no two labels or bars overlap.
  expect(markers[1].y).toBeGreaterThan(markers[0].y + 10);
  expect(markers[2].y).toBeGreaterThan(markers[1].y + 10);
  const apart = (a: { y: number; height: number }, b: { y: number; height: number }) =>
    a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      expect(apart(labels[i], labels[j])).toBe(true);
      expect(apart(bars[i], bars[j])).toBe(true);
    }
  // Each bar starts at its marker, and the bars keep the markers' order in the Transitions row.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(bars[i].x - (markers[i].x + markers[i].width / 2))).toBeLessThanOrEqual(1);
  }
  expect(bars[1].y).toBeGreaterThan(bars[0].y);
  expect(bars[2].y).toBeGreaterThan(bars[1].y);
  // The lane grew to fit; the bars stay inside the Transitions row.
  await expect(page.locator('.lane-track')).toHaveAttribute('data-subrows', '3');
  expect((await page.locator('.lane-track').boundingBox())!.height).toBeGreaterThan(h0 + 10);
  const transitions = (await page.locator('[data-row="transitions"]').boundingBox())!;
  for (const b of bars) {
    expect(b.y).toBeGreaterThanOrEqual(transitions.y);
    expect(b.y + b.height).toBeLessThanOrEqual(transitions.y + transitions.height);
  }
  // Hit-testing: clicking the third sub-row's marker selects it.
  await page.locator('[data-moment="stk003"] .lane-marker').click();
  await expect(page.locator('[data-moment="stk003"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-moment="stk001"]')).toHaveAttribute('aria-pressed', 'false');
});
