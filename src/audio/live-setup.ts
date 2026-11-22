/**
 * The voices, timbres and mix live mode plays with (PLAN.md §9), taken from the piece at the
 * playhead, and the live score the worklet loads for them.
 */

import { defaultVoice } from '../core/defaults';
import { partLines } from '../core/flat';
import { keyAt, lifeAt, pitchAt } from '../core/query';
import type {
  CompiledScore,
  CompiledVoice,
  Key,
  MixSettings,
  Piece,
  Pitch,
  Seconds,
  Timbre,
  VoiceDef,
} from '../core/types';
import type { ParamValue } from '../dsp/mix';

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
  /** The voice's own gain, before that correction (`liveGains` recomputes it for a new mix). */
  baseGain?: number;
  pan: number | 'auto';
  mute: boolean;
  solo: boolean;
  sends: { reverb?: number; delay?: number };
  /**
   * Added to reach LIVE_MIN_VOICES: 'pool' (a voice of the piece that does not sound there) or
   * 'new' (not in the piece; `LiveSetup.added` has its definition). Its timbre, part, mute and
   * solo are the nearest sounding voice's; a take writes them into the piece (core/live-take
   * `takeVoices`).
   */
  fill?: 'pool' | 'new';
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
  /**
   * Peak lines per part over the whole piece (every part name, '' = none; at least 1), for the
   * per-part correction (`liveGains`). Absent: gains are used as given.
   */
  partPeaks?: Record<string, number>;
  /** Definitions of the `fill: 'new'` voices (appended to the pool when a take is written). */
  added?: VoiceDef[];
  /** The piece's voice ids (a pool change while live re-enters, `liveSetupChange`). */
  pool?: string[];
}

/** Live mode plays at least this many voices (a triad plus a doubling), filling from the pool. */
export const LIVE_MIN_VOICES = 4;

/** Fade-out of the old live engine when re-entering on the same context (s). */
export const LIVE_REENTER_FADE = 0.03;
/** Crossfade of a live voice's timbre change (s), as playback's hot-swap fade (SWAP_FADE). */
export const LIVE_TIMBRE_FADE = 0.02;

/** Live time runs from 0 when live mode starts; the live score lasts this long (s). */
export const LIVE_DURATION: Seconds = 1e7;

/**
 * The live setup from `piece` at time `at`: the voices sounding there (else every voice that ever
 * sounds, else the whole pool), each with its range, the timbre in force at `at`, its pitch there (else
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
 *
 * Fewer than LIVE_MIN_VOICES voices there: voices are added up to it (`fill`), so a triad plus a
 * doubling is playable. They are live voices like the others (alive throughout, silent at level
 * 0), so g_n stays constant; with them each voice sounds at the normalisation of n live lines.
 */
export function liveSetupFrom(piece: Piece, score: CompiledScore, at: Seconds): LiveSetup {
  const compiled = score.voices;
  let pick = compiled.filter((v) => lifeAt(v, at) !== null);
  if (pick.length === 0) pick = compiled.filter((v) => v.lives.length > 0);
  // Nothing ever sounds (an empty piece): the whole pool, so chords can be played (M7-c).
  if (pick.length === 0) pick = compiled.slice();
  const part = (i: number): string => compiled[i]?.part ?? '';
  const own = (cv: CompiledVoice): LiveVoiceSetup => {
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
      gain: cv.gain,
      baseGain: cv.gain,
      pan: cv.pan,
      mute: cv.mute,
      solo: cv.solo,
      sends: { ...cv.sends },
    };
  };
  const sounding = pick.map(own);
  const { voices, added } = fill(piece, compiled, pick, sounding);
  const partPeaks = peaksOf(score);
  const correction = partCorrection(
    partPeaks,
    voices.map((v) => v.part),
    piece.mix,
  );
  voices.forEach((v, k) => (v.gain = (v.baseGain ?? v.gain) * correction[k]));
  return {
    voices,
    mix: piece.mix,
    timbres: piece.timbres,
    referenceHz: score.referenceHz,
    seed: score.seed,
    key: score.keys.length > 0 ? keyAt(score, at) : piece.key,
    partPeaks,
    ...(added.length > 0 ? { added } : {}),
    pool: piece.voices.map((v) => v.id),
  };
}

/**
 * Fewer than LIVE_MIN_VOICES picked: adds the pool's other voices, nearest by pool index first
 * (ties: the lower), then new default voices (`added`) when the pool is smaller. Each added voice
 * takes the timbre, part, mute and solo of the picked voice nearest it by pool index (new voices
 * count as after the pool's end), keeping its own range and mix settings. Order: pool order, new
 * voices last.
 */
function fill(
  piece: Piece,
  compiled: readonly CompiledVoice[],
  pick: readonly CompiledVoice[],
  sounding: LiveVoiceSetup[],
): { voices: LiveVoiceSetup[]; added: VoiceDef[] } {
  if (sounding.length >= LIVE_MIN_VOICES || sounding.length === 0) {
    return { voices: sounding, added: [] };
  }
  const dist = (i: number): number => {
    let d = Infinity;
    for (const cv of pick) d = Math.min(d, Math.abs(cv.index - i));
    return d;
  };
  /** The picked voice nearest pool index i (ties: the lower index). */
  const source = (i: number): LiveVoiceSetup => {
    let best = 0;
    for (let k = 1; k < pick.length; k++) {
      const d = Math.abs(pick[k].index - i) - Math.abs(pick[best].index - i);
      if (d < 0 || (d === 0 && pick[k].index < pick[best].index)) best = k;
    }
    return sounding[best];
  };
  const picked = new Set(pick.map((cv) => cv.index));
  const rest = compiled
    .filter((cv) => !picked.has(cv.index))
    .sort((a, b) => dist(a.index) - dist(b.index) || a.index - b.index)
    .slice(0, LIVE_MIN_VOICES - sounding.length);
  const entries: { index: number; v: LiveVoiceSetup }[] = pick.map((cv, k) => ({
    index: cv.index,
    v: sounding[k],
  }));
  for (const cv of rest) {
    const def = piece.voices[cv.index];
    const range: [Pitch, Pitch] = def ? [def.range[0], def.range[1]] : [36, 84];
    const src = source(cv.index);
    entries.push({
      index: cv.index,
      v: {
        id: cv.id,
        range,
        timbre: src.timbre,
        pitch: src.pitch,
        part: src.part,
        gain: cv.gain,
        baseGain: cv.gain,
        pan: cv.pan,
        mute: src.mute,
        solo: src.solo,
        sends: { ...cv.sends },
        fill: 'pool',
      },
    });
  }
  entries.sort((a, b) => a.index - b.index);
  const voices = entries.map((e) => e.v);
  const added: VoiceDef[] = [];
  const used = new Set([...piece.voices.map((v) => v.id), ...compiled.map((v) => v.id)]);
  let n = piece.voices.length;
  while (voices.length < LIVE_MIN_VOICES) {
    while (used.has(`v${n + 1}`)) n++;
    const src = source(piece.voices.length);
    const def = defaultVoice(n, src.timbre);
    used.add(def.id);
    if (src.part !== '') def.part = src.part;
    if (src.mute) def.mute = true;
    if (src.solo) def.solo = true;
    added.push(def);
    voices.push({
      id: def.id,
      range: [def.range[0], def.range[1]],
      timbre: src.timbre,
      pitch: src.pitch,
      part: src.part,
      gain: def.gain,
      baseGain: def.gain,
      pan: def.pan,
      mute: src.mute,
      solo: src.solo,
      sends: {},
      fill: 'new',
    });
  }
  return { voices, added };
}

/**
 * Each live voice's static gain under `mix` (a `mix.normalise` change while live): its own gain
 * times the per-part correction for that mode. Setups without `partPeaks` keep their gains.
 */
export function liveGains(setup: LiveSetup, mix: MixSettings): number[] {
  const peaks = setup.partPeaks;
  if (!peaks) return setup.voices.map((v) => v.gain);
  const c = partCorrection(
    peaks,
    setup.voices.map((v) => v.part),
    mix,
  );
  return setup.voices.map((v, k) => (v.baseGain ?? v.gain) * c[k]);
}

/** What `LiveEngine.update` sends for a new setup of the same live voices. */
export interface LiveSetupChange {
  /** Live voices whose timbre changes (crossfaded). */
  timbres: { voice: number; timbre: string }[];
  /** `param` messages (dsp/mix.ts paths) for gains, pan, mute, solo and sends that change. */
  params: { path: string; value: ParamValue }[];
  /** Each live voice's static gain under the new setup (`liveGains`). */
  gains: number[];
}

/**
 * The in-place change from `old` to `next` (a piece edit while live), or null when the pool, the
 * live voices (count, ids, ranges, parts) or the tuning differ: live mode must re-enter then.
 * `sent`: the gains last sent (default: `old`'s under its mix).
 */
export function liveSetupChange(
  old: LiveSetup,
  next: LiveSetup,
  sent: readonly number[] = liveGains(old, old.mix),
): LiveSetupChange | null {
  const n = old.voices.length;
  if (next.voices.length !== n || next.referenceHz !== old.referenceHz) return null;
  // A written take appends the voices live mode added (`added`): the same pool for live.
  const pool = (next.pool ?? []).join('\n');
  const was = old.pool ?? [];
  if (
    pool !== was.join('\n') &&
    pool !== [...was, ...(old.added ?? []).map((v) => v.id)].join('\n')
  ) {
    return null;
  }
  for (let i = 0; i < n; i++) {
    const a = old.voices[i];
    const b = next.voices[i];
    if (a.id !== b.id || a.part !== b.part) return null;
    if (a.range[0] !== b.range[0] || a.range[1] !== b.range[1]) return null;
  }
  const gains = liveGains(next, next.mix);
  const timbres: LiveSetupChange['timbres'] = [];
  const params: LiveSetupChange['params'] = [];
  for (let i = 0; i < n; i++) {
    const a = old.voices[i];
    const b = next.voices[i];
    const at = `voices.${i}.`;
    if (gains[i] !== sent[i]) params.push({ path: `${at}gain`, value: gains[i] });
    if (b.pan !== a.pan) params.push({ path: `${at}pan`, value: b.pan });
    if (b.mute !== a.mute) params.push({ path: `${at}mute`, value: b.mute });
    if (b.solo !== a.solo) params.push({ path: `${at}solo`, value: b.solo });
    for (const k of ['reverb', 'delay'] as const) {
      if (b.sends[k] !== a.sends[k])
        params.push({ path: `${at}sends.${k}`, value: b.sends[k] ?? null });
    }
    if (b.timbre !== a.timbre) timbres.push({ voice: i, timbre: b.timbre });
  }
  return { timbres, params, gains };
}

/** The piece's peak lines per part name (at least 1), every name included. */
function peaksOf(score: CompiledScore): Record<string, number> {
  const lines = partLines(score);
  const out: Record<string, number> = {};
  for (const v of score.voices) {
    const name = v.part ?? '';
    out[name] = Math.max(1, lines[name] ?? 1);
  }
  return out;
}

/** Per live voice (parts `live`): the gain factor that keeps its per-part trim (see above). */
function partCorrection(
  peaks: Record<string, number>,
  live: readonly string[],
  mix: MixSettings,
): number[] {
  const names = Object.keys(peaks);
  if (mix.normalise === 'all' || names.length < 2) return live.map(() => 1);
  const peak = (name: string): number => peaks[name] ?? 1;
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
