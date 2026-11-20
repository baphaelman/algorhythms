/**
 * Real-time factor (PLAN.md §8.9): 24 voices plus FX at 48 kHz must render at ≥ 10× real time in
 * Node. The workload glides every voice continuously, through every ease and all six presets.
 */

import { describe, expect, it } from 'vitest';
import { createLoadedGraph } from '../../src/audio/offline';
import { ALL_EASES, denseScore, FIXTURE_MIX } from '../../src/audio/fixtures/scores';
import { BLOCK_FRAMES } from '../../src/dsp/constants';

const RATE = 48000;

function measure(seconds: number): number {
  const graph = createLoadedGraph({ score: denseScore(24, 40, 5, ALL_EASES), mix: FIXTURE_MIX, sampleRate: RATE });
  const l = new Float32Array(BLOCK_FRAMES);
  const r = new Float32Array(BLOCK_FRAMES);
  graph.play(0);
  const warm = Math.round((3 * RATE) / BLOCK_FRAMES);
  for (let i = 0; i < warm; i++) graph.process(l, r);
  const blocks = Math.round((seconds * RATE) / BLOCK_FRAMES);
  const t0 = performance.now();
  for (let i = 0; i < blocks; i++) graph.process(l, r);
  return (seconds * 1000) / (performance.now() - t0);
}

describe('real-time factor', () => {
  it('renders 24 voices + FX at 48 kHz at ≥ 10× real time', () => {
    const rtf = Math.max(measure(20), measure(20)); // best of two, to discount scheduler noise
    console.info(`RTF, 24 voices + reverb + delay + tone + limiter at 48 kHz: ${rtf.toFixed(1)}×`);
    expect(rtf).toBeGreaterThanOrEqual(10);
  }, 60_000);
});
