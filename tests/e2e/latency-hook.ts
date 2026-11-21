import { expect, type Page } from '@playwright/test';
import './app-hook';

/**
 * Edit → swap latency hooks (edit-latency.spec, mouse-only.spec): each `swap` post to the worklet
 * and each click's event time, on the same clock.
 */
export interface LatencyHook {
  __lat: { clicks: number[]; swaps: number[] };
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
};

export const summary = (xs: number[]) => ({
  n: xs.length,
  medianMs: Number(median(xs).toFixed(1)),
  maxMs: Number(Math.max(...xs).toFixed(1)),
});

/** Records each swap post to the worklet, and each click's event time. Needs the engine. */
export async function installLatencyHooks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Window & LatencyHook;
    w.__lat = { clicks: [], swaps: [] };
    const port = (window.__algorhythms!.engine() as unknown as { node: AudioWorkletNode }).node
      .port;
    const post = port.postMessage.bind(port) as (m: unknown, t?: Transferable[]) => void;
    port.postMessage = ((m: { type?: string }, t?: Transferable[]) => {
      if (m?.type === 'swap') w.__lat.swaps.push(performance.now());
      post(m, t);
    }) as typeof port.postMessage;
    document.addEventListener('click', (e) => w.__lat.clicks.push(e.timeStamp), true);
  });
}

export const swapCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as LatencyHook).__lat.swaps.length);

/** Clicks `click()` n times; returns each click → swap latency (ms). */
export async function timeClicks(
  page: Page,
  n: number,
  click: (i: number) => Promise<void>,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = await swapCount(page);
    await click(i);
    await expect.poll(() => swapCount(page)).toBeGreaterThan(before);
    out.push(
      await page.evaluate((k) => {
        const l = (window as unknown as LatencyHook).__lat;
        return l.swaps[k] - l.clicks[l.clicks.length - 1];
      }, before),
    );
    await page.waitForTimeout(200);
  }
  return out;
}
