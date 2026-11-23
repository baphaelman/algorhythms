/**
 * Walk over: Key / Chord (PLAN.md §6.2 walk, revision 10): flip the switch, the walk's steps land
 * on chord tones, Key drops the field, undo. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  over?: string;
}

interface Hook {
  editor: { select(ids: string[]): void; undo(): boolean };
  store: {
    getState(): {
      piece: { moments: M[] };
      compiled: { walkSteps: { momentId: string; from: number; to: number }[] };
    };
  };
}

const walkOf = (page: Page): Promise<M> =>
  page.evaluate(() =>
    (window.__algorhythms as unknown as Hook).store
      .getState()
      .piece.moments.find((m) => m.id === 'walk1')!,
  );

/** Pitch classes of the walk's moving steps. */
const stepPcs = (page: Page): Promise<number[]> =>
  page.evaluate(() => [
    ...new Set(
      (window.__algorhythms as unknown as Hook).store
        .getState()
        .compiled.walkSteps.filter((s) => s.momentId === 'walk1' && s.from !== s.to)
        .map((s) => ((s.to % 12) + 12) % 12),
    ),
  ]);

/** Opens the texture block's More (the walk's fields), if closed. */
async function openMore(page: Page): Promise<void> {
  const more = page.getByTestId('inspector').getByTestId('insp-texture-more');
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
}

test('Walk over: Chord steps on chord tones; Key drops the field; undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      end: unknown;
      key: unknown;
    };
    p.key = { tonic: 'C', scale: 'major' };
    p.moments = [
      {
        id: 'start0',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [48, 55, 60, 64] },
        voicing: 'even',
        assign: 'ordered',
      },
      {
        id: 'walk1',
        type: 'walk',
        at: 1,
        until: 14,
        grid: 0.5,
        density: 0.8,
        steps: [-2, -1, 1, 2],
        stepGlide: 0.3,
      },
    ];
    p.end = { at: 16, fade: 1 };
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.select(['walk1']));
  await openMore(page);
  const sw = page.getByTestId('inspector').getByTestId('insp-walk-over');
  const key = sw.getByRole('button', { name: 'Key' });
  const chord = sw.getByRole('button', { name: 'Chord' });
  await expect(key).toHaveAttribute('aria-pressed', 'true');
  await expect(chord).toHaveAttribute('aria-pressed', 'false');
  // Over the key the walk uses scale tones outside the C major triad.
  expect((await stepPcs(page)).some((pc) => ![0, 4, 7].includes(pc))).toBe(true);

  await chord.click();
  await expect(chord).toHaveAttribute('aria-pressed', 'true');
  expect((await walkOf(page)).over).toBe('chord');
  await expect
    .poll(async () => (await stepPcs(page)).every((pc) => [0, 4, 7].includes(pc)))
    .toBe(true);
  expect((await stepPcs(page)).length).toBeGreaterThan(0);

  await key.click();
  expect('over' in (await walkOf(page))).toBe(false);

  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo());
  expect((await walkOf(page)).over).toBe('chord');
  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo());
  expect('over' in (await walkOf(page))).toBe(false);
  await expect(key).toHaveAttribute('aria-pressed', 'true');
});
