/**
 * Recording a live take (PLAN.md §9 "Recording", §15 M7; M7-c): enter live through the drawer,
 * arm at the playhead, play by musical typing and the test hook, stop. The take is ordinary
 * moments at the presses' applied times with the glide settings, replacing the piece from the
 * playhead; one undo restores what it replaced; after leaving live mode Play plays it, and the
 * compiled pitches equal what live played. Escape, Space and closing the drawer stop and keep a
 * take.
 */

import { expect, test, type Page } from '@playwright/test';
import { openEditor, type LiveHook } from './live-hook';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

interface Stamp {
  liveTime: number;
}
interface Change {
  seq: number;
  press: number;
  held: number[];
  stamp: Stamp | null;
}
interface MomentShape {
  id: string;
  type: string;
  at: number;
  pitch?: number | string;
  notes?: { kind: string; pitches: number[] };
  byVoice?: boolean;
  voicing?: string;
  glide?: { length: number; stagger: number; order: string; jitter: number; ease: string };
}
type Hook = Omit<LiveHook, 'live' | 'editor' | 'engine'> & {
  engine(): { currentTime(): number } | null;
  actions: { seek(t: number): void };
  editor: {
    state: { getState(): { undoLabel: string } };
    undo(): boolean;
    redo(): boolean;
  };
  analyser(): AnalyserNode | null;
  pitchesAt(t: number): Record<string, number | null>;
  live: {
    engine(): {
      active: boolean;
      changes: Change[];
      now(): number;
      settings: Record<string, unknown>;
      noteOn(p: number): unknown;
      noteOff(p: number): unknown;
      allNotesOff(): void;
      snapshot(t: number): { voices: { id: string; pitch: number; level: number }[] };
    };
    record: {
      state: { getState(): { status: string; at: number; liveAt: number } };
    };
  };
};
type W = { __algorhythms: Hook };

const recordStatus = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__algorhythms.live.record.state.getState().status);
const pieceJson = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify((window as unknown as W).__algorhythms.store.getState().piece),
  );
const moments = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as W).__algorhythms.store.getState().piece
        .moments as unknown as MomentShape[],
  );
const undoLabel = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__algorhythms.editor.state.getState().undoLabel);

async function openLive(page: Page): Promise<void> {
  await page.getByTestId('live-toggle').click();
  await expect(page.getByTestId('live-drawer')).toHaveAttribute('data-running', 'true');
}

async function arm(page: Page): Promise<void> {
  await page.getByTestId('live-record').click();
  await expect.poll(() => recordStatus(page)).toBe('recording');
  await expect(page.getByTestId('live-record')).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Taps the playback output, waits until the heard playhead passes `t` (a new playback context can
 * take seconds to start running in headless Firefox, the playhead held meanwhile), then the RMS.
 */
async function rmsOnceHeard(page: Page, t: number): Promise<number> {
  await page.evaluate(() => (window as unknown as W).__algorhythms.analyser());
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as W).__algorhythms.engine()?.currentTime() ?? 0),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(t);
  return page.evaluate(() => {
    const an = (window as unknown as W).__algorhythms.analyser();
    if (!an) return 0;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const x of buf) s += x * x;
    return Math.sqrt(s / buf.length);
  });
}

/** Distinct pitches of the sounding live voices at live time t. */
const livePitches = (page: Page, ts: number[]) =>
  page.evaluate(
    (times) =>
      times.map((t) => {
        const s = (window as unknown as W).__algorhythms.live.engine().snapshot(t);
        const ps = s.voices.filter((v) => v.level > 1e-3).map((v) => v.pitch);
        return [...new Set(ps.map((p) => Math.round(p * 1e4) / 1e4))].sort((a, b) => a - b);
      }),
    ts,
  );

/** Distinct compiled pitches at piece time t. */
const compiledPitches = (page: Page, ts: number[]) =>
  page.evaluate(
    (times) =>
      times.map((t) => {
        const ps = Object.values((window as unknown as W).__algorhythms.pitchesAt(t)).filter(
          (p): p is number => p !== null,
        );
        return [...new Set(ps.map((p) => Math.round(p * 1e4) / 1e4))].sort((a, b) => a - b);
      }),
    ts,
  );

test('record a take: moments, one undo, playback matches live', async ({ page }) => {
  test.setTimeout(90_000);
  await openEditor(page);
  const T0 = 30; // 8 lines sound here (the live pool)
  await page.evaluate((t) => (window as unknown as W).__algorhythms.actions.seek(t), T0);
  const original = await pieceJson(page);
  const before = (await moments(page)).filter((m) => m.at < T0).length;

  await openLive(page);
  // Glide settings the take carries.
  await page.getByTestId('live-stagger').fill('0.1');
  await page.getByTestId('live-order').selectOption('low-first');
  const settings = await page.evaluate(
    () => (window as unknown as W).__algorhythms.live.engine().settings,
  );
  await arm(page);
  const { at, liveAt } = await page.evaluate(() =>
    (window as unknown as W).__algorhythms.live.record.state.getState(),
  );
  expect(at).toBeCloseTo(T0, 6);
  const elapsed = page.getByTestId('live-record').getByTestId('live-record-time');
  await expect(elapsed).toHaveText(/^0:0\d\.\d$/);
  await expect(page.getByTestId('live-record-drawer')).toContainText('Recording');

  // Musical typing: A (C4) from silence, then G (G4) alone.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyG');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyG');
  // The hook: a three-note chord in one task (one press, within 15 ms).
  await page.evaluate(() => {
    const e = (window as unknown as W).__algorhythms.live.engine();
    e.noteOn(60);
    e.noteOn(64);
    e.noteOn(67);
  });
  await page.waitForTimeout(900);
  // All at once: H = ∅ holds.
  await page.evaluate(() => (window as unknown as W).__algorhythms.live.engine().allNotesOff());
  await page.waitForTimeout(150);
  const headMoved = await page.evaluate(() =>
    (window as unknown as W).__algorhythms.live.engine().now(),
  );
  expect(headMoved - liveAt).toBeGreaterThan(2);
  await expect(elapsed).not.toHaveText(/^0:0[01]\./);
  await expect(page.getByTestId('time')).not.toHaveText('0:30.0');

  // Live pitches at settled times (each press's stamp + 0.6 s: after glide + stagger).
  const changes = await page.evaluate(
    () => (window as unknown as W).__algorhythms.live.engine().changes,
  );
  const presses = changes.filter((c) => c.seq === c.press && c.held.length > 0);
  expect(presses.length).toBe(3);
  const pressAt = presses.map((c) => c.stamp!.liveTime);
  const chordFinal = changes.filter((c) => c.press === presses[2].seq).at(-1)!;
  expect(chordFinal.held).toEqual([60, 64, 67]);
  const sampleLive = pressAt.flatMap((t) => [t + 0.6, t + 0.65]);
  const live = await livePitches(page, sampleLive);
  expect(live[0]).toEqual([60]);
  expect(live[2]).toEqual([67]);
  expect(live[4]).toEqual([60, 64, 67]);

  await page.getByTestId('live-record').click();
  await expect.poll(() => recordStatus(page)).toBe('off');
  await expect(page.getByTestId('live-record')).toHaveAttribute('aria-pressed', 'false');
  expect(await undoLabel(page)).toBe('Record take');

  // The moments: the piece before T0, a merge at T0 (Tidewater sounds there), then the take.
  const all = await moments(page);
  expect(all.filter((m) => m.at < T0).length).toBe(before);
  const take = all.filter((m) => m.at >= T0);
  expect(take.map((m) => m.type)).toEqual(['merge', 'chord', 'unison', 'chord']);
  const [, establish, unison, chord] = take;
  const pieceTime = (t: number) => T0 + (t - liveAt);
  expect(establish.byVoice).toBe(true);
  expect(establish.at).toBeGreaterThanOrEqual(T0);
  // At the press's applied time, or once the cut lines have faded (takeBase silentFrom).
  // Times are canonical (1 ms, core/canonical.ts): within half a millisecond.
  expect(establish.at).toBeGreaterThanOrEqual(pieceTime(pressAt[0]) - 5e-4);
  expect(establish.at).toBeLessThanOrEqual(Math.max(pieceTime(pressAt[0]), T0 + 0.07) + 5e-4);
  expect(unison.pitch).toBe(67);
  expect(Math.abs(unison.at - pieceTime(pressAt[1]))).toBeLessThanOrEqual(5e-4);
  expect(chord.notes).toEqual({ kind: 'pitches', pitches: [60, 64, 67] });
  expect(chord.voicing).toBe('even');
  expect(Math.abs(chord.at - pieceTime(pressAt[2]))).toBeLessThanOrEqual(5e-4);
  for (const m of [unison, chord]) {
    expect(m.glide).toMatchObject({
      length: settings.glide as number,
      stagger: 0.1,
      order: 'low-first',
      jitter: 0,
      ease: settings.ease as string,
    });
  }

  // Compiled = live (within 1 cent) at the sampled times.
  const compiled = await compiledPitches(page, sampleLive.map(pieceTime));
  expect(compiled.length).toBe(live.length);
  compiled.forEach((ps, k) => {
    expect(ps.length).toBe(live[k].length);
    ps.forEach((p, j) => expect(Math.abs(p - live[k][j])).toBeLessThan(0.01));
  });

  // One undo removes the whole take and restores what it replaced; redo brings it back.
  await page.evaluate(() => (window as unknown as W).__algorhythms.editor.undo());
  expect(await pieceJson(page)).toBe(original);
  await page.evaluate(() => (window as unknown as W).__algorhythms.editor.redo());
  expect((await moments(page)).filter((m) => m.at >= T0).length).toBe(4);

  // Leave live mode; Play from T0 plays the take.
  await page.getByLabel('Close live drawer').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__algorhythms.live.engine().active))
    .toBe(false);
  await page.evaluate((t) => (window as unknown as W).__algorhythms.actions.seek(t), T0);
  await page.getByTestId('play').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as W).__algorhythms.store.getState().transport;
        return `${s.status}/${s.audio}`;
      }),
    )
    .toBe('playing/ready');
  const rms = await rmsOnceHeard(page, establish.at + 0.5);
  expect(rms).toBeGreaterThan(1e-4);
});

test('Escape, Space and closing the drawer stop and keep the take', async ({ page }) => {
  test.setTimeout(90_000);
  await openEditor(page);
  await page.evaluate(() => (window as unknown as W).__algorhythms.actions.seek(3));
  await openLive(page);

  // Escape stops (live stays on); a second Escape is the drawer's again.
  await arm(page);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyD');
  await page.keyboard.press('Escape');
  await expect.poll(() => recordStatus(page)).toBe('off');
  expect(await undoLabel(page)).toBe('Record take');
  await expect(page.getByTestId('live-drawer')).toBeVisible();
  const establishes = (ms: MomentShape[], p: number) =>
    ms.some((m) => m.type === 'chord' && m.byVoice && m.notes!.pitches.every((x) => x === p));
  expect(establishes(await moments(page), 64)).toBe(true);

  // Space stops too (it does not play while live).
  await arm(page);
  await page.keyboard.down('KeyF');
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyF');
  await page.keyboard.press('Space');
  await expect.poll(() => recordStatus(page)).toBe('off');
  // The second take starts where the first stopped (the playhead), from silence again.
  const second = await moments(page);
  expect(establishes(second, 64)).toBe(true);
  expect(establishes(second, 65)).toBe(true);
  await expect(page.getByTestId('live-drawer')).toBeVisible();

  // A take with no notes changes nothing.
  const json = await pieceJson(page);
  await arm(page);
  await page.waitForTimeout(200);
  await page.getByTestId('live-record').click();
  await expect.poll(() => recordStatus(page)).toBe('off');
  expect(await pieceJson(page)).toBe(json);

  // Closing the drawer while recording keeps the take (and its release is not recorded).
  await arm(page);
  await page.keyboard.down('KeyJ');
  await page.waitForTimeout(300);
  await page.getByLabel('Close live drawer').click();
  await page.keyboard.up('KeyJ');
  await expect.poll(() => recordStatus(page)).toBe('off');
  await expect(page.getByTestId('live-drawer')).toHaveCount(0);
  expect(await pieceJson(page)).not.toBe(json);
  expect(await undoLabel(page)).toBe('Record take');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__algorhythms.live.engine().active))
    .toBe(false);
});

test('a chord lifted key by key 20 ms apart holds the chord; on 1 voice filled to 4; plays back', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openEditor(page);
  const T0 = 6; // one line has sounded by here: live fills to 4 voices from the pool
  await page.evaluate((t) => (window as unknown as W).__algorhythms.actions.seek(t), T0);
  await openLive(page);
  const settings = await page.evaluate(
    () => (window as unknown as W).__algorhythms.live.engine().settings,
  );
  expect(settings.release).toBe('hold');
  await arm(page);
  const { liveAt } = await page.evaluate(() =>
    (window as unknown as W).__algorhythms.live.record.state.getState(),
  );
  // A note from silence, then C E G (one press) and its keys lifted 20 ms apart (spun, so the
  // gaps are exact: 40 ms in all, inside the 60 ms grace).
  await page.evaluate(() => (window as unknown as W).__algorhythms.live.engine().noteOn(57));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const e = (window as unknown as W).__algorhythms.live.engine();
    e.noteOff(57);
    e.noteOn(60);
    e.noteOn(64);
    e.noteOn(67);
  });
  await page.waitForTimeout(700);
  const released = await page.evaluate(() => {
    const e = (window as unknown as W).__algorhythms.live.engine();
    const spin = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    e.noteOff(67);
    spin(20);
    e.noteOff(60);
    spin(20);
    e.noteOff(64);
    return e.now();
  });
  await page.waitForTimeout(500);
  const changes = await page.evaluate(
    () => (window as unknown as W).__algorhythms.live.engine().changes,
  );
  // No re-target to the keys still down: nothing with keys held is posted after C E G.
  const chordAt = changes.findIndex((c) => c.held.length === 3);
  expect(chordAt).toBeGreaterThan(0);
  expect(changes.slice(chordAt + 1).filter((c) => c.held.length > 0)).toEqual([]);
  const times = [released + 0.1, released + 0.4];
  const live = await livePitches(page, times);
  expect(live).toEqual([
    [60, 64, 67],
    [60, 64, 67],
  ]);

  await page.getByTestId('live-record').click();
  await expect.poll(() => recordStatus(page)).toBe('off');
  const take = (await moments(page)).filter((m) => m.at >= T0);
  expect(take.map((m) => m.type)).toEqual(['merge', 'chord', 'chord']);
  expect(take[2].notes).toEqual({ kind: 'pitches', pitches: [60, 64, 67] });
  // The establishing chord plays on all four live voices, written into the piece.
  const establish = take[1] as MomentShape & { target?: { voices: string[] } };
  expect(establish.target?.voices).toHaveLength(4);
  const compiled = await compiledPitches(
    page,
    times.map((t) => T0 + (t - liveAt)),
  );
  compiled.forEach((ps, k) => {
    expect(ps.length).toBe(live[k].length);
    ps.forEach((p, j) => expect(Math.abs(p - live[k][j])).toBeLessThan(0.01));
  });

  // Leave live mode; Play from T0 plays the take.
  await page.getByLabel('Close live drawer').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__algorhythms.live.engine().active))
    .toBe(false);
  await page.evaluate((t) => (window as unknown as W).__algorhythms.actions.seek(t), T0);
  await page.getByTestId('play').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as W).__algorhythms.store.getState().transport;
        return `${s.status}/${s.audio}`;
      }),
    )
    .toBe('playing/ready');
  const rms = await rmsOnceHeard(page, establish.at + 0.5);
  expect(rms).toBeGreaterThan(1e-4);
});
