/**
 * Built-in timbre presets (PLAN.md §8.5, M2 set). Data, plus `isTimbreName`: `VoiceDef.timbre` and
 * a timbre moment's `preset` name one of these or a key of `Piece.timbres`, which adds to or
 * overrides them.
 *
 * Harmonic amplitudes are relative (the wavetable builder normalises each table's peak), index 0
 * is the fundamental, and missing partials are 0. `stretch`, `fm`, `noise` and `strikePartials`
 * are M6 features, used by `bell` and the M6-c presets (`epiano`, `flute`, `marimba`, `brass`).
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

/** Bell, held: prime, nominal (the octave) and a faint double octave, all harmonic. */
const BELL_HARMONICS = [1, 0.4, 0, 0.1];

/**
 * Bell strike: a church bell's partials relative to the prime (hum 0.5, tierce 1.2, quint 1.5,
 * then the inharmonic upper partials), upper ones dying faster; the hum rings longest.
 */
const BELL_STRIKE = [
  { ratio: 0.5, amp: 0.5, decay: 8 },
  { ratio: 1.2, amp: 0.35, decay: 1.8 },
  { ratio: 1.5, amp: 0.15, decay: 1.4 },
  { ratio: 2.51, amp: 0.2, decay: 0.9 },
  { ratio: 2.67, amp: 0.2, decay: 0.8 },
  { ratio: 3, amp: 0.15, decay: 0.8 },
  { ratio: 3.36, amp: 0.12, decay: 0.6 },
  { ratio: 4.2, amp: 0.12, decay: 0.45 },
  { ratio: 5.33, amp: 0.1, decay: 0.3 },
  { ratio: 6.7, amp: 0.08, decay: 0.2 },
  { ratio: 8.2, amp: 0.05, decay: 0.12 },
];

/** Flute: a strong fundamental, a weak octave and little else; the breath comes from `noise`. */
const FLUTE_HARMONICS = [1, 0.3, 0.1, 0.04, 0.015];

/** Marimba bar: three partials; stretch 0.98 puts them at 1, 3.94 and 8.86 (a tuned bar). */
const MARIMBA_HARMONICS = [1, 0.28, 0.06];

/** Wobble: a soft glass-like tone with a strong fundamental and faint odd partials. */
const WOBBLE_HARMONICS = [1, 0.05, 0.16, 0.02, 0.06, 0, 0.025];

/** The six M2 presets, `wobble` (M3), `bell` (M6) and the M6-c presets, by name. */
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
   * Bell (M6, redesigned; build log "Bell redesign"): a crisp strike of inharmonic church-bell
   * partials that die away, upper ones first, over a harmonic tone that sits under held chords.
   */
  bell: {
    harmonics: BELL_HARMONICS,
    stretch: 0,
    strikePartials: BELL_STRIKE,
    brightness: { tilt: -1, track: 0.4 },
    detuneSpread: 1,
    accent: 0.1,
    articulation: { amount: 0.45, attack: 0.002, decay: 2.5, crisp: true },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
  /**
   * Electric piano (M6-c): a sine carrier phase-modulated 1:1 (a tine-like bark that darkens up
   * the keyboard), a crisp strike that rings down over about a second and a half.
   */
  epiano: {
    harmonics: [1],
    stretch: 0,
    fm: { ratio: 1, index: 1.4, indexTrack: 0.6 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 1.5,
    accent: 0.1,
    articulation: { amount: 0.8, attack: 0.002, decay: 1.5, crisp: true },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
  /**
   * Breathy flute (M6-c): a near-sine tone with band-passed breath noise, a soft bloom on arrival,
   * and a late, slightly irregular vibrato.
   */
  flute: {
    harmonics: FLUTE_HARMONICS,
    stretch: 0,
    noise: { level: 0.045, bandwidth: 0.35 },
    brightness: { tilt: -1, track: 0.3 },
    detuneSpread: 1,
    accent: 0.35,
    articulation: { amount: 0.15, attack: 0.08, decay: 0.4 },
    vibrato: { rate: 5.2, depthCents: 9, delay: 0.35, jitter: 0.5 },
    drift: { cents: 2, rate: 0.3, amp: 0.04 },
  },
  /**
   * Marimba (M6-c): a tuned bar's stretched partials (additive path), a crisp mallet strike with a
   * breath of noise, and a short decay to a faint sustain.
   */
  marimba: {
    harmonics: MARIMBA_HARMONICS,
    stretch: 0.98,
    noise: { level: 0.05, bandwidth: 1.5 },
    brightness: { tilt: -2, track: 0.5 },
    detuneSpread: 0.5,
    accent: 0.1,
    articulation: { amount: 0.85, attack: 0.002, decay: 0.6, crisp: true },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
  /**
   * Soft brass (M6-c): FM 1:1 at a moderate index for the brassy spread of partials, darker up
   * high, with a slow swell on arrival, gentle late vibrato and a little ensemble detune.
   */
  brass: {
    harmonics: [1],
    stretch: 0,
    fm: { ratio: 1, index: 2, indexTrack: 0.8 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 2,
    accent: 0.3,
    articulation: { amount: 0.25, attack: 0.07, decay: 0.5 },
    vibrato: { rate: 5, depthCents: 5, delay: 0.7, jitter: 0.5 },
    drift: { cents: 1.5, rate: 0.2, amp: 0.03 },
  },
};

/** True if `name` is a key of `timbres` (a piece's own presets) or a built-in preset. */
export function isTimbreName(name: string, timbres?: Record<string, Timbre> | null): boolean {
  if (Object.hasOwn(BUILTIN_TIMBRES, name)) return true;
  return !!timbres && typeof timbres === 'object' && Object.hasOwn(timbres, name);
}
