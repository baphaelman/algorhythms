/**
 * Per-part sum normalisation (PLAN.md §8.4 revision 10, `mix.normalise: 'part'`): a part joining
 * leaves the other parts' level alone, pieces without parts render bit for bit as with 'all'
 * (the render goldens), and the trim is static.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DRY_MIX,
  FIXTURE_MIX,
  FIXTURE_NAMES,
  fixtureScore,
  makeScore,
} from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { canonicalPiece } from '../../src/core/canonical';
import { newPiece } from '../../src/core/defaults';
import { flatten } from '../../src/core/flat';
import { parsePiece } from '../../src/core/schema';
import type { CompiledScore, MixSettings } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { Driver, RATE, rms } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

const PART: MixSettings = { ...DRY_MIX, normalise: 'part' };
const frames = (s: number) => Math.ceil((s * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;

/** Part A: 3 lines from 0 s; part B: 3 lines fading in at 4 s (0.5 s); all to 10 s. */
function joinScore(bLines = 3): CompiledScore {
  const a = [57, 64, 69].map((start) => ({ start, died: 10 }));
  const b = [72, 76, 79, 83].slice(0, bLines).map((start) => ({ start, born: 4, died: 10 }));
  const score = makeScore([...a, ...b], 10);
  score.voices.forEach((v, i) => (v.part = i < 3 ? 'A' : 'B'));
  return score;
}

/** RMS level (dB) of part A's summed voice stems in [from, to) seconds. */
function partALevel(score: CompiledScore, mix: MixSettings, from: number, to: number): number {
  const n = frames(10);
  const input = { score: flatten(score), mix, sampleRate: RATE };
  const gain = new Float32Array(n);
  renderOffline(input, n, { kind: 'mix', captureGain: gain });
  const sum = new Float32Array(n);
  for (let v = 0; v < 3; v++) {
    const s = renderOffline(input, n, { kind: 'voice', index: v, replayGain: gain });
    for (let i = 0; i < n; i++) sum[i] += s.left[i];
  }
  return 20 * Math.log10(rms(sum, Math.round(from * RATE), Math.round(to * RATE)));
}

function digest(out: { left: Float32Array; right: Float32Array }): string {
  const h = createHash('sha256');
  h.update(new Uint8Array(out.left.buffer));
  h.update(new Uint8Array(out.right.buffer));
  return h.digest('hex').slice(0, 32);
}

describe("mix.normalise: 'part'", () => {
  it('a part joining keeps the other part within 0.2 dB (it drops ~3 dB with "all")', () => {
    for (const bLines of [1, 3]) {
      const score = joinScore(bLines);
      const before = partALevel(score, PART, 2, 3.8);
      const after = partALevel(score, PART, 5, 9);
      const allBefore = partALevel(score, DRY_MIX, 2, 3.8);
      const allAfter = partALevel(score, DRY_MIX, 5, 9);
      console.info(
        `part A, ${bLines} line(s) of B join: 'part' ${(after - before).toFixed(3)} dB, ` +
          `'all' ${(allAfter - allBefore).toFixed(3)} dB`,
      );
      expect(Math.abs(after - before)).toBeLessThanOrEqual(0.2);
      expect(allAfter - allBefore).toBeLessThan(bLines === 1 ? -0.9 : -2.5);
    }
  });

  it("each part's share is static, √(its peak lines / Σ peak lines): the tutti is 'all'", () => {
    for (const bLines of [1, 3]) {
      const score = joinScore(bLines);
      expect(flatten(score).partLines).toEqual({ A: 3, B: bLines });
      // With both parts sounding, the levels are those of 'all'.
      const tutti = partALevel(score, PART, 5, 9) - partALevel(score, DRY_MIX, 5, 9);
      expect(Math.abs(tutti)).toBeLessThan(0.01);
      // Before B joins, A alone sounds at its share: 10·log10(3 / (3 + b)) under 'all'.
      const alone = partALevel(score, PART, 2, 3.8) - partALevel(score, DRY_MIX, 2, 3.8);
      expect(alone).toBeCloseTo(10 * Math.log10(3 / (3 + bLines)), 1);
    }
  });

  it('keeps each part steady through a seek and hot-swaps (a part moved, a new part)', () => {
    const score = joinScore();
    const d = new Driver(score, PART);
    d.graph.play(0);
    d.run(6);
    const a0 = d.graph.voiceAmplitude(0);
    const b0 = d.graph.voiceAmplitude(5);
    d.graph.seek(7);
    d.run(0.5);
    expect(d.graph.voiceAmplitude(0) / a0).toBeCloseTo(1, 3);
    // Voice 5 moves to part A: A peaks at 4 lines, B at 2; every line keeps 1/√6.
    const moved = joinScore();
    moved.voices[5].part = 'A';
    d.graph.swap(flatten(moved));
    d.run(0.5);
    expect(d.graph.voiceAmplitude(0) / a0).toBeCloseTo(1, 3);
    expect(d.graph.voiceAmplitude(5) / b0).toBeCloseTo(1, 3);
    // Voice 5 alone in a new part C: its group starts at its own level, no 50 ms ramp from 1.
    const fresh = joinScore();
    fresh.voices[5].part = 'C';
    d.graph.swap(flatten(fresh));
    d.run(0.01);
    expect(d.graph.voiceAmplitude(5) / b0).toBeCloseTo(1, 2);
    d.run(0.5);
    expect(d.graph.voiceAmplitude(0) / a0).toBeCloseTo(1, 3);
    expect(d.graph.voiceAmplitude(5) / b0).toBeCloseTo(1, 3);
  });

  it('the flag survives loading and canonical storage (the mix schema passes it through)', () => {
    const piece = newPiece({ seed: 1, title: 'Flag' });
    piece.mix.normalise = 'part';
    const parsed = parsePiece(JSON.parse(JSON.stringify(piece)));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    expect(parsed.piece.mix.normalise).toBe('part');
    expect(canonicalPiece(parsed.piece).mix.normalise).toBe('part');
  });

  it('pieces without parts (and one-part pieces) render bit for bit as the goldens', () => {
    const golden = JSON.parse(
      readFileSync(join(import.meta.dirname, 'render-golden.json'), 'utf8'),
    ) as Record<string, string>;
    for (const name of FIXTURE_NAMES) {
      const score = fixtureScore(name);
      const mix = { ...FIXTURE_MIX, normalise: 'part' as const };
      const out = renderOffline({ score, mix, sampleRate: RATE }, frames(6));
      expect(digest(out), name).toBe(golden[`fixture:${name}`]);
    }
    const one = fixtureScore('stress');
    for (const v of one.voices) v.part = 'Only';
    const mix = { ...FIXTURE_MIX, normalise: 'part' as const };
    expect(digest(renderOffline({ score: one, mix, sampleRate: RATE }, frames(6)))).toBe(
      golden['fixture:stress'],
    );
  });
});
