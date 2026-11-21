/**
 * M3 acceptance: 60 fps at 1080p with 24 voices (PLAN.md §15). Chromium only. The player runs the
 * real page at 1920x1080 with a generated 24-voice piece playing, and the animation loop records
 * each frame's interval and the time its work took (window.__algorhythms.frameStats).
 */

import { expect, test } from '@playwright/test';
import { seek } from './app-hook';
import { generate } from '../../src/core/generate';
import { serializePiece } from '../../src/core/schema';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
};
const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? NaN;
};

test('1080p, 24 voices, playing: median frame interval is 60 fps', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'frame timing is asserted on Chromium only');
  test.setTimeout(90_000);
  const piece = generate(7, { mode: 'dorian', voices: 24 });
  expect(piece.voices).toHaveLength(24);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles({
    name: 'dense.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializePiece(piece)),
  });
  await expect(page.getByTestId('keyvoices')).toContainText('/ 24 notes');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await seek(page, 60); // into the Drift/Gather sections: many voices
  await page.waitForFunction(
    () => document.querySelector('[data-testid=time]')?.textContent !== '00:00.0',
  );
  await page.waitForTimeout(1500); // warm up the JIT and the audio

  const stats = await page.evaluate(async () => {
    const fs = window.__algorhythms!.frameStats;
    const follow = window.__algorhythms!.store.getState().view.follow;
    fs.reset();
    fs.enabled = true;
    const start0 = fs.start;
    await new Promise((r) => setTimeout(r, 8000));
    fs.enabled = false;
    return {
      work: fs.work,
      interval: fs.interval,
      drawn: fs.drawn,
      follow,
      start0,
      start1: fs.start,
    };
  });
  const status = await page.evaluate(
    () => document.querySelector('[data-testid=keyvoices]')?.textContent,
  );

  const result = {
    frames: stats.interval.length,
    drawn: stats.drawn,
    intervalMedianMs: Number(median(stats.interval).toFixed(3)),
    intervalP95Ms: Number(percentile(stats.interval, 0.95).toFixed(3)),
    intervalMaxMs: Number(Math.max(...stats.interval).toFixed(3)),
    workMedianMs: Number(median(stats.work).toFixed(3)),
    workP95Ms: Number(percentile(stats.work, 0.95).toFixed(3)),
    voicesAtEnd: status,
    follow: stats.follow,
    viewStartMovedS: Number((stats.start1 - stats.start0).toFixed(3)),
  };
  console.log(
    `[${info.project.name}] frame times @1920x1080, 24 voices: ${JSON.stringify(result)}`,
  );
  info.annotations.push({ type: 'frame-times', description: JSON.stringify(result) });

  // Measured while following: Smooth is on and the view scrolls with the playhead (~8 s).
  expect(stats.follow, 'follow mode').toBe('smooth');
  expect(stats.start1 - stats.start0, 'view start advanced (s)').toBeGreaterThan(5);
  expect(stats.interval.length, 'a frame per vsync for 8 s').toBeGreaterThan(300);
  expect(stats.drawn, 'the canvas is redrawn every frame while playing').toBeGreaterThan(300);
  // Chromium reports frame timestamps in 0.1 ms steps; 16.7 is one vsync at 60 Hz.
  expect(median(stats.interval), 'median frame interval (ms)').toBeLessThanOrEqual(16.7 + 1e-6);
  expect(median(stats.work), 'median per-frame work (ms), budget §10').toBeLessThanOrEqual(4);
});
