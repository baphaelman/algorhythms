import { describe, expect, it } from 'vitest';
import {
  EaseCode,
  FLAT_LAYOUT_VERSION,
  LEVEL_STRIDE,
  LIFE_DIED,
  LIFE_STRIDE,
  SEG_CLAMPED,
  SEG_EASE,
  SEG_M0,
  SEG_STRIDE,
  TIMBRE_PRESET,
  TIMBRE_STRIDE,
  VOICE_ID_HASH,
  VOICE_PAN,
  VOICE_SEND_DELAY,
  VOICE_SEND_REVERB,
  VOICE_STRIDE,
  flatten,
  hashVoiceId,
  partLines,
  transferList,
  unflatten,
} from '../../src/core/flat';
import type { CompiledScore, CompiledVoice } from '../../src/core/types';

function voice(index: number, patch: Partial<CompiledVoice> = {}): CompiledVoice {
  return {
    id: `v${index + 1}`,
    index,
    lives: [],
    segments: [],
    timbre: [{ t: 0, preset: 'glass', fade: 0 }],
    level: [],
    gain: 1,
    pan: 'auto',
    mute: false,
    solo: false,
    sends: {},
    ...patch,
  };
}

/** A small score touching every field and option the layout carries. */
function fixture(): CompiledScore {
  return {
    duration: 30,
    voices: [
      voice(0, {
        lives: [
          { born: 0, died: 12, fadeIn: 0, fadeOut: 2 },
          { born: 15, fadeIn: 1.5 },
        ],
        segments: [
          { t0: 0, t1: 4, p0: 57, p1: 57, ease: 'smootherstep', momentId: 'k3f9aa' },
          { t0: 4, t1: 7, p0: 57, p1: 64, ease: 'cosine', m0: 0.75, clamped: true },
          { t0: 7, t1: 12, p0: 64, p1: 60, ease: 'expo' },
          {
            t0: 15,
            t1: 18,
            p0: 60,
            p1: 62,
            ease: { kind: 'bezier', x1: 0.2, y1: -0.4, x2: 0.8, y2: 1.4 },
          },
          { t0: 18, t1: 30, p0: 62, p1: 62, ease: 'linear' },
        ],
        timbre: [
          { t: 0, preset: 'glass', fade: 0 },
          { t: 20, preset: 'reed', fade: 2 },
        ],
        level: [
          { t: 5, gain: 0.5, over: 2 },
          { t: 9, gain: 1, over: 0 },
        ],
        gain: 0.8,
        pan: -0.25,
        sends: { reverb: 0.4 },
      }),
      voice(1, {
        mute: true,
        solo: true,
        sends: { delay: 0.1 },
        timbre: [{ t: 0, preset: 'reed', fade: 0 }],
      }),
      voice(2, { timbre: [{ t: 0, preset: 'organ', fade: 0 }] }),
    ],
    walkSteps: [],
    momentSpans: [{ id: 'k3f9aa', start: 4, end: 7 }],
    diagnostics: [{ level: 'info', code: 'demo', message: 'demo' }],
    keys: [{ t: 0, key: { tonic: 'A', scale: 'dorian' } }],
    referenceHz: 442,
    seed: 2611,
  };
}

/** The parts of a score the flat layout carries, with optional fields in canonical form. */
function audioPart(score: CompiledScore): CompiledScore {
  return {
    ...score,
    momentSpans: [],
    diagnostics: [],
    keys: [],
    voices: score.voices.map((v) => ({
      ...v,
      lives: v.lives.map((l) => {
        const { fadeOut, ...rest } = l;
        return fadeOut ? { ...rest, fadeOut } : rest;
      }),
      segments: v.segments.map((s) => {
        const { momentId: _m, m0, clamped, ...rest } = s;
        return { ...rest, ...(m0 ? { m0 } : {}), ...(clamped ? { clamped } : {}) };
      }),
    })),
  };
}

describe('flatten / unflatten', () => {
  it('round-trips everything the audio thread needs', () => {
    const score = fixture();
    expect(unflatten(flatten(score))).toEqual(audioPart(score));
  });

  it('uses fixed strides and the documented encodings', () => {
    const flat = flatten(fixture());
    expect(flat.layout).toBe(FLAT_LAYOUT_VERSION);
    expect(flat.voiceIds).toEqual(['v1', 'v2', 'v3']);
    const v = flat.voices[0];
    expect(v.segments.length).toBe(5 * SEG_STRIDE);
    expect(v.lives.length).toBe(2 * LIFE_STRIDE);
    expect(v.levels.length).toBe(2 * LEVEL_STRIDE);
    expect(v.timbres.length).toBe(2 * TIMBRE_STRIDE);
    expect(flat.voiceParams.length).toBe(3 * VOICE_STRIDE);

    expect(v.segments[1 * SEG_STRIDE + SEG_EASE]).toBe(EaseCode.Cosine);
    expect(v.segments[1 * SEG_STRIDE + SEG_M0]).toBe(0.75);
    expect(v.segments[1 * SEG_STRIDE + SEG_CLAMPED]).toBe(1);
    expect(v.segments[3 * SEG_STRIDE + SEG_EASE]).toBe(EaseCode.Bezier);
    expect(v.lives[1 * LIFE_STRIDE + LIFE_DIED]).toBe(Infinity);

    // Timbre names are interned in order of first use.
    expect(flat.timbreNames).toEqual(['glass', 'reed', 'organ']);
    expect(flat.voices[1].timbres[TIMBRE_PRESET]).toBe(1);

    // 'auto' pan and absent sends are NaN; the id hash is stored per voice.
    expect(flat.voiceParams[VOICE_PAN]).toBe(-0.25);
    expect(flat.voiceParams[VOICE_STRIDE + VOICE_PAN]).toBeNaN();
    expect(flat.voiceParams[VOICE_SEND_REVERB]).toBe(0.4);
    expect(flat.voiceParams[VOICE_SEND_DELAY]).toBeNaN();
    expect(flat.voiceParams[VOICE_STRIDE + VOICE_ID_HASH]).toBe(hashVoiceId('v2'));
  });

  it('rejects voices out of pool order', () => {
    const score = fixture();
    score.voices.reverse();
    expect(() => flatten(score)).toThrow(/index/);
  });

  it('handles an empty score', () => {
    const empty: CompiledScore = { ...fixture(), voices: [] };
    expect(unflatten(flatten(empty))).toEqual(audioPart(empty));
  });
});

describe('parts (revision 10)', () => {
  const lives = (born: number, died: number, fade = 1) => [
    { born, died, fadeIn: fade, fadeOut: fade },
  ];
  const score = (voices: CompiledVoice[]): CompiledScore => ({ ...fixture(), voices });

  it('carries CompiledVoice.part through flatten and unflatten', () => {
    const s = score([voice(0, { part: 'Bass' }), voice(1), voice(2, { part: 'Keys' })]);
    const flat = flatten(s);
    expect(flat.voiceParts).toEqual(['Bass', '', 'Keys']);
    expect(unflatten(flat).voices.map((v) => v.part)).toEqual(['Bass', undefined, 'Keys']);
  });

  it('partLines: per part, the most voices sounding at once; crossfades count once', () => {
    // A: 0–10 and 2–8 overlap (2); B: 5–15; no part: 18–25.
    const s = score([
      voice(0, { part: 'A', lives: lives(0, 10) }),
      voice(1, { part: 'A', lives: lives(2, 8) }),
      voice(2, { part: 'B', lives: lives(5, 15) }),
      voice(3, { lives: lives(18, 25) }),
    ]);
    expect(partLines(s)).toEqual({ A: 2, B: 1, '': 1 });
    // A third A line crossfading in as voice 0 fades out: counted from fade middles, still 2.
    s.voices[0].lives = lives(0, 11, 2);
    s.voices.push(voice(4, { part: 'A', lives: lives(9, 14, 2) }));
    expect(partLines(s)).toEqual({ A: 2, B: 1, '': 1 });
    // Voices, not line weights.
    s.voices[1].weight = [{ t: 4, w: 3, over: 1 }];
    expect(partLines(s)).toEqual({ A: 2, B: 1, '': 1 });
    s.voices.push(voice(5, { part: 'A', lives: lives(3, 6) }));
    expect(flatten(s).partLines).toEqual({ A: 3, B: 1, '': 1 });
    expect(partLines(score([voice(0)]))).toEqual({ '': 1 });
  });
});

describe('transferList', () => {
  it('lists each buffer once and survives a structured-clone transfer', () => {
    const flat = flatten(fixture());
    const list = transferList(flat);
    expect(list.length).toBe(1 + 6 * flat.voices.length);
    expect(new Set(list).size).toBe(list.length);

    const received = structuredClone(flat, { transfer: list });
    expect(flat.voiceParams.byteLength).toBe(0); // detached on the sending side
    expect(unflatten(received)).toEqual(audioPart(fixture()));
  });
});

describe('hashVoiceId', () => {
  it('is a stable unsigned 32-bit FNV-1a', () => {
    expect(hashVoiceId('')).toBe(0x811c9dc5);
    expect(hashVoiceId('a')).toBe(0xe40c292c);
    expect(hashVoiceId('v1')).not.toBe(hashVoiceId('v2'));
    expect(hashVoiceId('v10')).toBeGreaterThanOrEqual(0);
  });
});
