/**
 * Arrival bloom (build log, "Arrival bloom"). When a glide arrives at a new pitch the timbre's
 * articulation strikes. On a held tone a fast strike reads as a pop ("a light pop at the end of
 * every moment", owner, version 29), loudest when every chord voice strikes on one sample.
 *
 * Measure (the moment-end "step" metric of clicks.test.ts): each voice's amplitude, read at every
 * block end (2.7 ms), and its second difference over the strike's peak, worst over the arrival
 * and the decay after it. Four voices move chord to chord and arrive together (stagger 0). Before
 * the bloom: glass 0.086, organ 0.031, reed 0.019, pluck 0.22. Every preset but pluck must stay
 * at or under ARRIVAL_STEP, solo or in the chord, and so must the chord's summed amplitude. Pluck
 * keeps its crisp 12 ms attack (owner, 2026-11-21) and must stay above PLUCK_CRISP.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX, makeScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { createLoadedGraph } from '../../src/audio/offline';
import { flatten } from '../../src/core/flat';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { CompiledScore, Timbre } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { computeStrikeShares, VoiceData } from '../../src/dsp/voice';
import { timbreParams } from '../../src/dsp/wavetable';
import { RATE } from './helpers';

vi.setConfig({ testTimeout: 30_000 });

const ARRIVAL_STEP = 0.03;
const PLUCK_CRISP = 0.1;
const ARRIVE = 3;
const SECONDS = 4.5;

/** n lines, chord to chord from 1 s; the first glide ends at ARRIVE, the others `stagger` s apart. */
function chordToChord(timbre: string, stagger = 0, n = 4): CompiledScore {
  const from = [45, 48, 52, 55];
  const to = [47, 50, 53, 57];
  const specs: VoiceSpec[] = [];
  for (let i = 0; i < n; i++) {
    const end = ARRIVE + i * stagger;
    specs.push({
      id: `l${i}`,
      start: from[i],
      moves: [{ at: 1, to: to[i], len: end - 1 }],
      timbre,
    });
  }
  return makeScore(specs, SECONDS, 3);
}

/** Per-voice amplitude at every block end. */
function amplitudes(score: CompiledScore, timbres?: Record<string, Timbre>): Float64Array[] {
  const g = createLoadedGraph({ score, mix: DRY_MIX, sampleRate: RATE, timbres });
  g.play(0);
  const blocks = Math.round((SECONDS * RATE) / BLOCK_FRAMES);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  const amp = score.voices.map(() => new Float64Array(blocks));
  for (let b = 0; b < blocks; b++) {
    g.process(bl, br);
    for (const v of score.voices) amp[v.index][b] = g.voiceAmplitude(v.index);
  }
  return amp;
}

const B0 = Math.floor(((ARRIVE - 0.02) * RATE) / BLOCK_FRAMES);
const B1 = Math.ceil(((SECONDS - 0.3) * RATE) / BLOCK_FRAMES);

/** Worst |Δ²a| ÷ peak over [ARRIVE − 20 ms, SECONDS − 0.3 s]. */
function step(a: Float64Array): number {
  let pk = 0;
  for (let b = B0; b <= B1; b++) pk = Math.max(pk, a[b]);
  let w = 0;
  for (let b = B0; b <= B1; b++) w = Math.max(w, Math.abs(a[b + 1] - 2 * a[b] + a[b - 1]) / pk);
  return w;
}

function arrivalStep(score: CompiledScore): { voice: number; sum: number } {
  const amp = amplitudes(score);
  const sum = new Float64Array(amp[0].length);
  for (const a of amp) for (let b = 0; b < a.length; b++) sum[b] += a[b];
  return { voice: Math.max(...amp.map(step)), sum: step(sum) };
}

const NAMES = Object.keys(BUILTIN_TIMBRES);

describe('arrival bloom: step at arrivals', () => {
  const chord = Object.fromEntries(NAMES.map((t) => [t, arrivalStep(chordToChord(t))]));
  const solo = Object.fromEntries(NAMES.map((t) => [t, arrivalStep(chordToChord(t, 0, 1))]));
  console.info(
    'arrival step (chord voice / chord sum / solo): ' +
      NAMES.map(
        (t) =>
          `${t} ${chord[t].voice.toFixed(4)}/${chord[t].sum.toFixed(4)}/${solo[t].voice.toFixed(4)}`,
      ).join(', '),
  );

  // Crisp strikes (pluck, bell) are notes, not blooms.
  const soft = NAMES.filter((t) => timbreParams(BUILTIN_TIMBRES[t]).artCrisp === 0);
  it.each(soft)('%s: under the bar, in a chord and solo', (t) => {
    expect(chord[t].voice).toBeLessThanOrEqual(ARRIVAL_STEP);
    expect(chord[t].sum).toBeLessThanOrEqual(ARRIVAL_STEP);
    expect(solo[t].voice).toBeLessThanOrEqual(ARRIVAL_STEP);
  });

  it('pluck keeps its crisp strike, in a chord and solo', () => {
    expect(chord.pluck.voice).toBeGreaterThan(PLUCK_CRISP);
    expect(solo.pluck.voice).toBeGreaterThan(PLUCK_CRISP);
  });
});

describe('arrival bloom: envelope', () => {
  it('soft strikes bloom over 50 ms·√amount; crisp ones keep the 12 ms floor', () => {
    const p = (t: Timbre) => timbreParams(t);
    expect(p(BUILTIN_TIMBRES.glass).artAttack).toBeCloseTo(0.05 * Math.sqrt(0.35), 6);
    expect(p(BUILTIN_TIMBRES.organ).artAttack).toBeCloseTo(0.05 * Math.sqrt(0.12), 6);
    expect(p(BUILTIN_TIMBRES.choir).artAttack).toBe(0.18);
    expect(p(BUILTIN_TIMBRES.pluck)).toMatchObject({ artAttack: 0.012, artCrisp: 1 });
    expect(p(BUILTIN_TIMBRES.glass).artCrisp).toBe(0);
    // An explicit flag overrides the amount rule both ways.
    const glass = BUILTIN_TIMBRES.glass;
    const crispGlass = { ...glass, articulation: { ...glass.articulation, crisp: true } };
    expect(p(crispGlass)).toMatchObject({ artAttack: 0.012, artCrisp: 1 });
    const pluck = BUILTIN_TIMBRES.pluck;
    const softPluck = { ...pluck, articulation: { ...pluck.articulation, crisp: false } };
    expect(p(softPluck).artAttack).toBeCloseTo(0.05 * Math.sqrt(0.9), 6);
  });

  it('coincident arrivals share one bloom (1/√k); spread ones strike in full', () => {
    const shares = (score: CompiledScore): number[] => {
      const flat = flatten(score);
      const slotOf = new Int32Array(flat.timbreNames.length);
      const data = flat.voices.map((v, i) => VoiceData.fromFlat(v, flat.voiceParams, i, slotOf));
      computeStrikeShares(data);
      // The hold after the glide: its arrival is ARRIVE (+ stagger).
      return data.map((d) => d.share[d.nSeg - 1]);
    };
    for (const s of shares(chordToChord('glass'))) expect(s).toBeCloseTo(0.5, 9);
    for (const s of shares(chordToChord('glass', 0.3))) expect(s).toBe(1);
    for (const s of shares(chordToChord('glass', 0, 1))) expect(s).toBe(1);
    // Within the window the weight falls smoothly: 20 ms apart counts half.
    const two = shares(chordToChord('glass', 0.02, 2));
    for (const s of two) expect(s).toBeCloseTo(1 / Math.sqrt(1.5), 9);
  });

  it('the share lowers the bloom, not the held level', () => {
    const glass = BUILTIN_TIMBRES.glass;
    // Same attack and decay, but crisp: rises to the full amount in a chord.
    const full = {
      ...glass,
      articulation: { ...glass.articulation, attack: 0.05 * Math.sqrt(0.35), crisp: true },
    };
    const score = chordToChord('g');
    const shared = amplitudes(score, { g: glass })[0];
    const whole = amplitudes(score, { g: full })[0];
    const at = (s: number) => Math.round((s * RATE) / BLOCK_FRAMES);
    const before = shared[at(ARRIVE - 0.01)];
    let peakShared = 0;
    let peakWhole = 0;
    for (let b = at(ARRIVE); b < at(ARRIVE + 0.1); b++) {
      peakShared = Math.max(peakShared, shared[b]);
      peakWhole = Math.max(peakWhole, whole[b]);
    }
    const db = (x: number) => 20 * Math.log10(x);
    console.info(
      `glass chord bloom: shared +${db(peakShared / before).toFixed(2)} dB, ` +
        `unshared +${db(peakWhole / before).toFixed(2)} dB`,
    );
    expect(db(peakShared / before)).toBeLessThan(0.6 * db(peakWhole / before));
    expect(db(peakShared / before)).toBeGreaterThan(1);
    // After the decay (to 1 % in 0.7 s) both sit at 1 − amount.
    const late = at(ARRIVE + 1.2);
    expect(shared[late] / whole[late]).toBeCloseTo(1, 3);
  });
});
