/**
 * Drag preview and auditioning (PLAN.md §11.3, owner 2026-11-21; M4.5-35): a palette drag shows
 * the moment's ghost lines at the drop time before the drop, and Escape clears them; hover is
 * silent; an inspector chord pick sounds while stopped and not while playing; a dot drag sounds.
 * Sound is read through the debug hook's analyser. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface AuditionHook {
  audition: { count: number; suppressed: number; active: boolean };
  preview: { type: string | null; ghost: object | null; drag: boolean };
  editor: { select(ids: string[]): void };
}
const hook = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as AuditionHook;
    return {
      count: h.audition.count,
      suppressed: h.audition.suppressed,
      active: h.audition.active,
      preview: h.preview.type,
      drag: h.preview.drag,
      ghostAt: window.__algorhythms!.frameStats.preview,
    };
  });
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as AuditionHook).editor.select(i), ids);

/** The output's highest RMS over `ms` (sampled every 25 ms). */
function peakRms(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (ms) => {
    const an = window.__algorhythms!.analyser();
    if (!an) return -1;
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      peak = Math.max(peak, Math.sqrt(sum / buf.length));
      await new Promise((r) => setTimeout(r, 25));
    }
    return peak;
  }, ms);
}

/** Waits up to `ms` for audible output; returns its RMS (0 if none). */
function waitForSound(page: Page, ms = 5000): Promise<number> {
  return page.evaluate(async (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const an = window.__algorhythms!.analyser();
      if (an) {
        const buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 0.002) return rms;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return 0;
  }, ms);
}

/** Waits for the output to fall silent (an FX tail may ring after the last sound). */
async function waitForSilence(page: Page): Promise<void> {
  await expect.poll(() => peakRms(page, 200), { timeout: 15_000 }).toBeLessThan(0.0005);
}

/** Four voices in C major (C3 G3 C4 E4), a split at 2 s and a chord (Am) at 6 s; ends at 12 s. */
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
      view: Record<string, unknown>;
      defaults: { glide: Record<string, unknown> };
    };
    p.start = [48, 55, 60, 64].map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
    p.defaults.glide = { ...p.defaults.glide, length: 1, stagger: 0, jitter: 0 };
    p.moments = [
      { id: 'split1', type: 'split', at: 2, count: 6, voicing: 'even' },
      {
        id: 'chord1',
        type: 'chord',
        at: 6,
        notes: { kind: 'chord', symbol: 'Am' },
        voicing: 'even',
        assign: 'ordered',
      },
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 12, fade: 1 };
    const view = { ...p.view };
    delete view.gridBpm;
    p.view = view;
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.audio))
    .toBe('ready');
  // The analyser exists once the engine does.
  await expect.poll(() => peakRms(page, 50)).toBeGreaterThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  // Loading, a fresh engine and waits for silence take a while on a loaded machine.
  test.setTimeout(90_000);
  await open(page);
});

test('a palette drag shows ghost lines at the drop time; Escape clears them', async ({ page }) => {
  const n0 = await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length);
  const unison = page.getByTestId('palette').locator('[data-moment="unison"]');
  const box = (await page.locator('#score').boundingBox())!;
  const ub = (await unison.boundingBox())!;
  await page.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await page.mouse.down();
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x + 3, y, { steps: 2 });
  await expect.poll(async () => (await hook(page)).drag).toBe(true);
  await expect.poll(async () => Number.isFinite((await hook(page)).ghostAt)).toBe(true);
  const at1 = (await hook(page)).ghostAt;
  // It follows the pointer.
  await page.mouse.move(x + box.width * 0.2, y, { steps: 4 });
  await expect.poll(async () => (await hook(page)).ghostAt).toBeGreaterThan(at1 + 0.5);

  // Escape. Playwright's emulated drag doesn't deliver key presses to the page (a real browser
  // cancels the drag itself and fires dragend), so the key event is dispatched directly.
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await expect.poll(async () => Number.isNaN((await hook(page)).ghostAt)).toBe(true);
  expect((await hook(page)).preview).toBeNull();
  await page.mouse.up();
  // Cancelled: nothing was added, and the ghost is still gone.
  expect(
    await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length),
  ).toBe(n0);
  expect(Number.isNaN((await hook(page)).ghostAt)).toBe(true);
});

test('a palette drop still adds the moment, and the ghost goes', async ({ page }) => {
  const n0 = await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length);
  const box = (await page.locator('#score').boundingBox())!;
  await page
    .getByTestId('palette')
    .locator('[data-moment="unison"]')
    .dragTo(page.locator('#score'), {
      targetPosition: { x: box.width * 0.6, y: box.height / 2 },
    });
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length))
    .toBe(n0 + 1);
  await expect.poll(async () => Number.isNaN((await hook(page)).ghostAt)).toBe(true);
});

test('hovering the palette previews on the score and makes no sound', async ({ page }) => {
  await seek(page, 1);
  await waitForSilence(page);
  const before = (await hook(page)).count;
  await page.getByTestId('palette').locator('[data-moment="unison"]').hover();
  await expect.poll(async () => (await hook(page)).preview).toBe('unison');
  await expect.poll(async () => (await hook(page)).ghostAt).toBeCloseTo(1, 3);
  expect(await peakRms(page, 1200)).toBeLessThan(0.0005);
  expect(await page.evaluate(() => window.__algorhythms!.engine()?.isPlaying ?? false)).toBe(false);
  expect((await hook(page)).count).toBe(before);
});

test('a chord pick sounds while stopped, and not while playing', async ({ page }) => {
  await select(page, ['chord1']);
  const picker = page.getByTestId('inspector').getByTestId('insp-chord-picker');
  const group = (name: string) => picker.getByRole('group', { name });
  await waitForSilence(page);
  const c0 = (await hook(page)).count;
  await group('From the key').getByRole('button', { name: 'IV F', exact: true }).click();
  await expect.poll(async () => (await hook(page)).count).toBe(c0 + 1);
  expect(await waitForSound(page)).toBeGreaterThan(0.002);
  // One-shot: it ends by itself.
  await expect.poll(async () => (await hook(page)).active, { timeout: 5000 }).toBe(false);

  // While playing, picks are heard through the hot-swap, not auditioned.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.status))
    .toBe('playing');
  const s = await hook(page);
  await group('Quality').getByRole('button', { name: 'm7', exact: true }).click();
  await expect.poll(async () => (await hook(page)).suppressed).toBe(s.suppressed + 1);
  expect((await hook(page)).count).toBe(s.count);
});

test('dragging a dot sounds the note, and stops on release', async ({ page }) => {
  await select(page, ['split1']);
  const dot = page.getByTestId('arrival-dot').last();
  await expect(dot).toBeVisible();
  await waitForSilence(page);
  const c0 = (await hook(page)).count;
  const b = (await dot.boundingBox())!;
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 8, { steps: 4 });
  await page.mouse.move(from.x, from.y - 20, { steps: 4 });
  await expect.poll(async () => (await hook(page)).count).toBeGreaterThan(c0);
  expect((await hook(page)).active).toBe(true);
  expect(await waitForSound(page)).toBeGreaterThan(0.002);
  await page.mouse.up();
  await expect.poll(async () => (await hook(page)).active).toBe(false);
  expect(await page.evaluate(() => window.__algorhythms!.engine()?.isPlaying ?? false)).toBe(false);
});
