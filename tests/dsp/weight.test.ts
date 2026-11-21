/**
 * Line weights (PLAN.md §15 M4.5 "Distinct notes", revision 8): a line of weight w sounds at the
 * power of w incoherent lines, √w in amplitude, and g_n counts it as w lines.
 */

import { describe, expect, it } from 'vitest';
import { DRY_MIX, makeScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import type { CompiledScore, WeightChange } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { RATE, rms } from './helpers';

const END = 4;
const FRAMES = Math.ceil((END * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
const GAIN = new Float32Array(FRAMES).fill(1);

/** Voices centred (pan 0), so left = right; `weights[i]` is voice i's weight timeline. */
function score(starts: number[], weights: (WeightChange[] | undefined)[] = []): CompiledScore {
  const specs: VoiceSpec[] = starts.map((p, i) => ({ id: `w${i}`, start: p, pan: 0 }));
  const s = makeScore(specs, END, 3);
  s.voices.forEach((v, i) => {
    if (weights[i]) v.weight = weights[i];
  });
  return s;
}

/** RMS of voice `index`'s stem over [from, to) seconds. */
function stemRms(s: CompiledScore, index: number, from: number, to: number): number {
  const out = renderOffline({ score: s, mix: DRY_MIX, sampleRate: RATE }, FRAMES, {
    kind: 'voice',
    index,
    replayGain: GAIN,
  });
  return rms(out.left, Math.floor(from * RATE), Math.floor(to * RATE));
}

describe('line weight', () => {
  it('a line of weight w sounds at √w the amplitude of a weight-1 line', () => {
    const ratio = (w: number): number => {
      const s = score([57, 64], [[{ t: 0, w, over: 0 }]]);
      return stemRms(s, 0, 1.5, 3.5) / stemRms(s, 1, 1.5, 3.5);
    };
    const base = ratio(1);
    const report: string[] = [];
    for (const w of [0.5, 2, 4, 8]) {
      const r = ratio(w) / base;
      report.push(`${w}: ${r.toFixed(4)}`);
      expect(r / Math.sqrt(w), `weight ${w}`).toBeCloseTo(1, 2);
    }
    console.info(`stem amplitude ÷ weight-1 amplitude: ${report.join(', ')}`);
  });

  it('g_n counts a weight-w line as w lines', () => {
    // Voice 0's stem carries g_n: next to one line of weight 3 it matches three separate lines.
    const weighted = stemRms(score([60, 55], [undefined, [{ t: 0, w: 3, over: 0 }]]), 0, 1.5, 3.5);
    const separate = stemRms(score([60, 55, 67, 72]), 0, 1.5, 3.5);
    const one = stemRms(score([60, 55]), 0, 1.5, 3.5);
    expect(weighted / separate).toBeCloseTo(1, 2);
    // And not as one line: g_n is √(2/4) lower than with two weight-1 lines.
    expect(weighted / one).toBeCloseTo(Math.sqrt(2 / 4), 2);
  });

  it('follows a weight ramp', () => {
    const s = score([57, 64], [[{ t: 1.5, w: 4, over: 0.5 }]]);
    const before = stemRms(s, 0, 0.5, 1.4) / stemRms(s, 1, 0.5, 1.4);
    const after = stemRms(s, 0, 2.5, 3.5) / stemRms(s, 1, 2.5, 3.5);
    expect(after / before).toBeCloseTo(2, 2);
  });
});
