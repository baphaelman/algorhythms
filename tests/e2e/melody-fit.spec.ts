/**
 * M10b-5 (PLAN.md §6.4): New → "Like the video" opens the template; a melody added from the
 * palette fits the chords and re-fits when the chord under it changes, in the same undo entry.
 */
import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

interface M {
  id: string;
  type: string;
  at: number;
  notes?: { pitch: number; len: number }[] | { kind: string; symbol?: string };
  fit?: { seed: number };
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(
    () => (window.__algorhythms!.store.getState().piece as unknown as { moments: M[] }).moments,
  );

test('New → Like the video: six chord blocks and one Wander, no split, merge or unison', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('new-video-piece')).toHaveText('Like the video');
  await page.getByTestId('new-video-piece').click();
  await expect
    .poll(async () => (await moments(page)).map((m) => m.type))
    .toEqual(['chord', 'chord', 'chord', 'chord', 'chord', 'chord', 'walk']);
  const title = await page.evaluate(
    () =>
      (window.__algorhythms!.store.getState().piece as unknown as { meta: { title: string } }).meta
        .title,
  );
  expect(title).toBe('Like the video');
  const diagnostics = await page.evaluate(
    () =>
      (window.__algorhythms!.store.getState().compiled as unknown as { diagnostics: unknown[] })
        .diagnostics,
  );
  expect(diagnostics).toEqual([]);
});

test('Add → Melody fits the chord; changing the chord re-fits it; one undo restores both', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    p.key = { tonic: 'C', scale: 'major' };
    p.view = { ...p.view, gridBpm: 80, meter: 4 };
    p.end = { at: 12, fade: 1 };
    const chord = (id: string, at: number, symbol: string) => ({
      id,
      type: 'chord',
      at,
      notes: { kind: 'chord', symbol },
      voicing: 'even',
      assign: 'ordered',
      count: 4,
      register: [48, 67],
      glide: { land: true, length: 0.4 },
    });
    p.moments = [chord('c1', 0, 'I'), chord('c2', 3, 'V'), chord('c3', 6, 'I')];
    h.actions.loadPiece(p as never);
  });
  await seek(page, 3);
  await page.getByTestId('palette').locator('[data-moment="tune"]').click();
  const tune = async (): Promise<M> => (await moments(page)).find((m) => m.type === 'tune')!;
  await expect.poll(async () => (await moments(page)).length).toBe(4);
  const first = await tune();
  expect(first.at).toBeCloseTo(3, 6);
  expect(first.fit).toBeDefined();
  const notes = first.notes as { pitch: number; len: number }[];
  expect(notes.reduce((a, n) => a + n.len, 0)).toBeCloseTo(3, 5);
  // The downbeat note is a tone of V (G B D).
  expect([7, 11, 2]).toContain(notes[0].pitch % 12);

  // Change the chord under it to IV: the melody follows.
  await page.evaluate(() => window.__algorhythms!.actions.select(['c2']));
  const picker = page.getByTestId('inspector').getByTestId('insp-chord-picker');
  await picker
    .getByRole('group', { name: 'From the key' })
    .getByRole('button', { name: 'IV F', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        ((await moments(page)).find((m) => m.id === 'c2')!.notes as { symbol: string }).symbol,
    )
    .toBe('F');
  const refit = await tune();
  const now = refit.notes as { pitch: number; len: number }[];
  expect(now).not.toEqual(notes);
  expect(refit.fit).toEqual(first.fit);
  expect([5, 9, 0]).toContain(now[0].pitch % 12);
  for (const n of now) expect([0, 2, 4, 5, 7, 9, 11]).toContain(n.pitch % 12);

  // One undo: the chord and the melody together.
  await page.evaluate(() =>
    (window.__algorhythms as unknown as { editor: { undo(): boolean } }).editor.undo(),
  );
  const back = await moments(page);
  expect((back.find((m) => m.id === 'c2')!.notes as { symbol: string }).symbol).toBe('V');
  expect(back.find((m) => m.type === 'tune')!.notes).toEqual(notes);
});
