/**
 * M7a live engine path in a real browser (PLAN.md §9, §15 M7): enter live mode (an 'interactive'
 * context), play notes through the test hook, check that sound starts and the key-to-glide-start
 * latency, then leave (the context closes; playback returns on a 'playback' context).
 *
 * Latency, per note (all in the page):
 * - `at`: performance.now() when `noteOn` is called; `contextTime`: ctx.currentTime then;
 * - `frame`: the context frame of the block the worklet applied the note at (its glide starts on
 *   that block), reported back by the worklet with `receivedFrame` (the next block's first frame
 *   when the message arrived) and `callbackFrames`: the device callback period, measured by the
 *   worklet as the median run of blocks it renders back to back (Date.now gaps ≥ 2 ms between
 *   callbacks). Firefox reports baseLatency 0 but renders 6–7 blocks per ~19 ms callback (pulse,
 *   any latencyHint), so the period is measured, not taken from baseLatency;
 * - engine latency = frame / sampleRate − contextTime: how far past the context's render position
 *   at the call the glide starts (message passing plus the wait for the next callback);
 * - heard = getOutputTimestamp's performanceTime + (frame / sampleRate − its contextTime): when the
 *   glide's first frame leaves the device, on the performance clock; total = heard − at;
 * - lag: how far the timestamp's heard position trails the render position (currentTime) at that
 *   instant, i.e. the output latency the timestamp actually includes;
 * - device = min(outputLatency, lag) + callback period.
 * Gate (§15 M7: key-to-glide start ≤ 10 ms + device output latency), on every note:
 * - frame = receivedFrame: the worklet applies a message at the first block after it arrives;
 * - engine ≤ 10 ms + one callback period: a message that misses the callback in progress (it is
 *   rendered in one go, and Firefox delivers port messages only between callbacks) starts with
 *   the next one;
 * - total − device ≤ 10 ms;
 * - main thread: call → post (`postMs`, the key's message handed to the port) ≤ 5 ms.
 * The log lists each note: post, plan (call → decided), applied (call → stamp back), and slip
 * (wall − context time since the call). A note late to the ear with a small engine latency and a
 * matching slip is an audio-render stall (the context clock stopped), not main-thread work.
 * What the heard gate covers per engine (measured 2026-11-22):
 * - Chromium: baseLatency = the callback (512 frames); getOutputTimestamp trails currentTime by
 *   outputLatency + 0…1 callback, so the gate includes the reported device output latency;
 * - Firefox: the timestamp is currentTime − outputLatency at now − outputLatency (lag 0), so it
 *   excludes the output latency and device is the callback alone: the gate proves key → glide
 *   rendered ≤ 10 ms + one callback; the device's own latency is Firefox's outputLatency, unchecked;
 * - WebKit (macOS CI): outputLatency 0 (unreported), callback 128 frames: the same as Firefox.
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
        postMs: number;
        planMs: number;
        applied: Promise<{ frame: number; receivedFrame: number; callbackFrames: number } | null>;
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

// @latency: timing gate, run alone on CI.
test(
  'live mode: enter, notes sound with key-to-glide start ≤ 10 ms + device latency, exit',
  { tag: '@latency' },
  async ({ page }) => {
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
      callbackMs: number;
      lagMs: number;
      frame: number;
      receivedFrame: number;
      postMs: number;
      planMs: number;
      appliedMs: number;
      slipMs: number;
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
          const appliedMs = performance.now() - ev.at;
          const ts = ctx.getOutputTimestamp();
          // Wall time since the call minus context time since: > 0 when the render clock stalled.
          const slipMs = performance.now() - ev.at - (ctx.currentTime - ev.contextTime) * 1000;
          const lagMs =
            (ctx.currentTime - (ts.contextTime ?? NaN)) * 1000 -
            (performance.now() - (ts.performanceTime ?? NaN));
          const start = stamp.frame / ctx.sampleRate;
          const heard =
            ts.performanceTime !== undefined && ts.contextTime !== undefined
              ? ts.performanceTime + (start - ts.contextTime) * 1000
              : NaN;
          const callbackMs = (stamp.callbackFrames / ctx.sampleRate) * 1000;
          const outputMs = Math.max(0, Math.min((ctx.outputLatency || 0) * 1000, lagMs));
          return {
            engineMs: (start - ev.contextTime) * 1000,
            totalMs: heard - ev.at,
            deviceMs: outputMs + callbackMs,
            callbackMs,
            lagMs,
            frame: stamp.frame,
            receivedFrame: stamp.receivedFrame,
            postMs: ev.postMs,
            planMs: ev.planMs,
            appliedMs,
            slipMs,
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
    const callback = results.map((r) => r.callbackMs);
    const lag = results.map((r) => r.lagMs);
    const post = results.map((r) => r.postMs);
    console.info(
      `live latency (${results.length} notes, ${info.sampleRate} Hz, baseLatency ${(info.baseLatency * 1000).toFixed(1)} ms, ` +
        `outputLatency ${(info.outputLatency * 1000).toFixed(1)} ms, callback ${Math.min(...callback).toFixed(1)}–${Math.max(...callback).toFixed(1)} ms, ` +
        `timestamp lag ${Math.min(...lag).toFixed(1)}–${Math.max(...lag).toFixed(1)} ms): engine median ${med(engine).toFixed(1)} / max ${Math.max(...engine).toFixed(1)} ms; ` +
        `key → heard median ${med(total).toFixed(1)} / max ${Math.max(...total).toFixed(1)} ms; ` +
        `beyond device latency median ${med(beyond).toFixed(1)} / max ${Math.max(...beyond).toFixed(1)} ms; ` +
        `call → post median ${med(post).toFixed(2)} / max ${Math.max(...post).toFixed(2)} ms; rms ${rms.toFixed(4)}`,
    );
    // Per note: main-thread call → post and call → decided, call → stamp received, the clock
    // slip (wall − context time since the call: an audio-render stall), engine and beyond device.
    const perNote = results
      .map(
        (r, i) =>
          `#${i} p${notes[i]}: post ${r.postMs.toFixed(2)} plan ${r.planMs.toFixed(2)} applied ${r.appliedMs.toFixed(1)} ` +
          `slip ${r.slipMs.toFixed(1)} engine ${r.engineMs.toFixed(1)} beyond ${(r.totalMs - r.deviceMs).toFixed(1)} ms`,
      )
      .join('\n');
    console.info(perNote);
    expect(rms).toBeGreaterThan(0.005);
    // Main thread: every press posts its message within 5 ms of the call.
    expect(Math.max(...post), `main-thread call → post per note:\n${perNote}`).toBeLessThanOrEqual(5);
    for (const r of results) {
      expect(r.callbackMs).toBeGreaterThan(0); // measured
      expect(r.frame).toBe(r.receivedFrame); // applied at the first block after it arrived
      expect(r.engineMs).toBeGreaterThanOrEqual(0); // never before the call
      // At most one callback late: the message missed the callback in progress. (frame equals
      // receivedFrame, so anything later is the message's delivery to the audio thread.)
      expect(r.engineMs, 'message delivery to the worklet').toBeLessThanOrEqual(10 + r.callbackMs);
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
  },
);
