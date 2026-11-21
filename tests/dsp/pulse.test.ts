/**
 * Pulse in sound (R9-3b; PLAN §6.2 `pulse`, build log "R9-3b"). Each hit multiplies the voice's
 * level by its envelope: a smootherstep onset over an attack that follows the arrival bloom, the
 * accent at t + attack, the specified fall to floor × accent by t + decay. Hits re-strike the
 * articulation (share 1, the timbre's own crisp). Measured on offline renders, never by ear.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX } from '../../src/audio/fixtures/scores';
import { createLoadedGraph, renderOffline } from '../../src/audio/offline';
import { compile } from '../../src/core/compiler/compile';
import { flatten } from '../../src/core/flat';
import { pulseGainAt } from '../../src/core/pulse';
import type { CompiledScore, Piece, PulseRecord } from '../../src/core/types';
import { BLOCK_FRAMES, BLOOM_ATTACK, LIMITER_LOOKAHEAD } from '../../src/dsp/constants';
import { computeStrikeShares, VoiceData } from '../../src/dsp/voice';
import { crossfadePiece } from '../unit/core/crossfade-fixtures';
import { GATE_PATTERN, pulseChordPiece, pulseGatePiece } from '../unit/core/pulse-fixtures';
import { clickScore, RATE } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

/** The bloom's envelope bound (clicks.test, arrival-bloom.test). */
const ARRIVAL_STEP = 0.03;
const LAG = Math.round(LIMITER_LOOKAHEAD * RATE);

const hitsOf = (s: CompiledScore, v: number): PulseRecord[] =>
  (s.voices[v].pulse ?? []).filter((r) => r.hit);

function mono(p: Piece, seconds: number): { score: CompiledScore; x: Float32Array } {
  const score = compile(p);
  const frames = Math.ceil((seconds * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  const out = renderOffline({ score, mix: DRY_MIX, sampleRate: RATE }, frames);
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) x[i] = out.left[i] + out.right[i];
  return { score, x };
}

/** Peak |x| over one 440 Hz period centred at time t (output time, lag removed). */
function envAt(x: Float32Array, t: number): number {
  const c = Math.round(t * RATE) + LAG;
  let m = 0;
  for (let i = c - 55; i <= c + 55; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

/** Per-voice amplitude at every block end. */
function amplitudes(score: CompiledScore, seconds: number, unlocked = false): Float64Array[] {
  const g = createLoadedGraph({ score, mix: DRY_MIX, sampleRate: RATE, unlocked });
  g.play(0);
  const blocks = Math.round((seconds * RATE) / BLOCK_FRAMES);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  const amp = score.voices.map(() => new Float64Array(blocks));
  for (let b = 0; b < blocks; b++) {
    g.process(bl, br);
    for (const v of score.voices) amp[v.index][b] = g.voiceAmplitude(v.index);
  }
  return amp;
}

describe('pulse gate on a sine (floor 0)', () => {
  const { score, x } = mono(pulseGatePiece('sine'), 6);
  const hits = hitsOf(score, 0);

  it('hits on every step of the pattern', () => {
    expect(hits.map((h) => h.t)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
    expect(hits.map((h) => h.accent)).toEqual([...GATE_PATTERN, ...GATE_PATTERN]);
  });

  it('each onset is within 1 ms of its hit (silence before it)', () => {
    let worst = 0;
    for (const h of hits.slice(1)) {
      const at = Math.round(h.t * RATE) + LAG;
      // Silent from the previous hit's decay end to the onset.
      for (let i = at - Math.round(0.15 * RATE); i < at; i++) expect(x[i]).toBe(0);
      let n = at;
      while (x[n] === 0) n++;
      const err = (n - at) / RATE;
      worst = Math.max(worst, err);
      expect(err).toBeGreaterThanOrEqual(0);
      expect(err).toBeLessThan(0.001);
    }
    console.info(`pulse onsets: worst ${(worst * 1000).toFixed(3)} ms after the hit`);
  });

  it('per-hit peaks follow the accents', () => {
    const peaks = hits.map((h) => {
      let m = 0;
      const a = Math.round(h.t * RATE) + LAG;
      for (let i = a; i < a + 0.45 * RATE; i++) m = Math.max(m, Math.abs(x[i]));
      return m / h.accent;
    });
    const ratio = peaks.map((p) => p / Math.max(...peaks));
    console.info(`pulse peaks / accent (normalised): ${ratio.map((r) => r.toFixed(4)).join(' ')}`);
    for (const r of ratio) expect(Math.abs(r - 1)).toBeLessThan(0.01);
  });

  it('falls to the floor (0) by t + decay and stays there', () => {
    for (const h of hits) {
      const end = Math.round((h.t + h.decay) * RATE) + LAG + 32;
      for (let i = end; i < Math.round((h.t + 0.5) * RATE) + LAG; i++) expect(x[i]).toBe(0);
      expect(envAt(x, h.t + h.decay - 0.03)).toBeGreaterThan(0);
    }
  });
});

describe('pulse gate on a sine (floor 0.2)', () => {
  const { score, x } = mono(pulseGatePiece('sine', { floor: 0.2 }), 6);
  const hits = hitsOf(score, 0);
  const full = envAt(x, 0.8);

  it('reaches accent × floor at t + decay and holds it to the next hit', () => {
    const errs: number[] = [];
    for (const h of hits) {
      for (const dt of [h.decay + 0.005, h.decay + 0.1, 0.49]) {
        const want = full * h.accent * h.floor;
        errs.push(Math.abs(envAt(x, h.t + dt) - want) / want);
      }
      // Still above the floor halfway down the decay.
      expect(envAt(x, h.t + h.decay / 2)).toBeGreaterThan(full * h.accent * h.floor * 1.05);
    }
    console.info(`pulse floor: worst error ${(Math.max(...errs) * 100).toFixed(3)} %`);
    for (const e of errs) expect(e).toBeLessThan(0.01);
  });

  it('jumps above the floor back to 1 when the pulse ends', () => {
    expect(envAt(x, 5.3) / full).toBeGreaterThan(0.99);
  });
});

/** Every pulse record time and every other change (arrivals, births, deaths) in a score. */
function changeTimes(score: CompiledScore): number[] {
  const out: number[] = [];
  for (const v of score.voices) {
    for (const r of v.pulse ?? []) out.push(r.t, r.t + r.decay);
    for (const s of v.segments) if (s.p0 !== s.p1) out.push(s.t0, s.t1);
    for (const l of v.lives) out.push(l.born, l.died ?? Infinity);
  }
  return out;
}

describe.each(['sine', 'glass', 'pluck'])('pulse onsets stay click-free, %s', (timbre) => {
  const score = compile(pulseChordPiece(timbre));
  const frames = Math.ceil((10.5 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  const out = renderOffline({ score, mix: DRY_MIX, sampleRate: RATE }, frames);
  const s2 = (x: Float32Array, a: number, b: number): number =>
    clickScore(x, a, b, RATE, 0.01, 1e-3, 2).ratio;
  const both = (from: number, to: number): number => {
    const a = Math.floor(from * RATE) + LAG;
    const b = Math.floor(to * RATE) + LAG;
    return Math.max(s2(out.left, a, b), s2(out.right, a, b));
  };
  const changes = changeTimes(score);
  let steady = 0;
  for (let t = 0.3; t < 10.3; t += 0.02) {
    if (changes.some((c) => c > t - 0.08 && c < t + 0.1)) continue;
    steady = Math.max(steady, both(t, t + 0.02));
  }
  const onsets = [...new Set(score.voices.flatMap((v) => hitsOf(score, v.index).map((h) => h.t)))];

  it('the sample detector at every hit onset stays within 2× the steady signal', () => {
    let worst = 0;
    for (const t of onsets) worst = Math.max(worst, both(t - 0.01, t + 0.06));
    console.info(`${timbre} pulse onsets: steady ${steady.toFixed(3)}, worst ${worst.toFixed(3)}`);
    if (timbre !== 'pluck') expect(worst).toBeLessThanOrEqual(2 * steady);
  });

  it('the amplitude envelope rises within the bloom bound (crisp pluck excepted)', () => {
    const amp = amplitudes(score, 10.5);
    let rise = 0;
    let hit = 0;
    for (const v of score.voices) {
      const a = amp[v.index];
      const peakAmp = a.reduce((m, x) => Math.max(m, x), 0);
      if (peakAmp === 0) continue;
      for (const h of hitsOf(score, v.index)) {
        const b0 = Math.floor((h.t * RATE) / BLOCK_FRAMES);
        const bA = Math.ceil(((h.t + BLOOM_ATTACK) * RATE) / BLOCK_FRAMES);
        const bEnd = Math.ceil(((h.t + h.decay) * RATE) / BLOCK_FRAMES);
        for (let b = Math.max(1, b0 - 1); b <= bEnd && b + 1 < a.length; b++) {
          const d2 = Math.abs(a[b + 1] - 2 * a[b] + a[b - 1]) / peakAmp;
          if (b <= bA) rise = Math.max(rise, d2);
          hit = Math.max(hit, d2);
        }
      }
    }
    console.info(`${timbre} pulse envelope: rise ${rise.toFixed(4)}, whole hit ${hit.toFixed(4)}`);
    if (timbre === 'pluck') expect(rise).toBeGreaterThan(ARRIVAL_STEP);
    else expect(rise).toBeLessThan(ARRIVAL_STEP);
  });
});

describe('pulse strikes', () => {
  const peaksOf = (p: Piece): number[] => {
    const { score, x } = mono(p, 6);
    return hitsOf(score, 0).map((h) => {
      let m = 0;
      const a = Math.round(h.t * RATE) + LAG;
      for (let i = a; i < a + 0.45 * RATE; i++) m = Math.max(m, Math.abs(x[i]));
      return m / h.accent;
    });
  };

  it('re-strike the articulation on every hit; strike: false does not', () => {
    const on = peaksOf(pulseGatePiece('pluck', { floor: 0.5 }));
    const off = peaksOf(pulseGatePiece('pluck', { floor: 0.5, strike: false }));
    console.info(
      `pluck peaks / accent, strike: ${on.map((p) => (p / on[0]).toFixed(3)).join(' ')}; ` +
        `no strike: ${off.map((p) => (p / on[0]).toFixed(3)).join(' ')}`,
    );
    for (const p of on) expect(Math.abs(p / on[0] - 1)).toBeLessThan(0.05);
    for (let i = 1; i < on.length; i++) expect(on[i] / off[i]).toBeGreaterThan(3);
  });

  it('are never shared (share 1) while arrivals keep their bloom shares', () => {
    const score = compile(pulseChordPiece('glass'));
    const flat = flatten(score);
    const slotOf = new Int32Array(flat.timbreNames.length);
    const data = flat.voices.map((fv, i) => VoiceData.fromFlat(fv, flat.voiceParams, i, slotOf));
    computeStrikeShares(data);
    let arrivalShared = 0;
    for (const v of score.voices) {
      const d = data[v.index];
      const hitT = new Set(hitsOf(score, v.index).map((h) => h.t));
      for (let k = 0; k < d.nStrike; k++) {
        if (hitT.has(d.strikeT[k])) expect(d.strikeShare[k]).toBe(1);
        else if (d.strikeShare[k] < 1) arrivalShared++;
      }
      // Every hit strikes (strike defaults to true).
      for (const t of hitT) expect(Array.from(d.strikeT)).toContain(t);
    }
    expect(arrivalShared).toBeGreaterThan(0);
  });
});

/** Level in effect at t (linear ramps from the level before; 1 before the first). */
function levelOf(v: CompiledScore['voices'][number], t: number): number {
  let level = 1;
  let start = 1;
  v.level.forEach((e, i) => {
    if (e.t > t) return;
    if (i > 0) {
      const p = v.level[i - 1];
      const u = p.over > 0 ? (e.t - p.t) / p.over : 1;
      start += (p.gain - start) * (u >= 1 ? 1 : u);
    }
    const u = e.over > 0 ? (t - e.t) / e.over : 1;
    level = u >= 1 ? e.gain : start + (e.gain - start) * u;
  });
  return level;
}

describe('pulse multiplies crossfade weights and level moments', () => {
  it('amplitude with pulse and level = without × pulse × level, through merges and splits', () => {
    const ref = compile(crossfadePiece('sine'));
    const p = crossfadePiece('sine');
    p.moments.push(
      {
        id: 'pz',
        type: 'pulse',
        at: 0.5,
        until: 15,
        step: 0.4,
        pattern: [1, 0.5],
        decay: 0,
        floor: 0.8,
        mode: 'together',
        strike: false,
      },
      { id: 'lz', type: 'level', at: 8, target: 'all', gain: 0.6, over: 0.5 },
    );
    const score = compile(p);
    expect(score.voices.map((v) => v.segments)).toEqual(ref.voices.map((v) => v.segments));
    expect(score.voices.map((v) => v.lives)).toEqual(ref.voices.map((v) => v.lives));
    // Unlocked: a unison group's gain h couples its members' levels (as for level moments).
    const a = amplitudes(score, 15, true);
    const b = amplitudes(ref, 15, true);
    let worst = 0;
    let checked = 0;
    for (const v of score.voices) {
      const recs = v.pulse ?? [];
      const peakAmp = b[v.index].reduce((m, x) => Math.max(m, x), 0);
      for (let k = 0; k < a[v.index].length; k++) {
        const t = ((k + 1) * BLOCK_FRAMES) / RATE;
        if (!(b[v.index][k] > 1e-3 * peakAmp)) continue;
        // Past each record's onset (decay 0: the gain is then accent × floor, as core says).
        if (recs.some((r) => t >= r.t && t < r.t + BLOOM_ATTACK + 0.01)) continue;
        const want = pulseGainAt(v, t) * levelOf(v, t);
        worst = Math.max(worst, Math.abs(a[v.index][k] / b[v.index][k] - want));
        checked++;
      }
    }
    console.info(
      `pulse × crossfade × level: worst ratio error ${worst.toExponential(2)} over ${checked} blocks`,
    );
    expect(checked).toBeGreaterThan(5000);
    expect(worst).toBeLessThan(1e-9);
  });
});
