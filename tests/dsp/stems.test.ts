/**
 * Stems hooks (PLAN.md §12): per-voice renders (dry, through the master tone and the limiter's
 * delay, × the recorded g_L) plus the FX-returns render sum to the mix, residual ≤ −90 dBFS.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_MIX,
  lockStressScore,
  stressScore,
  unisonChordScore,
} from '../../src/audio/fixtures/scores';
import type { CompiledScore, MixSettings } from '../../src/core/types';
import { flatten } from '../../src/core/flat';
import { renderOffline } from '../../src/audio/offline';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { dbfs, RATE } from './helpers';

// Slowest test 5 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 60_000 });

/**
 * Renders the mix (capturing g_L), every voice stem and the FX stem; returns the worst sample
 * difference between Σ stems and the mix, the mix's peak, the smallest g_L and the stems.
 */
function stemSum(
  score: CompiledScore,
  mix: MixSettings,
  seconds: number,
): { worst: number; level: number; minGain: number; stems: Float32Array[] } {
  const flat = flatten(score);
  const frames = Math.ceil((seconds * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  const input = { score: flat, mix, sampleRate: RATE };
  const gain = new Float32Array(frames);
  const full = renderOffline(input, frames, { kind: 'mix', captureGain: gain });
  let minGain = 1;
  for (let i = 0; i < frames; i++) minGain = Math.min(minGain, gain[i]);
  const sumL = new Float64Array(frames);
  const sumR = new Float64Array(frames);
  const stems: Float32Array[] = [];
  const add = (s: { left: Float32Array; right: Float32Array }) => {
    for (let i = 0; i < frames; i++) {
      sumL[i] += s.left[i];
      sumR[i] += s.right[i];
    }
  };
  for (let v = 0; v < score.voices.length; v++) {
    const stem = renderOffline(input, frames, { kind: 'voice', index: v, replayGain: gain });
    stems.push(stem.left);
    add(stem);
  }
  add(renderOffline(input, frames, { kind: 'fx', replayGain: gain }));
  let worst = 0;
  let level = 0;
  for (let i = 0; i < frames; i++) {
    worst = Math.max(worst, Math.abs(sumL[i] - full.left[i]), Math.abs(sumR[i] - full.right[i]));
    level = Math.max(level, Math.abs(full.left[i]));
  }
  return { worst, level, minGain, stems };
}

describe('stems exact sum', () => {
  it('Σ voice stems + FX stem = mix within −90 dBFS, with the limiter engaged', () => {
    const score = stressScore(8, 10, 1, 9);
    for (const v of score.voices) v.gain = 3; // push the limiter
    score.voices[2].mute = true; // a muted voice contributes an empty stem
    const mix = { ...FIXTURE_MIX, tone: { tilt: 1.5, lowpassHz: 9000 } };
    const { worst, level, minGain, stems } = stemSum(score, mix, 12);
    expect(minGain, 'limiter engaged').toBeLessThan(0.7);
    expect(stems[2].every((x) => x === 0)).toBe(true);
    expect(level).toBeGreaterThan(0.5);
    console.info(
      `stems residual: ${dbfs(worst).toFixed(1)} dBFS (peak mix ${dbfs(level).toFixed(1)} dBFS)`,
    );
    expect(dbfs(worst)).toBeLessThanOrEqual(-90);
  }, 90_000); // 9 s, 1 worker. Every stem pass runs every voice's controls (unison lock): slow on a loaded machine

  it('holds through unisons, merges, births into unisons and a muted voice in a group', () => {
    // The group pass sees every voice's state in every render mode, so locked voices' stems
    // (each carrying its group gain h) still sum to the mix.
    const phrase = unisonChordScore('sine');
    for (const v of phrase.voices) v.gain = 3;
    phrase.voices[1].mute = true; // stays in its group, silent
    const a = stemSum(phrase, FIXTURE_MIX, 21);
    const b = stemSum(lockStressScore(8, 24, 5), FIXTURE_MIX, 24);
    expect(a.minGain, 'limiter engaged').toBeLessThan(0.8);
    expect(a.stems[1].every((x) => x === 0)).toBe(true);
    console.info(
      `stems residual, unison phrase: ${dbfs(a.worst).toFixed(1)} dBFS; ` +
        `lock workload: ${dbfs(b.worst).toFixed(1)} dBFS`,
    );
    expect(dbfs(a.worst)).toBeLessThanOrEqual(-90);
    expect(dbfs(b.worst)).toBeLessThanOrEqual(-90);
  }, 360_000); // 36 s, 1 worker

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
