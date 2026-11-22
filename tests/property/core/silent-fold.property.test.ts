/**
 * composing.md §3 #4 and #6 (2026-11-22): no line is lost by folding; a silent part is brought in
 * by a chord, unison or tune partway through.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { pitchesWithPcs, scalePcs } from '../../../src/core/scales';
import type { Key, Moment, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from '../../unit/core/compiler-fixtures';

vi.setConfig({ testTimeout: 30_000 });

const RUNS = Number(process.env.PROP_RUNS ?? 150);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);
const KEY: Key = { tonic: 'C', scale: 'major' };
const END = 80;

/** Pitches sounding at t per part. */
function sounding(p: Piece, s: ReturnType<typeof compile>, t: number, part: string): number[] {
  const out: number[] = [];
  s.voices.forEach((v, i) => {
    if (p.voices[i].part !== part) return;
    const life = v.lives.find((l) => l.born <= t && (l.died ?? Infinity) > t);
    if (!life) return;
    const g = v.segments.find((x) => x.t0 <= t && t < x.t1);
    if (g) out.push(g.p1);
  });
  return out.sort((a, b) => a - b);
}

/**
 * Two parts with ranges of 12–30 semitones, each opening on 1–5 distinct scale tones, then
 * shifts (one unit per piece, so distinct notes stay distinct before folding) on a whole part or
 * on every line. Each shift starts after the last one's moves have all started: a moment that
 * cancels pending moves can leave a line on a note another line was leaving (not a fold).
 */
const foldArb = fc
  .record({
    seed: fc.integer({ min: 0, max: 0xffff }),
    lo: fc.tuple(fc.integer({ min: 40, max: 70 }), fc.integer({ min: 40, max: 70 })),
    width: fc.tuple(fc.integer({ min: 12, max: 30 }), fc.integer({ min: 12, max: 30 })),
    k: fc.tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 })),
    pick: fc.array(fc.nat(), { minLength: 10, maxLength: 10 }),
    unit: fc.constantFrom('semitones' as const, 'scaleSteps' as const),
    shifts: fc.array(
      fc.record({
        gap: fc.integer({ min: 1, max: 30 }).map((x) => x / 10),
        by: fc.integer({ min: -14, max: 14 }),
        target: fc.constantFrom<string | undefined>('A', 'B', undefined),
        length: fc.integer({ min: 1, max: 30 }).map((x) => x / 10),
        stagger: fc.integer({ min: 0, max: 20 }).map((x) => x / 10),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  })
  .map((r) => {
    const moments: MomentInput[] = [];
    const ranges: [number, number][] = [0, 1].map((j) => [r.lo[j], r.lo[j] + r.width[j]]);
    ['A', 'B'].forEach((part, j) => {
      const tones = pitchesWithPcs(scalePcs(KEY), ranges[j][0], ranges[j][1]);
      const pitches: number[] = [];
      for (let i = 0; pitches.length < r.k[j]; i++) {
        const c = tones[r.pick[(i + 5 * j) % 10] % tones.length];
        if (!pitches.includes(c)) pitches.push(c);
        else if (i > 40) break;
      }
      moments.push({
        type: 'chord',
        at: 0,
        target: { part },
        notes: { kind: 'pitches', pitches: pitches.sort((a, b) => a - b) },
        voicing: 'even',
        assign: 'ordered',
      });
    });
    let at = 0;
    let prev = 0;
    for (const x of r.shifts) {
      at += prev + x.gap;
      prev = x.stagger + 0.1;
      moments.push({
        type: 'shift',
        at,
        by: x.by,
        unit: r.unit,
        target: x.target === undefined ? undefined : { part: x.target },
        glide: { length: x.length, stagger: x.stagger, jitter: 0 },
      });
    }
    const p = piece({
      seed: r.seed,
      pool: 12,
      start: [],
      key: KEY,
      end: { at: END, fade: 1 },
      moments,
    });
    p.voices.forEach((v, i) => {
      v.part = i < 6 ? 'A' : 'B';
      v.range = ranges[i < 6 ? 0 : 1];
    });
    return p;
  });

describe('folding (property, #6)', () => {
  it('no line is lost by folding: every line of each part still sounds at the end', () => {
    fc.assert(
      fc.property(foldArb, (p) => {
        const s = compile(p);
        for (const [j, part] of ['A', 'B'].entries()) {
          const opening = p.moments[j] as Extract<Moment, { type: 'chord' }>;
          const k = opening.notes.kind === 'pitches' ? opening.notes.pitches.length : 0;
          const end = sounding(p, s, END - 2, part);
          expect(end, part).toHaveLength(k);
          expect(new Set(end).size, part).toBe(k);
        }
      }),
      { numRuns: RUNS, seed: SEED, path: process.env.PROP_PATH },
    );
  });
});

/** "Pad" sounding from 0, "Bells" silent, then a chord, unison or tune on Bells. */
const entryArb = fc
  .record({
    seed: fc.integer({ min: 0, max: 0xffff }),
    pad: fc.integer({ min: 1, max: 4 }),
    bells: fc.integer({ min: 1, max: 4 }),
    at: fc.integer({ min: 5, max: 80 }).map((x) => x / 10),
    land: fc.boolean(),
    entry: fc.oneof(
      fc.record({
        type: fc.constant('chord' as const),
        notes: fc.oneof(
          fc.record({
            kind: fc.constant('chord' as const),
            symbol: fc.constantFrom('C', 'Am7', 'G7', 'Fmaj7', 'Dm9', 'C/E'),
          }),
          fc.record({
            kind: fc.constant('pitches' as const),
            pitches: fc.array(fc.integer({ min: 50, max: 96 }), { minLength: 1, maxLength: 5 }),
          }),
        ),
        voicing: fc.constantFrom('even' as const, 'close' as const, 'nearest' as const),
        assign: fc.constant('ordered' as const),
      }),
      fc.record({
        type: fc.constant('unison' as const),
        pitch: fc.oneof(
          fc.integer({ min: 50, max: 96 }),
          fc.constantFrom('center' as const, 'tonic' as const),
        ),
        octaves: fc.boolean(),
      }),
      fc.record({
        type: fc.constant('tune' as const),
        notes: fc.array(
          fc.record({
            pitch: fc.integer({ min: 50, max: 96 }),
            len: fc.constantFrom(0.25, 0.5, 1),
          }),
          { minLength: 1, maxLength: 4 },
        ),
      }),
    ),
  })
  .map((r) => {
    const pool = r.pad + r.bells;
    const entry = {
      ...r.entry,
      at: r.at,
      target: { part: 'Bells' },
      glide: { length: 1, land: r.land },
    } as MomentInput;
    const make = (moments: MomentInput[]): Piece => {
      const p = piece({
        seed: r.seed,
        pool,
        start: [48, 52, 55, 59].slice(0, r.pad),
        end: { at: 20, fade: 1 },
        moments,
      });
      p.voices.forEach((v, i) => {
        v.part = i < r.pad ? 'Pad' : 'Bells';
        if (i >= r.pad) v.range = [60, 90];
      });
      return p;
    };
    return { p: make([entry]), without: make([]), pad: r.pad, at: r.at };
  });

describe('silent parts (property, #4)', () => {
  it('a chord, unison or tune on a silent part brings it in at its time, the rest untouched', () => {
    fc.assert(
      fc.property(entryArb, ({ p, without, pad, at }) => {
        const { score: s, trace } = compileWithTrace(p);
        const id = p.moments[p.moments.length - 1].id;
        // Born on their notes, not out of another line.
        for (const m of trace.moments.filter((x) => x.id === id))
          for (const it of m.intents ?? []) if (it.kind === 'birth') expect(it.parent).toBe(-1);
        expect(s.diagnostics.filter((d) => d.momentId === id && d.code === 'no-effect')).toEqual(
          [],
        );
        const bells = s.voices.slice(pad).filter((v) => v.lives.length > 0);
        expect(bells.length).toBeGreaterThan(0);
        for (const v of bells) {
          expect(v.lives[0].born).toBeGreaterThanOrEqual(at - 1e-9);
          expect(v.lives[0].born).toBeLessThan(at + 2);
        }
        expect(s.voices.slice(0, pad)).toEqual(compile(without).voices.slice(0, pad));
      }),
      { numRuns: RUNS, seed: SEED, path: process.env.PROP_PATH },
    );
  });
});
