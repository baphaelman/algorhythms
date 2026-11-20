/** The M0 test tone (src/dsp/test-tone.ts) in Node, in 128-frame blocks as a worklet runs it. */

import { describe, expect, it } from 'vitest';
import { SINE_TABLE_SIZE, TestTone, makeSineTable } from '../../src/dsp/test-tone';

const RATE = 48000;
const BLOCK = 128;

function renderSeconds(tone: TestTone, seconds: number): Float32Array {
  const blocks = Math.ceil((seconds * RATE) / BLOCK);
  const out = new Float32Array(blocks * BLOCK);
  const block = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    tone.render(block, BLOCK);
    out.set(block, b * BLOCK);
  }
  return out;
}

function risingCrossingFrequency(x: Float32Array): number {
  const c: number[] = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) c.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((c.length - 1) * RATE) / (c[c.length - 1] - c[0]);
}

describe('TestTone', () => {
  it('sine table has a guard point', () => {
    const t = makeSineTable();
    expect(t.length).toBe(SINE_TABLE_SIZE + 1);
    expect(t[SINE_TABLE_SIZE]).toBeCloseTo(t[0], 6);
  });

  it('plays 440 Hz at the requested amplitude, with no NaN', () => {
    const tone = new TestTone(RATE, 440, 0.25);
    tone.fadeTo(1, 0.01);
    const x = renderSeconds(tone, 1);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(Math.abs(risingCrossingFrequency(x) - 440)).toBeLessThan(0.01);
    const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(0.25, 3);
  });

  it('fades in from silence without a click', () => {
    const tone = new TestTone(RATE, 440, 0.25);
    tone.fadeTo(1, 0.01);
    const x = renderSeconds(tone, 0.1);
    expect(x[0]).toBe(0);
    // A clean 440 Hz sine at 0.25 changes by at most 2π·440/48000·0.25 ≈ 0.0144 per sample.
    let maxStep = 0;
    for (let i = 1; i < x.length; i++) maxStep = Math.max(maxStep, Math.abs(x[i] - x[i - 1]));
    expect(maxStep).toBeLessThan(0.0145);
  });

  it('fades out to silence', () => {
    const tone = new TestTone(RATE, 440, 0.25);
    tone.fadeTo(1, 0);
    renderSeconds(tone, 0.05);
    tone.fadeTo(0, 0.02);
    const x = renderSeconds(tone, 0.05);
    const tail = x.subarray(Math.ceil(0.021 * RATE));
    expect(tail.every((v) => v === 0)).toBe(true);
  });
});
