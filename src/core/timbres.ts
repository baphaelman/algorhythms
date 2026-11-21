/**
 * Built-in timbre presets (PLAN.md §8.5, M2 set). Data only: `VoiceDef.timbre` names one of these
 * or a key of `Piece.timbres`, which adds to or overrides them.
 *
 * Harmonic amplitudes are relative (the wavetable builder normalises each table's peak), index 0
 * is the fundamental, and missing partials are 0. `stretch`, `fm` and `noise` are M6 features;
 * of the presets only `bell` uses them.
 */

import type { Timbre } from './types';

/**
 * Choir source: every partial equal before the tilt. The vowel comes from `formants`, at fixed Hz,
 * so it does not slide up and down with the pitch.
 */
const CHOIR_HARMONICS = Array.from({ length: 32 }, () => 1);

/** A classic sung "ah": F1–F3 near 700, 1200 and 2600 Hz, widened a little for an ensemble. */
const CHOIR_FORMANTS = [
  { hz: 700, bw: 130, gain: 1 },
  { hz: 1200, bw: 150, gain: 0.6 },
  { hz: 2600, bw: 220, gain: 0.25 },
  { hz: 3300, bw: 300, gain: 0.1 },
];

/** Hammond-like drawbars 16' 8' 5⅓' 4' 2⅔' 2' (sub-octave folded onto the fundamental). */
const ORGAN_HARMONICS = [1, 0.75, 0.55, 0.5, 0, 0.35, 0, 0.28, 0, 0, 0, 0.12, 0, 0, 0, 0.08];

/** Clarinet-like: odd partials strong, even partials faint, gently falling. */
const REED_HARMONICS = [
  1, 0.04, 0.62, 0.05, 0.42, 0.05, 0.3, 0.04, 0.22, 0.04, 0.16, 0.03, 0.12, 0.03, 0.09, 0.02, 0.07,
  0.02, 0.05, 0.015, 0.04,
];

/** Soft glass: a strong fundamental with a few faint upper partials. */
const GLASS_HARMONICS = [1, 0.06, 0.22, 0.03, 0.1, 0.02, 0.05, 0, 0.025];

/** Plucked string: roughly 1/n with a slight comb dip (plucked about a fifth along the string). */
const PLUCK_HARMONICS = [
  1, 0.48, 0.3, 0.2, 0.06, 0.13, 0.12, 0.09, 0.07, 0.025, 0.05, 0.045, 0.035, 0.03, 0.01, 0.02,
];

/** Bell: seven partials falling off gently; stretched, they sit at n^1.12 (2.17, 3.42, ...). */
const BELL_HARMONICS = [1, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08];

/** Wobble: a soft glass-like tone with a strong fundamental and faint odd partials. */
const WOBBLE_HARMONICS = [1, 0.05, 0.16, 0.02, 0.06, 0, 0.025];

/** The six M2 presets, `wobble` (M3) and `bell` (M6), by name. */
export const BUILTIN_TIMBRES: Record<string, Timbre> = {
  /** Pure sine. Voices meeting mid-glide lock into one steady tone. */
  sine: {
    harmonics: [1],
    stretch: 0,
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0.15,
    articulation: { amount: 0, attack: 0.01, decay: 0.2 },
    vibrato: { rate: 5, depthCents: 0, delay: 0.4 },
  },
  /** Glass harmonica: near-sine with a soft strike on arrival and a little shimmer. */
  glass: {
    harmonics: GLASS_HARMONICS,
    stretch: 0,
    brightness: { tilt: -1.5, track: 0.3 },
    detuneSpread: 1,
    accent: 0.25,
    articulation: { amount: 0.35, attack: 0.004, decay: 0.7 },
    vibrato: { rate: 4.2, depthCents: 4, delay: 0.6 },
  },
  /** Drawbar organ: steady, no vibrato, a small key-click articulation. */
  organ: {
    harmonics: ORGAN_HARMONICS,
    stretch: 0,
    brightness: { tilt: -1, track: 0 },
    detuneSpread: 0.5,
    accent: 0.1,
    articulation: { amount: 0.12, attack: 0.003, decay: 0.08 },
    vibrato: { rate: 6, depthCents: 0, delay: 0 },
  },
  /** Clarinet-like reed: hollow odd-partial tone with a gentle late vibrato. */
  reed: {
    harmonics: REED_HARMONICS,
    stretch: 0,
    brightness: { tilt: -2, track: 0.5 },
    detuneSpread: 1,
    accent: 0.3,
    articulation: { amount: 0.2, attack: 0.02, decay: 0.25 },
    vibrato: { rate: 5, depthCents: 8, delay: 0.5, jitter: 0.4 },
    drift: { cents: 2.5, rate: 0.25, amp: 0.03 },
  },
  /**
   * Choir "ah": fixed-Hz formants, a wide ensemble detune, a soft swell on arrival, gentle
   * irregular vibrato and a slow per-voice pitch and level wander.
   */
  choir: {
    harmonics: CHOIR_HARMONICS,
    stretch: 0,
    brightness: { tilt: -4, track: 0 },
    detuneSpread: 7,
    accent: 0.15,
    articulation: { amount: 0.08, attack: 0.18, decay: 0.8 },
    vibrato: { rate: 5, depthCents: 9, delay: 0.45, jitter: 0.8 },
    formants: CHOIR_FORMANTS,
    drift: { cents: 6, rate: 0.35, amp: 0.06 },
  },
  /** Pluck: bright, strong attack on every arrival that decays back to a quiet sustain. */
  pluck: {
    harmonics: PLUCK_HARMONICS,
    stretch: 0,
    brightness: { tilt: -3, track: 0.5 },
    detuneSpread: 1.5,
    accent: 0.1,
    articulation: { amount: 0.9, attack: 0.002, decay: 0.35 },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
  /**
   * Wobble: soft glass-like partials, a gentle bloom on arrival and a very slow drift. Its
   * `wobble` (unison beating) is ignored since revision 8; the preset keeps its name and sound.
   */
  wobble: {
    harmonics: WOBBLE_HARMONICS,
    stretch: 0,
    brightness: { tilt: -1, track: 0.3 },
    detuneSpread: 0.5,
    accent: 0.2,
    articulation: { amount: 0.2, attack: 0.03, decay: 1.2 },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
    drift: { cents: 1, rate: 0.1 },
    wobble: 3,
  },
  /**
   * Bell (M6): stretched partials (additive path), phase-modulated at a non-integer ratio for the
   * clang, a crisp strike that rings for seconds, and a breath of mallet noise.
   */
  bell: {
    harmonics: BELL_HARMONICS,
    stretch: 0.12,
    fm: { ratio: 1.41, index: 0.35, indexTrack: 0.5 },
    noise: { level: 0.04, bandwidth: 2 },
    brightness: { tilt: -1.5, track: 0.4 },
    detuneSpread: 1,
    accent: 0.1,
    articulation: { amount: 0.75, attack: 0.002, decay: 3, crisp: true },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
};
