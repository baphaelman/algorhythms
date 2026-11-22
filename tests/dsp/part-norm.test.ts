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
import { clickScore, Driver, RATE, rms } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

const PART: MixSettings = { ...DRY_MIX, normalise: 'part' };
const ALL: MixSettings = { ...DRY_MIX, normalise: 'all' };
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
      const allBefore = partALevel(score, ALL, 2, 3.8);
      const allAfter = partALevel(score, ALL, 5, 9);
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
      const tutti = partALevel(score, PART, 5, 9) - partALevel(score, ALL, 5, 9);
      expect(Math.abs(tutti)).toBeLessThan(0.01);
      // Before B joins, A alone sounds at its share: 10·log10(3 / (3 + b)) under 'all'.
      const alone = partALevel(score, PART, 2, 3.8) - partALevel(score, ALL, 2, 3.8);
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

  it("is the default: absent means 'part', in the DSP as in the schema", () => {
    const score = joinScore();
    const { normalise: _, ...absent } = PART;
    const n = frames(6);
    const a = renderOffline({ score: flatten(score), mix: absent, sampleRate: RATE }, n);
    const p = renderOffline({ score: flatten(score), mix: PART, sampleRate: RATE }, n);
    expect(digest(a)).toBe(digest(p));
    expect(partALevel(score, absent, 2, 3.8) - partALevel(score, ALL, 2, 3.8)).toBeCloseTo(-3, 1);
  });

  it("'all' and 'part' survive loading and canonical storage", () => {
    for (const v of ['all', 'part'] as const) {
      const piece = newPiece({ seed: 1, title: 'Flag' });
      piece.mix.normalise = v;
      const parsed = parsePiece(JSON.parse(JSON.stringify(piece)));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      expect(parsed.piece.mix.normalise).toBe(v);
      expect(canonicalPiece(parsed.piece).mix.normalise).toBe(v);
    }
  });

  it('switching while playing glides both ways over the 50 ms smoothing (no step, no click)', () => {
    // Before 6 s, A sounds 3 of its 3 lines and B 1 of its 3: under 'part' A's lines sit at
    // √(3/6)/√3 (−1.76 dB against 'all', 1/√4) and B's at √(3/6) (+3.01 dB).
    const a = [57, 64, 69].map((start) => ({ start, died: 10 }));
    const b = [
      { start: 72, died: 10 },
      { start: 76, born: 6, died: 10 },
      { start: 79, born: 6, died: 10 },
    ];
    const score = makeScore([...a, ...b], 10);
    score.voices.forEach((v, i) => (v.part = i < 3 ? 'A' : 'B'));
    const run = (toggle: boolean) => {
      const d = new Driver(score, PART);
      const amp: [number, number][] = [];
      const go = (s: number) => {
        for (let k = Math.ceil((s * RATE) / BLOCK_FRAMES); k > 0; k--) {
          d.run(BLOCK_FRAMES / RATE);
          amp.push([d.graph.voiceAmplitude(0), d.graph.voiceAmplitude(3)]);
        }
      };
      d.graph.play(0);
      go(1.5);
      if (toggle) d.graph.setMix(ALL);
      go(1);
      if (toggle) d.graph.setMix(PART);
      go(1);
      if (toggle) d.graph.setParam('normalise', 'all');
      go(0.3);
      // Back before the fade to row 0 ends (10 time constants).
      if (toggle) d.graph.setParam('normalise', 'part');
      go(1.2);
      return { amp, out: d.out() };
    };
    const t = run(true);
    const ref = run(false);
    const blk = (s: number) => Math.round((s * RATE) / BLOCK_FRAMES);
    const db = (i: number, v: 0 | 1) => 20 * Math.log10(t.amp[i][v]);
    // Settled levels: 'part', then 'all', then 'part' again.
    expect(db(blk(2.45), 0) - db(blk(1.45), 0)).toBeCloseTo(1.76, 1);
    expect(db(blk(2.45), 1) - db(blk(1.45), 1)).toBeCloseTo(-3.01, 1);
    expect(db(blk(3.45), 0) - db(blk(1.45), 0)).toBeCloseTo(0, 2);
    expect(db(blk(4.95), 1) - db(blk(1.45), 1)).toBeCloseTo(0, 2);
    // One block of the 50 ms one-pole moves 5.2 % of the gap: ≤ 0.16 dB for 3 dB.
    let worst = 0;
    for (let i = blk(1); i < blk(5); i++)
      for (const v of [0, 1] as const)
        worst = Math.max(worst, Math.abs(20 * Math.log10(t.amp[i][v] / t.amp[i - 1][v])));
    console.info(`normalise toggle: worst per-block level step ${worst.toFixed(3)} dB`);
    expect(worst).toBeLessThan(0.2);
    const click = (x: Float32Array) =>
      clickScore(x, Math.floor(1.4 * RATE), Math.floor(5 * RATE), RATE, 0.01, 1e-3, 2).ratio;
    const toggled = Math.max(click(t.out.left), click(t.out.right));
    const plain = Math.max(click(ref.out.left), click(ref.out.right));
    console.info(
      `normalise toggle: click ratio ${toggled.toFixed(4)} (no toggle ${plain.toFixed(4)})`,
    );
    expect(toggled).toBeLessThan(plain * 1.1);
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
