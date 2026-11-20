/**
 * M2 sound engine in real browsers (PLAN.md §14, §15): the engine worklet loads in dev and prod,
 * renders fixtures offline and live, and the export worker writes WAV files the browser decodes.
 * Runs on the hidden fixture page (fixtures.html). Audio is analysed in Node.
 */

import { expect, test, type Page } from '@playwright/test';

interface Hook {
  workletUrl: string;
  processorName: string;
  names: string[];
  renderOffline(
    name: string,
    seconds: number,
    sampleRate?: number,
  ): Promise<{ left: number[]; right: number[]; sampleRate: number }>;
  exportCheck(
    name: string,
    bitDepth: 16 | 24 | 32,
    sampleRate: 44100 | 48000,
  ): Promise<{
    bytes: number;
    header: {
      formatTag: number;
      channels: number;
      sampleRate: number;
      bitDepth: number;
      frames: number;
    };
    decodedSeconds: number;
    decodedChannels: number;
    decodedPeak: number;
    progress: number[];
  }>;
  analyser: AnalyserNode | null;
}

const CEILING = Math.pow(10, -1 / 20);

function analyse(samples: number[], sampleRate: number, from = 0, to = samples.length) {
  let sumSq = 0;
  let peak = 0;
  let finite = true;
  const crossings: number[] = [];
  for (let i = from; i < to; i++) {
    const s = samples[i];
    if (!Number.isFinite(s)) finite = false;
    sumSq += s * s;
    peak = Math.max(peak, Math.abs(s));
    if (i > from) {
      const a = samples[i - 1];
      if (a < 0 && s >= 0) crossings.push(i - 1 + -a / (s - a));
    }
  }
  const span = crossings.length > 1 ? crossings[crossings.length - 1] - crossings[0] : 0;
  return {
    finite,
    peak,
    rms: Math.sqrt(sumSq / Math.max(1, to - from)),
    frequency: span > 0 ? ((crossings.length - 1) * sampleRate) / span : 0,
  };
}

async function openFixtures(
  page: Page,
): Promise<Pick<Hook, 'workletUrl' | 'processorName' | 'names'>> {
  await page.goto('./fixtures.html');
  await expect(page.getByRole('heading', { name: 'AlgoRhythms sound fixtures' })).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __fixtures?: unknown }).__fixtures !== undefined,
  );
  return page.evaluate(() => {
    const h = (window as unknown as { __fixtures: Hook }).__fixtures;
    return { workletUrl: h.workletUrl, processorName: h.processorName, names: h.names };
  });
}

test('engine worklet URL comes from the expected pipeline', async ({ page }) => {
  const { workletUrl } = await openFixtures(page);
  if (test.info().project.name.endsWith('-dev')) {
    expect(workletUrl).toMatch(/^\/src\/audio\/worklet\/engine\.worklet\.ts\?worker_file/);
  } else {
    expect(workletUrl).toMatch(/^\/[\w-]+\/assets\/engine\.worklet-[\w-]+\.js$/);
  }
  const response = await page.request.get(new URL(workletUrl, page.url()).href);
  expect(response.ok()).toBe(true);
});

test('the engine worklet renders A4 offline at 440 Hz under the ceiling', async ({ page }) => {
  await openFixtures(page);
  const r = await page.evaluate(() =>
    (window as unknown as { __fixtures: Hook }).__fixtures.renderOffline('a4-sine', 2),
  );
  const a = analyse(r.left, r.sampleRate, Math.floor(0.5 * r.sampleRate));
  expect(a.finite).toBe(true);
  expect(a.rms, 'audible').toBeGreaterThan(0.05);
  expect(a.peak).toBeLessThanOrEqual(CEILING);
  // The always-on detune moves A4 by 1.5–4 cents: under ±1.1 Hz.
  expect(Math.abs(a.frequency - 440), `frequency ${a.frequency.toFixed(2)} Hz`).toBeLessThan(1.5);
});

test('the engine worklet renders a preset fixture with FX', async ({ page }) => {
  await openFixtures(page);
  const r = await page.evaluate(() =>
    (window as unknown as { __fixtures: Hook }).__fixtures.renderOffline('preset-choir', 4),
  );
  for (const ch of [r.left, r.right]) {
    const a = analyse(ch, r.sampleRate);
    expect(a.finite).toBe(true);
    expect(a.rms).toBeGreaterThan(0.01);
    expect(a.peak).toBeLessThanOrEqual(CEILING);
  }
});

test('Play sounds a live A4 through the engine worklet', async ({ page }) => {
  await openFixtures(page);
  await page.getByLabel('Fixture').selectOption('a4-sine');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('#state')).toHaveText('playing', { timeout: 10_000 });
  const captured = await page.evaluate(async () => {
    const hook = (window as unknown as { __fixtures: Hook }).__fixtures;
    const deadline = performance.now() + 6000;
    let buf = new Float32Array(0);
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const an = hook.analyser;
      if (!an) continue;
      buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      if (Math.sqrt(s / buf.length) > 0.05) break;
    }
    const an = hook.analyser;
    return an
      ? { samples: Array.from(buf), sampleRate: an.context.sampleRate, state: an.context.state }
      : null;
  });
  expect(captured, 'analyser exposed while playing').not.toBeNull();
  expect(captured!.state).toBe('running');
  const a = analyse(captured!.samples, captured!.sampleRate);
  expect(a.rms, 'non-silent').toBeGreaterThan(0.05);
  expect(Math.abs(a.frequency - 440), `frequency ${a.frequency.toFixed(2)} Hz`).toBeLessThan(3);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#state')).toHaveText('stopped');
});

for (const [bitDepth, sampleRate] of [
  [16, 48000],
  [24, 44100],
  [32, 48000],
] as const) {
  test(`exports a valid ${bitDepth}-bit ${sampleRate / 1000} kHz WAV that the browser decodes`, async ({
    page,
  }) => {
    await openFixtures(page);
    const r = await page.evaluate(
      ([b, s]) =>
        (window as unknown as { __fixtures: Hook }).__fixtures.exportCheck('preset-pluck', b, s),
      [bitDepth, sampleRate] as const,
    );
    expect(r.header.formatTag).toBe(bitDepth === 32 ? 3 : 1);
    expect(r.header.bitDepth).toBe(bitDepth);
    expect(r.header.sampleRate).toBe(sampleRate);
    expect(r.header.channels).toBe(2);
    expect(r.decodedChannels).toBe(2);
    expect(r.decodedSeconds).toBeCloseTo(r.header.frames / sampleRate, 2);
    expect(r.decodedSeconds).toBeGreaterThan(13); // 13 s piece + FX tail
    expect(r.decodedPeak).toBeGreaterThan(0.05);
    expect(r.decodedPeak).toBeLessThanOrEqual(CEILING + 2 / 32768); // dither may add an LSB
    expect(r.progress[r.progress.length - 1]).toBe(1);
  });
}
