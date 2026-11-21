/**
 * Distinct notes (PLAN §11.3 revision 8, M4.5-29): resting lines never share a pitch, and merges
 * keep the weight of the lines they join.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compile,
  compileWithTrace,
  HANDOVER,
  type CompileTrace,
} from '../../../src/core/compiler/compile';
import { lifeAt, linesAt, pitchAt, segmentAt, weightTargetAt } from '../../../src/core/query';
import { degreesToPcs, pitchesWithPcs } from '../../../src/core/scales';
import { partOf } from '../../../src/core/parts';
import type { CompiledScore, Piece } from '../../../src/core/types';
import { piece } from '../../unit/core/compiler-fixtures';
import { pieceArb } from './compiler-arbitraries';

const RUNS = Number(process.env.PROP_RUNS ?? 150);
// Reproducible by default; set PROP_SEED=random (or a number) to explore other pieces.
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);
/** Longest wait for a scheduled departure (glide length + stagger + jitter in the arbitraries). */
const PART = 10;

/** Death times (moment time) per voice from a compile trace: lines killed by a moment (§7.4). */
type Killed = Map<number, number[]>;

function killedBy(trace: CompileTrace): Killed {
  const out: Killed = new Map();
  for (const m of trace.moments)
    for (const it of m.intents ?? [])
      if (it.kind === 'death') out.set(it.voice, [...(out.get(it.voice) ?? []), m.t]);
  return out;
}

/**
 * Pitches of the lines resting at t (holding, life open and not fading out). With `killed`, lines
 * dying by a merge or a chord `count` (they glide into a survivor and wait for it, §7.4) are left
 * out too.
 */
function resting(s: CompiledScore, t: number, killed?: Killed): number[] {
  return restingLines(s, t, killed).map((l) => l.p);
}

/**
 * As `resting`, with when each line next leaves its pitch in this life (Infinity: it stays).
 */
function restingLines(
  s: CompiledScore,
  t: number,
  killed?: Killed,
): { p: number; leaves: number; v: number }[] {
  const out: { p: number; leaves: number; v: number }[] = [];
  s.voices.forEach((v, vi) => {
    const life = lifeAt(v, t);
    if (!life) return;
    const died = life.died;
    if (died !== undefined && t >= died - (life.fadeOut ?? 0)) return;
    // On its way out: a moment killed it in this life (or before it was born).
    const prev = v.lives.filter((l) => l.born < life.born).at(-1)?.died ?? -Infinity;
    if (killed?.get(vi)?.some((k) => k > prev && k <= t)) return;
    const g = segmentAt(v, t);
    if (!g || g.p0 !== g.p1 || (g.m0 ?? 0) !== 0 || g.curve) return;
    // A line still settling (its move ended within the join hand-over window) may not have merged.
    if (g.t0 > t - 0.2 && g.t0 > life.born) return;
    let leaves = Infinity;
    for (const h of v.segments) {
      if (h.t0 <= t || h.t0 >= (died ?? Infinity)) continue;
      if ((h.curve ? h.curve.p1 : h.p1) !== g.p0) {
        leaves = h.t0;
        break;
      }
    }
    out.push({ p: g.p0, leaves, v: vi });
  });
  return out.sort((a, b) => a.p - b.p);
}

/**
 * Two lines may share a pitch only on their way apart: a later moment already moves one of them
 * on (its staggered moves start after the other arrives), within PART seconds. Revision 9: only
 * lines of one part (`partOf`) count; lines of different parts may share a pitch.
 */
function checkDistinct(p: Piece): void {
  const { score: s, trace } = compileWithTrace(p);
  const killed = killedBy(trace);
  const part = (v: number): string => partOf(p.voices[v]);
  for (let t = 0.25; t < s.duration; t += 0.5) {
    const ls = restingLines(s, t, killed);
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length && Math.abs(ls[j].p - ls[i].p) < 1e-6; j++) {
        if (part(ls[i].v) !== part(ls[j].v)) continue;
        if (Math.min(ls[i].leaves, ls[j].leaves) - t > PART)
          expect.fail(`two lines of part '${part(ls[i].v)}' rest on ${ls[i].p} at ${t}`);
      }
    }
  }
}

describe('distinct notes (property)', () => {
  it('no two resting lines share a pitch', () => {
    fc.assert(fc.property(pieceArb(), checkDistinct), { numRuns: RUNS, seed: SEED });
  });

  it('with parts (revision 9): no two resting lines of one part share a pitch', () => {
    fc.assert(fc.property(pieceArb({ parts: true }), checkDistinct), {
      numRuns: RUNS,
      seed: SEED,
      path: process.env.PROP_PATH,
    });
  });

  it('with parts: lines of different parts never merge (no join, death or newborn crosses a part)', () => {
    fc.assert(
      fc.property(pieceArb({ parts: true }), (p) => {
        const { trace } = compileWithTrace(p);
        const part = (v: number): string => partOf(p.voices[v]);
        for (const m of trace.moments) {
          for (const it of m.intents ?? []) {
            if (it.kind === 'death' && it.into !== undefined && it.into >= 0)
              expect(part(it.into), `${m.id} death`).toBe(part(it.voice));
            if (it.kind === 'birth' && it.parent !== undefined && it.parent >= 0)
              expect(part(it.voice), `${m.id} birth`).toBe(part(it.parent));
          }
        }
      }),
      { numRuns: RUNS, seed: SEED, path: process.env.PROP_PATH },
    );
  });

  // A line that ends early without a moment killing it joined a line resting on its note
  // (compile.ts onJoin): that line is of its part.
  it('with parts: a line that joins another joins one of its own part', () => {
    fc.assert(
      fc.property(pieceArb({ parts: true }), (p) => {
        const { score: s, trace } = compileWithTrace(p);
        const killed = killedBy(trace);
        const part = (v: number): string => partOf(p.voices[v]);
        s.voices.forEach((v, vi) => {
          let prev = -Infinity;
          for (const life of v.lives) {
            const died = life.died;
            const from = prev;
            prev = died ?? Infinity;
            if (died === undefined || died >= s.duration || (life.fadeOut ?? 0) !== HANDOVER)
              continue;
            if (killed.get(vi)?.some((k) => k > from && k <= died)) continue;
            // It follows its survivor until its fade ends: compare just before it closes.
            const t = died - 1e-6;
            const pt = pitchAt(v, t);
            if (pt === null) continue;
            const hosts = s.voices.flatMap((u, ui) => {
              if (ui === vi || !lifeAt(u, t)) return [];
              const q = pitchAt(u, t);
              return q !== null && Math.abs(q - pt) < 1e-4 ? [ui] : [];
            });
            if (hosts.length === 0) continue; // no line on its note: not a join
            expect(
              hosts.some((u) => part(u) === part(vi)),
              `${v.id} (part '${part(vi)}') joined ${hosts.map((u) => s.voices[u].id).join()} at ${died}`,
            ).toBe(true);
          }
        });
      }),
      { numRuns: RUNS, seed: SEED, path: process.env.PROP_PATH },
    );
  });

  // Owner, 2026-11-21: a chord or degrees chord (any voicing, with or without count) takes free
  // octaves of its chord tones in the lines' range before two lines share a note, so the lines
  // heard are min(lines, chord tones in range).
  it('chords take free octaves before merging lines', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 36, max: 72 }),
        fc.integer({ min: 4, max: 30 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 4 }),
        fc.constantFrom('even', 'close', 'nearest'),
        fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
        (lo, w, offs, degrees, voicing, reg, count) => {
          const hi = lo + w;
          const start = [...new Set(offs.map((o) => lo + (o % (w + 1))))];
          const p = piece({
            start,
            range: [lo, hi],
            pool: 12,
            glide: { length: 1, jitter: 0, stagger: 0.3 },
            end: { at: 20, fade: 1 },
            moments: [
              {
                type: 'chord',
                at: 1,
                notes: { kind: 'degrees', degrees },
                voicing,
                assign: 'ordered',
                ...(reg === undefined || lo + reg + 4 > hi
                  ? {}
                  : { register: [lo + reg, lo + reg + 4] }),
                ...(count === undefined ? {} : { count }),
              },
            ],
          });
          const s = compile(p);
          if (s.diagnostics.some((d) => d.level === 'error')) return;
          const tones = pitchesWithPcs(degreesToPcs(degrees, p.key), lo, hi).length;
          if (tones === 0) return; // folded into range: not a voicing question
          expect(linesAt(s, 15)).toBe(Math.min(count ?? start.length, tones));
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it('a unison then a chord: the summed weight is kept through the merge and the split', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 48, max: 72 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (n, u, seed) => {
          const start = Array.from({ length: n }, (_, i) => 48 + 2 * i);
          const s = compile(
            piece({
              seed,
              start,
              pool: 16,
              end: { at: 40, fade: 1 },
              moments: [
                { type: 'unison', at: 1, pitch: u, octaves: false },
                {
                  type: 'chord',
                  at: 12,
                  notes: { kind: 'pitches', pitches: start },
                  voicing: 'even',
                  assign: 'ordered',
                },
              ],
            }),
          );
          const total = (t: number): number =>
            s.voices.reduce((a, v) => {
              const life = lifeAt(v, t);
              if (!life || (life.died !== undefined && t >= life.died - (life.fadeOut ?? 0)))
                return a;
              return a + weightTargetAt(v, t);
            }, 0);
          expect(resting(s, 11)).toEqual([u]);
          expect(total(11)).toBeCloseTo(n, 9);
          expect(resting(s, 29)).toEqual(start);
          expect(total(29)).toBeCloseTo(n, 9);
        },
      ),
      { numRuns: 60, seed: 2611 },
    );
  });
});
