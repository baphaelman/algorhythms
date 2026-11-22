/**
 * The voices, timbres and mix live mode plays with (PLAN.md §9), taken from the piece at the
 * playhead, and the live score the worklet loads for them.
 */

import { partLines } from '../core/flat';
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
  /** Its part ('' = none); the live voices normalise per part as in the piece. */
  part: string;
  /** Static gain: the voice's, times the per-part trim correction (`liveSetupFrom`). */
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
 *
 * Per-part normalisation (§8.4 rev 10, `mix.normalise` 'part', the default): in the piece, a voice
 * of part p sounds at trim_p / √(lines of p sounding), trim_p = √(N_p / Σ N) over the piece's
 * peak lines per part (core/flat `partLines`). The live score has only the live voices, each
 * alive throughout, so the graph would give them trim √(n_p / n) instead (n_p of the n live voices
 * in p). Each live voice's gain is scaled by √(N_p·n / (Σ N·n_p)), so at the playhead every voice
 * keeps the gain it has in the piece. With silence as a shared level of 0 the lives, and so g_n,
 * stay constant in live mode.
 */
export function liveSetupFrom(piece: Piece, score: CompiledScore, at: Seconds): LiveSetup {
  const compiled = score.voices;
  let pick = compiled.filter((v) => lifeAt(v, at) !== null);
  if (pick.length === 0) pick = compiled.filter((v) => v.lives.length > 0);
  if (pick.length === 0) pick = compiled.slice(0, 1);
  const part = (i: number): string => compiled[i]?.part ?? '';
  const correction = partCorrection(
    score,
    pick.map((cv) => part(cv.index)),
    piece.mix,
  );
  const voices = pick.map((cv, k): LiveVoiceSetup => {
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
      part: part(cv.index),
      gain: cv.gain * correction[k],
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

/** Per live voice (parts `live`): the gain factor that keeps its per-part trim (see above). */
function partCorrection(score: CompiledScore, live: readonly string[], mix: MixSettings): number[] {
  const names = new Set(score.voices.map((v) => v.part ?? ''));
  if (mix.normalise === 'all' || names.size < 2) return live.map(() => 1);
  const lines = partLines(score);
  const peak = (name: string): number => Math.max(1, lines[name] ?? 1);
  let total = 0;
  for (const name of names) total += peak(name);
  const count = new Map<string, number>();
  for (const name of live) count.set(name, (count.get(name) ?? 0) + 1);
  // The live score's own trims, as the graph computes them from its partLines.
  const n = live.length;
  return live.map((name) => {
    const np = count.get(name) ?? 1;
    const liveGroups = count.size;
    const own = liveGroups > 1 ? Math.sqrt(np / n) : 1;
    return Math.sqrt(peak(name) / total) / own;
  });
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
      ...(v.part !== '' ? { part: v.part } : {}),
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
