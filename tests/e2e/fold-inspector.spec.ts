/**
 * M13 "Upside down and wider/closer" and "Next" (PLAN.md): the spread inspector names the chord a
 * value would land on before it commits; Upside down offers the middle, the axis that keeps the
 * key and the one a whole step up, each with its key and chord, shows when the lines cross, and
 * has Cross at one point; widths other than 1 burst through one point; Next offers the closed
 * loop on a voicing that allows it.
 */

import { expect, test, type Page } from '@playwright/test';

interface M {
  id: string;
  type: string;
  factor?: number;
  around?: number | string;
  snap?: string;
  glide?: Record<string, unknown>;
}

const moment = (page: Page, id: string): Promise<M | null> =>
  page.evaluate(
    (i) =>
      (
        window.__algorhythms as unknown as {
          store: { getState(): { piece: { moments: M[] } } };
        }
      ).store
        .getState()
        .piece.moments.find((m) => m.id === i) ?? null,
    id,
  );

/** C major at 60 bpm: Am7 as E4 G4 A4 C5 on four lines from 0 s, then `more`. */
async function open(page: Page, more: object[] = []): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((more) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      key: unknown;
      end: Record<string, unknown>;
      voices: { part?: string; range?: number[] }[];
      view: Record<string, unknown>;
      defaults: { glide: Record<string, unknown> };
    };
    p.key = { tonic: 'C', scale: 'major' };
    for (const v of p.voices) {
      delete v.part;
      v.range = [36, 96];
    }
    p.end = { ...p.end, at: 40 };
    p.defaults.glide = { ...p.defaults.glide, stagger: 0.6, jitter: 0.2, land: false };
    p.moments = [
      {
        id: 'open',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [64, 67, 69, 72] },
        voicing: 'even',
        assign: 'ordered',
        count: 4,
      },
      ...more,
    ];
    p.view = { ...p.view, gridBpm: 60, meter: 4 };
    h.actions.setPiece(p);
  }, more);
}

const select = (page: Page, id: string) =>
  page.evaluate(
    (i) =>
      (window.__algorhythms as unknown as { editor: { select(x: string[]): void } }).editor.select([
        i,
      ]),
    id,
  );

const insp = (page: Page) => page.getByTestId('inspector');
const axis = (page: Page, id: string) =>
  insp(page).getByTestId('insp-fold-axis').locator(`button[data-axis="${id}"]`);

test('Wider/Closer names the chord a typed spacing would land on before it commits', async ({
  page,
}) => {
  await open(page, [
    { id: 'sp1', type: 'spread', at: 8, factor: 1.5, around: 'mean', snap: 'scale' },
  ]);
  await select(page, 'sp1');
  const lands = insp(page).getByTestId('insp-spread-lands');
  await expect(lands).toHaveText(/^Lands on \S+/);
  const before = await lands.textContent();
  const field = insp(page).getByTestId('insp-spread-factor');
  await field.fill('0.5');
  await expect(lands).toHaveAttribute('data-preview', 'true');
  await expect(lands).toHaveText(/^Would land on \S+/);
  expect((await moment(page, 'sp1'))?.factor).toBe(1.5);
  await field.press('Enter');
  await expect.poll(async () => (await moment(page, 'sp1'))?.factor).toBe(0.5);
  await expect(lands).not.toHaveAttribute('data-preview');
  await expect(lands).toHaveText(/^Lands on \S+/);
  expect(await lands.textContent()).not.toBe(before);
});

test('Upside down: the axes with their keys and chords, the crossing, Cross at one point', async ({
  page,
}) => {
  await open(page, [
    {
      id: 'fd1',
      type: 'spread',
      at: 8,
      factor: -1,
      around: 'mean',
      snap: 'scale',
      glide: { length: 4 },
    },
  ]);
  await select(page, 'fd1');
  await expect(axis(page, 'middle')).toHaveAttribute('aria-pressed', 'true');
  await expect(axis(page, 'keep')).toContainText(/Keep the key · (G♯|A♭)4/);
  await expect(axis(page, 'keep')).toContainText('→ Am7/E · C major');
  await expect(axis(page, 'lift')).toContainText('Up a whole step · A4');
  await expect(axis(page, 'lift')).toContainText('→ Bm7/F♯ · D major');

  // The lift: about A4, snapped by semitone, in D major.
  await axis(page, 'lift').click();
  await expect
    .poll(async () => {
      const m = await moment(page, 'fd1');
      return [m?.around, m?.snap];
    })
    .toEqual([69, 'chromatic']);
  await expect(axis(page, 'lift')).toHaveAttribute('aria-pressed', 'true');
  const lands = insp(page).getByTestId('insp-spread-lands');
  await expect(lands).toHaveText('Lands on Bm7/F♯ in D major');

  // Staggered and jittered, the lines cross one by one; switched on, all at one instant.
  const crossing = insp(page).getByTestId('insp-fold-crossing');
  await expect(crossing).toHaveText(/^Lines cross A4 from 0:\d\d\.\d \(bar \d+, beat \d\) to /);
  const sw = insp(page).getByTestId('insp-cross-point');
  await expect(sw).not.toBeChecked();
  await sw.check();
  await expect
    .poll(async () => {
      const g = (await moment(page, 'fd1'))?.glide;
      return [g?.stagger, g?.jitter];
    })
    .toEqual([0, 0]);
  await expect(crossing).toHaveText('All 4 lines meet at A4, 0:10.0 (bar 3, beat 3)');

  // Width 2: a burst through one point; the chord before it commits, then no key.
  const width = insp(page).getByTestId('insp-fold-width');
  await width.fill('2');
  await expect(lands).toHaveText(/^Would land on \S+/);
  await width.press('Enter');
  await expect.poll(async () => (await moment(page, 'fd1'))?.factor).toBe(-2);
  // A whole-tone set about A4 (D♯ G A C♯): named by its notes, in no key.
  await expect(lands).toHaveText('Lands on D♯ G A C♯');
  await expect(crossing).toHaveText(/^All 4 lines meet at A4, /);
  await expect(axis(page, 'lift')).not.toContainText('major');
});

test('Next offers the closed loop on a voicing that allows it', async ({ page }) => {
  await open(page);
  const card = page.getByTestId('suggestions').locator('button[data-kind="loop"]');
  await expect(card).toHaveAttribute('data-label', 'Down a third (loop 1/4)');
  await card.click();
  await expect(page.getByTestId('suggestions').locator('button[data-kind="loop"]')).toHaveAttribute(
    'data-label',
    'Down a third (loop 2/4)',
  );
});
