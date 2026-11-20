/**
 * Unison and merge level (PLAN.md §8.4, §14). With the always-on detune, N voices converged on one
 * pitch beat slowly instead of freezing their phase difference, so their level stays near the
 * incoherent sum √N — which the sum normalisation g_n = 1/√N maps back to the level of one voice
 * — and never sits near silence.
 *
 * Bands (relative to one voice alone, measured on these deterministic id sets):
 * - the average over a 9 s hold lies within [0.5, 1.6] (−6 dB … +4 dB);
 * - no 0.5 s window of the hold falls below 0.1 (−20 dB): beating troughs, never silence;
 * - during a merge, no 0.25 s window falls below 0.4 or rises above 1.6.
 */

import { describe, expect, it } from 'vitest';
import { DRY_MIX, makeScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { render, stereoRms } from './helpers';

const HOLD_FROM = 3;
const HOLD_TO = 12;

function unisonSpecs(n: number, prefix: string): VoiceSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    start: 57 + (i - (n - 1) / 2) * 2,
    moves: [{ at: 0.5, to: 57, len: 2 }],
    timbre: 'sine',
  }));
}

const single = stereoRms(
  render(makeScore(unisonSpecs(1, 'ref'), 13), DRY_MIX, 13),
  HOLD_FROM,
  HOLD_TO,
);

describe('unison level', () => {
  it.each([2, 4, 8, 16, 32])(
    '%i converged voices stay near the incoherent sum',
    (n) => {
      const report: string[] = [];
      for (let trial = 0; trial < 6; trial++) {
        const out = render(makeScore(unisonSpecs(n, `u${trial}-`), 13, trial + 1), DRY_MIX, 13);
        const whole = stereoRms(out, HOLD_FROM, HOLD_TO) / single;
        let low = Infinity;
        for (let t = HOLD_FROM; t + 0.5 <= HOLD_TO; t += 0.25) {
          low = Math.min(low, stereoRms(out, t, t + 0.5) / single);
        }
        report.push(`${whole.toFixed(2)}/${low.toFixed(2)}`);
        expect(whole, `trial ${trial}: hold average`).toBeGreaterThanOrEqual(0.5);
        expect(whole, `trial ${trial}: hold average`).toBeLessThanOrEqual(1.6);
        expect(low, `trial ${trial}: quietest 0.5 s`).toBeGreaterThanOrEqual(0.1);
      }
      console.info(`unison N=${n} (hold avg / quietest 0.5 s, × one voice): ${report.join(' ')}`);
    },
    60_000,
  ); // 6 id sets × up to 32 voices × 9 s: slow when the machine is loaded
});

describe('merge level', () => {
  it('voices merging into survivors never cancel them', () => {
    let low = Infinity;
    let high = 0;
    for (let trial = 0; trial < 12; trial++) {
      const p = `m${trial}-`;
      const specs: VoiceSpec[] = [
        { id: `${p}a`, start: 50 },
        { id: `${p}b`, start: 53, moves: [{ at: 2, to: 50, len: 1.5 }], died: 5.5, fadeOut: 2 },
        { id: `${p}c`, start: 57 },
        { id: `${p}d`, start: 62, moves: [{ at: 2, to: 57, len: 1.5 }], died: 5.5, fadeOut: 2 },
      ];
      const out = render(makeScore(specs, 10, trial + 1), DRY_MIX, 10);
      for (let t = 0.5; t + 0.25 <= 9.5; t += 0.25) {
        const v = stereoRms(out, t, t + 0.25) / single;
        low = Math.min(low, v);
        high = Math.max(high, v);
      }
    }
    console.info(
      `merge: 0.25 s windows between ${low.toFixed(2)} and ${high.toFixed(2)} × one voice`,
    );
    expect(low).toBeGreaterThanOrEqual(0.4);
    expect(high).toBeLessThanOrEqual(1.6);
  });
});
