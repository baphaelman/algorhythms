/**
 * M3 player in real browsers (PLAN.md §11, §15 M3): load, play, time advances, pause and seek,
 * the window, colours and theme, the examples gallery, files, share links, the phone layout and
 * time to first sound. Audio is analysed through an AnalyserNode the app's debug hook taps.
 */

import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

const ROOT = join(import.meta.dirname, '../..');
const EXAMPLES = join(ROOT, 'examples');
const readExample = (name: string): string =>
  readFileSync(join(EXAMPLES, `${name}.algorhythms.json`), 'utf8');

async function openApp(page: Page, path = './?example=tidewater-hymn'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('play')).toBeVisible();
  // The first frame has written the time readout.
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

const getState = (page: Page) =>
  page.evaluate(() => {
    const s = window.__algorhythms!.store.getState();
    return {
      title: s.piece.meta.title,
      voices: s.piece.voices.length,
      duration: s.compiled.duration,
      view: s.view,
      status: s.transport.status,
      scrubbing: s.transport.scrubbing,
      notices: s.notices,
    };
  });

async function waitForStatus(page: Page, status: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    (want) => window.__algorhythms?.store.getState().transport.status === want,
    status,
    { timeout },
  );
}

/** Seconds shown by the time readout. */
async function shownTime(page: Page): Promise<number> {
  const text = (await page.getByTestId('time').textContent()) ?? '';
  const m = /^(\d+):(\d+\.\d)$/.exec(text);
  if (!m) throw new Error(`unexpected time readout "${text}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Waits for the output to be audible; returns its RMS (0 if none). Generous: a loaded machine
 * can take seconds to start the audio thread. */
async function waitForSound(page: Page, timeout = 20_000): Promise<number> {
  return page.evaluate(async (ms) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
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
  }, timeout);
}

/** Two animation frames: lets the loop draw after a state change. */
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** The canvas background pixel and a hash of its pixels. */
async function canvasInfo(page: Page) {
  await frames(page);
  return page.evaluate(() => {
    const c = document.getElementById('score') as HTMLCanvasElement;
    const g = c.getContext('2d')!;
    const px = g.getImageData(2, 2, 1, 1).data;
    return { rgb: [px[0], px[1], px[2]], url: c.toDataURL() };
  });
}

test('page title is AlgoRhythms', async ({ page }) => {
  await page.goto('./?example=tidewater-hymn');
  await expect(page).toHaveTitle(/AlgoRhythms/);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('opens with the featured example loaded, not playing, at the start', async ({ page }) => {
  await openApp(page, './');
  const s = await getState(page);
  expect(s.title).toBe('Kite Day');
  expect(s.status).toBe('idle');
  await expect(page.getByTestId('title')).toHaveText('Kite Day');
  await expect(page.getByTestId('time')).toHaveText('00:00.0');
  await expect(page.getByTestId('duration')).not.toHaveText('00:00.0');
  await expect(page.getByTestId('keyvoices')).toContainText(/C pentatonic major · \d+ \/ 9 notes/);
  // No audio before a gesture beyond preloading: nothing is playing.
  expect(await page.evaluate(() => window.__algorhythms!.engine()?.isPlaying ?? false)).toBe(false);
  expect(await page.evaluate(() => window.__algorhythms!.frameStats.start)).toBe(0);
});

test('play makes sound and time advances; pause holds; seeking works', async ({ page }) => {
  test.slow(); // waits for sound; slow on a loaded machine
  await openApp(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  const rms = await waitForSound(page);
  expect(rms, 'audible output').toBeGreaterThan(0.002);

  await expect.poll(() => shownTime(page), { timeout: 20_000 }).toBeGreaterThan(1.5);
  // Real-time rate: ~1 s of piece per second of wall time (over 3 s, so a late frame matters less).
  const t0 = await shownTime(page);
  const w0 = Date.now();
  await page.waitForTimeout(3000);
  const rate = ((await shownTime(page)) - t0) / ((Date.now() - w0) / 1000);
  expect(rate).toBeGreaterThan(0.7);
  expect(rate).toBeLessThan(1.3);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const held = await shownTime(page);
  await page.waitForTimeout(600);
  expect(await shownTime(page)).toBe(held);
  expect((await getState(page)).status).toBe('paused');

  // Seek while paused.
  await seek(page, 42);
  await expect(page.getByTestId('time')).toHaveText('00:42.0');
  expect((await getState(page)).status).toBe('paused');

  // Resume from the new position.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => shownTime(page), { timeout: 10_000 }).toBeGreaterThan(42.4);
  expect(await shownTime(page)).toBeLessThan(48);

  // Seeking while playing keeps playing.
  await seek(page, 10);
  await expect
    .poll(async () => (await shownTime(page)) > 10.4 && (await shownTime(page)) < 16, {
      timeout: 10_000,
    })
    .toBe(true);
  expect((await getState(page)).status).toBe('playing');
});

test('Space plays and pauses; arrow keys seek', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Space');
  await waitForStatus(page, 'playing');
  await expect.poll(() => shownTime(page), { timeout: 10_000 }).toBeGreaterThan(0.5);
  await page.keyboard.press('Space');
  await waitForStatus(page, 'paused');
  const t = await shownTime(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => shownTime(page)).toBeCloseTo(t + 5, 0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => shownTime(page)).toBeCloseTo(t, 0);
});

test('the piece ends with the view parked at its end, and play restarts it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForStatus(page, 'playing');
  const { duration, view } = await getState(page);
  await seek(page, duration - 1.5);
  await waitForStatus(page, 'ended', 15_000);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start), {
      timeout: 10_000,
    })
    .toBeCloseTo(duration - view.window, 3); // clamped at the end
  expect(await page.evaluate(() => window.__algorhythms!.frameStats.head)).toBeCloseTo(1, 3);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForStatus(page, 'playing');
  await expect.poll(() => shownTime(page), { timeout: 10_000 }).toBeLessThan(5);
});

test('the window slider is logarithmic from 2 s to the open canvas; = and − zoom', async ({
  page,
}) => {
  await openApp(page);
  const slider = page.getByTestId('window-slider');
  const out = page.getByTestId('window-out');
  const { duration } = await getState(page);
  await slider.fill('0');
  await expect(out).toHaveText('2.0 s');
  expect((await getState(page)).view.window).toBeCloseTo(2, 5);
  // The far end is the open canvas (§11.3 revision 7): max(4 × the piece, its end + 10 min).
  const canvas = Math.max(duration * 4, duration + 600);
  await slider.fill('1000');
  expect((await getState(page)).view.window).toBeCloseTo(canvas, 3);
  await slider.fill('500');
  // Log scale: the middle is the geometric mean of 2 s and the canvas.
  expect((await getState(page)).view.window).toBeCloseTo(Math.sqrt(2 * canvas), 1);

  await slider.fill('300');
  const w = (await getState(page)).view.window;
  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('=');
  expect((await getState(page)).view.window).toBeCloseTo(w * 0.8, 3);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  expect((await getState(page)).view.window).toBeCloseTo(w * 1.25, 3);

  // Ctrl-scroll on the score zooms too.
  const box = (await page.getByTestId('stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = (await getState(page)).view.window;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -50);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await getState(page)).view.window).toBeLessThan(before);
});

test('a middle-button drag pans the paused view', async ({ page }) => {
  await openApp(page);
  await seek(page, 60);
  await expect(page.getByTestId('time')).toHaveText('01:00.0');
  await page.getByTestId('window-slider').fill('300');
  await frames(page);
  const box = (await page.getByTestId('stage').boundingBox())!;
  const y = box.y + box.height / 2;
  const start = () => page.evaluate(() => window.__algorhythms!.frameStats.start);
  const before = await start();
  await page.mouse.move(box.x + 300, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 500, y, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await frames(page);
  const { view, status } = await getState(page);
  expect(status).toBe('paused'); // a drag is not a click
  expect(view.follow).toBe('smooth'); // a paused pan keeps Follow
  expect(await start()).toBeLessThan(before - 1); // dragged right: shows earlier time
});

test('line colours change the picture', async ({ page }) => {
  await openApp(page);
  await seek(page, 50);
  await page.getByTestId('window-slider').fill('300');
  await page.getByTestId('view-options').click();
  await page.getByRole('button', { name: 'Ink', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ink', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect((await getState(page)).view.colors).toBe('ink');
  const ink = await canvasInfo(page);
  await expect(page.getByRole('button', { name: 'Per voice' })).toHaveCount(0);
  await page.getByRole('button', { name: 'By pitch', exact: true }).click();
  expect((await getState(page)).view.colors).toBe('pitch');
  const pitch = await canvasInfo(page);
  expect(ink.url).not.toBe(pitch.url);
});

test('themes: system default, light and dark toggle, and the choice is remembered', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);
  const bright = (rgb: number[]) => rgb[0] + rgb[1] + rgb[2];
  expect(bright((await canvasInfo(page)).rgb), 'system dark').toBeLessThan(150);
  await page.getByTestId('view-options').click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(bright((await canvasInfo(page)).rgb), 'forced light').toBeGreaterThan(600);
  await page.reload();
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('view-options').click();
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(bright((await canvasInfo(page)).rgb), 'auto follows the system again').toBeLessThan(150);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(bright((await canvasInfo(page)).rgb), 'system light').toBeGreaterThan(600);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(bright((await canvasInfo(page)).rgb), 'forced dark').toBeLessThan(150);
});

test('prefers-reduced-motion skips the future-dimming tween', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForStatus(page, 'playing');
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.ghost), { timeout: 400 })
    .toBe(0.35);
});

test('the examples gallery loads each example, stopped', async ({ page }) => {
  test.slow(); // waits for sound
  await openApp(page);
  await page.getByTestId('menu-button').click();
  const list = page.getByRole('list', { name: 'Originals' });
  await expect(list.getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('list', { name: 'Songs' }).getByRole('button')).toHaveCount(8);
  const comps = page.getByRole('list', { name: 'Experiments' }).getByRole('button');
  await expect(comps).toHaveCount(4);
  // Pinned at the top (owner, 2026-11-23).
  await expect(comps.first()).toContainText('Crease');
  await expect(comps.nth(1)).toContainText('Night Sleeper');
  await list.getByRole('button', { name: /Clockwork Heron/ }).click();
  await expect(page.getByTestId('menu-panel')).toBeHidden();
  await expect(page.getByTestId('title')).toHaveText('Clockwork Heron');
  const s = await getState(page);
  expect(s.voices).toBe(10);
  expect(s.status).toBe('idle');
  await expect(page).toHaveTitle(/Clockwork Heron/);

  // The newly loaded piece plays.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  expect(await waitForSound(page)).toBeGreaterThan(0.002);
  await expect.poll(() => shownTime(page), { timeout: 10_000 }).toBeGreaterThan(1);

  // Loading another while playing stops and resets.
  await page.getByTestId('menu-button').click();
  await page.getByTestId('example-the-cartographers-rain').click();
  await expect(page.getByTestId('title')).toHaveText("The Cartographer's Rain");
  expect((await getState(page)).status).toBe('idle');
  await expect(page.getByTestId('time')).toHaveText('00:00.0');
});

test('menu offers Generate and Export; Escape closes it and returns focus', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('menu-button').click();
  const panel = page.getByTestId('menu-panel');
  await expect(panel.getByRole('button', { name: /Generate/ })).toBeEnabled();
  await expect(panel.getByTestId('open-export')).toBeEnabled();
  await expect(panel.getByTestId('open-export-audio')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('menu-button')).toBeFocused();
});

test('opens a piece from a file; bad files show errors', async ({ page }) => {
  await openApp(page);
  const input = page.getByTestId('file-input');
  await input.setInputFiles({
    name: 'seven-doors.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from(readExample('seven-doors-in-fog')),
  });
  await expect(page.getByTestId('title')).toHaveText('Seven Doors in Fog');
  expect((await getState(page)).status).toBe('idle');

  await input.setInputFiles({
    name: 'broken.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ not json'),
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not open broken.algorhythms.json');
  await expect(alert).toContainText(/valid JSON/i);
  await expect(page.getByTestId('title')).toHaveText('Seven Doors in Fog'); // unchanged

  await input.setInputFiles({
    name: 'wrong.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"something-else","version":1}'),
  });
  await expect(page.getByRole('alert').last()).toContainText('Not an AlgoRhythms piece');

  // A newer file version loads with a warning.
  const newer = JSON.parse(readExample('tidewater-hymn')) as { version: number };
  newer.version = 99;
  await input.setInputFiles({
    name: 'newer.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(newer)),
  });
  await expect(page.getByTestId('title')).toHaveText('Tidewater Hymn');
  await expect(page.locator('.notice.warning')).toContainText(/newer AlgoRhythms/);
});

test('share links round-trip: encode in the page, open in a fresh page', async ({
  page,
  context,
}) => {
  test.slow(); // waits for sound
  await openApp(page);
  const link = await page.evaluate(async () => {
    const h = window.__algorhythms!;
    const text = await (await fetch('about:blank').catch(() => null))?.text();
    void text;
    const piece = JSON.parse(JSON.stringify(h.store.getState().piece)) as {
      meta: { title: string };
    };
    piece.meta.title = 'Round Trip Piece';
    return h.encodeShareLink(piece);
  });
  expect(link).toContain('#p=');
  expect(link.split('#p=')[1]).toMatch(/^2\.[A-Za-z0-9_-]+$/); // v2: stripped, packed (M5)
  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('title')).toHaveText('Round Trip Piece');
  const s = await fresh.evaluate(() => window.__algorhythms!.store.getState().piece.voices.length);
  expect(s).toBe(12);
  // The same piece with its own tracks: loaded, stopped.
  expect((await getState(fresh)).status).toBe('idle');
  await fresh.getByRole('button', { name: 'Play', exact: true }).click();
  expect(await waitForSound(fresh)).toBeGreaterThan(0.002);
});

test('a link made by another encoder (zlib deflate-raw) opens; a damaged one reports an error', async ({
  page,
}) => {
  const json = readExample('lanterns-over-salt-flats');
  const payload = deflateRawSync(Buffer.from(json)).toString('base64url');
  await openApp(page, `./#p=${payload}`);
  await expect(page.getByTestId('title')).toHaveText('Lanterns Over Salt Flats');

  await page.goto('about:blank');
  await openApp(page, './#p=AAAA-not-deflate');
  await expect(page.getByRole('alert')).toContainText('Could not open the shared link');
  await expect(page.getByTestId('title')).toHaveText('Kite Day'); // falls back to the featured piece

  // Pasting a different link into the same page (hashchange) loads that piece.
  await page.evaluate((p) => (location.hash = `p=${p}`), payload);
  await expect(page.getByTestId('title')).toHaveText('Lanterns Over Salt Flats');
});

test('wide layout shows the editor lane and inspector; the player layout has neither', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'full');
  await expect(page.locator('[data-slot="lane"]')).toBeVisible(); // M4d: the moment lane
  await expect(page.locator('[data-slot="inspector"]')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'player');
  expect(await page.locator('[data-slot]').count()).toBe(0);
});

test('phone viewport shows the player-only layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'player');
  expect(await page.locator('[data-slot]').count()).toBe(0);
  for (const id of ['play', 'time', 'scrubber', 'window-slider', 'stage']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);
  const stage = (await page.getByTestId('stage').boundingBox())!;
  expect(stage.height).toBeGreaterThan(200);
  // The player still plays on a phone.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForStatus(page, 'playing');
});

test('screenshots: desktop light, desktop dark, phone', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-prod', 'screenshots are taken once');
  const dir = process.env.E2E_SHOT_DIR ?? join(ROOT, 'test-results/screenshots');
  const settle = async () => {
    await seek(page, 62);
    await page.getByTestId('window-slider').fill('300');
    await frames(page);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page);
  const theme = async (name: string): Promise<void> => {
    await page.getByTestId('view-options').click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.keyboard.press('Escape');
  };
  await theme('Light');
  await settle();
  await page.screenshot({ path: join(dir, 'desktop-light.png') });
  await theme('Dark');
  await frames(page);
  await page.screenshot({ path: join(dir, 'desktop-dark.png') });
  await theme('Light');
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  await page.screenshot({ path: join(dir, 'phone.png') });
});

test(
  'time to first sound: press play as soon as the page is up and hear it within 3 s',
  {
    tag: '@perf',
  },
  async ({ page }, info) => {
    await page.goto('./?example=tidewater-hymn', { waitUntil: 'commit' });
    const play = page.getByRole('button', { name: 'Play', exact: true });
    await play.click();
    const heard = await page.evaluate(async () => {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const an = window.__algorhythms?.analyser();
        if (an) {
          const buf = new Float32Array(an.fftSize);
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          if (Math.sqrt(sum / buf.length) > 0.002) return performance.now(); // ms since navigation start
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return -1;
    });
    console.log(`[${info.project.name}] time to first sound: ${Math.round(heard)} ms`);
    info.annotations.push({
      type: 'time-to-first-sound-ms',
      description: String(Math.round(heard)),
    });
    expect(heard).toBeGreaterThan(0);
    // Visitors get the production build (§15); the dev server's unbundled modules only record.
    if (info.project.name.endsWith('-prod')) {
      expect(heard, 'ms from navigation start to audible output').toBeLessThan(3000);
    }
  },
);

test('setPiece recompiles once per frame and hot-swaps while playing', async ({ page }) => {
  test.slow(); // waits for sound
  await openApp(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForStatus(page, 'playing');
  await expect.poll(() => shownTime(page), { timeout: 20_000 }).toBeGreaterThan(1);

  const compiles = await page.evaluate(async () => {
    const h = window.__algorhythms!;
    const base = JSON.parse(JSON.stringify(h.store.getState().piece)) as {
      key: { tonic: string };
    };
    let changes = 0;
    let last = h.store.getState().compiled;
    const unsub = (h.store as unknown as { subscribe(f: () => void): () => void }).subscribe(() => {
      const c = h.store.getState().compiled;
      if (c !== last) {
        changes++;
        last = c;
      }
    });
    // Five edits in one frame: one compile.
    for (const tonic of ['B', 'C', 'D', 'E', 'D']) {
      base.key = { ...base.key, tonic };
      h.actions.setPiece(JSON.parse(JSON.stringify(base)));
    }
    await new Promise((r) => setTimeout(r, 300));
    unsub();
    return changes;
  });
  expect(compiles).toBe(1);
  await expect(page.getByTestId('keyvoices')).toContainText('D dorian');
  // Still playing, time still advancing, and the output is not silent.
  const t = await shownTime(page);
  await expect.poll(() => shownTime(page), { timeout: 20_000 }).toBeGreaterThan(t + 0.3);
  expect((await getState(page)).status).toBe('playing');
  expect(await waitForSound(page)).toBeGreaterThan(0.002);
});
