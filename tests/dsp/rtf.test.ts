/**
 * Real-time factor (PLAN.md §8.9): 24 voices plus FX at 48 kHz must render at ≥ 10× real time in
 * Node, i.e. use ≤ 10 % of one core. The workload glides every voice continuously, through every
 * ease and all six presets. The M6 workload gives every voice an M6 path: a third each bell
 * (additive + FM + noise), FM on a wavetable and breath noise.
 *
 * What is measured is the DSP as it ships: `tests/dsp/node/rtf-harness.ts`, bundled and minified
 * by Vite as the app's build bundles the worklet, run in a child Node process. In this (Vitest)
 * process every imported binding is a getter call, which made the same code ~1.5× slower
 * (docs/build-log.md, "Perf gates"). The gate uses the child's CPU time (`process.cpuUsage`),
 * because other test files run in parallel and wall-clock time would include waiting for a core,
 * and it takes the best of five 6 s runs, because a contended process may be parked on a slower
 * core for a while. Wall-clock RTF is reported too.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HARNESS = path.join(ROOT, 'tests/dsp/node/rtf-harness.ts');
let outDir = '';

beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), 'algorhythms-rtf-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    root: ROOT,
    build: {
      outDir,
      emptyOutDir: true,
      // As Vite bundles a worker (the worklet): minified, top-level `const` kept (an app or lib
      // build would turn it into `var`, so the minifier could not inline the DSP's constants).
      minify: true,
      target: 'es2022',
      modulePreload: false,
      rolldownOptions: {
        input: HARNESS,
        output: { format: 'es', entryFileNames: 'rtf.mjs', topLevelVar: false },
      },
    },
  });
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function measure(mode: 'plain' | 'm6'): { cpu: number; wall: number; runs: number[] } {
  const res = spawnSync(process.execPath, [path.join(outDir, 'rtf.mjs'), mode], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (res.status !== 0) throw new Error(`RTF harness failed: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as { cpu: number; wall: number; runs: number[] };
}

describe('real-time factor', () => {
  it('renders 24 voices + FX at 48 kHz at ≥ 10× real time', () => {
    const { cpu, wall, runs } = measure('plain');
    console.info(
      `RTF, 24 voices + reverb + delay + tone + limiter at 48 kHz: ${cpu.toFixed(1)}× (CPU time), ` +
        `${wall.toFixed(1)}× (wall clock); runs ${runs.join(' ')}`,
    );
    expect(cpu).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('renders 24 M6 voices (bell, FM, noise) + FX at 48 kHz at ≥ 10× real time', () => {
    const { cpu, wall, runs } = measure('m6');
    console.info(
      `RTF, 24 M6 voices (bell / FM / noise) + FX at 48 kHz: ${cpu.toFixed(1)}× (CPU time), ` +
        `${wall.toFixed(1)}× (wall clock); runs ${runs.join(' ')}`,
    );
    expect(cpu).toBeGreaterThanOrEqual(10);
  }, 120_000);
});
