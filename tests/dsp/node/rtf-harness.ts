/**
 * Child process for the RTF gate (tests/dsp/rtf.test.ts, PLAN.md §8.9). The test bundles this file
 * with Vite as the app's build does (minified: module constants inlined), so the gate measures the
 * DSP as it ships, not as Vitest's module runner transforms it (every imported binding becomes a
 * getter call there, which made the same code ~1.5× slower; docs/build-log.md, "Perf gates").
 *
 * argv[2]: 'plain' (24 gliding M2-preset voices) or 'm6' (a third each bell, FM reed and breath).
 * Prints one JSON line: the best and every run's RTF by CPU time and by wall clock.
 */

import { createLoadedGraph } from '../../../src/audio/offline';
import {
  ALL_EASES,
  denseScore,
  FIXTURE_MIX,
  M6_WORKLOAD_TIMBRES,
  withPulses,
} from '../../../src/audio/fixtures/scores';
import { BLOCK_FRAMES } from '../../../src/dsp/constants';

const RATE = 48000;
const M6_TIMBRES = ['bell', 'fmreed', 'breath'];
const m6 = process.argv[2] === 'm6';
const RUNS = 5;
const SECONDS = 6;

function measure(seconds: number): { cpu: number; wall: number } {
  const graph = createLoadedGraph({
    score: withPulses(denseScore(24, 40, 5, ALL_EASES, m6 ? M6_TIMBRES : undefined)),
    mix: FIXTURE_MIX,
    timbres: m6 ? M6_WORKLOAD_TIMBRES : undefined,
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

const runs = Array.from({ length: RUNS }, () => measure(SECONDS));
process.stdout.write(
  `${JSON.stringify({
    cpu: Math.max(...runs.map((x) => x.cpu)),
    wall: Math.max(...runs.map((x) => x.wall)),
    runs: runs.map((x) => Math.round(x.cpu * 100) / 100),
  })}\n`,
);
