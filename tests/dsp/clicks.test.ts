/**
 * Click detector on seek, loop, swap and pause/play (PLAN.md §8.7, §14, §15 M2).
 *
 * The detector (helpers.clickScore) is the largest sample-to-sample step divided by the local RMS
 * (±10 ms). For each timbre the threshold is twice the worst ratio of a clean, uninterrupted
 * render of the same fixture: a transport operation must look like ordinary signal. A positive
 * control (a hard splice, i.e. what a seek without the crossfade would do) must exceed it.
 */

import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { flatten } from '../../src/core/flat';
import type { CompiledScore, Piece } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { piece } from '../unit/core/compiler-fixtures';
import { DRY_MIX, FIXTURE_MIX, stressScore, swapPair } from '../../src/audio/fixtures/scores';
import { clickScore, Driver, RATE, render } from './helpers';

// Slowest test 1.5 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

// bell: the M6 paths (stretched partials, FM at the non-integer ratio 1.41, noise); M6-c: FM
// (epiano), noise (flute), stretch with a short decay (marimba).
const TIMBRES = ['sine', 'organ', 'pluck', 'bell', 'epiano', 'flute', 'marimba'] as const;

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

/**
 * Moment ends (owner report 2026-11-21, "a light pop at the end of every moment"): a compiled
 * piece with a chord arrival, a pin, level ramps, a split and a merge. At every end (glide
 * arrival, level ramp end, life birth or death, weight ramp end) the second-difference detector
 * (more sensitive to gain and slope steps than the first difference) must stay within
 * twice its worst value over the same render's steady stretches (≥ 80 ms from any end). The
 * articulation strike at each arrival (glass) is part of the timbre and must stay smooth. Organ is
 * left out: its top drawbars fill the second difference, so a 10 % step there scores only ~4
 * against a steady ~4.6.
 */
function momentEnds(score: CompiledScore): { t: number; kind: string }[] {
  const ends: { t: number; kind: string }[] = [];
  for (const v of score.voices) {
    for (const s of v.segments) if (s.p0 !== s.p1) ends.push({ t: s.t1, kind: 'arrival' });
    for (const l of v.level) if (l.over > 0) ends.push({ t: l.t + l.over, kind: 'level' });
    for (const w of v.weight ?? []) if (w.over > 0) ends.push({ t: w.t + w.over, kind: 'weight' });
    for (const life of v.lives) {
      if (life.born > 0) ends.push({ t: life.born, kind: 'birth' });
      if (life.died !== undefined) ends.push({ t: life.died, kind: 'death' });
    }
  }
  return ends;
}

function endsPiece(timbre: string): Piece {
  const p = piece({
    pool: 8,
    start: [48, 55, 60, 64],
    glide: { length: 1.2, stagger: 0.3, jitter: 0, arrive: 'together', ease: 'smootherstep' },
    moments: [
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: [50, 57, 62, 65] },
        voicing: 'even',
        assign: 'ordered',
      },
      { type: 'pin', at: 3.5, voice: 'v1', pitch: 45, glide: { length: 0.15, ease: 'smoothstep' } },
      { type: 'level', at: 4.5, target: { voices: ['v2', 'v3'] }, gain: 0.5, over: 0.4 },
      { type: 'split', at: 6, count: 7, voicing: 'even' },
      { type: 'merge', at: 10, count: 3, which: 'top', fade: 1 },
      { type: 'level', at: 13, target: { voices: ['v2', 'v3'] }, gain: 1, over: 0.2 },
    ],
    end: { at: 16, fade: 1 },
  });
  for (const v of p.voices) v.timbre = timbre;
  return p;
}

describe.each(['sine', 'glass'])('click detector, moment ends, %s', (timbre) => {
  const score = compile(endsPiece(timbre));
  const ends = momentEnds(score).filter((e) => e.t > 0.3 && e.t < 15);
  const out = render(score, DRY_MIX, 15.5);
  const score2 = (x: Float32Array, from: number, to: number): number =>
    clickScore(x, from, to, RATE, 0.01, 1e-3, 2).ratio;
  const both = (from: number, to: number): number =>
    Math.max(score2(out.left, from, to), score2(out.right, from, to));
  // Steady: 50 ms windows at least 80 ms from every end.
  let steady = 0;
  for (let t = 0.3; t < 15; t += 0.05) {
    if (ends.some((e) => Math.abs(e.t - t) < 0.08 || Math.abs(e.t - (t + 0.05)) < 0.08)) continue;
    steady = Math.max(steady, both(Math.floor(t * RATE), Math.floor((t + 0.05) * RATE)));
  }
  const threshold = 2 * steady;

  it('covers every kind of end', () => {
    const kinds = new Set(ends.map((e) => e.kind));
    for (const k of ['arrival', 'level', 'birth', 'death', 'weight']) expect(kinds, k).toContain(k);
  });

  it('every moment end stays click-free', () => {
    const worst: Record<string, number> = {};
    for (const e of ends) {
      const r = both(Math.floor((e.t - 0.03) * RATE), Math.floor((e.t + 0.06) * RATE));
      worst[e.kind] = Math.max(worst[e.kind] ?? 0, r);
    }
    console.info(
      `${timbre} ends: steady ${steady.toFixed(3)}, ` +
        Object.entries(worst)
          .map(([k, r]) => `${k} ${r.toFixed(3)}`)
          .join(', '),
    );
    for (const [k, r] of Object.entries(worst)) expect(r, k).toBeLessThanOrEqual(threshold);
  });

  it('catches a 10 % gain step at a moment end (positive control)', () => {
    // What a level or envelope that jumps at a segment end would do; median over the arrivals.
    const ratios: number[] = [];
    for (const e of ends.filter((x) => x.kind === 'arrival')) {
      const at = Math.round(e.t * RATE);
      const x = out.left.slice(at - 480, at + 480);
      for (let i = 480; i < x.length; i++) x[i] *= 1.1;
      ratios.push(score2(x, 470, 490));
    }
    ratios.sort((a, b) => a - b);
    const median = ratios[ratios.length >> 1];
    console.info(`${timbre} ends: 10 % step ${median.toFixed(3)} (median of ${ratios.length})`);
    expect(median).toBeGreaterThan(threshold);
  });
});

/**
 * The same piece's per-voice amplitude, read at every block end (2.7 ms). At glide arrivals, pin
 * arrivals, weight ramp ends and split/merge births and deaths it must be continuous in value and
 * slope: the second difference stays under ENVELOPE_CORNER of the voice's peak. Measured on main:
 * at most 6e-4. A 10 % gain step at control rate scores ~0.1. Glass's articulation strike scored
 * 0.13 (35 % in 12 ms, the owner's moment-end pop); its arrival bloom (build log, "Arrival
 * bloom") must stay under ARRIVAL_STEP. Pluck's crisp strike is the positive control. Level ramps
 * are linear by design (a corner at each end, ~7e-3 for a 0.4 s ramp to half), so their ends are
 * left to the sample test.
 * Fixed (build log, "Merges and splits crossfade"): when gliding lines met in a merge, the unison
 * group gain h stepped by up to 30 % in one block; capture now fades in (tests/dsp/crossfade.test.ts).
 */
const ENVELOPE_CORNER = 0.01;
const ARRIVAL_STEP = 0.03;

function envelopeAtEnds(timbre: string): Record<string, number> {
  const score = compile(endsPiece(timbre));
  const d = new Driver(score, DRY_MIX);
  d.graph.play(0);
  const blocks = Math.round((15 * RATE) / BLOCK_FRAMES);
  const amp = score.voices.map(() => new Float64Array(blocks));
  for (let b = 0; b < blocks; b++) {
    d.run(BLOCK_FRAMES / RATE);
    for (const v of score.voices) amp[v.index][b] = d.graph.voiceAmplitude(v.index);
  }
  const worst: Record<string, number> = {};
  for (const v of score.voices) {
    const a = amp[v.index];
    const peakAmp = a.reduce((m, x) => Math.max(m, x), 0);
    if (peakAmp === 0) continue;
    for (const e of momentEnds({ ...score, voices: [v] })) {
      if (e.kind === 'level' || e.t > 14.9) continue;
      const b0 = Math.round((e.t * RATE) / BLOCK_FRAMES);
      for (let b = Math.max(1, b0 - 4); b <= Math.min(blocks - 2, b0 + 4); b++) {
        const d2 = Math.abs(a[b + 1] - 2 * a[b] + a[b - 1]) / peakAmp;
        worst[e.kind] = Math.max(worst[e.kind] ?? 0, d2);
      }
    }
  }
  console.info(
    `${timbre} envelope corners at ends: ` +
      Object.entries(worst)
        .map(([k, r]) => `${k} ${r.toExponential(2)}`)
        .join(', '),
  );
  return worst;
}

describe('envelope at moment ends', () => {
  it('sine: arrivals, weight ramps, births and deaths are smooth in amplitude', () => {
    const worst = envelopeAtEnds('sine');
    expect(Object.keys(worst).sort()).toEqual(['arrival', 'birth', 'death', 'weight']);
    for (const [k, r] of Object.entries(worst)) expect(r, k).toBeLessThan(ENVELOPE_CORNER);
  });

  it('glass: the arrival bloom stays under ARRIVAL_STEP (0.13 before it)', () => {
    const worst = envelopeAtEnds('glass');
    for (const [k, r] of Object.entries(worst)) {
      expect(r, k).toBeLessThan(k === 'arrival' ? ARRIVAL_STEP : ENVELOPE_CORNER);
    }
  });

  it('pluck: the crisp strike exceeds the bound (positive control)', () => {
    expect(envelopeAtEnds('pluck').arrival).toBeGreaterThan(5 * ENVELOPE_CORNER);
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
