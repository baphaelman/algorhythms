/**
 * Child process for the no-GC test (PLAN.md §8.11): renders 24 voices plus FX at 48 kHz, warms
 * up, then runs `process()` for 60 s of audio with V8's --trace-gc switched on for exactly that
 * span. Any "Scavenge" (or other GC) line printed during the run is a failure. A PerformanceObserver
 * on 'gc' entries double-checks the count. Prints a JSON summary as its last line.
 *
 * argv[2]: 'plain' (default: the allocation-free eases), 'all' (adds expo and bézier) or 'lock'
 * (unisons, pair merges, births into held unisons and a seek every 5 s: the unison lock's paths).
 * Run as: node --import ./tests/dsp/node/register.mjs tests/dsp/node/gc-harness.ts [plain|all|lock]
 */

import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { createLoadedGraph } from '../../../src/audio/offline';
import {
  ALL_EASES,
  denseScore,
  FIXTURE_MIX,
  lockStressScore,
  PLAIN_EASES,
} from '../../../src/audio/fixtures/scores';
import { BLOCK_FRAMES } from '../../../src/dsp/constants';

const RATE = 48000;
const arg = process.argv[2];
const mode = arg === 'all' || arg === 'lock' ? arg : 'plain';
const score =
  mode === 'lock'
    ? lockStressScore(12, 80, 17)
    : denseScore(24, 80, 5, mode === 'all' ? ALL_EASES : PLAIN_EASES);
const graph = createLoadedGraph({ score, mix: FIXTURE_MIX, sampleRate: RATE });
const left = new Float32Array(BLOCK_FRAMES);
const right = new Float32Array(BLOCK_FRAMES);
graph.play(0);

// 'lock': the measured run seeks every 5 s (from its first block), cycling through SEEK_TO, so it
// replays the same score spans each cycle. The targets are Smis, so the call itself cannot box a
// double. V8 deoptimises a function the first time it meets a branch or value shape it has no type
// feedback for, and the deoptimised code boxes doubles (MBs per second in computeGroups). That is a
// one-time JIT cost, not per-block allocation, so the warm-up first plays the whole score once and
// then runs one full seek cycle, so every path the measured run takes is already optimised.
const SEEK_TO = new Int32Array([12, 19, 31, 44]);
const seekEvery = mode === 'lock' ? Math.round((5 * RATE) / BLOCK_FRAMES) : 0;
/** One block of the run; block i of a seek cycle seeks first when it starts a 5 s span. */
function step(i: number): void {
  if (seekEvery > 0 && i % seekEvery === 0) graph.seek(SEEK_TO[(i / seekEvery) & 3]);
  graph.process(left, right);
}
const runBlocks = Math.round((60 * RATE) / BLOCK_FRAMES);
const playThrough = Math.round(((mode === 'lock' ? 76 : 5) * RATE) / BLOCK_FRAMES);
for (let i = 0; i < playThrough; i++) graph.process(left, right);
const warmCycle = seekEvery > 0 ? 4 * seekEvery : Math.round((5 * RATE) / BLOCK_FRAMES);
for (let i = 0; i < warmCycle; i++) step(i);

let observed = 0;
let observing = false;
const obs = new PerformanceObserver((list) => {
  if (observing) observed += list.getEntries().length;
});
obs.observe({ entryTypes: ['gc'] });
// Let any GC triggered by warm-up or by creating the observer be delivered before measuring.
await new Promise((resolve) => setTimeout(resolve, 50));
observing = true;

v8.setFlagsFromString('--trace-gc');
const t0 = performance.now();
for (let i = 0; i < runBlocks; i++) step(i);
const ms = performance.now() - t0;
v8.setFlagsFromString('--no-trace-gc');

await new Promise((resolve) => setTimeout(resolve, 50));
observing = false;
obs.disconnect();
process.stdout.write(
  `\n${JSON.stringify({ mode, audioSeconds: 60, ms: Math.round(ms), observedGc: observed })}\n`,
);
