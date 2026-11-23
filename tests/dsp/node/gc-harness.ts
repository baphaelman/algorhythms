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
 * moments, M6-b2) or 'fx' (the plain workload with a master FX edit every 0.25 s: tilt, low-pass
 * in and out of bypass, room size and delay-time crossfades and glides, glue on and off, width) or
 * 'parts' (the 'lock' workload with seeks, its voices in two parts and no part, `mix.normalise: 'part'`).
 * 'live' (M7a; argv[3]: the session file, see `buildLive`).
 * Run as: node --import ./tests/dsp/node/register.mjs tests/dsp/node/gc-harness.ts [plain|all|lock|m6|timbre|fx|parts|live <file>]
 */

import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { createLoadedGraph } from '../../../src/audio/offline';
import type { Graph } from '../../../src/dsp/graph';
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
import type { MixSettings } from '../../../src/core/types';
import { LiveInput } from '../../../src/dsp/live';
import { readFileSync } from 'node:fs';

const RATE = 48000;
const arg = process.argv[2];
const mode =
  arg === 'all' ||
  arg === 'lock' ||
  arg === 'm6' ||
  arg === 'timbre' ||
  arg === 'fx' ||
  arg === 'parts' ||
  arg === 'live'
    ? arg
    : 'plain';
const seeking = mode === 'lock' || mode === 'timbre' || mode === 'parts';
// Every other voice pulses (R9-3b): onsets, strikes and decays on the audio thread.
const score = withPulses(
  mode === 'lock' || mode === 'parts'
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
if (mode === 'parts') score.voices.forEach((v, i) => (v.part = ['A', 'B', ''][i % 3]));
const left = new Float32Array(BLOCK_FRAMES);
const right = new Float32Array(BLOCK_FRAMES);
const live = mode === 'live' ? buildLive() : null;
const graph =
  live?.graph ??
  createLoadedGraph({
    score,
    mix: mode === 'parts' ? { ...FIXTURE_MIX, normalise: 'part' } : FIXTURE_MIX,
    timbres: mode === 'm6' || mode === 'timbre' ? M6_WORKLOAD_TIMBRES : undefined,
    sampleRate: RATE,
  });
if (!live) graph.play(0);

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
const WARM_EDITS = 5000;
// 'fx': cycles through three mixes, built once (the edit itself arrives from postMessage).
const F = FIXTURE_MIX;
const FX_EDITS: MixSettings[] = [
  F,
  {
    ...F,
    reverb: { ...F.reverb, size: 0.15 },
    delay: { ...F.delay, time: 1.2 },
    tone: { tilt: 4, lowpassHz: 600 },
    glue: 1,
    width: 0.4,
  },
  {
    ...F,
    reverb: { ...F.reverb, size: 0.9 },
    delay: { ...F.delay, time: 1.195 },
    tone: { tilt: -3, lowpassHz: 24000 },
    glue: 0.5,
    width: 2,
  },
];
const editEvery = mode === 'fx' ? Math.round((0.25 * RATE) / BLOCK_FRAMES) : 0;
/** One block of the run; block i of a seek cycle seeks first when it starts a 5 s span. */
function step(i: number): void {
  if (live) return live.step();
  if (seekEvery > 0 && i % seekEvery === 0) graph.seek(SEEK_TO[(i / seekEvery) & 3]);
  if (editEvery > 0 && i % editEvery === 0) graph.setMix(FX_EDITS[(i / editEvery) % 3]);
  graph.process(left, right);
}
const runBlocks = Math.round((60 * RATE) / BLOCK_FRAMES);
// live: 30 s (the session file's fast phase), so every apply path, compaction included, is
// optimised before the run.
const playThrough = Math.round(((seeking ? 76 : live ? 30 : 5) * RATE) / BLOCK_FRAMES);
for (let i = 0; i < playThrough; i++) {
  if (editEvery > 0 || live) step(i);
  else graph.process(left, right);
}
if (seekEvery > 0) {
  for (let i = 0; i < WARM_SEEKS * 4; i++) {
    if ((i & 3) === 0) graph.seek(SEEK_TO[(i >> 2) & 3]);
    graph.process(left, right);
  }
}
// 'fx': setMix is message handling, not process(); it runs interpreted (boxing doubles, ~3 KB
// per edit) until V8 tiers it up, so the warm-up sends it WARM_EDITS times first.
if (editEvery > 0) {
  for (let i = 0; i < WARM_EDITS; i++) graph.setMix(FX_EDITS[i % 3]);
  graph.setMix(F);
}
// (The live run's blocks are counted by `live.step` itself.)
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
  `\n${JSON.stringify({ mode, audioSeconds: 60, ms: Math.round(t1 - t0), observedGc, newSpaceBytes, ...(live ? { messages: live.measured() } : {}) })}\n`,
);

/**
 * 'live' (M7a): 24 live voices (a graph in live mode and its LiveInput, as in the worklet) under
 * the session tests/dsp/live-schedule.ts wrote to argv[3]: the main thread's decisions, made
 * beforehand because they allocate, replayed block by block. So the measured span holds only what
 * the worklet does: queueing a message's copy, applying it, the bend, rendering.
 */
/** `xs` with tagged (boxed) elements: an array that once held a non-number never unboxes. */
function tagged(xs: number[]): number[] {
  const out: unknown[] = [null, ...xs];
  out.shift();
  return out as number[];
}

function buildLive(): { graph: Graph; step(): void; measured(): number } {
  const file = JSON.parse(readFileSync(process.argv[3], 'utf8')) as {
    score: Parameters<typeof createLoadedGraph>[0]['score'];
    mix: MixSettings;
    voices: number;
    warmBlocks: number;
    messages: {
      block: number;
      seq: number;
      moves: number[];
      n: number;
      gain: number | null;
      over: number;
      press: number;
    }[];
    bends: { block: number; semitones: number }[];
  };
  const g = createLoadedGraph({ score: file.score, mix: file.mix, sampleRate: RATE });
  const input = new LiveInput(g, file.voices);
  g.play(0);
  const msgs = file.messages;
  const nMsg = msgs.length;
  // Preallocated records, read without allocating. The scalars passed to the worklet's methods
  // are boxed numbers in tagged arrays, as a port message's fields are: from a Float64Array, a call
  // V8 does not inline (setBend, sometimes queue) boxed each one, ~1.4 KB per run that depended on
  // inlining decisions, i.e. on JIT timing.
  const B = Int32Array.from(msgs, (m) => m.block);
  const Q = tagged(msgs.map((m) => m.seq));
  const N = Int32Array.from(msgs, (m) => m.n);
  const G = tagged(msgs.map((m) => (m.gain === null ? NaN : m.gain)));
  const O = tagged(msgs.map((m) => m.over));
  const P = tagged(msgs.map((m) => m.press));
  const M = msgs.map((m) => Float64Array.from(m.moves));
  const BB = Int32Array.from(file.bends, (x) => x.block);
  const BV = tagged(file.bends.map((x) => x.semitones));
  let k = 0;
  let kb = 0;
  let b = 0;
  let measureFrom = -1;
  return {
    graph: g,
    step(): void {
      if (measureFrom < 0 && b >= file.warmBlocks) measureFrom = k;
      while (k < nMsg && B[k] === b) {
        input.queue(Q[k], M[k], N[k], G[k], O[k], P[k]);
        k++;
      }
      while (kb < BB.length && BB[kb] === b) input.setBend(BV[kb++]);
      input.beforeBlock(b * BLOCK_FRAMES);
      g.process(left, right);
      b++;
    },
    measured: () => k - Math.max(0, measureFrom),
  };
}
