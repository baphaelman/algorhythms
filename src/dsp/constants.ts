/**
 * Fixed sizes of the DSP graph (PLAN.md §8.1, §8.4, §8.11).
 *
 * The DSP may import only types from core (plus core/ease and core/segment), so constants that
 * also exist in core/types.ts (MAX_VOICES) are restated here.
 */

/** Frames per processing block. Both hosts (worklet and export worker) use exactly this (§8.1). */
export const BLOCK_FRAMES = 128;

/**
 * Frames per control tick. Pitch, envelopes, pan and the mip choice are evaluated once per tick
 * and interpolated linearly per sample in between (§8.4's control-rate option, §8.9 fallback 1).
 * Must divide BLOCK_FRAMES.
 */
export const CONTROL_PERIOD = 16;

/** Maximum pool size; equals core/types.ts MAX_VOICES. */
export const DSP_MAX_VOICES = 32;

/** Ghost voices available for seek, loop and swap crossfades (two per voice). */
export const MAX_GHOSTS = 2 * DSP_MAX_VOICES;

/** Maximum distinct timbres (wavetable slots) a graph holds at once. */
export const MAX_TIMBRE_SLOTS = 64;

/** Base amplitude of one voice before normalisation (the prototype used 0.2). */
export const VOICE_BASE_GAIN = 0.25;

/** Shortest life fade, so a zero-length fade still cannot click (seconds). */
export const MIN_LIFE_FADE = 0.005;

/**
 * Shortest articulation attack (seconds; M4.5-32). The attack is a smootherstep; shorter ones
 * tick at arrivals, loudest when every moving voice arrives on the same sample.
 */
export const MIN_ARTICULATION_ATTACK = 0.012;

/** Crossfade length for seek, loop wrap, play and pause (§8.7), in seconds. */
export const SEEK_FADE = 0.005;

/** Crossfade and slew length for hot-swap (§8.7), in seconds. */
export const SWAP_FADE = 0.02;

/** A swap that moves a voice's pitch by more than this many semitones crossfades instead of slewing. */
export const SWAP_CROSSFADE_SEMITONES = 0.5;

/** Time constant of the sum-normalisation smoother g_n (§8.4), in seconds. */
export const NORM_SMOOTHING = 0.05;

/** Limiter look-ahead (§8.6), in seconds. */
export const LIMITER_LOOKAHEAD = 0.005;

/** Ramp time for a mute or solo change, in seconds. */
export const MUTE_RAMP = 0.02;
