/**
 * Per-voice overrides (PLAN.md §11.3 "Every dot is draggable", revision 6): random overrides on
 * random pieces. The overridden voice lands on its (range-folded) pitch at `at + end` unless
 * something cut its glide, targets stay in range, and the incremental compile equals a full one
 * while overrides are set, edited and cleared.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { patchMoment, type MomentPatch } from '../../../src/app/editor/ops';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { MIN_GLIDE } from '../../../src/core/compiler/glide';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import type { Piece, VoiceOverride } from '../../../src/core/types';
import { pieceArb } from './compiler-arbitraries';

const RUNS = Number(process.env.PROP_RUNS ?? 150);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);

const POINT = new Set(['chord', 'unison', 'split', 'merge', 'shift', 'spread', 'note', 'pin']);
const tenths = (lo: number, hi: number): fc.Arbitrary<number> =>
  fc.integer({ min: lo * 10, max: hi * 10 }).map((x) => x / 10);

interface OvEdit {
  j: number;
  list: VoiceOverride[];
}

const ovEditArb = (pool: number): fc.Arbitrary<OvEdit> =>
  fc.record({
    j: fc.nat(),
    list: fc.array(
      fc.record(
        {
          voice: fc.integer({ min: 0, max: pool - 1 }),
          pitch: fc.oneof(fc.integer({ min: 30, max: 100 }), tenths(40, 80)),
          end: tenths(0, 6),
        },
        { requiredKeys: ['voice'] },
      ),
      { maxLength: 3 },
    ),
  });

/** Sets the overrides of the j-th point moment (an empty list clears them). */
function applyOv(p: Piece, e: OvEdit): Piece {
  const ms = p.moments.filter((m) => POINT.has(m.type));
  if (ms.length === 0) return p;
  const m = ms[e.j % ms.length];
  return patchMoment(p, m.id, {
    overrides: e.list.length > 0 ? e.list : undefined,
  } as MomentPatch);
}

const withOverrides = pieceArb({ maxMoments: 12 }).chain((p) =>
  fc
    .array(ovEditArb(p.voices.length), { minLength: 1, maxLength: 5 })
    .map((edits) => ({ piece: edits.reduce(applyOv, p), edits })),
);

describe('overrides (property)', () => {
  it('an uncut overridden glide ends at at + end; targets stay in range', () => {
    let checked = 0;
    fc.assert(
      fc.property(withOverrides, ({ piece }) => {
        const { score: s, trace } = compileWithTrace(piece);
        // A dying voice, after its death glide, follows the survivor it merges into.
        const follows = (v: number, t: number): boolean =>
          trace.moments.some((d) => {
            if (d.t > t || !(d.intents ?? []).some((x) => x.kind === 'death' && x.voice === v)) {
              return false;
            }
            const voice = s.voices[v];
            const glide = voice.segments.find((x) => x.momentId === d.id && x.t0 >= d.t);
            const died = voice.lives.find((l) => l.born <= d.t && (l.died ?? Infinity) > d.t)?.died;
            return !!glide && t > glide.t0 && t < (died ?? Infinity);
          });
        for (const m of piece.moments) {
          if (!m.overrides || m.muted || !POINT.has(m.type)) continue;
          const last = new Map<number, VoiceOverride>();
          for (const o of m.overrides) {
            const prev = last.get(o.voice);
            last.set(o.voice, {
              voice: o.voice,
              pitch: o.pitch ?? prev?.pitch,
              end: o.end ?? prev?.end,
            });
          }
          for (const o of last.values()) {
            const v = s.voices[o.voice];
            const [lo, hi] = piece.voices[o.voice].range;
            for (const g of v.segments) {
              if (g.momentId !== m.id || g.p0 === g.p1 || g.t0 < m.at - 1e-9) continue;
              if (follows(o.voice, g.t0)) continue; // a copy of its survivor's move (M4.5-17)
              const cut = g.curve !== undefined && g.curve.t1 > g.t1 + 1e-9;
              const p1 = g.curve ? g.curve.p1 : g.p1;
              expect(p1).toBeGreaterThanOrEqual(lo);
              expect(p1).toBeLessThanOrEqual(hi);
              if (cut || o.end === undefined || m.type === 'note') continue;
              const want = m.at + Math.max(o.end, MIN_GLIDE);
              // A voice born by an earlier moment keeps its start: it may only end later.
              if (Math.abs(g.t1 - want) > 1e-6) expect(g.t1 - g.t0).toBeCloseTo(MIN_GLIDE, 6);
              else checked++;
            }
          }
        }
      }),
      { numRuns: RUNS, seed: SEED, endOnFailure: true },
    );
    expect(checked).toBeGreaterThan(50);
  }, 120_000);

  it('incremental compile equals a full compile as overrides are set, edited and cleared', () => {
    fc.assert(
      fc.property(withOverrides, ({ piece, edits }) => {
        const inc = createIncrementalCompiler();
        let p = piece;
        expect(structuredClone(inc.compile(p))).toStrictEqual(structuredClone(compile(p)));
        for (const e of [...edits, ...edits.map((x) => ({ ...x, list: [] }))]) {
          p = applyOv(p, e);
          expect(structuredClone(inc.compile(p))).toStrictEqual(structuredClone(compile(p)));
        }
      }),
      { numRuns: Math.ceil(RUNS / 2), seed: SEED, endOnFailure: true },
    );
  }, 120_000);
});
