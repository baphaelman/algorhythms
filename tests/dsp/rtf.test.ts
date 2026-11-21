/**
 * Real-time factor (PLAN.md §8.9): 24 voices plus FX at 48 kHz must render at ≥ 10× real time in
 * Node, i.e. use ≤ 10 % of one core. The workload glides every voice continuously, through every
 * ease and all six presets.
 *
 * The gate uses this process's CPU time (`process.cpuUsage`), because Vitest runs test files in
 * parallel processes and wall-clock time would include waiting for a core, and it takes the best of
 * five 6 s runs, because a contended process may be parked on a slower (efficiency) core for a
 * while. Wall-clock RTF is reported too.
 */

import { describe, expect, it } from 'vitest';
import { createLoadedGraph } from '../../src/audio/offline';
import { ALL_EASES, denseScore, FIXTURE_MIX, withPulses } from '../../src/audio/fixtures/scores';
import { BLOCK_FRAMES } from '../../src/dsp/constants';

const RATE = 48000;

function measure(seconds: number): { cpu: number; wall: number } {
  const graph = createLoadedGraph({
    score: withPulses(denseScore(24, 40, 5, ALL_EASES)),
    mix: FIXTURE_MIX,
    sampleRate: RATE,
  });
  const l = new Float32Array(BLOCK_FRAMES);
  const r = new Float32Array(BLOCK_FRAMES);
  graph.play(0);
  const warm = Math.round((3 * RATE) / BLOCK_FRAMES);
  for (let i = 0; i < warm; i++) graph.process(l, r);
  const blocks = Math.round((seconds * RATE) / BLOCK_FRAMES);
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i < blocks; i++) graph.process(l, r);
  const wallMs = performance.now() - t0;
  const c = process.cpuUsage(c0);
  const cpuMs = (c.user + c.system) / 1000;
  return { cpu: (seconds * 1000) / cpuMs, wall: (seconds * 1000) / wallMs };
}

describe('real-time factor', () => {
  it('renders 24 voices + FX at 48 kHz at ≥ 10× real time', () => {
    const runs = Array.from({ length: 5 }, () => measure(6));
    const cpu = Math.max(...runs.map((r) => r.cpu));
    const wall = Math.max(...runs.map((r) => r.wall));
    console.info(
      `RTF, 24 voices + reverb + delay + tone + limiter at 48 kHz: ${cpu.toFixed(1)}× (CPU time), ` +
        `${wall.toFixed(1)}× (wall clock)`,
    );
    expect(cpu).toBeGreaterThanOrEqual(10);
  }, 60_000);
});
