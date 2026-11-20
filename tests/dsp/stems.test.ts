/**
 * Stems hooks (PLAN.md §12): per-voice renders (dry, through the master tone and the limiter's
 * delay, × the recorded g_L) plus the FX-returns render sum to the mix, residual ≤ −90 dBFS.
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_MIX, stressScore } from '../../src/audio/fixtures/scores';
import { flatten } from '../../src/core/flat';
import { renderOffline } from '../../src/audio/offline';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { dbfs, RATE } from './helpers';

describe('stems exact sum', () => {
  it('Σ voice stems + FX stem = mix within −90 dBFS, with the limiter engaged', () => {
    const score = stressScore(8, 10, 1, 9);
    for (const v of score.voices) v.gain = 3; // push the limiter
    score.voices[2].mute = true; // a muted voice contributes an empty stem
    const mix = { ...FIXTURE_MIX, tone: { tilt: 1.5, lowpassHz: 9000 } };
    const flat = flatten(score);
    const frames = Math.ceil((12 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const input = { score: flat, mix, sampleRate: RATE };

    const gain = new Float32Array(frames);
    const full = renderOffline(input, frames, { kind: 'mix', captureGain: gain });
    let minGain = 1;
    for (let i = 0; i < frames; i++) minGain = Math.min(minGain, gain[i]);
    expect(minGain, 'limiter engaged').toBeLessThan(0.7);

    const sumL = new Float64Array(frames);
    const sumR = new Float64Array(frames);
    const add = (s: { left: Float32Array; right: Float32Array }) => {
      for (let i = 0; i < frames; i++) {
        sumL[i] += s.left[i];
        sumR[i] += s.right[i];
      }
    };
    for (let v = 0; v < score.voices.length; v++) {
      const stem = renderOffline(input, frames, { kind: 'voice', index: v, replayGain: gain });
      if (v === 2) expect(stem.left.every((x) => x === 0)).toBe(true);
      add(stem);
    }
    add(renderOffline(input, frames, { kind: 'fx', replayGain: gain }));

    let worst = 0;
    let level = 0;
    for (let i = 0; i < frames; i++) {
      worst = Math.max(worst, Math.abs(sumL[i] - full.left[i]), Math.abs(sumR[i] - full.right[i]));
      level = Math.max(level, Math.abs(full.left[i]));
    }
    expect(level).toBeGreaterThan(0.5);
    console.info(`stems residual: ${dbfs(worst).toFixed(1)} dBFS (peak mix ${dbfs(level).toFixed(1)} dBFS)`);
    expect(dbfs(worst)).toBeLessThanOrEqual(-90);
  });

  it('replaying the recorded g_L reproduces the mix bit for bit', () => {
    const score = stressScore(6, 6, 1, 2);
    for (const v of score.voices) v.gain = 3;
    const frames = Math.ceil((7 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const input = { score, mix: FIXTURE_MIX, sampleRate: RATE };
    const gain = new Float32Array(frames);
    const a = renderOffline(input, frames, { kind: 'mix', captureGain: gain });
    const b = renderOffline(input, frames);
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
  });
});
