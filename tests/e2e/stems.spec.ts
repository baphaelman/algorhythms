/**
 * Stems export in real browsers (PLAN.md §12): the worker renders every file of the zip, the files
 * sum to the mix, cancel stops a running export, and (Chromium) a 5-minute, 24-voice export
 * streamed to a file handle stays within the memory budget. Runs on the hidden fixture page.
 *
 * Memory evidence (Chromium): resident set size of every browser process (renderer, GPU, utility,
 * browser), sampled with `ps` every 250 ms during the export, minus the idle total before it. The
 * stems worker runs inside the page's renderer process, so this includes its ArrayBuffers (which
 * `performance.memory` does not), the zip chunks in flight, and the browser-side file writes.
 * `performance.measureUserAgentSpecificMemory()` is recorded too when the page can be made
 * cross-origin isolated (it counts dedicated workers).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { chromium, expect, test, type Page } from '@playwright/test';
import { parseWavHeader } from '../../src/audio/wav';
import type {
  StemsHook,
  StemsRunOptions,
  StemsRunResult,
} from '../../src/audio/fixtures/stems-hook';

async function openFixtures(page: Page, isolate = false): Promise<void> {
  if (isolate) {
    await page.route('**/*', async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: {
          ...res.headers(),
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        },
      });
    });
  }
  await page.goto('./fixtures.html');
  await page.waitForFunction(
    () => (window as unknown as { __fixtures?: unknown }).__fixtures !== undefined,
  );
}

function run(page: Page, o: StemsRunOptions): Promise<StemsRunResult> {
  return page.evaluate(
    (opts) =>
      (window as unknown as { __fixtures: { stems: StemsHook } }).__fixtures.stems.run(opts),
    o,
  );
}

function floats(wav: Uint8Array): { left: Float32Array; right: Float32Array } {
  const info = parseWavHeader(wav);
  const v = new DataView(wav.buffer, wav.byteOffset + info.dataOffset, info.dataBytes);
  const left = new Float32Array(info.frames);
  const right = new Float32Array(info.frames);
  for (let i = 0; i < info.frames; i++) {
    left[i] = v.getFloat32(i * 8, true);
    right[i] = v.getFloat32(i * 8 + 4, true);
  }
  return { left, right };
}

test('stems zip from the worker: entries, headers, and the exact sum', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixtures(page);
  const r = await run(page, {
    fixture: 'stress',
    seconds: 3,
    hot: true,
    target: 'blob',
    returnZip: true,
  });
  expect(r.ok, r.error).toBe(true);
  expect(r.zip64).toBe(false);
  expect(r.plan?.bytes).toBe(r.bytes);
  expect(r.progress.length).toBeGreaterThan(5);
  expect(r.progress.at(-1)).toBeCloseTo(1, 5);
  for (let i = 1; i < r.progress.length; i++)
    expect(r.progress[i]).toBeGreaterThanOrEqual(r.progress[i - 1]);

  const zip = new Uint8Array(Buffer.from(r.zipBase64!, 'base64'));
  expect(zip.length).toBe(r.bytes);
  const files = unzipSync(zip);
  expect(Object.keys(files)).toEqual(r.entries);
  expect(r.entries![0]).toBe('mix.wav');
  expect(r.entries!.at(-1)).toBe('fx-returns.wav');
  for (const wav of Object.values(files)) {
    expect(parseWavHeader(wav)).toMatchObject({
      formatTag: 3,
      channels: 2,
      sampleRate: 48000,
      bitDepth: 32,
    });
  }

  const mix = floats(files['mix.wav']);
  const sum = [new Float64Array(mix.left.length), new Float64Array(mix.left.length)];
  for (const [name, wav] of Object.entries(files)) {
    if (name === 'mix.wav') continue;
    const s = floats(wav);
    for (let i = 0; i < mix.left.length; i++) {
      sum[0][i] += s.left[i];
      sum[1][i] += s.right[i];
    }
  }
  let worst = 0;
  for (let i = 0; i < mix.left.length; i++) {
    worst = Math.max(worst, Math.abs(sum[0][i] - mix.left[i]), Math.abs(sum[1][i] - mix.right[i]));
  }
  const residual = 20 * Math.log10(Math.max(worst, 1e-12));
  console.info(`browser stems residual: ${residual.toFixed(1)} dBFS`);
  expect(residual).toBeLessThanOrEqual(-90);
});

test('cancelling mid-export rejects with AbortError and stops the worker', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixtures(page);
  const r = await run(page, { fixture: 'dense-24', seconds: 20, target: 'null', cancelAt: 0.2 });
  expect(r.ok).toBe(false);
  expect(r.error).toBe('AbortError');
  expect(r.progress.at(-1)).toBeLessThan(0.5);
  // the page still works afterwards: a second, small export completes
  const again = await run(page, { fixture: 'a4-sine', target: 'null' });
  expect(again.ok, again.error).toBe(true);
});

/** Resident memory (MB) of the browser's main process and all its descendants. */
function treeRssMb(userDataDir: string): number {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
  const root = rows.find((r) => r.cmd.includes(`--user-data-dir=${userDataDir}`));
  if (!root) throw new Error('browser process not found');
  const family = new Set([root.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (!family.has(r.pid) && family.has(r.ppid)) {
        family.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => family.has(r.pid)).reduce((n, r) => n + r.rss, 0) / 1024;
}

test(
  '5 min × 24 voices streamed to a file handle stays under the memory budget',
  {
    tag: '@perf',
  },
  async ({ browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'File System Access is Chromium-only');
    test.skip(!testInfo.project.name.endsWith('prod'), 'measured once, on the production build');
    test.setTimeout(15 * 60_000);
    // A persistent profile (a real on-disk origin), because an incognito context's OPFS quota is
    // too small for a 2 GB file.
    const userDataDir = mkdtempSync(join(tmpdir(), 'stems-mem-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      baseURL: testInfo.project.use.baseURL,
    });
    try {
      const page = await context.newPage();
      await openFixtures(page, true);
      const isolated = await page.evaluate(() => self.crossOriginIsolated);
      await page.waitForTimeout(1500);
      const idle = treeRssMb(userDataDir);

      let peak = idle;
      let peakUam = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          peak = Math.max(peak, treeRssMb(userDataDir));
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      const uamSampler = (async () => {
        while (sampling && isolated) {
          const b = await page.evaluate(() =>
            (window as unknown as { __fixtures: { stems: StemsHook } }).__fixtures.stems.memory(),
          );
          if (!b) break;
          peakUam = Math.max(peakUam, b);
        }
      })();

      const r = await run(page, {
        fixture: 'dense-24',
        seconds: 300,
        bitDepth: 24,
        target: 'opfs',
      });
      sampling = false;
      await Promise.all([sampler, uamSampler]);

      expect(r.ok, r.error).toBe(true);
      const delta = peak - idle;
      console.info(
        [
          `stems memory: ${r.plan!.entries.length} files, zip ${(r.bytes! / 1e9).toFixed(2)} GB, ${(r.ms / 1000).toFixed(0)} s`,
          `idle total RSS ${idle.toFixed(0)} MB, peak ${peak.toFixed(0)} MB, delta ${delta.toFixed(0)} MB`,
          `measureUserAgentSpecificMemory: ${peakUam > 0 ? `peak ${(peakUam / 1e6).toFixed(0)} MB` : 'unavailable in this browser build'}`,
        ].join('\n'),
      );
      expect(r.fileBytes).toBe(r.bytes);
      expect(r.cdEntries).toBe(r.plan!.entries.length);
      expect(r.firstEntryIsMixWav).toBe(true);
      expect(r.bytes!).toBeGreaterThan(1.5e9);
      expect(delta).toBeLessThan(500);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
);
