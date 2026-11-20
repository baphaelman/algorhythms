/**
 * Typed-array layout of a compiled score, for posting to the AudioWorklet and the export worker
 * (PLAN.md §8.2, §8.11).
 *
 * The audio thread must not allocate in `process()`, so it receives a few Float64Arrays (sent as
 * transferables) instead of a graph of objects. `flatten` runs on the main thread, where
 * allocation is fine.
 *
 * Record layouts (strides and field offsets) are defined in core/segment.ts, which the DSP may
 * import by value, and re-exported here. Each record is a run of STRIDE doubles; record i of an
 * array starts at index i·STRIDE.
 *
 * Not carried (the audio thread doesn't need them): moment spans, diagnostics, the key timeline,
 * and `Segment.momentId`. `unflatten` therefore returns those as empty.
 *
 * Transferring detaches the arrays on the sender's side; flatten again to post another copy.
 */

import { EaseCode, easeCodeOf } from './ease';
import {
  LEVEL_GAIN,
  LEVEL_OVER,
  LEVEL_STRIDE,
  LEVEL_T,
  LIFE_BORN,
  LIFE_DIED,
  LIFE_FADE_IN,
  LIFE_FADE_OUT,
  LIFE_STRIDE,
  SEG_BX1,
  SEG_BX2,
  SEG_BY1,
  SEG_BY2,
  SEG_CLAMPED,
  SEG_EASE,
  SEG_M0,
  SEG_P0,
  SEG_P1,
  SEG_STRIDE,
  SEG_T0,
  SEG_T1,
  TIMBRE_FADE,
  TIMBRE_PRESET,
  TIMBRE_STRIDE,
  TIMBRE_T,
  VOICE_GAIN,
  VOICE_ID_HASH,
  VOICE_MUTE,
  VOICE_PAN,
  VOICE_SEND_DELAY,
  VOICE_SEND_REVERB,
  VOICE_SOLO,
  VOICE_STRIDE,
} from './segment';
import type { CompiledScore, CompiledVoice, EaseRef, Life, Segment } from './types';

export {
  LEVEL_GAIN,
  LEVEL_OVER,
  LEVEL_STRIDE,
  LEVEL_T,
  LIFE_BORN,
  LIFE_DIED,
  LIFE_FADE_IN,
  LIFE_FADE_OUT,
  LIFE_STRIDE,
  SEG_BX1,
  SEG_BX2,
  SEG_BY1,
  SEG_BY2,
  SEG_CLAMPED,
  SEG_EASE,
  SEG_M0,
  SEG_P0,
  SEG_P1,
  SEG_STRIDE,
  SEG_T0,
  SEG_T1,
  TIMBRE_FADE,
  TIMBRE_PRESET,
  TIMBRE_STRIDE,
  TIMBRE_T,
  VOICE_GAIN,
  VOICE_ID_HASH,
  VOICE_MUTE,
  VOICE_PAN,
  VOICE_SEND_DELAY,
  VOICE_SEND_REVERB,
  VOICE_SOLO,
  VOICE_STRIDE,
};
export { EaseCode };

/** Version of this layout; bump it whenever a stride or offset changes. */
export const FLAT_LAYOUT_VERSION = 1;

/** One voice's time-varying data. Every array is sorted by time. */
export interface FlatVoice {
  /** Segment records, SEG_STRIDE doubles each, sorted by t0. */
  segments: Float64Array<ArrayBuffer>;
  /** Life records, LIFE_STRIDE doubles each. LIFE_DIED is +Infinity for an open life. */
  lives: Float64Array<ArrayBuffer>;
  /** Level-change records, LEVEL_STRIDE doubles each. The level is 1 before the first. */
  levels: Float64Array<ArrayBuffer>;
  /** Timbre-change records, TIMBRE_STRIDE doubles each; TIMBRE_PRESET indexes timbreNames. */
  timbres: Float64Array<ArrayBuffer>;
}

/** A compiled score as typed arrays plus a little plain metadata (copied once per load). */
export interface FlatScore {
  /** FLAT_LAYOUT_VERSION at flatten time. */
  layout: typeof FLAT_LAYOUT_VERSION;
  /** CompiledScore.duration. */
  duration: number;
  /** Hz of pitch 69. */
  referenceHz: number;
  /** Piece seed, for seeded phases and noise. */
  seed: number;
  /** Voice ids in pool order; voiceIds.length is the voice count. */
  voiceIds: string[];
  /** Static per-voice params, VOICE_STRIDE doubles per voice, in pool order. */
  voiceParams: Float64Array<ArrayBuffer>;
  /** Distinct timbre preset names; TIMBRE_PRESET values index this list. */
  timbreNames: string[];
  /** Per-voice arrays in pool order. */
  voices: FlatVoice[];
}

/** FNV-1a 32-bit hash of a string (integer ops only, so identical on every engine). */
export function hashVoiceId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function writeEase(out: Float64Array, o: number, ease: EaseRef): void {
  out[o + SEG_EASE] = easeCodeOf(ease);
  if (typeof ease === 'object') {
    out[o + SEG_BX1] = ease.x1;
    out[o + SEG_BY1] = ease.y1;
    out[o + SEG_BX2] = ease.x2;
    out[o + SEG_BY2] = ease.y2;
  } else {
    out[o + SEG_BX1] = 0;
    out[o + SEG_BY1] = 0;
    out[o + SEG_BX2] = 1;
    out[o + SEG_BY2] = 1;
  }
}

function flattenVoice(v: CompiledVoice, timbreIndex: Map<string, number>): FlatVoice {
  const segments = new Float64Array(v.segments.length * SEG_STRIDE);
  v.segments.forEach((s, i) => {
    const o = i * SEG_STRIDE;
    segments[o + SEG_T0] = s.t0;
    segments[o + SEG_T1] = s.t1;
    segments[o + SEG_P0] = s.p0;
    segments[o + SEG_P1] = s.p1;
    writeEase(segments, o, s.ease);
    segments[o + SEG_M0] = s.m0 ?? 0;
    segments[o + SEG_CLAMPED] = s.clamped ? 1 : 0;
  });

  const lives = new Float64Array(v.lives.length * LIFE_STRIDE);
  v.lives.forEach((l, i) => {
    const o = i * LIFE_STRIDE;
    lives[o + LIFE_BORN] = l.born;
    lives[o + LIFE_DIED] = l.died ?? Infinity;
    lives[o + LIFE_FADE_IN] = l.fadeIn;
    lives[o + LIFE_FADE_OUT] = l.fadeOut ?? 0;
  });

  const levels = new Float64Array(v.level.length * LEVEL_STRIDE);
  v.level.forEach((c, i) => {
    const o = i * LEVEL_STRIDE;
    levels[o + LEVEL_T] = c.t;
    levels[o + LEVEL_GAIN] = c.gain;
    levels[o + LEVEL_OVER] = c.over;
  });

  const timbres = new Float64Array(v.timbre.length * TIMBRE_STRIDE);
  v.timbre.forEach((c, i) => {
    const o = i * TIMBRE_STRIDE;
    let idx = timbreIndex.get(c.preset);
    if (idx === undefined) {
      idx = timbreIndex.size;
      timbreIndex.set(c.preset, idx);
    }
    timbres[o + TIMBRE_T] = c.t;
    timbres[o + TIMBRE_PRESET] = idx;
    timbres[o + TIMBRE_FADE] = c.fade;
  });

  return { segments, lives, levels, timbres };
}

/** Flattens a compiled score into typed arrays. Voices must be in pool order. */
export function flatten(score: CompiledScore): FlatScore {
  const timbreIndex = new Map<string, number>();
  const voiceParams = new Float64Array(score.voices.length * VOICE_STRIDE);
  const voices = score.voices.map((v, i) => {
    if (v.index !== i) {
      throw new Error(`flatten: voice ${v.id} has index ${v.index} at position ${i}`);
    }
    const o = i * VOICE_STRIDE;
    voiceParams[o + VOICE_GAIN] = v.gain;
    voiceParams[o + VOICE_PAN] = v.pan === 'auto' ? NaN : v.pan;
    voiceParams[o + VOICE_MUTE] = v.mute ? 1 : 0;
    voiceParams[o + VOICE_SOLO] = v.solo ? 1 : 0;
    voiceParams[o + VOICE_SEND_REVERB] = v.sends.reverb ?? NaN;
    voiceParams[o + VOICE_SEND_DELAY] = v.sends.delay ?? NaN;
    voiceParams[o + VOICE_ID_HASH] = hashVoiceId(v.id);
    return flattenVoice(v, timbreIndex);
  });
  return {
    layout: FLAT_LAYOUT_VERSION,
    duration: score.duration,
    referenceHz: score.referenceHz,
    seed: score.seed,
    voiceIds: score.voices.map((v) => v.id),
    voiceParams,
    timbreNames: [...timbreIndex.keys()],
    voices,
  };
}

/** Every ArrayBuffer in a flat score, each once: pass as the postMessage transfer list. */
export function transferList(flat: FlatScore): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>([flat.voiceParams.buffer]);
  for (const v of flat.voices) {
    out.add(v.segments.buffer);
    out.add(v.lives.buffer);
    out.add(v.levels.buffer);
    out.add(v.timbres.buffer);
  }
  return [...out];
}

function readEase(a: Float64Array, o: number): EaseRef {
  switch (a[o + SEG_EASE]) {
    case EaseCode.Smootherstep:
      return 'smootherstep';
    case EaseCode.Smoothstep:
      return 'smoothstep';
    case EaseCode.Cosine:
      return 'cosine';
    case EaseCode.Linear:
      return 'linear';
    case EaseCode.Expo:
      return 'expo';
    case EaseCode.Bezier:
      return {
        kind: 'bezier',
        x1: a[o + SEG_BX1],
        y1: a[o + SEG_BY1],
        x2: a[o + SEG_BX2],
        y2: a[o + SEG_BY2],
      };
    default:
      throw new Error(`unflatten: unknown ease code ${a[o + SEG_EASE]}`);
  }
}

function records<T>(a: Float64Array, stride: number, read: (o: number) => T): T[] {
  const out: T[] = [];
  for (let o = 0; o < a.length; o += stride) out.push(read(o));
  return out;
}

/**
 * Rebuilds a CompiledScore from a flat score, for tests and debugging. Lossy where noted in the
 * module comment; optional fields come back in canonical form: `m0` only when nonzero, `clamped`
 * only when true, `died` only when finite, `fadeOut` only when nonzero, sends only when set.
 */
export function unflatten(flat: FlatScore): CompiledScore {
  const voices = flat.voices.map((fv, i): CompiledVoice => {
    const p = i * VOICE_STRIDE;
    const pan = flat.voiceParams[p + VOICE_PAN];
    const sendReverb = flat.voiceParams[p + VOICE_SEND_REVERB];
    const sendDelay = flat.voiceParams[p + VOICE_SEND_DELAY];
    const sends: CompiledVoice['sends'] = {};
    if (!Number.isNaN(sendReverb)) sends.reverb = sendReverb;
    if (!Number.isNaN(sendDelay)) sends.delay = sendDelay;
    return {
      id: flat.voiceIds[i] ?? '',
      index: i,
      lives: records(fv.lives, LIFE_STRIDE, (o): Life => {
        const life: Life = { born: fv.lives[o + LIFE_BORN], fadeIn: fv.lives[o + LIFE_FADE_IN] };
        const died = fv.lives[o + LIFE_DIED];
        const fadeOut = fv.lives[o + LIFE_FADE_OUT];
        if (Number.isFinite(died)) life.died = died;
        if (fadeOut !== 0) life.fadeOut = fadeOut;
        return life;
      }),
      segments: records(fv.segments, SEG_STRIDE, (o): Segment => {
        const s: Segment = {
          t0: fv.segments[o + SEG_T0],
          t1: fv.segments[o + SEG_T1],
          p0: fv.segments[o + SEG_P0],
          p1: fv.segments[o + SEG_P1],
          ease: readEase(fv.segments, o),
        };
        const m0 = fv.segments[o + SEG_M0];
        if (m0 !== 0) s.m0 = m0;
        if (fv.segments[o + SEG_CLAMPED] === 1) s.clamped = true;
        return s;
      }),
      timbre: records(fv.timbres, TIMBRE_STRIDE, (o) => ({
        t: fv.timbres[o + TIMBRE_T],
        preset: flat.timbreNames[fv.timbres[o + TIMBRE_PRESET]] ?? '',
        fade: fv.timbres[o + TIMBRE_FADE],
      })),
      level: records(fv.levels, LEVEL_STRIDE, (o) => ({
        t: fv.levels[o + LEVEL_T],
        gain: fv.levels[o + LEVEL_GAIN],
        over: fv.levels[o + LEVEL_OVER],
      })),
      gain: flat.voiceParams[p + VOICE_GAIN],
      pan: Number.isNaN(pan) ? 'auto' : pan,
      mute: flat.voiceParams[p + VOICE_MUTE] === 1,
      solo: flat.voiceParams[p + VOICE_SOLO] === 1,
      sends,
    };
  });
  return {
    duration: flat.duration,
    voices,
    momentSpans: [],
    diagnostics: [],
    keys: [],
    referenceHz: flat.referenceHz,
    seed: flat.seed,
  };
}
