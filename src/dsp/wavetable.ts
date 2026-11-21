/**
 * Band-limited wavetables (PLAN.md §8.4, §8.5, §8.11).
 *
 * A timbre becomes MIP_COUNT single-cycle tables, one per octave of fundamental frequency. Mip m
 * serves fundamentals from MIP_BASE_HZ·2^m up to MIP_BASE_HZ·2^(m+1); the oscillator crossfades
 * mip m into mip m+1 by the fractional part of log2(f / MIP_BASE_HZ), so long glides have no
 * zipper noise. Because mip m is still heard (fading out) up to the top of its octave, it holds
 * only the partials n with n · MIP_BASE_HZ·2^(m+1) ≤ Nyquist: nothing ever aliases.
 *
 * Building is a pure function of (timbre, sample rate). The live app runs it in a worker and
 * transfers the result to the worklet; the export worker calls it directly.
 *
 * Brightness (§8.5): partial n is scaled by tilt dB per octave of n (relative to the fundamental).
 * With `track` ≠ 0 the tilt follows pitch: each mip uses the tilt at its own fundamental,
 * tilt − track · 3 dB/oct per octave above middle C (clamped to −2..+3 octaves).
 *
 * Formants (`timbre.formants`): each partial is also weighted by a formant envelope evaluated at
 * its frequency in Hz for the mip's bottom fundamental, so the vowel stays at fixed Hz instead of
 * moving with the pitch. Between two mips the oscillator plays both tables' formants slightly
 * shifted (by up to the mip spacing), so formant timbres get finer mips: FORMANT_MIPS_PER_OCTAVE
 * per octave instead of one. A set records its spacing in `mipsPerOctave`.
 *
 * Loudness: tables are scaled so that, at middle C, the timbre has the RMS of a unit sine. Partial
 * phases are fixed per partial index (a Schroeder-like sequence, to keep the crest factor low), so
 * adjacent mips and different timbres crossfade without comb filtering.
 */

import type { Timbre } from '../core/types';
import { BLOOM_ATTACK, CRISP_AMOUNT, MIN_ARTICULATION_ATTACK } from './constants';
import * as pmath from './pmath';

/** Points in one table cycle (a guard point follows, so reads never wrap). */
export const WAVETABLE_SIZE = 2048;
/** Floats per mip: the cycle plus the guard point. */
export const WAVETABLE_STRIDE = WAVETABLE_SIZE + 1;
/** Fundamental at the bottom of mip 0. Lower fundamentals use mip 0. */
export const MIP_BASE_HZ = 20;
/** Mips cover fundamentals from 20 Hz to 40.96 kHz; the top one is empty at 48 kHz. */
export const MIP_COUNT = 11;
/** Partials per timbre (§8.5). */
export const MAX_HARMONICS = 32;
/**
 * Mip spacing for timbres with formants. At 4 per octave a formant is smeared by at most ±9 %
 * (1.5 semitones) halfway between two mips, well inside a formant's bandwidth.
 */
export const FORMANT_MIPS_PER_OCTAVE = 4;

/** Number of mips at a spacing: the same 20 Hz…40.96 kHz span as MIP_COUNT octave mips. */
export function mipCountFor(mipsPerOctave: number): number {
  return (MIP_COUNT - 1) * mipsPerOctave + 1;
}

/** Partials on the additive path (§8.5, "Inharmonic timbres"). */
export const MAX_PARTIALS = 16;
/** Stretch range the engine honours (the schema enforces the same). */
export const STRETCH_MIN = -0.5;
export const STRETCH_MAX = 1;

/**
 * FM (`Voice.synthExt`). Sidebands of the top partial H·f must stay below FM_ALIAS_LIMIT ·
 * Nyquist: the index is capped so that H·f + (H·β + FM_SIDEBAND_MARGIN)·r·f fits (Carson's rule
 * with a margin of three sidebands; tests/dsp/m6.test.ts measures what folds over). β tracking
 * reads the octave above middle C clamped to FM_TRACK_MIN_OCT..FM_TRACK_MAX_OCT.
 */
export const FM_ALIAS_LIMIT = 0.9;
export const FM_SIDEBAND_MARGIN = 3;
export const FM_TRACK_MIN_OCT = -2;
export const FM_TRACK_MAX_OCT = 4;

/**
 * Coherence rows (`WavetableSet.coherence`), COH_STRIDE doubles per row, COH_PER_OCTAVE rows per
 * octave of fundamental from MIP_BASE_HZ (finer than the mips: FM spectra change fast with the
 * tracked index), COH_ROWS in all: the complex amplitude of
 * harmonics 1..MAX_HARMONICS locked to the carrier phase (re, im pairs), the breath noise level
 * (one noise source per voice, so it is coherent between timbres), and the power of everything
 * else (inharmonic partials and sidebands, DC). Units: a sine of amplitude a has power a².
 */
export const COH_NOISE = 2 * MAX_HARMONICS;
export const COH_REST = COH_NOISE + 1;
export const COH_STRIDE = COH_REST + 1;
export const COH_PER_OCTAVE = 8;
export const COH_ROWS = (MIP_COUNT - 1) * COH_PER_OCTAVE + 1;

/** Pitch at which `brightness.track` has no effect and loudness is normalised (C4). */
export const REFERENCE_HZ = 261.6255653005986;
/** Tilt change per octave of pitch at track = 1, in dB/octave. */
const TRACK_DB_PER_OCTAVE = 3;
/** 20·log10(2): converts dB per octave into a power of the partial number. */
const DB_PER_OCTAVE_TO_EXPONENT = 1 / 6.020599913279624;

/** The non-wavetable part of a timbre, as plain numbers for the audio thread. */
export interface TimbreParams {
  /** Extra detune spread in cents (§8.4). */
  detuneSpread: number;
  /** Motion accent amount. */
  accent: number;
  /** Articulation depth 0..1. */
  artAmount: number;
  /**
   * Effective articulation attack, seconds: ≥ MIN_ARTICULATION_ATTACK, and for soft strikes
   * ≥ BLOOM_ATTACK·√amount.
   */
  artAttack: number;
  /** 1 when strikes are crisp (keep their attack, never shared by coincident arrivals), else 0. */
  artCrisp: number;
  /** Articulation decay to about 1 % (−40 dB), seconds (≥ 1 ms). */
  artDecay: number;
  /** Vibrato rate in Hz. */
  vibRate: number;
  /** Vibrato depth in cents. */
  vibDepthCents: number;
  /** Vibrato onset delay after arrival, seconds. */
  vibDelay: number;
  /** Vibrato rate and depth variation per voice and over time, 0..1. */
  vibJitter: number;
  /** Pitch drift depth in cents (0 = off). */
  driftCents: number;
  /** Drift rate in Hz (how fast the wander changes direction). */
  driftRate: number;
  /** Amplitude drift depth as a fraction (0 = off). */
  driftAmp: number;
  /** FM (M6): modulator/carrier frequency ratio, or 0 when FM is off. */
  fmRatio: number;
  /** FM peak phase deviation at middle C, in radians (the classic index β; 0 = off). */
  fmIndex: number;
  /** FM index tracking: β scales by 2^(−indexTrack · octaves above middle C). */
  fmIndexTrack: number;
  /**
   * Highest nonzero partial as a multiple of f (harmonic number, or n^(1+stretch) on the
   * additive path); the FM aliasing cap needs it.
   */
  fmTop: number;
  /** Breath noise (M6): RMS relative to the tone's (unit-sine RMS at middle C); 0 = off. */
  noiseLevel: number;
  /** Breath noise band-pass −3 dB width as a fraction of f (Q = 1 / bandwidth). */
  noiseBandwidth: number;
  /** Inharmonicity (M6): nonzero uses the additive path (`WavetableSet.partialRatio`). */
  stretch: number;
}

/** Wavetables for one timbre at one sample rate, plus its scalar params. Transferable. */
export interface WavetableSet {
  /** Sample rate the mips were built for. */
  sampleRate: number;
  /** Mips per octave of fundamental: 1, or FORMANT_MIPS_PER_OCTAVE for formant timbres. */
  mipsPerOctave: number;
  /** mipCountFor(mipsPerOctave) tables of WAVETABLE_STRIDE floats each. */
  data: Float32Array<ArrayBuffer>;
  /** sameAsNext[m] = 1 when mip m equals mip m+1 (the oscillator then reads one table). */
  sameAsNext: Uint8Array<ArrayBuffer>;
  /** Scalar timbre parameters. */
  params: TimbreParams;
  /**
   * Additive path (M6, `stretch` ≠ 0): frequency ratio n^(1+stretch) of each nonzero partial
   * among the first MAX_PARTIALS, in order. Empty for wavetable timbres.
   */
  partialRatio: Float64Array<ArrayBuffer>;
  /**
   * Additive path: amplitude of each partial per mip (mip m at `m · partialRatio.length + i`),
   * normalised like the tables and shaped by tilt, track and formants at the mip's bottom
   * fundamental. Partials near Nyquist are faded per voice, not here.
   */
  partialAmp: Float64Array<ArrayBuffer>;
  /**
   * What a voice's output holds by pitch, for the timbre crossfade's gain law (`Voice`'s
   * `balanceRoles`) and the unison lock: COH_ROWS rows of COH_STRIDE doubles (see COH_NOISE).
   * Optional: sets without it crossfade at constant amplitude.
   */
  coherence?: Float64Array<ArrayBuffer>;
}

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Extracts and sanitises the scalar parameters of a timbre. */
export function timbreParams(t: Timbre): TimbreParams {
  const artAmount = Math.min(1, Math.max(0, finiteOr(t.articulation.amount, 0)));
  const crisp = t.articulation.crisp ?? artAmount >= CRISP_AMOUNT;
  return {
    detuneSpread: finiteOr(t.detuneSpread, 0),
    accent: Math.max(0, finiteOr(t.accent, 0)),
    artAmount,
    artAttack: Math.max(
      MIN_ARTICULATION_ATTACK,
      crisp ? 0 : BLOOM_ATTACK * Math.sqrt(artAmount),
      finiteOr(t.articulation.attack, 0.01),
    ),
    artCrisp: crisp ? 1 : 0,
    artDecay: Math.max(0.001, finiteOr(t.articulation.decay, 0.2)),
    vibRate: Math.max(0, finiteOr(t.vibrato.rate, 0)),
    vibDepthCents: Math.max(0, finiteOr(t.vibrato.depthCents, 0)),
    vibDelay: Math.max(0, finiteOr(t.vibrato.delay, 0)),
    vibJitter: Math.min(1, Math.max(0, finiteOr(t.vibrato.jitter ?? 0, 0))),
    driftCents: Math.max(0, finiteOr(t.drift?.cents ?? 0, 0)),
    driftRate: Math.max(0, finiteOr(t.drift?.rate ?? 0, 0)),
    driftAmp: Math.min(1, Math.max(0, finiteOr(t.drift?.amp ?? 0, 0))),
    ...extParams(t),
  };
}

/** Effective stretch: clamped, and 0 (the wavetable path) when not finite. */
function cleanStretch(t: Timbre): number {
  return Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, finiteOr(t.stretch, 0)));
}

/** The M6 parameters: FM, noise and stretch, sanitised; all 0 when absent. */
function extParams(
  t: Timbre,
): Pick<
  TimbreParams,
  'fmRatio' | 'fmIndex' | 'fmIndexTrack' | 'fmTop' | 'noiseLevel' | 'noiseBandwidth' | 'stretch'
> {
  const stretch = cleanStretch(t);
  const ratio = Math.min(32, Math.max(0, finiteOr(t.fm?.ratio ?? 0, 0)));
  const index = Math.min(20, Math.max(0, finiteOr(t.fm?.index ?? 0, 0)));
  const fmOn = ratio > 0 && index > 0;
  let top = 0;
  const limit = stretch !== 0 ? MAX_PARTIALS : MAX_HARMONICS;
  for (let k = 0; k < Math.min(limit, t.harmonics.length); k++) {
    if (finiteOr(t.harmonics[k], 0) !== 0) top = k + 1;
  }
  const level = Math.min(4, Math.max(0, finiteOr(t.noise?.level ?? 0, 0)));
  return {
    fmRatio: fmOn ? ratio : 0,
    fmIndex: fmOn ? index : 0,
    fmIndexTrack: fmOn ? Math.min(4, Math.max(-4, finiteOr(t.fm?.indexTrack ?? 0, 0))) : 0,
    fmTop: stretch !== 0 && top > 0 ? pmath.pow(top, 1 + stretch) : top,
    noiseLevel: level,
    noiseBandwidth:
      level > 0 ? Math.min(8, Math.max(0.01, finiteOr(t.noise?.bandwidth ?? 1, 1))) : 1,
    stretch,
  };
}

/** The usable formants of a timbre (finite, positive centre and bandwidth, nonzero gain). */
function cleanFormants(t: Timbre): { hz: number; bw: number; gain: number }[] {
  const out: { hz: number; bw: number; gain: number }[] = [];
  for (const f of t.formants ?? []) {
    const hz = finiteOr(f.hz, 0);
    const bw = finiteOr(f.bw, 0);
    const gain = finiteOr(f.gain, 0);
    if (hz > 0 && bw > 0 && gain > 0) out.push({ hz, bw, gain });
  }
  return out;
}

/**
 * Formant envelope at `hz`: the sum of resonance magnitudes gain / √(1 + ((f − hz) / (bw/2))²),
 * i.e. each formant is `gain` at its centre and −3 dB at ±bw/2. Exported for tests.
 */
export function formantGain(
  formants: readonly { hz: number; bw: number; gain: number }[],
  f: number,
): number {
  let g = 0;
  for (const F of formants) {
    const x = (f - F.hz) / (F.bw / 2);
    g += F.gain / Math.sqrt(1 + x * x);
  }
  return g;
}

/** Phase of partial n (1-based), fixed per n so every table agrees. */
function partialPhase(n: number): number {
  return (Math.PI * (n - 1) * n) / MAX_HARMONICS;
}

/**
 * Partial amplitudes for one mip (index 0 = fundamental), before normalisation. With formants,
 * partial n is also weighted by the formant envelope at n · f0 Hz.
 */
function mipAmplitudes(
  t: Timbre,
  tilt: number,
  maxPartial: number,
  formants: readonly { hz: number; bw: number; gain: number }[],
  f0: number,
  out: Float64Array,
): void {
  out.fill(0);
  const count = Math.min(MAX_HARMONICS, t.harmonics.length, maxPartial);
  const exponent = tilt * DB_PER_OCTAVE_TO_EXPONENT;
  for (let k = 0; k < count; k++) {
    const a = finiteOr(t.harmonics[k], 0);
    if (a === 0) continue;
    out[k] = a * pmath.pow(k + 1, exponent);
    if (formants.length > 0) out[k] *= formantGain(formants, (k + 1) * f0);
  }
}

/** Builds the band-limited mip tables of a timbre for a sample rate. Pure. */
export function buildWavetables(timbre: Timbre, sampleRate: number): WavetableSet {
  const formants = cleanFormants(timbre);
  const mipsPerOctave = formants.length > 0 ? FORMANT_MIPS_PER_OCTAVE : 1;
  const mipCount = mipCountFor(mipsPerOctave);
  const data = new Float32Array(mipCount * WAVETABLE_STRIDE);
  const sameAsNext = new Uint8Array(mipCount);
  const nyquist = sampleRate / 2;
  const baseTilt = finiteOr(timbre.brightness.tilt, 0);
  const track = finiteOr(timbre.brightness.track, 0);

  // Normalise so the untracked spectrum (the spectrum at the reference pitch) has unit-sine RMS.
  const ref = new Float64Array(MAX_HARMONICS);
  mipAmplitudes(timbre, baseTilt, MAX_HARMONICS, formants, REFERENCE_HZ, ref);
  let power = 0;
  for (let k = 0; k < MAX_HARMONICS; k++) power += ref[k] * ref[k];
  const scale = power > 0 ? 1 / Math.sqrt(power) : 0;

  const amps = new Float64Array(MAX_HARMONICS);
  const prevAmps = new Float64Array(MAX_HARMONICS);
  const cycle = new Float64Array(WAVETABLE_SIZE);
  const tableAmps = new Float64Array(mipCount * MAX_HARMONICS);
  for (let m = 0; m < mipCount; m++) {
    // For one mip per octave these are exactly 20·2^m and 2·fBottom, as before formants existed.
    const fBottom = MIP_BASE_HZ * pmath.exp2(m / mipsPerOctave);
    const fTop = fBottom * pmath.exp2(1 / mipsPerOctave);
    const maxPartial = Math.floor(nyquist / fTop);
    const octaves = Math.min(3, Math.max(-2, pmath.log2(fBottom / REFERENCE_HZ)));
    const tilt = baseTilt - track * TRACK_DB_PER_OCTAVE * octaves;
    mipAmplitudes(timbre, tilt, maxPartial, formants, fBottom, amps);
    for (let k = 0; k < MAX_HARMONICS; k++) tableAmps[m * MAX_HARMONICS + k] = amps[k] * scale;

    const offset = m * WAVETABLE_STRIDE;
    let same = m > 0;
    for (let k = 0; k < MAX_HARMONICS && same; k++) same = amps[k] === prevAmps[k];
    if (same) {
      data.copyWithin(offset, offset - WAVETABLE_STRIDE, offset);
      sameAsNext[m - 1] = 1;
    } else {
      cycle.fill(0);
      for (let k = 0; k < MAX_HARMONICS; k++) {
        const a = amps[k] * scale;
        if (a === 0) continue;
        const n = k + 1;
        const phase = partialPhase(n);
        const step = (2 * Math.PI * n) / WAVETABLE_SIZE;
        for (let i = 0; i < WAVETABLE_SIZE; i++) cycle[i] += a * pmath.sin(step * i + phase);
      }
      for (let i = 0; i < WAVETABLE_SIZE; i++) data[offset + i] = cycle[i];
      data[offset + WAVETABLE_SIZE] = cycle[0];
    }
    prevAmps.set(amps);
  }
  const params = timbreParams(timbre);
  const { partialRatio, partialAmp } = buildPartials(
    timbre,
    params.stretch,
    formants,
    mipsPerOctave,
  );
  const coherence = buildCoherence(
    params,
    sampleRate,
    mipsPerOctave,
    tableAmps,
    partialRatio,
    partialAmp,
  );
  return {
    sampleRate,
    mipsPerOctave,
    data,
    sameAsNext,
    params,
    partialRatio,
    partialAmp,
    coherence,
  };
}

/**
 * J_0..J_kmax at z ≥ 0 into `out` (Bessel functions of the first kind): Miller's backward
 * recurrence J_{k−1} = (2k/z)·J_k − J_{k+1}, normalised by J_0 + 2·Σ J_2k = 1.
 */
export function besselJ(z: number, kmax: number, out: Float64Array): void {
  out.fill(0, 0, kmax + 1);
  if (!(z > 1e-12)) {
    out[0] = 1;
    return;
  }
  const start = 2 * Math.ceil((kmax + z + 30) / 2);
  let jNext = 0;
  let j = 1e-300;
  let norm = 0;
  for (let k = start; k > 0; k--) {
    const jPrev = ((2 * k) / z) * j - jNext;
    jNext = j;
    j = jPrev; // J_{k−1}
    const i = k - 1;
    if (i <= kmax) out[i] = j;
    if (i === 0) norm += j;
    else if ((i & 1) === 0) norm += 2 * j;
    if (Math.abs(j) > 1e200) {
      j *= 1e-200;
      jNext *= 1e-200;
      norm *= 1e-200;
      for (let q = i; q <= kmax; q++) out[q] *= 1e-200;
    }
  }
  for (let q = 0; q <= kmax; q++) out[q] /= norm;
}

/**
 * The coherence rows of a set (see COH_STRIDE), each at its fundamental, as the voice
 * synthesises it (the blend of the two mips there): partial n of the table (or additive partial i at R_i) is a·sin(2π·R·φ + θ)
 * with θ = partialPhase. FM at ratio r and index β (tracked and capped as in `Voice.synthExt`)
 * splits it into J_k(R·β)·a at R + k·r for every k; a component on a whole multiple of f is
 * locked to the carrier phase (negative multiples fold over with their sign), anything else is
 * free-running and counts as power only. Pure.
 */
function buildCoherence(
  params: TimbreParams,
  sampleRate: number,
  mipsPerOctave: number,
  tableAmps: Float64Array,
  partialRatio: Float64Array,
  partialAmp: Float64Array,
): Float64Array<ArrayBuffer> {
  const mipCount = mipCountFor(mipsPerOctave);
  const out = new Float64Array(COH_ROWS * COH_STRIDE);
  const P = partialRatio.length;
  const additive = P > 0;
  const count = additive ? P : MAX_HARMONICS;
  const nyq = sampleRate / 2;
  const fm = params.fmIndex > 0 && params.fmRatio > 0;
  const r = params.fmRatio;
  const J = new Float64Array(256);
  for (let row = 0; row < COH_ROWS; row++) {
    const o = row * COH_STRIDE;
    const u = row / COH_PER_OCTAVE;
    const f = MIP_BASE_HZ * pmath.exp2(u);
    // The tables (or partial rows) the oscillator blends there.
    let m = Math.floor(u * mipsPerOctave);
    if (m > mipCount - 2) m = mipCount - 2;
    const w = u * mipsPerOctave - m;
    let beta = 0;
    if (fm) {
      const oct = Math.min(
        FM_TRACK_MAX_OCT,
        Math.max(FM_TRACK_MIN_OCT, pmath.log2(f / REFERENCE_HZ)),
      );
      beta = params.fmIndex * pmath.exp2(-params.fmIndexTrack * oct);
      const room = (FM_ALIAS_LIMIT * nyq) / f;
      const top = Math.min(params.fmTop, room);
      const cap = ((room - top) / r - FM_SIDEBAND_MARGIN) / top;
      if (!(beta <= cap)) beta = cap > 0 ? cap : 0;
    }
    let rest = 0;
    let dc = 0;
    for (let q = 0; q < count; q++) {
      const R = additive ? partialRatio[q] : q + 1;
      const a0 = additive ? partialAmp[m * P + q] : tableAmps[m * MAX_HARMONICS + q];
      const a1 = additive ? partialAmp[(m + 1) * P + q] : tableAmps[(m + 1) * MAX_HARMONICS + q];
      const a = a0 + (a1 - a0) * w;
      if (a === 0) continue;
      // Additive partial q (among the nonzero ones) starts at q(q+1)/(4·MAX_PARTIALS) cycles
      // (Voice.synthExt): partialPhase(q + 1) too.
      const theta = partialPhase(q + 1);
      const cs = pmath.cos(theta);
      const sn = pmath.sin(theta);
      const z = R * beta;
      const kmax = fm ? Math.min(255, Math.ceil(z + 3 * Math.sqrt(z) + 10)) : 0;
      if (fm) besselJ(z, kmax, J);
      else J[0] = 1;
      for (let k = -kmax; k <= kmax; k++) {
        const jk = k < 0 ? ((-k & 1) === 1 ? -J[-k] : J[-k]) : J[k];
        const A = a * jk;
        if (A === 0) continue;
        const h = R + k * r;
        const n = Math.round(h);
        if (Math.abs(h - n) > 1e-9) rest += A * A;
        else if (n === 0) dc += A * sn;
        else if (Math.abs(n) > MAX_HARMONICS) rest += A * A;
        else if (n > 0) {
          out[o + 2 * (n - 1)] += A * cs;
          out[o + 2 * (n - 1) + 1] += A * sn;
        } else {
          // sin(−2π|n|φ + θ) = −sin(2π|n|φ − θ).
          out[o + 2 * (-n - 1)] -= A * cs;
          out[o + 2 * (-n - 1) + 1] += A * sn;
        }
      }
    }
    out[o + COH_NOISE] = params.noiseLevel;
    out[o + COH_REST] = rest + 2 * dc * dc;
  }
  return out;
}

/**
 * The additive path's partials (§8.5, "Inharmonic timbres"): the nonzero partials n among the
 * first MAX_PARTIALS at ratio n^(1+stretch), with per-mip amplitudes. Tilt applies per octave of
 * the ratio, track and formants per mip as for the tables, and the set is normalised to
 * unit-sine RMS at the reference pitch. Empty when stretch is 0.
 */
function buildPartials(
  t: Timbre,
  stretch: number,
  formants: readonly { hz: number; bw: number; gain: number }[],
  mipsPerOctave: number,
): { partialRatio: Float64Array<ArrayBuffer>; partialAmp: Float64Array<ArrayBuffer> } {
  if (stretch === 0) return { partialRatio: new Float64Array(0), partialAmp: new Float64Array(0) };
  const idx: number[] = [];
  for (let k = 0; k < Math.min(MAX_PARTIALS, t.harmonics.length); k++) {
    if (finiteOr(t.harmonics[k], 0) !== 0) idx.push(k);
  }
  const P = idx.length;
  const partialRatio = new Float64Array(P);
  for (let i = 0; i < P; i++) partialRatio[i] = pmath.pow(idx[i] + 1, 1 + stretch);
  const baseTilt = finiteOr(t.brightness.tilt, 0);
  const track = finiteOr(t.brightness.track, 0);
  const amps = (tilt: number, f0: number, out: Float64Array, offset: number): void => {
    const exponent = tilt * DB_PER_OCTAVE_TO_EXPONENT;
    for (let i = 0; i < P; i++) {
      const r = partialRatio[i];
      let a = finiteOr(t.harmonics[idx[i]], 0) * pmath.pow(r, exponent);
      if (formants.length > 0) a *= formantGain(formants, r * f0);
      out[offset + i] = a;
    }
  };
  const ref = new Float64Array(P);
  amps(baseTilt, REFERENCE_HZ, ref, 0);
  let power = 0;
  for (let i = 0; i < P; i++) power += ref[i] * ref[i];
  const scale = power > 0 ? 1 / Math.sqrt(power) : 0;
  const mipCount = mipCountFor(mipsPerOctave);
  const partialAmp = new Float64Array(mipCount * P);
  for (let m = 0; m < mipCount; m++) {
    const fBottom = MIP_BASE_HZ * pmath.exp2(m / mipsPerOctave);
    const octaves = Math.min(3, Math.max(-2, pmath.log2(fBottom / REFERENCE_HZ)));
    amps(baseTilt - track * TRACK_DB_PER_OCTAVE * octaves, fBottom, partialAmp, m * P);
    for (let i = 0; i < P; i++) partialAmp[m * P + i] *= scale;
  }
  return { partialRatio, partialAmp };
}

/** The buffers of a set, for a postMessage transfer list. */
export function wavetableTransferList(set: WavetableSet): ArrayBuffer[] {
  const list: ArrayBuffer[] = [set.data.buffer, set.sameAsNext.buffer];
  if (set.partialRatio.byteLength > 0) list.push(set.partialRatio.buffer, set.partialAmp.buffer);
  if (set.coherence) list.push(set.coherence.buffer);
  return list;
}
