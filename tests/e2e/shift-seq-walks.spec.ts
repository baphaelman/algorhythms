/**
 * M13 (PLAN.md "Composer's toolkit"): the Moved block's typed shift sequence (steps, lengths, the
 * live summary, one lane block per step, the score moving at each step, undo) and the walk
 * options "Glide to next tick" and "Step past neighbours" in the texture inspector. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  by?: number;
  seq?: { by: number; len: number }[];
  glideToTick?: boolean;
  stepPast?: number;
  stepGlide?: number;
}

interface Seg {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
  momentId?: string;
}

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { undoLabel: string } };
  };
  store: {
    getState(): {
      piece: { moments: M[] };
      compiled: { voices: { segments: Seg[] }[] };
    };
  };
}

const H = (page: Page) => ({
  moment: (id: string) =>
    page.evaluate(
      (i) =>
        (window.__algorhythms as unknown as Hook).store
          .getState()
          .piece.moments.find((m) => m.id === i) ?? null,
      id,
    ),
  select: (ids: string[]) =>
    page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  undoLabel: () =>
    page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
  /** The moving segments of moment `id`: [t0, t1] of each. */
  moves: (id: string) =>
    page.evaluate(
      (i) =>
        (window.__algorhythms as unknown as Hook).store
          .getState()
          .compiled.voices.flatMap((v) => v.segments)
          .filter((g) => g.momentId === i && g.p0 !== g.p1)
          .map((g) => [g.t0, g.t1]),
      id,
    ),
});

/** C major at 60 bpm in 4: an opening C chord on four lines, then `more`. */
async function open(page: Page, more: object[] = []): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((more) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      key: unknown;
      voices: { part?: string }[];
      view: Record<string, unknown>;
    };
    p.key = { tonic: 'C', scale: 'major' };
    for (const v of p.voices) delete v.part;
    p.moments = [
      {
        id: 'open',
        type: 'chord',
        at: 0,
        notes: { kind: 'chord', symbol: 'I' },
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

const insp = (page: Page) => page.getByTestId('inspector');

test('shift sequence: typed steps play one by one, draw a block each, and undo', async ({
  page,
}) => {
  await open(page, [{ id: 'sh', type: 'shift', at: 4, by: 2, unit: 'scaleSteps' }]);
  await H(page).select(['sh']);
  const field = insp(page).getByTestId('insp-shift-seq');
  await expect(field).toHaveValue('');
  await expect(insp(page).getByTestId('insp-shift-by')).toBeVisible();
  const before = await H(page).moves('sh');

  // The live summary counts the steps and says where the sequence ends (lengths in beats).
  await field.fill('−2 −1 −1 +1:2 +1:2 +1:2 +1');
  await expect(insp(page).getByTestId('insp-shift-seq-feedback')).toHaveText(
    /^7 steps, net 0 steps, ends at /,
  );
  await field.press('Enter');
  await field.blur();
  await expect.poll(async () => (await H(page).moment('sh'))?.seq?.length).toBe(7);
  const m = (await H(page).moment('sh'))!;
  expect(m.by).toBe(-2);
  // A missing length is the block's spacing (a bar plus its glide, in whole beats).
  const spacing = m.seq![0].len;
  expect(spacing).toBeGreaterThanOrEqual(4);
  expect(m.seq!.map((s) => s.len)).toEqual([spacing, spacing, spacing, 2, 2, 2, spacing]);
  expect(await H(page).undoLabel()).toBe('Edit shift sequence');
  // The shown text puts lengths only where they differ from the spacing; By hides.
  await expect(field).toHaveValue('−2 −1 −1 +1:2 +1:2 +1:2 +1');
  await expect(insp(page).getByTestId('insp-shift-by')).toHaveCount(0);

  // The score moves at every step's start.
  const starts: number[] = [];
  let t = 4;
  for (const s of m.seq!) {
    starts.push(t);
    t += s.len;
  }
  await expect.poll(async () => (await H(page).moves('sh')).length).toBeGreaterThan(before.length);
  const moves = await H(page).moves('sh');
  for (const s of starts) expect(moves.some(([t0]) => t0 >= s - 1e-6 && t0 < s + 1)).toBe(true);

  // The lane draws one block per step, labelled by its amount.
  const bar = page.locator('.lane-item[data-moment="sh"]');
  await expect(bar.getByTestId('lane-prog-chord')).toHaveText([
    '−2 steps',
    '−1 steps',
    '−1 steps',
    '+1 steps',
    '+1 steps',
    '+1 steps',
    '+1 steps',
  ]);

  // A bad step names itself and commits nothing.
  await field.fill('−2 x');
  await field.press('Enter');
  await expect(insp(page).getByTestId('insp-shift-seq-feedback')).toHaveText(
    /^Step 2: “x” is not an amount/,
  );
  await field.press('Escape');
  expect((await H(page).moment('sh'))?.seq?.length).toBe(7);

  await H(page).undo();
  await expect.poll(async () => (await H(page).moment('sh'))?.seq).toBeUndefined();
  expect((await H(page).moment('sh'))?.by).toBe(2);
  await expect(insp(page).getByTestId('insp-shift-by')).toBeVisible();
});

async function openMore(page: Page): Promise<void> {
  const more = insp(page).getByTestId('insp-texture-more');
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
}

const WALK = {
  id: 'wk',
  type: 'walk',
  at: 2,
  until: 30,
  grid: 1,
  density: 0.7,
  steps: [-2, -1, 1, 2],
  stepGlide: 0.2,
};

test('walk: Glide to next tick glides whole ticks; Step past neighbours sets the spacing', async ({
  page,
}) => {
  await open(page, [WALK]);
  await H(page).select(['wk']);
  await openMore(page);
  const tick = insp(page).getByTestId('insp-walk-glide-tick');
  await expect(tick).not.toBeChecked();
  await expect(insp(page).getByTestId('insp-walk-step-glide')).toBeVisible();
  const short = await H(page).moves('wk');
  expect(short.length).toBeGreaterThan(5);
  for (const [t0, t1] of short) expect(t1 - t0).toBeCloseTo(0.2, 6);

  await tick.check();
  await expect.poll(async () => (await H(page).moment('wk'))?.glideToTick).toBe(true);
  expect(await H(page).undoLabel()).toBe('Glide to next tick');
  await expect(insp(page).getByTestId('insp-walk-step-glide')).toHaveCount(0);
  await expect
    .poll(async () => (await H(page).moves('wk')).every(([t0, t1]) => Math.abs(t1 - t0 - 1) < 1e-6))
    .toBe(true);

  const past = insp(page).getByTestId('insp-walk-step-past-on');
  await expect(past).not.toBeChecked();
  await expect(insp(page).getByTestId('insp-walk-step-past')).toHaveCount(0);
  await past.check();
  await expect.poll(async () => (await H(page).moment('wk'))?.stepPast).toBe(1);
  const spacing = insp(page).getByTestId('insp-walk-step-past');
  await spacing.fill('2');
  await spacing.press('Enter');
  await expect.poll(async () => (await H(page).moment('wk'))?.stepPast).toBe(2);
  expect(await H(page).undoLabel()).toBe('Edit step past spacing');

  await H(page).undo();
  await H(page).undo();
  await expect.poll(async () => (await H(page).moment('wk'))?.stepPast).toBeUndefined();
  await H(page).undo();
  await expect.poll(async () => (await H(page).moment('wk'))?.glideToTick).toBeUndefined();
  await expect(insp(page).getByTestId('insp-walk-step-glide')).toBeVisible();
});
