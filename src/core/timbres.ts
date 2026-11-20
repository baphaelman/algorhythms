/**
 * Built-in timbre presets (PLAN.md §8.5, M2 set). Data only: `VoiceDef.timbre` names one of these
 * or a key of `Piece.timbres`, which adds to or overrides them.
 *
 * Harmonic amplitudes are relative (the wavetable builder normalises each table's peak), index 0
 * is the fundamental, and missing partials are 0. `stretch`, `fm` and `noise` are M6 features and
 * are left at their neutral values here.
 */

import type { Timbre } from './types';

/** Vowel "ah"-like weights: formant peaks near partials 3–4 and 10–12 for a voice around A3. */
const CHOIR_HARMONICS = [
  0.55, 0.7, 1, 0.85, 0.45, 0.25, 0.14, 0.1, 0.12, 0.2, 0.26, 0.2, 0.11, 0.06, 0.04, 0.03, 0.02,
  0.015, 0.01,
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

/** The six M2 presets, by name. */
export const BUILTIN_TIMBRES: Record<string, Timbre> = {
  /** Pure sine; the always-on detune (1-cent floor) is all that animates unisons. */
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
    vibrato: { rate: 5, depthCents: 8, delay: 0.5 },
  },
  /** Choir "ah": formant-weighted harmonics, wider chorus detune, singer's vibrato. */
  choir: {
    harmonics: CHOIR_HARMONICS,
    stretch: 0,
    brightness: { tilt: -1.5, track: 0.2 },
    detuneSpread: 4,
    accent: 0.2,
    articulation: { amount: 0.1, attack: 0.06, decay: 0.4 },
    vibrato: { rate: 5.5, depthCents: 14, delay: 0.35 },
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
};
