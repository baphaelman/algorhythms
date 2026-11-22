/**
 * Progression (PLAN.md §6.2 `progression`, revision 10): add one from the palette, type its
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

test('add a progression, type chords, lane names, HUD while playing, Freeze', async ({ page }) => {
  await open(page);
  await seek(page, 2);
  await page.getByTestId('palette').locator('[data-moment="progression"]').click();
  const added = (await H(page).moments()).find((m) => m.type === 'progression')!;
  expect(added.at).toBeCloseTo(2, 3);
  expect(added.chords!.map((c) => c.notes)).toEqual(['I', 'vi', 'IV', 'V']);

  const insp = page.getByTestId('inspector');
  await expect(insp.locator('[data-moment-type="progression"]')).toBeVisible();
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
