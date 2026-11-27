/**
 * Hover to hear (PLAN.md M13; owner 2026-11-23): an Add or Next card sounds what it would do after
 * a 250 ms dwell (or keyboard focus), names its result, stops with a 50 ms fade on leaving, plays
 * only while stopped, and "Hover sound" (View ▾) turns it off and is remembered. Read through the
 * audition debug state, never by listening (audition.spec checks the output is audible).
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(
  ({ browserName }) => browserName === 'webkit',
  'Chromium and Firefox (WebKit cannot be muted locally)',
);

// A loaded runner takes up to ~20 s to load the dev page and Firefox's first play can take as
// long again (worklet warm-up); the default 30 s isn't enough for a load plus a play or reload.
test.describe.configure({ timeout: 60_000 });

interface HoverHook {
  audition: {
    count: number;
    suppressed: number;
    active: boolean;
    kind: string | null;
    stops: number;
    lastFade: number;
  };
  hoverSound: {
    count: number;
    type: string | null;
    plan: { mode: string } | null;
    hoverAt: number;
    startedAt: number;
  };
}
const state = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as HoverHook;
    return {
      ...h.audition,
      hovers: h.hoverSound.count,
      type: h.hoverSound.type,
      mode: h.hoverSound.plan?.mode ?? null,
      /** ms from the latest hover to the latest sound's start (page clock). */
      dwell: h.hoverSound.startedAt - h.hoverSound.hoverAt,
    };
  });

/** Four voices split apart at 0 s, a unison at 2 s (0.5 s glide); no grid. */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    const view = { ...p.view };
    delete view.gridBpm;
    p.view = view;
    // Long enough that playback can't end mid-test on a slow runner.
    p.end = { ...(p.end as object), at: 60 };
    p.moments = [
      ...(p.moments as { id: string }[]).filter((m) => m.id === 'start0'),
      { id: 'spl001', type: 'split', at: 0, count: 4, voicing: 'even' },
      {
        id: 'uni001',
        type: 'unison',
        at: 2,
        pitch: 'center',
        octaves: false,
        glide: { length: 0.5, stagger: 0 },
      },
    ];
    h.actions.loadPiece(p);
  });
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await seek(page, 1);
}

const card = (page: Page, type: string) =>
  page.getByTestId('palette').locator(`[data-moment="${type}"]`);

test('a card sounds after the dwell, names its result, and stops with a 50 ms fade', async ({
  page,
}) => {
  await open(page);
  const chord = card(page, 'chord');
  await expect(chord).toHaveAttribute('data-result', /^→ \S/);
  await expect(chord.locator('.card-result')).toHaveText(/^→ \S/);
  // The tooltip has the whole result (a long one is cut off on the card).
  const result = (await chord.getAttribute('data-result'))!;
  expect((await chord.getAttribute('title'))!.startsWith(`${result}. `)).toBe(true);
  const s0 = await state(page);
  await chord.hover();
  await expect.poll(async () => (await state(page)).hovers).toBe(s0.hovers + 1);
  const on = await state(page);
  expect(on).toMatchObject({ active: true, kind: 'hover', type: 'chord', mode: 'transition' });
  // Not before the dwell (page clock, so a slow runner can't fake it); not long after either.
  expect(on.dwell).toBeGreaterThanOrEqual(249);
  expect(on.dwell).toBeLessThan(1500);

  // Moving to another card plays that one.
  await card(page, 'level').hover();
  await expect.poll(async () => (await state(page)).type).toBe('level');
  const lv = await state(page);
  expect(lv.hovers).toBe(s0.hovers + 2);
  expect(lv.mode).toBe('after');

  await page.mouse.move(2, 400);
  await expect.poll(async () => (await state(page)).active).toBe(false);
  expect((await state(page)).lastFade).toBeCloseTo(0.05, 6);
});

test('keyboard focus plays a card; blur stops it', async ({ page }) => {
  await open(page);
  const s0 = await state(page);
  // Tab until a palette card has focus.
  let type: string | null = null;
  for (let i = 0; i < 80 && type === null; i++) {
    await page.keyboard.press('Tab');
    type = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.closest('[data-testid="palette"]') ? el.getAttribute('data-moment') : null;
    });
    if (type && (await card(page, type).getAttribute('data-no-effect')) !== null) type = null;
  }
  expect(type).not.toBeNull();
  await expect.poll(async () => (await state(page)).hovers).toBe(s0.hovers + 1);
  expect((await state(page)).type).toBe(type);
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await state(page)).active).toBe(false);
});

test('a Next card sounds too; nothing plays while the transport plays', async ({ page }) => {
  await open(page);
  const next = page.getByTestId('suggestions').locator('[data-suggestion="0"]');
  await expect(next).toBeVisible();
  const s0 = await state(page);
  await next.hover();
  await expect.poll(async () => (await state(page)).hovers).toBe(s0.hovers + 1);
  await page.mouse.move(2, 400);
  await expect.poll(async () => (await state(page)).active).toBe(false);

  await page.getByTestId('play').click();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.status))
    .toBe('playing');
  const s1 = await state(page);
  await card(page, 'level').hover();
  await expect.poll(async () => (await state(page)).suppressed).toBeGreaterThan(s1.suppressed);
  expect((await state(page)).hovers).toBe(s1.hovers);
  expect((await state(page)).count).toBe(s1.count);
});

test('Hover sound off makes no sound and is remembered', async ({ page }) => {
  await open(page);
  await page.getByTestId('view-options').click();
  const toggle = page.getByTestId('hover-sound-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');

  // A fresh load (`open` navigates again) reads the remembered setting.
  await open(page);
  const s0 = await state(page);
  await card(page, 'chord').hover();
  // The ghost preview still shows; no sound.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__algorhythms as unknown as { preview: { type: string | null } }).preview.type,
      ),
    )
    .toBe('chord');
  await page.waitForTimeout(300);
  expect((await state(page)).count).toBe(s0.count);
  await page.mouse.move(2, 400);
  await page.getByTestId('view-options').click();
  await expect(page.getByTestId('hover-sound-toggle')).toHaveAttribute('aria-pressed', 'false');
});

for (const width of [900, 1200, 1280]) {
  test(`result labels fit their cards at ${width} px`, async ({ page }) => {
    await open(page);
    await page.setViewportSize({ width, height: 800 });
    await expect(card(page, 'chord')).toHaveAttribute('data-result', /→/);
    const fits = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.palette button')].map((b) => {
        const r = b.querySelector<HTMLElement>('.card-result');
        return {
          card: b.textContent,
          inside: b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight <= b.clientHeight + 1,
          whole: !r || r.scrollWidth <= r.clientWidth + 1,
        };
      }),
    );
    for (const f of fits) expect(f, f.card ?? '').toMatchObject({ inside: true, whole: true });
  });
}
