/**
 * M0 acceptance (PLAN.md §14, §15): the TypeScript AudioWorklet loads and plays a 440 Hz sine in
 * both `vite dev` and the production build (projects `<engine>-dev` / `<engine>-prod`).
 *
 * The audio is analysed in Node: the browser only returns raw samples.
 */

import { expect, test, type Page } from '@playwright/test';

interface DebugHook {
  workletUrl: string;
  processorName: string;
  analyser?: AnalyserNode;
}

interface Analysis {
  rms: number;
  peak: number;
  /** Frequency from linearly interpolated rising zero crossings, in Hz. */
  frequency: number;
}

function analyse(samples: number[], sampleRate: number): Analysis {
  let sumSq = 0;
  let peak = 0;
  const crossings: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
    peak = Math.max(peak, Math.abs(s));
    if (i > 0) {
      const a = samples[i - 1];
      if (a < 0 && s >= 0) crossings.push(i - 1 + -a / (s - a));
    }
  }
  const span = crossings.length > 1 ? crossings[crossings.length - 1] - crossings[0] : 0;
  return {
    rms: Math.sqrt(sumSq / Math.max(1, samples.length)),
    peak,
    frequency: span > 0 ? ((crossings.length - 1) * sampleRate) / span : 0,
  };
}

async function openPage(page: Page): Promise<DebugHook> {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'AlgoRhythms' })).toBeVisible();
  const hook = await page.evaluate(() => {
    const d = (window as unknown as { __algorhythms?: DebugHook }).__algorhythms;
    return d ? { workletUrl: d.workletUrl, processorName: d.processorName } : null;
  });
  expect(hook, 'debug hook installed by src/app/main.tsx').not.toBeNull();
  return hook!;
}

test('page title is AlgoRhythms', async ({ page }) => {
  await openPage(page);
  await expect(page).toHaveTitle('AlgoRhythms');
});

test('worklet URL comes from the expected pipeline for this mode', async ({ page }) => {
  const { workletUrl } = await openPage(page);
  if (test.info().project.name.endsWith('-dev')) {
    // Dev: Vite serves the TypeScript source transformed on the fly, imports unbundled.
    expect(workletUrl).toMatch(/^\/src\/audio\/worklet\/test-tone\.worklet\.ts\?worker_file/);
  } else {
    // Prod: one bundled, hashed ES module under the GitHub Pages base.
    expect(workletUrl).toMatch(/^\/[\w-]+\/assets\/test-tone\.worklet-[\w-]+\.js$/);
  }
  const response = await page.request.get(new URL(workletUrl, page.url()).href);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toMatch(/javascript/);
});

test('worklet module renders a 440 Hz sine in an OfflineAudioContext', async ({ page }) => {
  const hook = await openPage(page);
  const rendered = await page.evaluate(async ({ workletUrl, processorName }) => {
    const sampleRate = 48000;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: sampleRate / 2,
      sampleRate,
    });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, processorName, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frequency: 440, amplitude: 0.25 },
    });
    node.connect(ctx.destination);
    const buffer = await ctx.startRendering();
    return { samples: Array.from(buffer.getChannelData(0)), sampleRate };
  }, hook);

  const a = analyse(rendered.samples, rendered.sampleRate);
  expect(a.rms, 'non-silent').toBeGreaterThan(0.15);
  expect(a.peak, 'amplitude as requested').toBeCloseTo(0.25, 2);
  expect(Math.abs(a.frequency - 440), `frequency ${a.frequency.toFixed(2)} Hz`).toBeLessThan(1);
});

test('Play button sounds a 440 Hz sine through the worklet', async ({ page }) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('status')).toHaveText(/Playing/, { timeout: 10_000 });

  const captured = await page.evaluate(async () => {
    const d = (window as unknown as { __algorhythms?: DebugHook }).__algorhythms;
    const analyser = d?.analyser;
    if (!analyser) return null;
    const buf = new Float32Array(analyser.fftSize);
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      analyser.getFloatTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      if (Math.sqrt(sumSq / buf.length) > 0.1) break;
    }
    return {
      samples: Array.from(buf),
      sampleRate: analyser.context.sampleRate,
      state: analyser.context.state,
    };
  });

  expect(captured, 'analyser exposed while playing').not.toBeNull();
  expect(captured!.state).toBe('running');
  const a = analyse(captured!.samples, captured!.sampleRate);
  expect(a.rms, 'non-silent').toBeGreaterThan(0.1);
  expect(Math.abs(a.frequency - 440), `frequency ${a.frequency.toFixed(2)} Hz`).toBeLessThan(2);

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('status')).toHaveText('Stopped');
});
