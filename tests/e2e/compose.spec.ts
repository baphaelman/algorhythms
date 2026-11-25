/**
 * Compose for me (PLAN.md §11.3 "Compose in New piece", "Compose builds in play order", "Compose
 * for me, directed"; M4.5-28, M4.5-38, M12 D2): New → Compose for me opens the setup (every
 * answer Surprise me, keyboard-complete, remembered per browser); Compose builds the brief's piece
 * on screen, the camera and pen only moving forward; with Watch the composer unticked (remembered)
 * it opens the finished piece at once, Stop keeps a playable part, Compose again reopens the setup
 * with a new seed, and one undo goes back to the empty piece.
 */
import { expect, test, type Page } from '@playwright/test';
import { composedPiece } from '../../src/core/generate';
import type { ComposeBrief } from '../../src/core/compose-brief';
import { composeDirected } from '../../src/core/compose-directed';
import './app-hook';

interface Shown {
  title: string;
  moments: { id: string; at: number }[];
}
const piece = (page: Page): Promise<Shown> =>
  page.evaluate(() => {
    const p = window.__algorhythms!.store.getState().piece;
    return { title: p.meta.title, moments: p.moments };
  });
const count = async (page: Page): Promise<number> => (await piece(page)).moments.length;
const panel = (page: Page) => page.getByTestId('compose-panel');
const setup = (page: Page) => page.getByTestId('compose-setup');
const status = (page: Page) => panel(page).getAttribute('data-status');
const brief = (page: Page): Promise<ComposeBrief | null> =>
  page.evaluate(() => window.__algorhythms!.composeBrief() as ComposeBrief | null);
/** The finished piece of the last build. */
const expected = async (page: Page) => {
  const b = await brief(page);
  expect(b).not.toBeNull();
  return composedPiece(composeDirected(b!));
};
/** The finished piece, all of it in view. */
async function expectWhole(page: Page): Promise<void> {
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  expect((await piece(page)).moments).toEqual((await expected(page)).moments);
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start))
    .toBeLessThanOrEqual(0.01);
  const end = (await expected(page)).moments.at(-1)!.at;
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().view.window))
    .toBeGreaterThan(end);
}
/** The chip that is on in a question. */
const chosen = (page: Page, q: string) => page.getByTestId(`compose-${q}`).locator('label.on');

async function openSetup(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('compose-piece').click();
  await expect(setup(page)).toBeVisible();
}

/** Opens the setup and composes; with `seed`, a fixed one (and a 2 min Dreamy piece). */
async function compose(page: Page, seed?: number): Promise<void> {
  await openSetup(page);
  if (seed !== undefined) {
    await page.getByTestId('compose-mood').getByRole('radio', { name: 'Dreamy' }).click();
    await page.getByTestId('compose-length').getByRole('radio', { name: '2 min' }).click();
    await page.evaluate((s) => window.__algorhythms!.composeSeed(s), seed);
  }
  await page.getByTestId('compose-run').click();
  await expect(setup(page)).toBeHidden();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('inspector')).toBeHidden();
  await expect(panel(page)).toHaveAttribute('data-status', 'building');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('the setup opens from New: every answer Surprise me, More folded, old inputs gone', async ({
  page,
}) => {
  const before = await piece(page);
  await openSetup(page);
  for (const q of ['mood', 'length', 'shape', 'speed', 'parts']) {
    await expect(chosen(page, q)).toHaveText(['Surprise me']);
  }
  await expect(page.getByTestId('compose-start')).toHaveValue('surprise');
  // Tidewater Hymn has no melody line, so it is not offered.
  await expect(page.getByTestId('compose-start').locator('option[value="melody"]')).toHaveCount(0);
  await expect(page.getByTestId('compose-more')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('compose-key')).toBeHidden();
  await expect(page.getByTestId('compose-run')).toBeFocused();
  for (const old of ['seed', 'new-seed', 'mode', 'voices', 'density', 'natural']) {
    await expect(page.getByTestId(`compose-${old}`)).toHaveCount(0);
  }
  // Escape closes it; nothing changed.
  await page.keyboard.press('Escape');
  await expect(setup(page)).toBeHidden();
  await expect(panel(page)).toHaveCount(0);
  expect(await piece(page)).toEqual(before);
});

test('every control works from the keyboard; Enter on Compose composes the brief', async ({
  page,
  browserName,
}) => {
  // macOS WebKit's Tab skips radios and buttons (system "Keyboard navigation" off); Option-Tab doesn't.
  const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const BACK = `Shift+${TAB}`;
  await openSetup(page);
  // Back from Compose: Watch, Cancel, More, Start from, six Parts chips, Speed, Shape, Length,
  // Mood.
  for (let i = 0; i < 14; i++) await page.keyboard.press(BACK);
  const mood = page.getByTestId('compose-mood');
  await expect(mood.getByRole('radio', { name: 'Surprise me' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(chosen(page, 'mood')).toHaveText(['Calm']);
  await page.keyboard.press(TAB);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(chosen(page, 'length')).toHaveText(['2 min']);
  await page.keyboard.press(TAB);
  await page.keyboard.press('ArrowRight');
  await expect(chosen(page, 'shape')).toHaveText(['Build up']);
  await page.keyboard.press(TAB);
  await expect(
    page.getByTestId('compose-speed').getByRole('radio', { name: 'Surprise me' }),
  ).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight'); // Slow, Medium, Fast (WebKit radios don't wrap)
  await expect(chosen(page, 'speed')).toHaveText(['Fast']);
  await page.keyboard.press(TAB); // Parts: Surprise me
  await page.keyboard.press(TAB); // Chords
  await page.keyboard.press('Space');
  await page.keyboard.press(TAB); // Bass
  await page.keyboard.press(TAB); // Melody
  await page.keyboard.press('Space');
  await expect(chosen(page, 'parts')).toHaveText(['Chords', 'Melody']);
  await page.keyboard.press(TAB); // Pulse
  await page.keyboard.press(TAB); // Bells
  await page.keyboard.press(TAB); // Start from
  await expect(page.getByTestId('compose-start')).toBeFocused();
  await page.keyboard.type('N');
  await expect(page.getByTestId('compose-start')).toHaveValue('none');
  await page.keyboard.press(TAB); // More
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('compose-more')).toHaveAttribute('open', '');
  await expect(page.getByTestId('compose-scale')).toBeDisabled();
  await page.keyboard.press(TAB);
  await expect(page.getByTestId('compose-key')).toBeFocused();
  await page.keyboard.type('D');
  await expect(page.getByTestId('compose-key')).toHaveValue('2');
  await page.keyboard.press(TAB);
  await expect(page.getByTestId('compose-scale')).toBeFocused();
  await page.keyboard.type('Do');
  await expect(page.getByTestId('compose-scale')).toHaveValue('dorian');
  await page.keyboard.press(TAB);
  await page.keyboard.type('100');
  await page.keyboard.press(TAB); // Cancel
  await page.keyboard.press(TAB); // Watch the composer
  await expect(page.getByTestId('compose-watch')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('compose-watch')).not.toBeChecked();
  await page.keyboard.press(TAB); // Compose
  await expect(page.getByTestId('compose-run')).toBeFocused();
  await page.keyboard.press('Enter');

  // Unwatched: the finished piece at once.
  await expectWhole(page);
  const b = await brief(page);
  expect(b).toEqual({
    seed: b!.seed,
    mood: 'calm',
    length: 120,
    shape: 'build',
    speed: 'fast',
    parts: ['chords', 'melody'],
    start: { kind: 'none' },
    key: { tonic: 2, mode: 'dorian' },
    tempo: 100,
  });
});

test('Speed: Fast composes a Fast piece, and Compose again keeps it', async ({ page }) => {
  await openSetup(page);
  const speed = page.getByTestId('compose-speed');
  await expect(speed.getByRole('radio')).toHaveCount(4);
  await speed.getByRole('radio', { name: 'Fast' }).click();
  await expect(chosen(page, 'speed')).toHaveText(['Fast']);
  await page.getByTestId('compose-watch').uncheck();
  await page.getByTestId('compose-run').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  const b = (await brief(page))!;
  expect(b).toEqual({ seed: b.seed, speed: 'fast' });
  expect((await piece(page)).moments).toEqual((await expected(page)).moments);
  await page.getByTestId('compose-again').click();
  await expect(chosen(page, 'speed')).toHaveText(['Fast']);
});

test('Compose for me places moments over time, then shows the full piece', async ({ page }) => {
  await compose(page, 46); // seed 46 has detail steps
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const out: Sample[] = [];
    (window as unknown as { __trace: Sample[] }).__trace = out;
    const tick = (): void => {
      const status =
        document.querySelector('[data-testid="compose-panel"]')?.getAttribute('data-status') ??
        null;
      out.push({ start: h.frameStats.start, pen: h.compose.pen, detail: h.compose.detail, status });
      if (status === 'building') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const all = (await expected(page)).moments.length;
  await expect.poll(() => count(page), { timeout: 15_000 }).toBeGreaterThan(0);
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1500);
    seen.push(await count(page));
  }
  // Moments appear one by one over several seconds, not all at once.
  expect(seen[0]).toBeGreaterThan(0);
  expect(seen[3]).toBeGreaterThan(seen[0]);
  expect(seen[3]).toBeLessThan(all);
  expect(await status(page)).toBe('building');
  // The camera follows the composer's pen to the right.
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start))
    .toBeGreaterThan(5);
  await expect(panel(page)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  expect((await piece(page)).moments).toEqual((await expected(page)).moments);

  // In play order: the camera and pen never move back while the structure is placed; the detail
  // sweep then shows the whole piece (the camera still) and its pen also only moves forward.
  const samples = (
    await page.evaluate(() => (window as unknown as { __trace: Sample[] }).__trace)
  ).filter((s) => s.status === 'building');
  const structure = samples.filter((s) => !s.detail);
  const details = samples.filter((s) => s.detail);
  expect(structure.length).toBeGreaterThan(100);
  expect(details.length).toBeGreaterThan(5); // frames
  expect(samples.findIndex((s) => s.detail)).toBe(structure.length);
  for (let i = 1; i < structure.length; i++) {
    expect(structure[i].start).toBeGreaterThanOrEqual(structure[i - 1].start - 1e-6);
    expect(structure[i].pen).toBeGreaterThanOrEqual(structure[i - 1].pen - 1e-6);
  }
  expect(structure.at(-1)!.pen).toBeGreaterThan(100);
  // The first detail frame may still show the last structural camera; from then on it holds.
  for (let i = 2; i < details.length; i++) {
    expect(details[i].start).toBe(details[1].start);
    expect(details[i].pen).toBeGreaterThanOrEqual(details[i - 1].pen);
  }
});

interface Sample {
  start: number;
  pen: number;
  detail: boolean;
  status: string | null;
}

test('Watch the composer unticked opens the full piece; one undo empties back to before', async ({
  page,
}) => {
  await openSetup(page);
  await expect(page.getByTestId('compose-watch')).toBeChecked();
  await page.getByTestId('compose-watch').uncheck();
  await page.getByTestId('compose-run').click();
  await expect(setup(page)).toBeHidden();
  await expectWhole(page);
  await expect(page.getByTestId('compose-stop')).toHaveCount(0);
  const done = await piece(page);
  const want = await expected(page);
  expect(done.title).toBe(want.meta.title);
  expect(done.moments).toEqual(want.moments);

  // The user's own history change closes the panel, and the inspector returns.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await piece(page)).moments.length).toBe(0);
  await expect(panel(page)).toBeHidden();
  await expect(page.getByTestId('inspector')).toBeVisible();
  expect((await piece(page)).title).toBe('Untitled');
  expect(await page.evaluate(() => window.__algorhythms!.editor.state.getState().canUndo)).toBe(
    false,
  );
});

test('Stop keeps a partial piece that plays', async ({ page }) => {
  await compose(page);
  await expect.poll(() => count(page), { timeout: 30_000 }).toBeGreaterThan(2);
  // No Skip during the build; Stop stays.
  await expect(page.getByTestId('compose-skip')).toHaveCount(0);
  await page.getByTestId('compose-stop').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'stopped');
  const kept = await count(page);
  expect(kept).toBeGreaterThan(2);
  expect(kept).toBeLessThan((await expected(page)).moments.length);
  await page.waitForTimeout(1000);
  expect(await count(page)).toBe(kept);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.engine()?.currentTime() ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0.5);
  const errors = await page.evaluate(() =>
    (
      window.__algorhythms!.store.getState().compiled as unknown as {
        diagnostics: { level: string }[];
      }
    ).diagnostics.filter((d) => d.level === 'error'),
  );
  expect(errors).toEqual([]);
});

test('Compose again keeps the answers with a new seed, as one undo entry', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('compose-mood').getByRole('radio', { name: 'Dark' }).click();
  await page.getByTestId('compose-parts').getByRole('checkbox', { name: 'Bells' }).click();
  await page.getByTestId('compose-watch').uncheck();
  await page.getByTestId('compose-run').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  const first = (await brief(page))!;
  expect(first).toEqual({ seed: first.seed, mood: 'dark', parts: ['bells'] });

  await page.getByTestId('compose-again').click();
  await expect(setup(page)).toBeVisible();
  await expect(chosen(page, 'mood')).toHaveText(['Dark']);
  await expect(chosen(page, 'parts')).toHaveText(['Bells']);
  await expect(page.getByTestId('compose-watch')).not.toBeChecked();
  // Escape leaves the finished piece and the panel as they were.
  const done = await piece(page);
  await page.keyboard.press('Escape');
  await expect(setup(page)).toBeHidden();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  expect(await piece(page)).toEqual(done);

  await page.getByTestId('compose-again').click();
  await page.getByTestId('compose-run').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  const again = (await brief(page))!;
  expect(again.seed).not.toBe(first.seed);
  expect(again).toEqual({ ...first, seed: again.seed });
  expect((await piece(page)).moments).toEqual((await expected(page)).moments);
  // Still one undo entry back to the empty piece.
  await page.getByTestId('compose-close').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await piece(page)).moments.length).toBe(0);
  expect(await page.evaluate(() => window.__algorhythms!.editor.state.getState().canUndo)).toBe(
    false,
  );
});

test('the answers survive a reload', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('compose-length').getByRole('radio', { name: '5 min' }).click();
  await page.getByTestId('compose-shape').getByRole('radio', { name: 'Journey' }).click();
  await page.getByTestId('compose-more').locator('summary').click();
  await page.getByTestId('compose-tempo').fill('84');
  await page.getByTestId('compose-watch').uncheck();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openSetup(page);
  await expect(chosen(page, 'length')).toHaveText(['5 min']);
  await expect(chosen(page, 'shape')).toHaveText(['Journey']);
  await expect(chosen(page, 'mood')).toHaveText(['Surprise me']);
  // More opens by itself when it holds an answer.
  await expect(page.getByTestId('compose-more')).toHaveAttribute('open', '');
  await expect(page.getByTestId('compose-tempo')).toHaveValue('84');
  await expect(page.getByTestId('compose-watch')).not.toBeChecked();
});

test("the open piece's melody is offered when it has one, and goes into the brief", async ({
  page,
}) => {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openSetup(page);
  await page.getByTestId('compose-start').selectOption('melody');
  await page.getByTestId('compose-run').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'building');
  const b = (await brief(page))!;
  expect(b.start?.kind).toBe('melody');
  const notes = b.start?.kind === 'melody' ? b.start.notes : [];
  expect(notes.length).toBeGreaterThan(4);
  for (let i = 1; i < notes.length; i++)
    expect(notes[i].at).toBeGreaterThanOrEqual(notes[i - 1].at);
});

test('the setup fits 1280×720 without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSetup(page);
  const fit = await setup(page).evaluate((d) => ({
    scroll: d.scrollHeight,
    client: d.clientHeight,
    bottom: d.getBoundingClientRect().bottom,
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.bottom).toBeLessThanOrEqual(720);
  await expect(page.getByTestId('compose-run')).toBeInViewport();
});

test('the setup fits a narrow window and follows dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSetup(page);
  const fit = await setup(page).evaluate((d) => ({
    scroll: d.scrollWidth,
    client: d.clientWidth,
    right: d.getBoundingClientRect().right,
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.right).toBeLessThanOrEqual(390);
  const bg = () => setup(page).evaluate((d) => getComputedStyle(d).backgroundColor);
  const light = await bg();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(bg).not.toBe(light);
});

/** Composes `answers` (radio names per question, Parts checkbox names) with `seed`, unwatched. */
async function composeWith(
  page: Page,
  seed: number,
  answers: { mood?: string; parts?: string[] },
): Promise<{ scale: string; bpm: number; parts: string[] }> {
  await openSetup(page);
  if (answers.mood)
    await page.getByTestId('compose-mood').getByRole('radio', { name: answers.mood }).click();
  for (const p of answers.parts ?? [])
    await page.getByTestId('compose-parts').getByRole('checkbox', { name: p }).click();
  await page.evaluate((s) => window.__algorhythms!.composeSeed(s), seed);
  await page.getByTestId('compose-watch').setChecked(false);
  await page.getByTestId('compose-run').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  expect((await piece(page)).moments).toEqual((await expected(page)).moments);
  return page.evaluate(() => {
    const p = window.__algorhythms!.store.getState().piece as unknown as {
      key: { scale: string };
      view: { gridBpm: number };
      moments: { target?: { part?: string } }[];
    };
    const parts = new Set<string>();
    for (const m of p.moments) {
      if (m.target?.part) parts.add(m.target.part);
    }
    return { scale: p.key.scale, bpm: p.view.gridBpm, parts: [...parts].sort() };
  });
}

test('the answers shape the piece: two moods differ in mode and tempo; Parts gives only those', async ({
  page,
}) => {
  const calm = await composeWith(page, 11, { mood: 'Calm' });
  await page.getByTestId('compose-close').click();
  const driving = await composeWith(page, 11, { mood: 'Driving' });
  expect(driving.scale === calm.scale && driving.bpm === calm.bpm).toBe(false);
  expect(driving.bpm).toBeGreaterThan(calm.bpm);
  await page.getByTestId('compose-close').click();
  // Mood Surprise me again, so only Parts is set.
  await openSetup(page);
  await page.getByTestId('compose-mood').getByRole('radio', { name: 'Surprise me' }).click();
  await page.keyboard.press('Escape');
  const two = await composeWith(page, 12, { parts: ['Chords', 'Bass'] });
  expect(two.parts).toEqual(['Bass', 'Chords']);
});
