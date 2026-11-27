/**
 * Canonical numbers (core/canonical.ts, PLAN.md §11.4): what each field rounds to, idempotence,
 * copy-on-write, unknown fields untouched, and the examples change inaudibly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalPiece,
  roundLevel,
  roundOther,
  roundStep,
  roundTime,
} from '../../../src/core/canonical';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { withOpening } from '../opened-piece';
import { PieceSchema, parsePiece } from '../../../src/core/schema';
import type { Moment, Piece } from '../../../src/core/types';

function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

describe('rounding rules', () => {
  it('times to 1 ms, steps to 1 µs, levels to 3 digits, the rest to 12 digits', () => {
    expect(roundTime(1.23456)).toBe(1.235);
    expect(roundTime(133.74599999999998)).toBe(133.746);
    expect(roundStep(0.35714285714)).toBe(0.357143);
    expect(roundLevel(0.123456)).toBe(0.123);
    expect(roundLevel(12.345)).toBe(12.3);
    expect(roundOther(0.1 + 0.2)).toBe(0.3);
    expect(roundOther(60.000000000001)).toBe(60);
  });

  it('leaves integers alone and never rounds a positive time to 0', () => {
    expect(roundTime(4294967295)).toBe(4294967295);
    expect(roundTime(0.0001)).toBe(0.001);
    expect(roundStep(1e-9)).toBe(1e-6);
    expect(roundTime(-0.0001)).toBe(-0.001);
    expect(roundTime(0)).toBe(0);
  });

  it('is idempotent', () => {
    for (const x of [1.0005, 2.9999999, 0.1 + 0.7, 123.4565, 1e-7, 7 / 3]) {
      for (const r of [roundTime, roundStep, roundLevel, roundOther]) expect(r(r(x))).toBe(r(x));
    }
  });
});

describe('canonicalPiece', () => {
  const noisy = (): Piece => {
    const p = withOpening(newPiece({ seed: 1 }));
    p.voices[0].gain = 1.23456;
    p.voices[0].pan = -0.33333;
    p.voices[0].sends = { reverb: 0.55555 };
    p.defaults.glide.length = 2.0004;
    p.defaults.glide.jitter = 0.12345;
    p.end = { at: 60.0004, fade: 6 };
    p.view.loop = { start: 1.00049, end: 2 };
    p.moments.push(
      { id: 'lvl001', type: 'level', at: 1.2346, gain: 0.66666, over: 0.5006 },
      {
        id: 'pls001',
        type: 'pulse',
        at: 2,
        until: 9.99999,
        step: 0.3571428571,
        pattern: [1, 0.33333],
        decay: 0.30004,
        floor: 0.11111,
        mode: 'together',
      },
      {
        id: 'tun001',
        type: 'tune',
        at: 3,
        notes: [{ pitch: 60.0000000000001, len: 1.0714285714 }],
        glide: { length: 0.0999 },
      },
      {
        id: 'cho001',
        type: 'chord',
        at: 4,
        notes: { kind: 'pitches', pitches: [60.1 + 0.2] },
        voicing: 'even',
        assign: 'ordered',
        overrides: [{ voice: 0, end: 1.23456, weight: 1.23456 }],
      },
    );
    return p;
  };

  it('rounds each known field by its rule', () => {
    const c = canonicalPiece(noisy());
    expect(c.voices[0]).toMatchObject({ gain: 1.23, pan: -0.333, sends: { reverb: 0.556 } });
    expect(c.defaults.glide).toMatchObject({ length: 2, jitter: 0.123 });
    expect(c.end).toEqual({ at: 60, fade: 6 });
    expect(c.view.loop).toEqual({ start: 1, end: 2 });
    const [, lvl, pls, tun, cho] = c.moments as unknown as Record<string, unknown>[];
    expect(lvl).toMatchObject({ at: 1.235, gain: 0.667, over: 0.501 });
    expect(pls).toMatchObject({
      until: 10,
      step: 0.357143,
      pattern: [1, 0.333],
      decay: 0.3,
      floor: 0.111,
    });
    expect(tun).toMatchObject({ notes: [{ pitch: 60, len: 1.071429 }], glide: { length: 0.1 } });
    expect(cho).toMatchObject({
      notes: { pitches: [60.3] },
      overrides: [{ voice: 0, end: 1.235, weight: 1.23 }],
    });
  });

  it('is idempotent and copy-on-write', () => {
    const p = noisy();
    const c = canonicalPiece(p);
    expect(canonicalPiece(c)).toBe(c);
    // Unchanged parts keep their identity; the input is not mutated.
    expect(c.moments[0]).toBe(p.moments[0]);
    expect(c.timbres).toBe(p.timbres);
    expect(c.voices[1]).toBe(p.voices[1]);
    expect(p.voices[0].gain).toBe(1.23456);
    const clean = newPiece({ seed: 2 });
    expect(canonicalPiece(clean)).toBe(clean);
  });

  it('leaves unknown fields, timbres and the mix as written', () => {
    const p = withOpening(newPiece({ seed: 1 })) as Piece & Record<string, unknown>;
    p.future = { x: 1.234567890123456 };
    p.mix.reverb.size = 0.123456789;
    p.timbres.glass.accent = 0.123456789;
    (p.moments[0] as Moment & { extra: number }).extra = 1.23456789;
    const c = canonicalPiece(p);
    expect(c).toBe(p);
  });

  it("rounds the video's times and levels (M17)", () => {
    const p: Piece = {
      ...newPiece({ seed: 1 }),
      video: {
        window: 12.34567,
        followAt: 33.3333,
        ahead: 12.3456,
        section: { start: 1.23456, end: 9.87654 },
        fadeIn: 1.00004,
        leadIn: 0.5,
        fadeOut: 2.99999,
        endCard: 10,
        title: '1.23456',
      },
    };
    expect(canonicalPiece(p).video).toEqual({
      window: 12.346,
      followAt: 33.3,
      ahead: 12.3,
      section: { start: 1.235, end: 9.877 },
      fadeIn: 1,
      leadIn: 0.5,
      fadeOut: 3,
      endCard: 10,
      title: '1.23456',
    });
  });

  it('parsePiece returns canonical pieces', () => {
    const p = noisy();
    expect(parsed(p)).toEqual(parsed(canonicalPiece(p)));
    expect(canonicalPiece(parsed(p))).toEqual(parsed(p));
  });
});

describe('examples', () => {
  const ROOT = join(import.meta.dirname, '../../../examples');
  const files = [
    ...readdirSync(ROOT)
      .filter((f) => f.endsWith('.algorhythms.json'))
      .map((f) => join(ROOT, f)),
    ...['songs', 'experiments'].flatMap((d) =>
      readdirSync(join(ROOT, d)).map((f) => join(ROOT, d, f)),
    ),
  ];

  /** Largest difference between two compiled scores' numbers; throws if their shapes differ. */
  function maxDiff(a: unknown, b: unknown, path = ''): number {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
    if (Array.isArray(a) && Array.isArray(b)) {
      expect(b.length, path).toBe(a.length);
      return a.reduce((m: number, x, i) => Math.max(m, maxDiff(x, b[i], `${path}[${i}]`)), 0);
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      expect(Object.keys(b).sort(), path).toEqual(Object.keys(a).sort());
      return Object.keys(a).reduce(
        (m, k) => Math.max(m, maxDiff((a as never)[k], (b as never)[k], `${path}.${k}`)),
        0,
      );
    }
    expect(b, path).toEqual(a);
    return 0;
  }

  it('canonical numbers change the compiled examples inaudibly (≤ 0.5 ms, ≤ 0.005 gain)', () => {
    for (const f of files) {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown;
      const asWritten = compile(PieceSchema.parse(raw) as unknown as Piece);
      const canonical = compile(parsed(raw));
      const d = maxDiff(
        JSON.parse(JSON.stringify(asWritten)),
        JSON.parse(JSON.stringify(canonical)),
      );
      expect(d, f).toBeLessThanOrEqual(0.0051);
    }
  });
});
