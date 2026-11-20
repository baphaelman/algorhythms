/**
 * Click detector on seek, loop, swap and pause/play (PLAN.md §8.7, §14, §15 M2).
 *
 * The detector (helpers.clickScore) is the largest sample-to-sample step divided by the local RMS
 * (±10 ms). For each timbre the threshold is twice the worst ratio of a clean, uninterrupted
 * render of the same fixture: a transport operation must look like ordinary signal. A positive
 * control (a hard splice, i.e. what a seek without the crossfade would do) must exceed it.
 */

import { describe, expect, it } from 'vitest';
import { flatten } from '../../src/core/flat';
import { DRY_MIX, FIXTURE_MIX, stressScore, swapPair } from '../../src/audio/fixtures/scores';
import { clickScore, Driver, RATE, render } from './helpers';

const TIMBRES = ['sine', 'organ', 'pluck'] as const;

/** A driver that records the output frame at which each operation was requested. */
class Session extends Driver {
  readonly events: number[] = [];
  mark(): void {
    this.events.push(this.frames / RATE);
  }
}

/** Worst detector ratio within [e − 30 ms, e + 60 ms] of every event. */
function worstAround(x: Float32Array, events: number[]): { ratio: number; at: number } {
  let worst = { ratio: 0, at: -1 };
  for (const e of events) {
    const r = clickScore(
      x,
      Math.max(1, Math.floor((e - 0.03) * RATE)),
      Math.floor((e + 0.06) * RATE),
    );
    if (r.ratio > worst.ratio) worst = r;
  }
  return worst;
}

describe.each(TIMBRES)('click detector, %s', (timbre) => {
  const score = stressScore(8, 20, 1.2, 11, [timbre]);
  const reference = render(score, DRY_MIX, 20);
  const clean = Math.max(
    clickScore(reference.left, 480).ratio,
    clickScore(reference.right, 480).ratio,
  );
  const threshold = 2 * clean;

  it('catches a hard cut (positive control)', () => {
    // A hard splice (what a seek without the crossfade would do). How big its step is depends on
    // the two waveform values that meet, so take the median over nine splice points.
    const ratios: number[] = [];
    for (let k = 0; k < 9; k++) {
      const a = Math.round((2 + k * 0.0371) * RATE);
      const b = Math.round((9 + k * 0.0293) * RATE);
      const spliced = new Float32Array(a + 2 * RATE);
      spliced.set(reference.left.subarray(0, a));
      spliced.set(reference.left.subarray(b, b + 2 * RATE), a);
      ratios.push(clickScore(spliced, a - 480, a + 480).ratio);
    }
    ratios.sort((x, y) => x - y);
    const median = ratios[4];
    console.info(
      `${timbre}: clean ${clean.toFixed(3)}, threshold ${threshold.toFixed(3)}, hard cut ${median.toFixed(2)} (median of 9)`,
    );
    expect(median).toBeGreaterThan(1.5 * threshold);
  });

  it('seek (single and a scrub burst) and pause/play stay click-free', () => {
    const s = new Session(score, DRY_MIX);
    s.graph.play(0);
    s.run(2);
    s.mark();
    s.graph.seek(9);
    s.run(1.5);
    s.mark();
    s.graph.seek(3.3);
    s.run(1);
    for (let i = 0; i < 20; i++) {
      s.mark();
      s.graph.seek(5 + i * 0.07);
      s.run(0.05);
    }
    s.run(0.5);
    s.mark();
    s.graph.pause();
    s.run(0.3);
    s.mark();
    s.graph.play();
    s.run(1);
    const out = s.out();
    const w = Math.max(
      worstAround(out.left, s.events).ratio,
      worstAround(out.right, s.events).ratio,
    );
    console.info(`${timbre}: seek/pause worst ${w.toFixed(3)}`);
    expect(w).toBeLessThanOrEqual(threshold);
  });

  it('loop wraps stay click-free', () => {
    const s = new Session(score, DRY_MIX);
    s.graph.setLoop(2, 4.53);
    s.graph.play(0);
    s.run(12);
    const out = s.out();
    // Wraps happen every 2.53 s of piece time, starting when the playhead first reaches 4.53 s.
    const wraps = [0, 1, 2, 3].map((k) => 4.53 + k * 2.53);
    const w = Math.max(worstAround(out.left, wraps).ratio, worstAround(out.right, wraps).ratio);
    console.info(`${timbre}: loop worst ${w.toFixed(3)}`);
    expect(w).toBeLessThanOrEqual(threshold);
  });
});

describe('click detector, hot-swap', () => {
  it.each(['sine', 'organ'])(
    'swapping %s voices (crossfade, slew, removal, addition) is click-free',
    (timbre) => {
      const { a, b } = swapPair(3, timbre);
      const clean = clickScore(render(a, DRY_MIX, 6).left, 480).ratio;
      const s = new Session(a, DRY_MIX);
      s.graph.play(0);
      s.run(3);
      s.mark();
      s.graph.swap(flatten(b));
      s.run(3);
      const out = s.out();
      const w = Math.max(
        worstAround(out.left, s.events).ratio,
        worstAround(out.right, s.events).ratio,
      );
      console.info(`${timbre} swap: clean ${clean.toFixed(3)}, worst ${w.toFixed(3)}`);
      expect(w).toBeLessThanOrEqual(2 * clean);
    },
  );

  it('a swap with FX keeps the tail and stays under the ceiling', () => {
    const { a, b } = swapPair(2);
    const s = new Session(a, FIXTURE_MIX);
    s.graph.play(0);
    s.run(2);
    s.graph.swap(flatten(b));
    s.run(2);
    const out = s.out();
    expect(out.left.every((x) => Number.isFinite(x) && Math.abs(x) <= Math.pow(10, -1 / 20))).toBe(
      true,
    );
  });
});
