/**
 * M7 leftovers (PLAN.md §9; docs/build-log.md "M7 leftovers"): Play while live leaves live mode
 * and plays from the playhead in one click (Space does not); Notes-drawer edits while live reach
 * the live voices in place (held notes sound on), a pool change re-enters live mode; opening
 * another piece re-enters live mode on it with the drawer and typing kept.
 */

import { expect, test, type Page } from '@playwright/test';
import { openEditor } from './live-hook';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

interface VoiceLite {
  id: string;
  timbre: string;
  gain: number;
  mute?: boolean;
}
type Hook = {
  store: {
    getState(): {
      piece: { voices: VoiceLite[]; meta: { title: string } } & Record<string, unknown>;
      transport: { status: string; audio: string };
    };
  };
  actions: { seek(t: number): void; loadPiece(p: unknown): void };
  editor: { undo(): boolean; redo(): boolean };
  analyser(): AnalyserNode | null;
  live: {
    engine(): {
      active: boolean;
      held: number[];
      engine: { node: AudioWorkletNode & { __mark?: number } } | null;
      context: (AudioContext & { __mark?: number }) | null;
      liveVoices: { id: string; timbre: string; mute: boolean }[];
    };
    analyser(): AnalyserNode | null;
    ui: { getState(): { open: boolean; running: boolean; typing: boolean } };
    inputs: { down(source: string, p: number): void; held: number[] };
    record: { state: { getState(): { status: string } } };
  };
};
type W = { __algorhythms: Hook };

const engineState = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as W).__algorhythms;
    const e = h.live.engine();
    const ui = h.live.ui.getState();
    return {
      active: e.active,
      held: e.held,
      open: ui.open,
      typing: ui.typing,
      running: ui.running,
      sameEngine: e.engine?.node.__mark === 1,
      sameContext: e.context?.__mark === 1,
    };
  });

/** Marks the current live engine and context (a re-enter replaces the engine, not the context). */
const mark = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as W).__algorhythms.live.engine();
    if (e.engine) e.engine.node.__mark = 1;
    if (e.context) e.context.__mark = 1;
  });

const liveTimbres = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as W).__algorhythms.live.engine().liveVoices.map((v) => v.timbre),
  );

/** RMS of the live output now (an analyser on the live engine's node). */
const liveRms = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as W).__algorhythms.live.analyser();
    if (!a) return 0;
    const x = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(x);
    let s = 0;
    for (const v of x) s += v * v;
    return Math.sqrt(s / x.length);
  });

async function openLive(page: Page): Promise<void> {
  await page.getByTestId('live-toggle').click();
  await expect(page.getByTestId('live-drawer')).toHaveAttribute('data-running', 'true');
}

async function holdChord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as unknown as W).__algorhythms;
    for (const p of [60, 64, 67]) h.live.inputs.down('midi', p);
  });
  await expect.poll(async () => (await engineState(page)).held).toEqual([60, 64, 67]);
}

test('Play while live leaves live mode and plays from the playhead; Space does not', async ({
  page,
}) => {
  await openEditor(page);
  await page.evaluate(() => (window as unknown as W).__algorhythms.actions.seek(12));
  await openLive(page);

  // Space: nothing (a performer's hands are on the keys).
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  expect(await engineState(page)).toMatchObject({ active: true, open: true, typing: true });

  // One click on Play: the drawer closes, typing goes off, playback runs from 12 s.
  await page.getByTestId('play').click();
  await expect(page.getByTestId('live-drawer')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as W).__algorhythms.store.getState().transport;
        return `${s.status}/${s.audio}`;
      }),
    )
    .toBe('playing/ready');
  expect(await engineState(page)).toMatchObject({ active: false, open: false, typing: false });
  const now = await page.evaluate(() =>
    (window as unknown as { __algorhythms: { engine(): { currentTime(): number } } }).__algorhythms
      .engine()
      .currentTime(),
  );
  expect(now).toBeGreaterThanOrEqual(12);
  expect(now).toBeLessThan(16);
  await page.getByTestId('play').click();
});

test('Notes-drawer edits while live: in place with held notes; a pool change re-enters', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openEditor(page);
  await page.evaluate(() => (window as unknown as W).__algorhythms.actions.seek(30));
  await openLive(page);
  await page.getByTestId('voices-toggle').click();
  await expect(page.getByTestId('voices-drawer')).toBeVisible();
  await mark(page);
  await holdChord(page);
  await expect.poll(() => liveRms(page)).toBeGreaterThan(1e-3);
  const before = await liveTimbres(page);
  const voices = await page.evaluate(
    () => (window as unknown as W).__algorhythms.store.getState().piece.voices,
  );
  const first = await page.evaluate(
    () => (window as unknown as W).__algorhythms.live.engine().liveVoices[0].id,
  );
  const other = voices.find((v) => v.id === first)!.timbre === 'organ' ? 'reed' : 'organ';

  // One voice's timbre, then All notes, then a mute: same engine, held notes still sounding.
  await page.getByTestId(`timbre-${first}`).selectOption(other);
  await expect.poll(async () => (await liveTimbres(page))[0]).toBe(other);
  expect(await engineState(page)).toMatchObject({
    sameEngine: true,
    held: [60, 64, 67],
    active: true,
  });
  await page.getByTestId('timbre-all').selectOption('glass');
  await expect.poll(() => liveTimbres(page)).toEqual(before.map(() => 'glass'));
  await page.getByTestId(`mute-${first}`).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__algorhythms.live.engine().liveVoices[0].mute),
    )
    .toBe(true);
  expect(await engineState(page)).toMatchObject({ sameEngine: true, held: [60, 64, 67] });
  expect(await liveRms(page)).toBeGreaterThan(1e-3);

  // Undo and redo take the same path.
  for (let k = 0; k < 2; k++) {
    await page.evaluate(() => (window as unknown as W).__algorhythms.editor.undo());
  }
  await expect.poll(async () => (await liveTimbres(page))[0]).toBe(other);
  await page.evaluate(() => (window as unknown as W).__algorhythms.editor.undo());
  await expect.poll(() => liveTimbres(page)).toEqual(before);
  await page.evaluate(() => (window as unknown as W).__algorhythms.editor.redo());
  await expect.poll(async () => (await liveTimbres(page))[0]).toBe(other);
  expect(await engineState(page)).toMatchObject({ sameEngine: true, held: [60, 64, 67] });

  // Pool size: live mode re-enters on the same context; held notes released; drawer and typing
  // stay.
  const pool = page.getByTestId('pool-size');
  await pool.fill(String(voices.length + 2));
  await pool.press('Enter');
  await expect.poll(async () => (await engineState(page)).sameEngine).toBe(false);
  await expect
    .poll(() => engineState(page))
    .toMatchObject({
      active: true,
      sameContext: true,
      held: [],
      open: true,
      typing: true,
      running: true,
    });
  // It plays on the new engine.
  await holdChord(page);
  await expect.poll(() => liveRms(page)).toBeGreaterThan(1e-3);
});

test('edits while recording: timbre in place; a pool change stops and keeps the take', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openEditor(page);
  await page.evaluate(() => (window as unknown as W).__algorhythms.actions.seek(30));
  await openLive(page);
  await page.getByTestId('voices-toggle').click();
  const status = () =>
    page.evaluate(() => (window as unknown as W).__algorhythms.live.record.state.getState().status);
  await page.getByTestId('live-record').click();
  await expect.poll(status).toBe('recording');
  await mark(page);
  await holdChord(page);
  await page.waitForTimeout(300);
  const id = await page.evaluate(
    () => (window as unknown as W).__algorhythms.live.engine().liveVoices[0].id,
  );
  await page.getByTestId(`timbre-${id}`).selectOption('reed');
  await expect.poll(async () => (await liveTimbres(page))[0]).toBe('reed');
  expect(await status()).toBe('recording');
  expect(await engineState(page)).toMatchObject({ sameEngine: true, held: [60, 64, 67] });

  const n = await page.evaluate(
    () => (window as unknown as W).__algorhythms.store.getState().piece.voices.length,
  );
  const pool = page.getByTestId('pool-size');
  await pool.fill(String(n + 1));
  await pool.press('Enter');
  await expect.poll(status).toBe('off');
  await expect
    .poll(() => engineState(page))
    .toMatchObject({ sameEngine: false, active: true, open: true, held: [] });
  const piece = await page.evaluate(() => {
    const p = (window as unknown as W).__algorhythms.store.getState().piece as unknown as {
      voices: unknown[];
      moments: { type: string; at: number }[];
    };
    return { voices: p.voices.length, chords: p.moments.filter((m) => m.at >= 30).length };
  });
  expect(piece.voices).toBeGreaterThanOrEqual(n + 1); // the pool change is kept
  expect(piece.chords).toBeGreaterThan(0); // and the take, written after it
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __algorhythms: { editor: { state: { getState(): { undoLabel: string } } } };
          }
        ).__algorhythms.editor.state.getState().undoLabel,
    ),
  ).toBe('Record take');
});

test('opening another piece while live re-enters on it; drawer and typing stay', async ({
  page,
}) => {
  await openEditor(page);
  await openLive(page);
  await mark(page);
  await holdChord(page);
  await page.evaluate(() => {
    const h = (window as unknown as W).__algorhythms;
    const p = h.store.getState().piece;
    h.actions.loadPiece({
      ...p,
      meta: { ...p.meta, title: 'Another' },
      voices: p.voices.slice(0, 3).map((v) => ({ ...v, timbre: 'pluck' })),
      moments: [],
    });
  });
  await expect.poll(async () => (await engineState(page)).sameEngine).toBe(false);
  await expect
    .poll(() => engineState(page))
    .toMatchObject({ active: true, open: true, typing: true, running: true, held: [] });
  const live = await page.evaluate(() =>
    (window as unknown as W).__algorhythms.live.engine().liveVoices.map((v) => v.timbre),
  );
  expect(live.length).toBeGreaterThanOrEqual(3);
  expect(new Set(live)).toEqual(new Set(['pluck']));
  await expect(page.getByTestId('live-drawer')).toBeVisible();
  // Typing plays on the new piece's voices.
  await page.keyboard.down('KeyA');
  await expect.poll(async () => (await engineState(page)).held).toEqual([60]);
  await page.keyboard.up('KeyA');
});
