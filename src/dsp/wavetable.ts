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
 * Loudness: tables are scaled so that, at middle C, the timbre has the RMS of a unit sine. Partial
 * phases are fixed per partial index (a Schroeder-like sequence, to keep the crest factor low), so
 * adjacent mips and different timbres crossfade without comb filtering.
 */

import type { Timbre } from '../core/types';

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

/** Pitch at which `brightness.track` has no effect and loudness is normalised (C4). */
const REFERENCE_HZ = 261.6255653005986;
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
  /** Articulation attack, seconds (≥ 1 ms). */
  artAttack: number;
  /** Articulation decay to about 1 % (−40 dB), seconds (≥ 1 ms). */
  artDecay: number;
  /** Vibrato rate in Hz. */
  vibRate: number;
  /** Vibrato depth in cents. */
  vibDepthCents: number;
  /** Vibrato onset delay after arrival, seconds. */
  vibDelay: number;
}

/** Wavetables for one timbre at one sample rate, plus its scalar params. Transferable. */
export interface WavetableSet {
  /** Sample rate the mips were built for. */
  sampleRate: number;
  /** MIP_COUNT tables of WAVETABLE_STRIDE floats each. */
  data: Float32Array<ArrayBuffer>;
  /** sameAsNext[m] = 1 when mip m equals mip m+1 (the oscillator then reads one table). */
  sameAsNext: Uint8Array<ArrayBuffer>;
  /** Scalar timbre parameters. */
  params: TimbreParams;
}

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Extracts and sanitises the scalar parameters of a timbre. */
export function timbreParams(t: Timbre): TimbreParams {
  return {
    detuneSpread: finiteOr(t.detuneSpread, 0),
    accent: Math.max(0, finiteOr(t.accent, 0)),
    artAmount: Math.min(1, Math.max(0, finiteOr(t.articulation.amount, 0))),
    artAttack: Math.max(0.001, finiteOr(t.articulation.attack, 0.01)),
    artDecay: Math.max(0.001, finiteOr(t.articulation.decay, 0.2)),
    vibRate: Math.max(0, finiteOr(t.vibrato.rate, 0)),
    vibDepthCents: Math.max(0, finiteOr(t.vibrato.depthCents, 0)),
    vibDelay: Math.max(0, finiteOr(t.vibrato.delay, 0)),
  };
}

/** Phase of partial n (1-based), fixed per n so every table agrees. */
function partialPhase(n: number): number {
  return (Math.PI * (n - 1) * n) / MAX_HARMONICS;
}

/** Partial amplitudes for one mip (index 0 = fundamental), before normalisation. */
function mipAmplitudes(t: Timbre, tilt: number, maxPartial: number, out: Float64Array): void {
  out.fill(0);
  const count = Math.min(MAX_HARMONICS, t.harmonics.length, maxPartial);
  const exponent = tilt * DB_PER_OCTAVE_TO_EXPONENT;
  for (let k = 0; k < count; k++) {
    const a = finiteOr(t.harmonics[k], 0);
    if (a !== 0) out[k] = a * Math.pow(k + 1, exponent);
  }
}

/** Builds the band-limited mip tables of a timbre for a sample rate. Pure. */
export function buildWavetables(timbre: Timbre, sampleRate: number): WavetableSet {
  const data = new Float32Array(MIP_COUNT * WAVETABLE_STRIDE);
  const sameAsNext = new Uint8Array(MIP_COUNT);
  const nyquist = sampleRate / 2;
  const baseTilt = finiteOr(timbre.brightness.tilt, 0);
  const track = finiteOr(timbre.brightness.track, 0);

  // Normalise so the untracked spectrum (the spectrum at the reference pitch) has unit-sine RMS.
  const ref = new Float64Array(MAX_HARMONICS);
  mipAmplitudes(timbre, baseTilt, MAX_HARMONICS, ref);
  let power = 0;
  for (let k = 0; k < MAX_HARMONICS; k++) power += ref[k] * ref[k];
  const scale = power > 0 ? 1 / Math.sqrt(power) : 0;

  const amps = new Float64Array(MAX_HARMONICS);
  const prevAmps = new Float64Array(MAX_HARMONICS);
  const cycle = new Float64Array(WAVETABLE_SIZE);
  for (let m = 0; m < MIP_COUNT; m++) {
    const fBottom = MIP_BASE_HZ * Math.pow(2, m);
    const maxPartial = Math.floor(nyquist / (2 * fBottom));
    const octaves = Math.min(3, Math.max(-2, Math.log2(fBottom / REFERENCE_HZ)));
    mipAmplitudes(timbre, baseTilt - track * TRACK_DB_PER_OCTAVE * octaves, maxPartial, amps);

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
        for (let i = 0; i < WAVETABLE_SIZE; i++) cycle[i] += a * Math.sin(step * i + phase);
      }
      for (let i = 0; i < WAVETABLE_SIZE; i++) data[offset + i] = cycle[i];
      data[offset + WAVETABLE_SIZE] = cycle[0];
    }
    prevAmps.set(amps);
  }
  return { sampleRate, data, sameAsNext, params: timbreParams(timbre) };
}

/** The buffers of a set, for a postMessage transfer list. */
export function wavetableTransferList(set: WavetableSet): ArrayBuffer[] {
  return [set.data.buffer, set.sameAsNext.buffer];
}
