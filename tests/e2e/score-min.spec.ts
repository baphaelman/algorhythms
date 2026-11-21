/**
 * Score minimum height (build-log "Score minimum height", 2026-11-21): with the Sound drawer
 * (Master tab) or the Notes drawer open on a short window (one drawer at a time), the score canvas keeps its minimum
 * (`--score-min`: min(204px, 34vh) for the stage); the lanes keep 44 px; the drawer gives way and
 * scrolls inside itself; the plot
 * is never inverted (a line's y lies inside [padT, height − padB]). Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface ViewLite {
  height: number;
  padT: number;
  padB: number;
  pLo: number;
  pHi: number;
}

/** The last frame's view and the first segment pitch of every voice. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const hook = window.__algorhythms! as unknown as {
      frameStats: { view: ViewLite | null };
      store: { getState(): { compiled: { voices: { segments: { p0: number }[] }[] } } };
    };
    const v = hook.frameStats.view!;
    const pitches = hook.store
      .getState()
      .compiled.voices.flatMap((x) => (x.segments.length ? [x.segments[0].p0] : []));
    return { view: v, pitches };
  });

const DRAWERS = {
  sound: '.sound-drawer .sd-body:not([hidden])',
  notes: '.vd-scroll',
} as const;

for (const [width, height] of [
  [1024, 600],
  [1280, 720],
] as const) {
  for (const drawer of ['sound', 'notes'] as const) {
    test(`${width}×${height}, ${drawer} drawer open: the score keeps its minimum`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('./?example=kite-day');
      await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
      if (drawer === 'sound') {
        await page.getByTestId('sound-toggle').click();
        await page.getByTestId('sound-tab-master').click();
        await expect(page.getByTestId('master')).toBeVisible();
      } else {
        await page.getByTestId('voices-toggle').click();
        await expect(page.locator('.voices-drawer')).toBeVisible();
      }

      const minStage = Math.min(204, 0.34 * height);
      await expect
        .poll(() => page.locator('#score').evaluate((c) => c.clientHeight))
        .toBeGreaterThanOrEqual(Math.floor(minStage) - 2);

      // Nothing overlaps: the lanes end inside the timeline, the drawer starts below the
      // workspace (the page scrolls when the window is shorter than all the minimums).
      const sel = DRAWERS[drawer];
      const drawerSel = drawer === 'sound' ? '.sound-drawer' : '.voices-drawer';
      const r = await page.evaluate(
        ([a, b]) =>
          ['.workspace', '.timeline', '.lane-scroll', a, b].map((s) => {
            const x = document.querySelector(s)!.getBoundingClientRect();
            return { top: x.top, bottom: x.bottom, height: x.height };
          }),
        [drawerSel, sel] as const,
      );
      const [ws, tl, lane, dr, body0] = r;
      expect(lane.bottom).toBeLessThanOrEqual(tl.bottom + 1);
      expect(lane.height).toBeGreaterThanOrEqual(43);
      expect(dr.top).toBeGreaterThanOrEqual(ws.bottom);
      expect(body0.bottom).toBeLessThanOrEqual(dr.bottom + 1);

      // The drawer's body scrolls inside itself.
      const body = page.locator(sel).first();
      const { sh, ch } = await body.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
      expect(ch).toBeGreaterThan(0);
      expect(sh).toBeGreaterThan(ch + 1);
      await body.evaluate((e) => {
        e.scrollTop = 40;
      });
      expect(await body.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);

      // The plot is upright: every voice's first pitch maps inside [padT, height − padB].
      const { view, pitches } = await frame(page);
      expect(view.height - view.padT - view.padB).toBeGreaterThanOrEqual(110);
      expect(pitches.length).toBeGreaterThan(0);
      const y = (p: number): number =>
        view.padT +
        ((view.pHi - p) / (view.pHi - view.pLo)) * (view.height - view.padT - view.padB);
      for (const p of pitches) {
        if (p < view.pLo || p > view.pHi) continue;
        expect(y(p)).toBeGreaterThanOrEqual(view.padT - 0.5);
        expect(y(p)).toBeLessThanOrEqual(view.height - view.padB + 0.5);
      }
      const hi = Math.max(...pitches);
      const lo = Math.min(...pitches);
      if (hi > lo) expect(y(hi)).toBeLessThan(y(lo));
    });
  }
}
