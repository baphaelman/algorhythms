/** Unit tests for core/defaults.ts. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLIDE,
  DEFAULT_MIX,
  DEFAULT_TIMBRE,
  DEFAULT_VIEW,
  MOMENT_DEFAULTS,
  TIMBRE_DEFAULTS,
  cloneJson,
  defaultMix,
  defaultVoices,
  newPiece,
} from '../../../src/core/defaults';
import { parsePiece } from '../../../src/core/schema';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import { PIECE_FORMAT, PIECE_VERSION } from '../../../src/core/types';

describe('default constants', () => {
  it('are deeply frozen', () => {
    for (const c of [DEFAULT_GLIDE, DEFAULT_MIX, DEFAULT_VIEW, MOMENT_DEFAULTS, TIMBRE_DEFAULTS]) {
      expect(Object.isFrozen(c)).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_MIX.reverb)).toBe(true);
    expect(Object.isFrozen(MOMENT_DEFAULTS.walk.steps)).toBe(true);
  });

  it('match the plan: moderate reverb, delay off, limiter at −1 dB', () => {
    expect(DEFAULT_MIX.delay.returnLevel).toBe(0);
    expect(DEFAULT_MIX.limiter.ceilingDb).toBe(-1);
    expect(DEFAULT_MIX.reverb.returnLevel).toBeGreaterThan(0);
    expect(DEFAULT_MIX.reverb.returnLevel).toBeLessThan(1);
    expect(DEFAULT_GLIDE).toEqual({
      length: 3,
      jitter: 0.2,
      stagger: 0.8,
      arrive: 'together',
      order: 'random',
      ease: 'smootherstep',
    });
  });

  it('uses a timbre that exists among the built-ins', () => {
    expect(BUILTIN_TIMBRES[DEFAULT_TIMBRE]).toBeDefined();
  });

  it('pass the schema on their own', () => {
    const r = parsePiece({
      format: PIECE_FORMAT,
      version: PIECE_VERSION,
      mix: DEFAULT_MIX,
      view: DEFAULT_VIEW,
    });
    expect(r.ok).toBe(true);
  });
});

describe('factories', () => {
  it('return independent, editable copies', () => {
    const a = defaultMix();
    a.reverb.size = 0;
    expect(DEFAULT_MIX.reverb.size).not.toBe(0);
    expect(defaultMix()).toEqual(DEFAULT_MIX);
    const v = defaultVoices(3);
    v[0].range[0] = 0;
    expect(defaultVoices(3)[0].range).toEqual([38, 84]);
  });

  it('cloneJson deep-copies plain data', () => {
    const x = { a: [1, { b: 2 }], c: null, d: 'e' };
    const y = cloneJson(x);
    expect(y).toEqual(x);
    expect(y.a).not.toBe(x.a);
    expect(y.a[1]).not.toBe(x.a[1]);
  });
});

describe('newPiece', () => {
  it('is the empty template: 12-voice pool, one opening note at 0, A dorian', () => {
    const p = newPiece({ seed: 42, now: '2026-11-19T12:00:00.000Z', title: 'New' });
    expect(p.format).toBe('algorhythms');
    expect(p.version).toBe(2);
    expect(p.seed).toBe(42);
    expect(p.meta).toEqual({
      title: 'New',
      created: '2026-11-19T12:00:00.000Z',
      modified: '2026-11-19T12:00:00.000Z',
    });
    expect(p.voices.map((v) => v.id)).toEqual(Array.from({ length: 12 }, (_, i) => `v${i + 1}`));
    expect(p).not.toHaveProperty('start');
    expect(p.key).toEqual({ tonic: 'A', scale: 'dorian' });
    expect(p.moments).toEqual([
      {
        id: 'start0',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [57] },
        voicing: 'even',
        assign: 'ordered',
      },
    ]);
    expect(p.timbres).toEqual({ glass: BUILTIN_TIMBRES.glass });
    expect(p.timbres.glass).not.toBe(BUILTIN_TIMBRES.glass);
    expect(p.mix).toEqual(DEFAULT_MIX);
    expect(p.end).toEqual({ fade: 6 });
  });

  it('honours options and clamps the pool size', () => {
    const p = newPiece({
      seed: 1,
      poolSize: 40,
      timbre: 'organ',
      key: { tonic: 'C', scale: 'major' },
      startPitch: 60,
    });
    expect(p.voices).toHaveLength(32);
    expect(p.voices.every((v) => v.timbre === 'organ')).toBe(true);
    expect(Object.keys(p.timbres)).toEqual(['organ']);
    expect(p.key).toEqual({ tonic: 'C', scale: 'major' });
    expect(p.moments[0]).toMatchObject({ notes: { kind: 'pitches', pitches: [60] } });
    expect(newPiece({ seed: 1, poolSize: 0 }).voices).toHaveLength(1);
  });

  it('gives a fresh object every time', () => {
    const a = newPiece({ seed: 1 });
    const b = newPiece({ seed: 1 });
    expect(a).toEqual(b);
    a.voices[0].range[0] = 0;
    a.defaults.glide.length = 99;
    expect(b.voices[0].range[0]).toBe(38);
    expect(DEFAULT_GLIDE.length).toBe(3);
  });

  it('is a valid piece that parses back unchanged', () => {
    const p = newPiece({ seed: 7 });
    const r = parsePiece(p);
    expect(r.ok && r.piece).toEqual(p);
  });
});
