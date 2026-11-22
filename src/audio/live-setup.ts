/**
 * The voices, timbres and mix live mode plays with (PLAN.md §9), taken from the piece at the
 * playhead, and the live score the worklet loads for them.
 */

import { keyAt, lifeAt, pitchAt } from '../core/query';
import type { CompiledScore, Key, MixSettings, Piece, Pitch, Seconds, Timbre } from '../core/types';

/** One live voice. */
export interface LiveVoiceSetup {
  id: string;
  range: [Pitch, Pitch];
  /** Timbre preset name (a key of `timbres` or a built-in). */
  timbre: string;
  /** Pitch it starts on (silent until the first key). */
  pitch: Pitch;
  gain: number;
  pan: number | 'auto';
  mute: boolean;
  solo: boolean;
  sends: { reverb?: number; delay?: number };
}

/** Everything live mode needs from the piece. */
export interface LiveSetup {
  voices: LiveVoiceSetup[];
  mix: MixSettings;
  timbres?: Record<string, Timbre>;
  referenceHz: number;
  seed: number;
  /** Key at the playhead (release 'tonic'). */
  key: Key;
}

/** Live time runs from 0 when live mode starts; the live score lasts this long (s). */
export const LIVE_DURATION: Seconds = 1e7;

/**
 * The live setup from `piece` at time `at`: the voices sounding there (else every voice that ever
 * sounds, else the first), each with its range, the timbre in force at `at`, its pitch there (else
 * its first pitch, else the middle of its range) and its mix settings; the piece's mix, timbres,
 * tuning, seed and key at `at`.
 */
export function liveSetupFrom(piece: Piece, score: CompiledScore, at: Seconds): LiveSetup {
  const compiled = score.voices;
  let pick = compiled.filter((v) => lifeAt(v, at) !== null);
  if (pick.length === 0) pick = compiled.filter((v) => v.lives.length > 0);
  if (pick.length === 0) pick = compiled.slice(0, 1);
  const voices = pick.map((cv): LiveVoiceSetup => {
    const def = piece.voices[cv.index];
    const range: [Pitch, Pitch] = def ? [def.range[0], def.range[1]] : [36, 84];
    let timbre = def?.timbre ?? 'sine';
    for (const c of cv.timbre) if (c.t <= at) timbre = c.preset;
    const p = pitchAt(cv, at) ?? cv.segments[0]?.p0 ?? (range[0] + range[1]) / 2;
    return {
      id: cv.id,
      range,
      timbre,
      pitch: p,
      gain: cv.gain,
      pan: cv.pan,
      mute: cv.mute,
      solo: cv.solo,
      sends: { ...cv.sends },
    };
  });
  return {
    voices,
    mix: piece.mix,
    timbres: piece.timbres,
    referenceHz: score.referenceHz,
    seed: score.seed,
    key: score.keys.length > 0 ? keyAt(score, at) : piece.key,
  };
}

/**
 * The score the worklet loads for live mode: per voice one open life from 0, a hold at its start
 * pitch and a level of 0 (silent until the first key). Live moves then extend it (dsp/live.ts).
 */
export function liveScore(setup: LiveSetup): CompiledScore {
  return {
    duration: LIVE_DURATION,
    voices: setup.voices.map((v, index) => ({
      id: v.id,
      index,
      lives: [{ born: 0, fadeIn: 0 }],
      segments: [{ t0: 0, t1: LIVE_DURATION, p0: v.pitch, p1: v.pitch, ease: 'smootherstep' }],
      timbre: [{ t: 0, preset: v.timbre, fade: 0 }],
      level: [{ t: 0, gain: 0, over: 0 }],
      gain: v.gain,
      pan: v.pan,
      mute: v.mute,
      solo: v.solo,
      sends: { ...v.sends },
    })),
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: setup.key }],
    referenceHz: setup.referenceHz,
    seed: setup.seed,
  };
}
