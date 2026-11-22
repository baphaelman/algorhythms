/**
 * M7a live engine path in a real browser (PLAN.md §9, §15 M7): enter live mode (an 'interactive'
 * context), play notes through the test hook, check that sound starts and the key-to-glide-start
 * latency, then leave (the context closes; playback returns on a 'playback' context).
 *
 * Latency, per note (all in the page):
 * - `at`: performance.now() when `noteOn` is called; `contextTime`: ctx.currentTime then;
 * - `frame`: the context frame of the block the worklet applied the note at (its glide starts on
 *   that block), reported back by the worklet;
 * - engine latency = frame / sampleRate − contextTime: how far past the context's render position
 *   at the call the glide starts (message passing plus the wait for the next block);
 * - heard = getOutputTimestamp's performanceTime + (frame / sampleRate − its contextTime): when the
 *   glide's first frame leaves the device, on the performance clock; total = heard − at;
 * - device = outputLatency + baseLatency (what the platform adds after the render position).
 * Gate (§15 M7: key-to-glide start ≤ 10 ms + device output latency), on every note:
 * total − device ≤ 10 ms, and engine ≤ 10 ms + baseLatency. The context renders a callback of
 * baseLatency at a time and ctx.currentTime is where the next one starts: a message posted while
 * one is being rendered waits for the next (engine = baseLatency), else engine is 0.
 */

import { expect, test, type Page } from '@playwright/test';

interface LiveHookShape {
  live: {
    enter(): Promise<void>;
    exit(): Promise<void>;
    engine(): {
      active: boolean;
      context: AudioContext | null;
      held: number[];
      noteOn(p: number): {
        at: number;
        contextTime: number;
        applied: Promise<{ frame: number } | null>;
      };
      noteOff(p: number): { applied: Promise<unknown> };
      allNotesOff(): void;
    };
    analyser(): AnalyserNode | null;
  };
  engine(): { context: BaseAudioContext } | null;
  store: { getState(): { transport: { status: string; audio: string } } };
}

const hook = 'window.__algorhythms';

async function openApp(page: Page): Promise<void> {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.waitForFunction(`${hook} !== undefined`);
}

/** RMS of the live output over ~50 ms. */
const liveRms = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const h = (window as unknown as { __algorhythms: LiveHookShape }).__algorhythms;
    const an = h.live.analyser();
    if (!an) return 0;
    await new Promise((r) => setTimeout(r, 50));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const x of buf) s += x * x;
    return Math.sqrt(s / buf.length);
  });

test('live mode: enter, notes sound with key-to-glide start ≤ 10 ms + device latency, exit', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openApp(page);
  // A click first, so the page has a user activation (autoplay policy).
  await page.getByTestId('play').click();
  await page.evaluate(async () => {
    const h = (window as unknown as { __algorhythms: LiveHookShape }).__algorhythms;
    await h.live.enter();
  });
  const info = await page.evaluate(() => {
    const h = (window as unknown as { __algorhythms: LiveHookShape }).__algorhythms;
    const live = h.live.engine();
    const ctx = live.context!;
    return {
      active: live.active,
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency,
      outputLatency: ctx.outputLatency,
      playback: h.engine() !== null,
      status: h.store.getState().transport.status,
    };
  });
  expect(info.active).toBe(true);
  expect(info.state).toBe('running');
  expect(info.playback).toBe(false); // the playback context was closed
  expect(info.status).not.toBe('playing');
  // Silent until the first key.
  expect(await liveRms(page)).toBeLessThan(1e-4);

  const notes = [60, 64, 67, 72, 55, 62, 69, 57, 65, 60, 71, 52];
  const results: {
    engineMs: number;
    totalMs: number;
    deviceMs: number;
  }[] = [];
  for (const [i, p] of notes.entries()) {
    const r = await page.evaluate(
      async ({ p, prev }) => {
        const h = (window as unknown as { __algorhythms: LiveHookShape }).__algorhythms;
        const live = h.live.engine();
        const ctx = live.context!;
        // Wait a random fraction of a render quantum, so calls land anywhere in a block.
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        if (prev !== null) live.noteOff(prev);
        const ev = live.noteOn(p);
        const stamp = await ev.applied;
        if (!stamp) return null;
        const ts = ctx.getOutputTimestamp();
        const start = stamp.frame / ctx.sampleRate;
        const heard =
          ts.performanceTime !== undefined && ts.contextTime !== undefined
            ? ts.performanceTime + (start - ts.contextTime) * 1000
            : NaN;
        return {
          engineMs: (start - ev.contextTime) * 1000,
          totalMs: heard - ev.at,
          deviceMs: ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000,
        };
      },
      { p, prev: i > 0 ? notes[i - 1] : null },
    );
    expect(r).not.toBeNull();
    results.push(r!);
    await page.waitForTimeout(120);
  }
  // Sound: the last note is held (release 'hold').
  const rms = await liveRms(page);
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const med = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)];
  const engine = results.map((r) => r.engineMs);
  const total = results.map((r) => r.totalMs);
  const beyond = results.map((r) => r.totalMs - r.deviceMs);
  console.info(
    `live latency (${results.length} notes, ${info.sampleRate} Hz, baseLatency ${(info.baseLatency * 1000).toFixed(1)} ms, ` +
      `outputLatency ${(info.outputLatency * 1000).toFixed(1)} ms): engine median ${med(engine).toFixed(1)} / max ${Math.max(...engine).toFixed(1)} ms; ` +
      `key → heard median ${med(total).toFixed(1)} / max ${Math.max(...total).toFixed(1)} ms; ` +
      `beyond device latency median ${med(beyond).toFixed(1)} / max ${Math.max(...beyond).toFixed(1)} ms; rms ${rms.toFixed(4)}`,
  );
  expect(rms).toBeGreaterThan(0.005);
  for (const r of results) {
    expect(r.engineMs).toBeGreaterThanOrEqual(0); // never before the call
    // At most one device callback (baseLatency) late: the message missed the callback in progress.
    expect(r.engineMs).toBeLessThanOrEqual(10 + info.baseLatency * 1000);
    expect(r.totalMs - r.deviceMs).toBeLessThanOrEqual(10);
  }

  // Release and leave: the live context closes, playback gets a new 'playback' engine.
  await page.evaluate(async () => {
    const h = (window as unknown as { __algorhythms: LiveHookShape }).__algorhythms;
    const live = h.live.engine();
    live.allNotesOff();
    const ctx = live.context!;
    await h.live.exit();
    (window as unknown as { __liveCtx: AudioContext }).__liveCtx = ctx;
  });
  await page.waitForFunction(
    `${hook}.engine() !== null && ${hook}.store.getState().transport.audio === 'ready'`,
  );
  const after = await page.evaluate(() => {
    const h = (window as unknown as { __algorhythms: LiveHookShape }).__algorhythms;
    return {
      liveState: (window as unknown as { __liveCtx: AudioContext }).__liveCtx.state,
      active: h.live.engine().active,
    };
  });
  expect(after.active).toBe(false);
  expect(after.liveState).toBe('closed');
});
