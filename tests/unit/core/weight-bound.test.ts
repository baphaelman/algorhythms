/**
 * Revision 8 weights stay within the voices that fed a line (2026-11-22): a merge sums weights, a
 * split shares them out, so the lines of a part never weigh more than the part has voices.
 * - A merge or `count` death hands on weight but not count; a later split takes it back
 *   (`lines.ts collapse`), from its parent first, then from the other lines the moment touches.
 * - Lines dying into a line a level moment targets take its level change, so a hand-over is not
 *   scaled by a level they kept only because they were dying (`compile.ts levelMerging`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { lifeAt, linesAt, weightTargetAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, CompiledVoice, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 2, jitter: 0, stagger: 0.5, ease: 'smootherstep' as const };
const EPS = 1e-6;

/** Settled weights (the targets they head to) of the lines heard at t, by line. */
function settled(s: CompiledScore, t: number): Map<CompiledVoice, number> {
  const out = new Map<CompiledVoice, number>();
  for (const v of s.voices) {
    const life = lifeAt(v, t);
    // Lines fading out after a join or merge have handed their weight on.
    if (!life || (life.died !== undefined && t >= life.died - (life.fadeOut ?? 0))) continue;
    out.set(v, weightTargetAt(v, t));
  }
  return out;
}

/** The last level target at or before t (1 before any). */
function levelAt(v: CompiledVoice, t: number): number {
  let g = 1;
  for (const c of v.level) if (c.t <= t) g = c.gain;
  return g;
}

/** Weights of the lines heard at t, in pool order. */
function heard(s: CompiledScore, t: number): number[] {
  return [...settled(s, t).values()].map((w) => Math.round(w * 1e9) / 1e9);
}

const merge = (at: number, count: number, fade = 1.5): MomentInput => ({
  type: 'merge',
  at,
  count,
  which: 'top',
  fade,
});
const split = (at: number, count: number, pitches?: number[]): MomentInput => ({
  type: 'split',
  at,
  count,
  voicing: 'even',
  ...(pitches ? { notes: { kind: 'pitches' as const, pitches } } : {}),
});
const four = (moments: MomentInput[]): Piece =>
  piece({ start: [48, 55, 60, 64], glide: GLIDE, end: { at: 30, fade: 1 }, moments });

describe('a split takes back the weight a merge handed on', () => {
  it('merge to 2 or 1, split back to 4: every line weighs 1 again', () => {
    for (const n of [1, 2]) {
      const s = compile(four([merge(1, n), split(10, 4)]));
      expect(
        heard(s, 8).reduce((a, w) => a + w, 0),
        `merge ${n}`,
      ).toBeCloseTo(4, 9);
      expect(heard(s, 25), `merge ${n}`).toEqual([1, 1, 1, 1]);
      expect(linesAt(s, 25)).toBe(4);
    }
  });

  it('a heavy line split into fewer lines than its weight shares it evenly', () => {
    expect(heard(compile(four([merge(1, 1), split(10, 2)])), 25)).toEqual([2, 2]);
    expect(heard(compile(four([merge(1, 2), split(10, 3)])), 25)).toEqual([1, 1.5, 1.5]);
  });

  it("newborns of a light line take the heavy line's surplus, not a fresh voice's", () => {
    // v2 holds the merged top three; both newborns fork from v1 (48), the nearer line.
    const s = compile(
      piece({
        start: [48, 60, 62, 64],
        glide: GLIDE,
        end: { at: 30, fade: 1 },
        moments: [merge(1, 2), split(10, 4, [36, 40, 48, 60])],
      }),
    );
    expect(heard(s, 8)).toEqual([1, 3]);
    expect(heard(s, 25)).toEqual([1, 1, 1, 1]);
  });

  it('a line without surplus still splits into fresh voices', () => {
    const s = compile(piece({ start: [60], end: { at: 30, fade: 1 }, moments: [split(1, 3)] }));
    expect(heard(s, 25)).toEqual([1, 1, 1]);
  });

  it('incremental compiles match full ones', () => {
    const p = four([merge(1, 2), split(10, 4), merge(16, 1), split(22, 3)]);
    const inc = createIncrementalCompiler();
    inc.compile(p);
    const q = structuredClone(p);
    q.moments[3].at = 11;
    expect(inc.compile(q)).toEqual(compile(q));
  });
});

describe('lines merging into a level target take its level', () => {
  const moments = (levelFirst: boolean): MomentInput[] => {
    const lv: MomentInput = { type: 'level', at: 5, gain: 0.5, over: 2 };
    const mg = merge(5, 2, 1);
    return [{ type: 'level', at: 0, gain: 2, over: 0 }, ...(levelFirst ? [lv, mg] : [mg, lv])];
  };

  it('a merge and a level at one time give the same weights in either order', () => {
    for (const first of [false, true]) {
      const s = compile(four(moments(first)));
      expect(heard(s, 25), `level first ${first}`).toEqual([1, 3]);
      // The dying lines fade at the part's new level.
      for (const v of s.voices.slice(0, 4)) expect(levelAt(v, 9), v.id).toBe(0.5);
    }
  });

  it('incremental compiles match full ones', () => {
    const p = four(moments(false));
    const inc = createIncrementalCompiler();
    inc.compile(p);
    const q = structuredClone(p);
    q.moments[q.moments.length - 1].at = 6;
    expect(inc.compile(q)).toEqual(compile(q));
  });
});

describe('examples: settled weights stay within the voices', () => {
  const root = join(import.meta.dirname, '../../../examples');
  const files = ['', 'compositions'].flatMap((d) =>
    readdirSync(join(root, d))
      .filter((f) => f.endsWith('.algorhythms.json'))
      .map((f) => join(d, f)),
  );
  for (const f of files) {
    it(f, () => {
      const r = parsePiece(readFileSync(join(root, f), 'utf8'));
      if (!r.ok) throw new Error(r.errors.join('; '));
      const s = compile(r.piece);
      const partOf = (v: CompiledVoice): string => r.piece.voices[v.index].part ?? '';
      // A level moment on some of a part's lines (a rank or a pick) makes joins pass weight in
      // the survivor's level (× level²): bound the power instead, by each voice's peak level².
      const apart = r.piece.moments.some(
        (m) =>
          m.type === 'level' &&
          typeof m.target === 'object' &&
          ('rank' in m.target || 'voices' in m.target),
      );
      const bound = new Map<string, number>();
      for (const v of s.voices) {
        const peak = apart ? Math.max(1, ...v.level.map((c) => c.gain)) ** 2 : 1;
        bound.set(partOf(v), (bound.get(partOf(v)) ?? 0) + peak);
      }
      for (let t = 0; t < s.duration; t += 0.25) {
        const sum = new Map<string, number>();
        for (const [v, w] of settled(s, t)) {
          const x = apart ? w * levelAt(v, t) ** 2 : w;
          sum.set(partOf(v), (sum.get(partOf(v)) ?? 0) + x);
        }
        for (const [p, x] of sum)
          expect(x, `${f} part '${p}' at ${t.toFixed(2)}`).toBeLessThanOrEqual(bound.get(p)! + EPS);
      }
    });
  }
});
