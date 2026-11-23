/**
 * M10b-4 row inspectors (PLAN.md §6.4): the chord block inspector (Notes: n, Arrive, Relative),
 * a legacy unison rewritten by its first edit in one undo entry, typed chords filling a run of
 * chord blocks, and the texture inspector (Arpeggio → Wander → Hold). Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  at: number;
  count?: number;
  factor?: number;
  until?: number;
  mode?: string;
  notes?: { kind: string; symbol?: string };
  glide?: Record<string, unknown>;
}

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { undoLabel: string; selection: string[] } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

const H = (page: Page) => ({
  moments: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments),
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
});

/** C major at 60 bpm: an opening C chord on four lines, then `more`. */
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
const chip = (page: Page, group: string, name: string) =>
  insp(page).getByTestId(group).getByRole('button', { name, exact: true });

test('a chord block: Notes: 1, Arrive Float, Relative "Upside down"', async ({ page }) => {
  await open(page, [
    {
      id: 'c2',
      type: 'chord',
      at: 8,
      notes: { kind: 'chord', symbol: 'IV' },
      voicing: 'even',
      assign: 'ordered',
    },
  ]);
  await H(page).select(['c2']);
  await expect(insp(page).getByRole('heading')).toContainText('Chord');
  await expect(chip(page, 'insp-notes-mode', 'Chord')).toHaveAttribute('aria-pressed', 'true');

  // Notes: 1.
  const count = insp(page).getByTestId('insp-chord-count-slider');
  await count.focus();
  await count.press('Home');
  await expect.poll(async () => (await H(page).moment('c2'))?.count).toBe(1);
  // Blank again: as many as sound now.
  await insp(page).getByTestId('insp-chord-count-clear').click();
  await expect.poll(async () => (await H(page).moment('c2'))?.count).toBeUndefined();

  // Arrive: Land by default (no Transition shown), Float, Custom shows the sliders.
  await expect(chip(page, 'insp-arrive-mode', 'Land')).toHaveAttribute('aria-pressed', 'false');
  await chip(page, 'insp-arrive-mode', 'Float').click();
  await expect.poll(async () => (await H(page).moment('c2'))?.glide?.stagger).toBe(1);
  await expect(chip(page, 'insp-arrive-mode', 'Float')).toHaveAttribute('aria-pressed', 'true');
  await expect(insp(page).getByTestId('insp-transition')).toHaveCount(0);
  await chip(page, 'insp-arrive-mode', 'Custom').click();
  await expect(insp(page).getByTestId('insp-transition')).toBeVisible();
  await chip(page, 'insp-arrive-mode', 'Land').click();
  await expect.poll(async () => (await H(page).moment('c2'))?.glide?.land).toBe(true);
  await expect(insp(page).getByTestId('insp-transition')).toHaveCount(0);

  // Relative → Upside down: a spread with factor −1, same id.
  await chip(page, 'insp-notes-mode', 'Relative').click();
  await expect.poll(async () => (await H(page).moment('c2'))?.type).toBe('shift');
  await chip(page, 'insp-relative', 'Upside down').click();
  await expect
    .poll(async () => {
      const m = await H(page).moment('c2');
      return [m?.type, m?.factor];
    })
    .toEqual(['spread', -1]);
  await expect(chip(page, 'insp-relative', 'Upside down')).toHaveAttribute('aria-pressed', 'true');
  // Back to a chord.
  await chip(page, 'insp-notes-mode', 'Chord').click();
  await expect.poll(async () => (await H(page).moment('c2'))?.type).toBe('chord');
});

test('editing a legacy unison rewrites it as a chord, in one undo entry', async ({ page }) => {
  await open(page, [{ id: 'u1', type: 'unison', at: 8, pitch: 'center', octaves: false }]);
  await H(page).select(['u1']);
  await expect(insp(page).getByRole('heading')).toContainText('Chord');
  // Selecting it changes nothing.
  expect((await H(page).moment('u1'))?.type).toBe('unison');
  expect(await H(page).undoLabel()).toBe('');

  await chip(page, 'insp-arrive-mode', 'Float').click();
  await expect.poll(async () => (await H(page).moment('u1'))?.type).toBe('chord');
  const m = (await H(page).moment('u1'))!;
  expect(m.count).toBe(1);
  expect(m.glide?.stagger).toBe(1);
  expect(await H(page).undoLabel()).toBe('Arrive: Float');
  await H(page).undo();
  await expect.poll(async () => (await H(page).moment('u1'))?.type).toBe('unison');
  expect(await H(page).undoLabel()).toBe('');
});

test('typing "IV 2, V 2" in a chord block makes two chord blocks', async ({ page }) => {
  await open(page, [
    {
      id: 'c2',
      type: 'chord',
      at: 8,
      notes: { kind: 'chord', symbol: 'vi' },
      voicing: 'even',
      assign: 'ordered',
    },
  ]);
  await H(page).select(['c2']);
  const typed = insp(page).getByTestId('insp-block-chords');
  await typed.fill('IV 2, V 2');
  await typed.press('Enter');
  await expect.poll(async () => await H(page).undoLabel()).toBe('Type chords');
  const chords = (await H(page).moments()).filter((m) => m.type === 'chord' && m.id !== 'open');
  expect(chords.map((m) => [m.at, m.notes?.symbol])).toEqual([
    [8, 'IV'],
    [10, 'V'],
  ]);
  expect(chords[0].id).toBe('c2');
  expect((await H(page).moments()).some((m) => m.type === 'progression')).toBe(false);
  await expect(typed).toHaveValue('');
  // One undo entry.
  await H(page).undo();
  const back = (await H(page).moments()).filter((m) => m.type === 'chord' && m.id !== 'open');
  expect(back.map((m) => m.notes?.symbol)).toEqual(['vi']);
});

test('a texture: Arpeggio → Wander → Hold', async ({ page }) => {
  await open(page);
  // T at the playhead (0:00 is taken by the opening chord; move to 4 s first).
  await seek(page, 4);
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('t');
  const added = (await H(page).moments()).find((m) => m.type === 'pulse')!;
  expect(added.mode).toBe('updown');
  await expect(insp(page).getByRole('heading')).toContainText('Texture');
  await expect(chip(page, 'insp-texture', 'Arpeggio')).toHaveAttribute('aria-pressed', 'true');
  // The detailed fields sit under More.
  await expect(insp(page).getByTestId('insp-pulse-pattern')).toBeHidden();
  await insp(page).getByTestId('insp-texture-more').locator('summary').click();
  await expect(insp(page).getByTestId('insp-pulse-pattern')).toBeVisible();

  await chip(page, 'insp-texture', 'Wander').click();
  await expect
    .poll(async () => {
      const m = await H(page).moment(added.id);
      return [m?.type, m?.at, m?.until];
    })
    .toEqual(['walk', added.at, added.until]);
  await expect(chip(page, 'insp-texture', 'Wander')).toHaveAttribute('aria-pressed', 'true');

  await chip(page, 'insp-texture', 'Hold').click();
  await expect.poll(async () => await H(page).moment(added.id)).toBeNull();
  expect(await H(page).undoLabel()).toBe('Texture: Hold');
});
