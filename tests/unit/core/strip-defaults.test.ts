/**
 * Default stripping for share links (PLAN.md §11.4): `stripDefaults` drops every field that
 * `parsePiece` fills with the same value, and `parsePiece` restores it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLIDE,
  DEFAULT_MIX,
  DEFAULT_VIEW,
  MOMENT_DEFAULTS,
  TIMBRE_DEFAULTS,
  cloneJson,
  newPiece,
} from '../../../src/core/defaults';
import { jsonEqual, parsePiece, stripDefaults } from '../../../src/core/schema';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type { Piece } from '../../../src/core/types';

const HEAD = { format: 'algorhythms', version: 2 } as const;

function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

/** Strips `piece`, checks that parsing the result gives it back, and returns the stripped form. */
function roundTrip(piece: Piece): Record<string, unknown> {
  const s = stripDefaults(piece);
  expect(parsed(s)).toEqual(piece);
  return s;
}

/** The minimal valid moment of each type (only required fields). */
const REQUIRED: Record<string, Record<string, unknown>> = {
  chord: { notes: { kind: 'pitches', pitches: [60] } },
  unison: {},
  split: { count: 2 },
  merge: { count: 1 },
  shift: { by: 1 },
  spread: { factor: 1.5 },
  walk: { until: 10 },
  note: { from: 60, to: 62 },
  pin: { voice: 'v1', pitch: 60 },
  key: { key: { tonic: 'D', scale: 'major' } },
  level: { gain: 0.5 },
  pulse: { until: 4 },
  tune: {},
  timbre: { preset: 'bell' },
};

describe('stripDefaults', () => {
  it('an empty piece strips to its format and version', () => {
    const s = roundTrip(parsed({ ...HEAD, moments: [] }));
    expect(s).toEqual({ ...HEAD });
  });

  it('strips and restores each piece-level default', () => {
    const p = newPiece({ seed: 0 });
    const s = roundTrip(parsed(p));
    // newPiece's opening chord and its glass timbre are content, the rest are defaults.
    expect(Object.keys(s).sort()).toEqual(['format', 'moments', 'timbres', 'version']);
    expect(s.moments).toEqual([
      { type: 'chord', id: 'start0', at: 0, notes: { kind: 'pitches', pitches: [57] } },
    ]);
  });

  it('keeps a non-default value and only that one, at every level', () => {
    const p = parsed({
      ...HEAD,
      meta: { title: 'Mine' },
      seed: 7,
      tuning: { referenceHz: 432 },
      key: { tonic: 'C', scale: 'major' },
      defaults: { glide: { ...DEFAULT_GLIDE, stagger: 1.5 } },
      mix: { ...cloneJson(DEFAULT_MIX), delay: { ...DEFAULT_MIX.delay, feedback: 0.5 } },
      end: { at: 60 },
      view: { ...DEFAULT_VIEW, hud: false, gridBpm: 90 },
    });
    const s = roundTrip(p);
    expect(s).toEqual({
      ...HEAD,
      meta: { title: 'Mine' },
      seed: 7,
      tuning: { referenceHz: 432 },
      key: { tonic: 'C', scale: 'major' },
      defaults: { glide: { stagger: 1.5 } },
      mix: { delay: { feedback: 0.5 } },
      end: { at: 60 },
      view: { hud: false, gridBpm: 90 },
    });
  });

  it('strips voice defaults per field, and the whole default pool', () => {
    const p = parsed({
      ...HEAD,
      voices: [
        { id: 'v1', timbre: 'glass', pan: 'auto', gain: 1, range: [38, 84] },
        { id: 'v2', timbre: 'reed', pan: -0.5, gain: 2, range: [40, 60], part: 'A' },
      ],
    });
    expect(roundTrip(p).voices).toEqual([
      { id: 'v1' },
      { id: 'v2', timbre: 'reed', pan: -0.5, gain: 2, range: [40, 60], part: 'A' },
    ]);
    expect(roundTrip(parsed({ ...HEAD, voices: newPiece({ seed: 0 }).voices }))).not.toHaveProperty(
      'voices',
    );
  });

  for (const [type, defaults] of Object.entries(MOMENT_DEFAULTS)) {
    it(`strips and restores the ${type} moment's defaults`, () => {
      const m = { id: 'm00001', type, at: 1, ...REQUIRED[type], ...cloneJson(defaults) };
      const p = parsed({ ...HEAD, moments: [m] });
      const s = roundTrip(p).moments as Record<string, unknown>[];
      for (const k of Object.keys(defaults)) expect(s[0], k).not.toHaveProperty(k);
      expect(s[0]).toEqual({ type, id: 'm00001', at: 1, ...REQUIRED[type] });
    });
  }

  it('keeps a moment field that differs from its default', () => {
    const p = parsed({
      ...HEAD,
      moments: [{ id: 'w', type: 'walk', at: 0, until: 8, steps: [-1, 1], density: 0.45 }],
    });
    expect((roundTrip(p).moments as unknown[])[0]).toEqual({
      type: 'walk',
      id: 'w',
      at: 0,
      until: 8,
      steps: [-1, 1],
    });
  });

  it('strips timbre defaults field by field', () => {
    const t = { ...cloneJson(TIMBRE_DEFAULTS), harmonics: [1, 0.5], accent: 0.3 };
    const s = roundTrip(parsed({ ...HEAD, timbres: { mine: t } }));
    expect(s.timbres).toEqual({ mine: { harmonics: [1, 0.5], accent: 0.3 } });
    roundTrip(parsed({ ...HEAD, timbres: { glass: BUILTIN_TIMBRES.glass } }));
  });

  it('keeps unknown fields, in canonical key order', () => {
    const p = parsed({
      ...HEAD,
      zeta: 1,
      alpha: { b: 2, a: 1 },
      meta: { title: 'Untitled', x: 1 },
    });
    const s = roundTrip(p);
    expect(Object.keys(s)).toEqual(['format', 'version', 'meta', 'alpha', 'zeta']);
    expect(Object.keys(s.alpha as object)).toEqual(['a', 'b']);
    expect(s.meta).toEqual({ x: 1 });
  });
});

describe('jsonEqual', () => {
  it('compares plain JSON deeply, ignoring key order and undefined fields', () => {
    expect(jsonEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 0 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
