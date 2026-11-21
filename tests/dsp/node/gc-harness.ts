/**
 * Child process for the no-GC test (PLAN.md §8.11): renders 24 voices plus FX at 48 kHz, warms
 * up, then runs `process()` for 60 s of audio with V8's --trace-gc switched on for exactly that
 * span. Any "Scavenge" (or other GC) line printed during the run is a failure. A PerformanceObserver
 * on 'gc' entries double-checks the count, and the young generation's byte count catches
 * allocation too small to set off a GC. Prints a JSON summary as its last line.
 *
 * argv[2]: 'plain' (default: the allocation-free eases), 'all' (adds expo and bézier), 'lock'
 * (unisons, pair merges, births into held unisons and a seek every 5 s: the unison lock's paths)
 * 'm6' (plain eases on the M6 timbres: the M6-a bell, FM on a wavetable, breath noise, a bell with
 * struck partials and an FM index envelope) or 'timbre' (the 'lock' workload with seeks, every
 * voice changing timbre every ~1.5 s across every synthesis path, with overlapping fades: timbre
 * moments, M6-b2).
 * Run as: node --import ./tests/dsp/node/register.mjs tests/dsp/node/gc-harness.ts [plain|all|lock|m6|timbre]
 */

import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { createLoadedGraph } from '../../../src/audio/offline';
import {
  ALL_EASES,
  denseScore,
  FIXTURE_MIX,
  lockStressScore,
  M6_WORKLOAD_TIMBRES,
  PLAIN_EASES,
  withPulses,
  withTimbreChanges,
} from '../../../src/audio/fixtures/scores';
import { BLOCK_FRAMES } from '../../../src/dsp/constants';

const RATE = 48000;
const arg = process.argv[2];
const mode = arg === 'all' || arg === 'lock' || arg === 'm6' || arg === 'timbre' ? arg : 'plain';
const seeking = mode === 'lock' || mode === 'timbre';
// Every other voice pulses (R9-3b): onsets, strikes and decays on the audio thread.
const score = withPulses(
  mode === 'lock'
    ? lockStressScore(12, 80, 17)
    : mode === 'timbre'
      ? withTimbreChanges(lockStressScore(12, 80, 17), [
          'bell',
          'strikebell',
          'epiano',
          'flute',
          'choir',
          'sine',
          'glass',
          'fmreed',
        ])
      : denseScore(
          24,
          80,
          5,
          mode === 'all' ? ALL_EASES : PLAIN_EASES,
          mode === 'm6' ? ['bell', 'fmreed', 'breath', 'strikebell'] : undefined,
        ),
);
const graph = createLoadedGraph({
  score,
  mix: FIXTURE_MIX,
  timbres: mode === 'm6' || mode === 'timbre' ? M6_WORKLOAD_TIMBRES : undefined,
  sampleRate: RATE,
});
const left = new Float32Array(BLOCK_FRAMES);
const right = new Float32Array(BLOCK_FRAMES);
graph.play(0);

// 'lock': the measured run seeks every 5 s (from its first block), cycling through SEEK_TO, so it
// replays the same score spans each cycle. The targets are Smis, so the call itself cannot box a
// double. V8 deoptimises a function the first time it meets a branch or value shape it has no type
// feedback for, and the deoptimised code boxes doubles (MBs per second in computeGroups). That is a
// one-time JIT cost, not per-block allocation, so the warm-up first plays the whole score once.
// Code that runs only on a seek or a birth (applyTransport, jump, probe, ...) stays interpreted
// until it has run a few thousand times, and the interpreter boxes every double: ~8 KB per seek,
// ~100 KB per measured minute. So the warm-up then seeks WARM_SEEKS times (every 4 blocks, past
// the 5 ms fade; ~200 are needed) and ends with one full seek cycle like the measured run's
// (docs/build-log.md, "No-GC lock flake").
const SEEK_TO = new Int32Array([12, 19, 31, 44]);
const seekEvery = seeking ? Math.round((5 * RATE) / BLOCK_FRAMES) : 0;
const WARM_SEEKS = 1000;
/** One block of the run; block i of a seek cycle seeks first when it starts a 5 s span. */
function step(i: number): void {
  if (seekEvery > 0 && i % seekEvery === 0) graph.seek(SEEK_TO[(i / seekEvery) & 3]);
  graph.process(left, right);
}
const runBlocks = Math.round((60 * RATE) / BLOCK_FRAMES);
const playThrough = Math.round(((seeking ? 76 : 5) * RATE) / BLOCK_FRAMES);
for (let i = 0; i < playThrough; i++) graph.process(left, right);
if (seekEvery > 0) {
  for (let i = 0; i < WARM_SEEKS * 4; i++) {
    if ((i & 3) === 0) graph.seek(SEEK_TO[(i >> 2) & 3]);
    graph.process(left, right);
  }
}
const warmCycle = seekEvery > 0 ? 4 * seekEvery : Math.round((5 * RATE) / BLOCK_FRAMES);
for (let i = 0; i < warmCycle; i++) step(i);

// The observer counts only GCs that start inside [t0, t1], which lies inside the --trace-gc
// window. It used to count everything delivered during the 50 ms waits around the run too.
const starts: number[] = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) starts.push(e.startTime);
});
obs.observe({ entryTypes: ['gc'] });
// Let any GC triggered by warm-up or by creating the observer be delivered before measuring.
await new Promise((resolve) => setTimeout(resolve, 50));

/** Bytes in use in the young generation; read before the call allocates its own result. */
const newSpace = (): number =>
  v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space')?.space_used_size ?? NaN;
const n0 = newSpace();
const own = newSpace() - n0; // what one newSpace() call allocates after its reading
const nA = newSpace();
v8.setFlagsFromString('--trace-gc');
const t0 = performance.now();
for (let i = 0; i < runBlocks; i++) step(i);
const t1 = performance.now();
v8.setFlagsFromString('--no-trace-gc');
const nB = newSpace();

await new Promise((resolve) => setTimeout(resolve, 50));
obs.disconnect();
const observedGc = starts.filter((t) => t >= t0 && t <= t1).length;
// Young-generation bytes allocated by the run, plus ~2 KB by the timer and flag calls around it.
// Shows allocation too small to set off a GC; meaningless if a GC ran (the counts above fail).
const newSpaceBytes = nB - nA - own;
process.stdout.write(
  `\n${JSON.stringify({ mode, audioSeconds: 60, ms: Math.round(t1 - t0), observedGc, newSpaceBytes })}\n`,
);
