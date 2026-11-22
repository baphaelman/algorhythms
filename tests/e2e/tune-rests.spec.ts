/**
 * PLAN rev 10 tunes in the editor: a typed rest (a "rest" row with ▲/▼ disabled, no dot, a gap in
 * the lane bar, the line silent), Follow key (on: a key change moves the tune; the list and dots
 * show sounding pitches), with undo. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface Note {
  pitch?: number;
  rest?: boolean;
  len: number;
}
interface M {
  id: string;
  type: string;
  at: number;
  notes?: Note[];
  writtenIn?: string;
  key?: { tonic: string };
}
interface Seg {
  t0: number;
  t1: number;
  p0: number;
  momentId?: string;
}
interface Hook {
  editor: { select(ids: string[]): void; undo(): boolean };
  store: {
    getState(): {
      piece: { moments: M[] };
      compiled: { voices: { lives: { born: number; died?: number }[]; segments: Seg[] }[] };
    };
  };
}

const H = (page: Page) => ({
  moments: () =>
    page.evaluate(() => (window.__algorhythms as unknown as Hook).store.getState().piece.moments),
  select: (ids: string[]) =>
    page.evaluate((i) => (window.__algorhythms as unknown as Hook).editor.select(i), ids),
  undo: () => page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo()),
  /** The compiled pitch of voice 0 at t (null when silent). */
  pitchAt: (t: number) =>
    page.evaluate((at) => {
      const v = (window.__algorhythms as unknown as Hook).store.getState().compiled.voices[0];
      if (!v.lives.some((l) => at >= l.born && at < (l.died ?? Infinity))) return null;
      const s = v.segments.find((g) => g.t0 <= at && at < g.t1);
      return s ? s.p0 : null;
    }, t),
});

const tuneOf = async (page: Page): Promise<M> =>
  (await H(page).moments()).find((m) => m.id === 'tune1')!;

/** One line on C4 (C major), a key moment at 2, and a tune at 4 (written in C, following). */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      moments: unknown[];
      key: unknown;
      end: unknown;
      defaults: { glide: Record<string, unknown> };
      view: Record<string, unknown>;
    };
    p.defaults.glide = { ...p.defaults.glide, length: 1, stagger: 0, jitter: 0 };
    delete p.defaults.glide.land;
    p.moments = [
      { id: 'start0', type: 'chord', at: 0, notes: { kind: 'pitches', pitches: [48] } },
      { id: 'key1', type: 'key', at: 2, key: { tonic: 'C', scale: 'major' } },
      {
        id: 'tune1',
        type: 'tune',
        at: 4,
        writtenIn: 'C',
        notes: [
          { pitch: 60, len: 1 },
          { pitch: 62, len: 1 },
          { pitch: 64, len: 2 },
        ],
      },
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 16, fade: 1 };
    delete p.view.gridBpm;
    delete p.view.snapBeats;
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
}

const inspector = (page: Page) => page.getByTestId('inspector');
const rows = (page: Page) => inspector(page).getByTestId('tune-note');
const dots = (page: Page) => page.getByTestId('tune-dot');

test('typed rest: a rest row, no dot, a gap in the lane bar, the line silent; undo', async ({
  page,
}) => {
  await open(page);
  await H(page).select(['tune1']);
  const field = page.getByTestId('tune-text');
  await expect(field).toHaveValue('C4 1, D4 1, E4 2');
  await field.fill('C4 1, r 1, E4 2');
  await field.press('Enter');
  expect((await tuneOf(page)).notes).toEqual([
    { pitch: 60, len: 1 },
    { rest: true, len: 1 },
    { pitch: 64, len: 2 },
  ]);
  await expect(field).toHaveValue('C4 1, r 1, E4 2');
  await expect(rows(page)).toHaveCount(3);
  const rest = rows(page).nth(1);
  await expect(rest).toHaveAttribute('data-rest', 'true');
  await expect(rest.getByTestId('tune-note-name')).toHaveText('rest');
  await expect(rest.getByTestId('tune-note-up')).toBeDisabled();
  await expect(rest.getByTestId('tune-note-down')).toBeDisabled();
  await expect(dots(page)).toHaveCount(2);
  const bar = page.getByTestId('lane').locator('[data-moment="tune1"] .lane-art.lane-tune > span');
  await expect(bar).toHaveCount(2);
  expect(await H(page).pitchAt(4.5)).toBe(60);
  expect(await H(page).pitchAt(5.5)).toBeNull();
  expect(await H(page).pitchAt(6.5)).toBe(64);
  // `rest` works too.
  await field.fill('C4 1, rest 0.5, E4 2');
  await field.press('Enter');
  expect((await tuneOf(page)).notes![1]).toEqual({ rest: true, len: 0.5 });
  await H(page).undo();
  expect((await tuneOf(page)).notes![1]).toEqual({ rest: true, len: 1 });
});

test('Follow key: a key change moves the tune; off keeps the sound and stops following', async ({
  page,
}) => {
  await open(page);
  // The key moment goes to D: the tune (written in C) sounds a tone higher, no carry needed.
  await H(page).select(['key1']);
  await inspector(page).getByTestId('insp-tonic').selectOption('D');
  expect((await H(page).moments()).find((m) => m.id === 'key1')!.key!.tonic).toBe('D');
  expect((await tuneOf(page)).notes!.map((n) => n.pitch)).toEqual([60, 62, 64]);
  expect(await H(page).pitchAt(4.5)).toBe(62);
  expect(await H(page).pitchAt(7)).toBe(66);

  // The list, the typed text and the dots show sounding pitches.
  await H(page).select(['tune1']);
  const follow = page.getByTestId('tune-follow-key');
  await expect(follow).toBeChecked();
  await expect(page.getByTestId('tune-text')).toHaveValue('D4 1, E4 1, F#4 2');
  await expect(dots(page).first()).toHaveAttribute('data-pitch', '62');
  // ▲ on the first note: a scale step in D (D4 → E4), written back in C (C4 → D4).
  await rows(page).first().getByTestId('tune-note-up').click();
  expect((await tuneOf(page)).notes![0].pitch).toBe(62);
  expect(await H(page).pitchAt(4.5)).toBe(64);

  // Off: the notes become the sounding ones; a later key change leaves them.
  await follow.uncheck();
  const off = await tuneOf(page);
  expect(off.writtenIn).toBeUndefined();
  expect(off.notes!.map((n) => n.pitch)).toEqual([64, 64, 66]);
  expect(await H(page).pitchAt(4.5)).toBe(64);
  await H(page).undo();
  expect((await tuneOf(page)).writtenIn).toBe('C');
  await expect(follow).toBeChecked();
});
