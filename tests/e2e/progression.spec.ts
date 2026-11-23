/**
 * Progression (PLAN.md §6.2 `progression`, revision 10): a progression moment from a file (the
 * palette no longer adds one, §6.4) edits under its chord block's "Progression" fold: type its
 * chords, see each chord's name on the lane bar, follow the HUD chord while playing, then Freeze
 * it into chord moments (one undo entry). Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  chords?: { notes: string; len: number }[];
}

interface Hook {
  editor: {
    undo(): boolean;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
  store: {
    getState(): {
      piece: { moments: M[] };
      compiled: { harmony?: { t: number; label: string; momentId: string }[] };
    };
  };
  engine(): { currentTime(): number; isPlaying: boolean } | null;
}

const H = (page: Page) => ({
  moments: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  undoLabel: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
  selection: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().selection,
    ),
});

/** C E G C sounding from 0 in C major, tempo 60 (a beat is 1 s), automatic end. */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      key: unknown;
      end: Record<string, unknown>;
      voices: { id: string; part?: string }[];
      defaults: { glide: Record<string, unknown> };
      view: Record<string, unknown>;
    };
    p.key = { tonic: 'C', scale: 'major' };
    p.defaults.glide = { ...p.defaults.glide, length: 0.4, stagger: 0, jitter: 0 };
    delete p.defaults.glide.land;
    for (const v of p.voices) delete v.part;
    p.moments = [
      {
        id: 'open',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [48, 60, 64, 67] },
        voicing: 'even',
        assign: 'ordered',
        byVoice: true,
        target: { voices: p.voices.slice(0, 4).map((v) => v.id) },
      },
    ];
    p.end = { fade: 1 };
    p.view = { ...p.view, gridBpm: 60, meter: 4, snapBeats: true };
    h.actions.setPiece(p);
  });
}

/** Adds progression `chords` (each `len` s) at `at` (as one undo entry) and selects it. */
async function addProgression(
  page: Page,
  at: number,
  chords: string[],
  len: number,
  count?: number,
): Promise<void> {
  await page.evaluate(
    ({ at, chords, len, count }) => {
      const h = window.__algorhythms!;
      const p = structuredClone(h.store.getState().piece) as unknown as { moments: object[] };
      p.moments.push({
        id: 'prog01',
        type: 'progression',
        at,
        chords: chords.map((notes) => ({ notes, len })),
        voicing: 'even',
        assign: 'ordered',
        ...(count ? { count } : {}),
      });
      h.actions.setPiece(p);
      h.actions.select(['prog01']);
    },
    { at, chords, len, count },
  );
}

test('add a progression, type chords, lane names, HUD while playing, Freeze', async ({ page }) => {
  await open(page);
  await addProgression(page, 2, ['I', 'vi', 'IV', 'V'], 2.5);
  const added = (await H(page).moments()).find((m) => m.type === 'progression')!;
  expect(added.at).toBeCloseTo(2, 3);

  const insp = page.getByTestId('inspector');
  await expect(insp.locator('[data-moment-type="progression"]')).toBeVisible();
  await insp.getByTestId('insp-prog-more').locator('summary').click();
  const text = insp.getByTestId('prog-text');
  await text.fill('I 1, IV 1, V 1, I 1');
  await text.press('Enter');
  await expect.poll(async () => (await H(page).undoLabel()) ?? '').toContain('Type chords');
  const typed = (await H(page).moments()).find((m) => m.type === 'progression')!;
  expect(typed.chords).toEqual([
    { notes: 'I', len: 1 },
    { notes: 'IV', len: 1 },
    { notes: 'V', len: 1 },
    { notes: 'I', len: 1 },
  ]);

  // The inspector lists the chords; the lane bar names each over its span.
  await expect(insp.getByTestId('prog-chord-name')).toHaveText([
    'I · C',
    'IV · F',
    'V · G',
    'I · C',
  ]);
  const bar = page.locator(`.lane-item[data-moment="${typed.id}"]`);
  await expect(bar.getByTestId('lane-prog-chord')).toHaveText([
    'I · C',
    'IV · F',
    'V · G',
    'I · C',
  ]);
  const boxes = await bar
    .getByTestId('lane-prog-chord')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const w of boxes) expect(Math.abs(w - boxes[0])).toBeLessThan(2);

  // Playing from 3.2 s: the HUD reads the chord in effect at the playhead (IV, then V).
  await seek(page, 3.2);
  await page.getByTestId('play').click();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.engine()?.isPlaying ?? false))
    .toBe(true);
  const hud = () =>
    page.evaluate(() => {
      const h = window.__algorhythms as unknown as Hook;
      const t = h.engine()!.currentTime();
      const hs = h.store.getState().compiled.harmony ?? [];
      let label = '';
      for (const x of hs) if (x.t <= t) label = x.label;
      return { t, label };
    });
  await expect.poll(async () => (await hud()).t, { timeout: 10_000 }).toBeGreaterThan(3.3);
  const a = await hud();
  if (a.t < 4) expect(a.label).toBe('IV · F');
  await expect.poll(async () => (await hud()).t, { timeout: 10_000 }).toBeGreaterThan(4.3);
  const b = await hud();
  if (b.t < 5) expect(b.label).toBe('V · G');
  await page.getByTestId('play').click();

  // Freeze: four chord moments in its place, selected; one undo entry brings it back.
  await insp.getByTestId('insp-freeze').click();
  await expect
    .poll(async () => (await H(page).moments()).some((m) => m.type === 'progression'))
    .toBe(false);
  const chords = (await H(page).moments()).filter((m) => m.type === 'chord' && m.id !== 'open');
  expect(chords.map((m) => m.at)).toEqual([2, 3, 4, 5]);
  expect((await H(page).selection()).sort()).toEqual(chords.map((m) => m.id).sort());
  await expect(page.locator('.lane-item[data-type="chord"]')).toHaveCount(5);
  await H(page).undo();
  await expect
    .poll(async () => (await H(page).moments()).some((m) => m.type === 'progression'))
    .toBe(true);
});

/** The notes (pitches, low to high) each voice is heading for at `t`. */
async function notesAt(page: Page, t: number): Promise<number[]> {
  return page.evaluate((t) => {
    type Seg = { t0: number; t1: number; p1: number; curve?: { p1: number } };
    const s = (
      window.__algorhythms as unknown as {
        store: { getState(): { compiled: { voices: { segments: Seg[] }[] } } };
      }
    ).store.getState().compiled;
    const out: number[] = [];
    for (const v of s.voices) {
      const g = v.segments.find((x) => x.t0 <= t && t < x.t1);
      if (g) out.push(g.curve ? g.curve.p1 : g.p1);
    }
    return out.sort((a, b) => a - b);
  }, t);
}

test('owner notes: on New → Empty, chords match, default spacing, the chord list edits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('new-piece').click();
  await expect.poll(async () => (await H(page).moments()).length).toBe(0);

  // A dorian's own chords as unit tests' default progression has them (progression.test.ts).
  await addProgression(page, 0, ['i', 'IV', '♭VII', 'i'], 5.8, 3);
  const prog = (await H(page).moments()).find((m) => m.type === 'progression')!;

  // Every chord, the first included: three notes in a close voicing around the middle.
  for (let k = 0; k < 4; k++) {
    const ps = await notesAt(page, 5.8 * (k + 1) - 0.05);
    expect(ps).toHaveLength(3);
    expect(ps[2] - ps[0]).toBeLessThanOrEqual(12);
  }

  const insp = page.getByTestId('inspector');
  await insp.getByTestId('insp-prog-more').locator('summary').click();
  const rows = insp.getByTestId('prog-chord');
  const bar = page.locator(`.lane-item[data-moment="${prog.id}"]`);
  await expect(rows).toHaveCount(4);

  // A chip appends its chord with the default spacing.
  await insp.getByTestId('prog-chips').locator('[data-numeral="ii"]').click();
  await expect.poll(async () => (await H(page).undoLabel()) ?? '').toContain('Add chord');
  let chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords.at(-1)).toEqual({ notes: 'ii', len: 5.8 });
  await expect(rows).toHaveCount(5);
  await expect(insp.getByTestId('prog-chord-name').nth(4)).toHaveText('ii · Bm');
  await expect(bar.getByTestId('lane-prog-chord')).toHaveCount(5);
  await expect(bar.getByTestId('lane-prog-chord').nth(4)).toHaveText('ii · Bm');

  // Hovering a row highlights its chord on the lane.
  await rows.nth(1).hover();
  await expect(bar.getByTestId('lane-prog-chord').nth(1)).toHaveClass(/\bon\b/);

  // Retime chord 2 (seconds without a tempo).
  const len = rows.nth(1).getByTestId('prog-chord-len');
  await len.fill('3');
  await len.press('Enter');
  await expect.poll(async () => (await H(page).undoLabel()) ?? '').toContain('Edit chord length');
  chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords[1]).toEqual({ notes: 'IV', len: 3 });

  // Change chord 1 with the picker.
  await rows.nth(0).getByTestId('prog-chord-pick').click();
  await expect(insp.getByTestId('prog-chips').locator('[data-numeral="i"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await insp.getByTestId('prog-chips').locator('[data-numeral="♭III"]').click();
  await expect.poll(async () => (await H(page).undoLabel()) ?? '').toContain('Change chord');
  chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords[0].notes).toBe('♭III');
  await insp.getByTestId('prog-change-done').click();

  // Reorder, then remove chord 3.
  await rows.nth(0).getByTestId('prog-chord-down').click();
  await expect.poll(async () => (await H(page).undoLabel()) ?? '').toContain('Move chord');
  chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords.slice(0, 2).map((c) => c.notes)).toEqual(['IV', '♭III']);
  await rows.nth(2).getByTestId('prog-chord-remove').click();
  await expect(rows).toHaveCount(4);
  chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords.map((c) => c.notes)).toEqual(['IV', '♭III', 'i', 'ii']);
  await expect(bar.getByTestId('lane-prog-chord')).toHaveCount(4);

  // Each edit is one undo step.
  await H(page).undo();
  await expect(rows).toHaveCount(5);
  chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords.map((c) => c.notes)).toEqual(['IV', '♭III', '♭VII', 'i', 'ii']);
  await H(page).undo();
  chords = (await H(page).moments()).find((m) => m.id === prog.id)!.chords!;
  expect(chords.map((c) => c.notes)).toEqual(['♭III', 'IV', '♭VII', 'i', 'ii']);
});
