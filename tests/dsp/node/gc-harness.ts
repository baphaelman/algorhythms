/**
 * Child process for the no-GC test (PLAN.md §8.11): renders 24 voices plus FX at 48 kHz, warms
 * up, then runs `process()` for 60 s of audio with V8's --trace-gc switched on for exactly that
 * span. Any "Scavenge" (or other GC) line printed during the run is a failure. A PerformanceObserver
 * on 'gc' entries double-checks the count. Prints a JSON summary as its last line.
 *
 * argv[2]: 'plain' (default: the allocation-free eases) or 'all' (adds expo and bézier).
 * Run as: node --import ./tests/dsp/node/register.mjs tests/dsp/node/gc-harness.ts [plain|all]
 */

import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { createLoadedGraph } from '../../../src/audio/offline';
import { ALL_EASES, denseScore, FIXTURE_MIX, PLAIN_EASES } from '../../../src/audio/fixtures/scores';
import { BLOCK_FRAMES } from '../../../src/dsp/constants';

const RATE = 48000;
const mode = process.argv[2] === 'all' ? 'all' : 'plain';
const score = denseScore(24, 80, 5, mode === 'all' ? ALL_EASES : PLAIN_EASES);
const graph = createLoadedGraph({ score, mix: FIXTURE_MIX, sampleRate: RATE });
const left = new Float32Array(BLOCK_FRAMES);
const right = new Float32Array(BLOCK_FRAMES);
graph.play(0);

const warmBlocks = Math.round((10 * RATE) / BLOCK_FRAMES);
for (let i = 0; i < warmBlocks; i++) graph.process(left, right);

let observed = 0;
let observing = false;
const obs = new PerformanceObserver((list) => {
  if (observing) observed += list.getEntries().length;
});
obs.observe({ entryTypes: ['gc'] });
// Let any GC triggered by warm-up or by creating the observer be delivered before measuring.
await new Promise((resolve) => setTimeout(resolve, 50));
observing = true;

const runBlocks = Math.round((60 * RATE) / BLOCK_FRAMES);
v8.setFlagsFromString('--trace-gc');
const t0 = performance.now();
for (let i = 0; i < runBlocks; i++) graph.process(left, right);
const ms = performance.now() - t0;
v8.setFlagsFromString('--no-trace-gc');

await new Promise((resolve) => setTimeout(resolve, 50));
observing = false;
obs.disconnect();
process.stdout.write(
  `\n${JSON.stringify({ mode, audioSeconds: 60, ms: Math.round(ms), observedGc: observed })}\n`,
);
