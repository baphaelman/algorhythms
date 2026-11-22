/**
 * A fork takes its parent's level (integrator, 2026-11-22): a newborn of a split or a chord
 * `count` comes in at the level of the line it forks from, carrying a ramp in progress, so the
 * fork is level-continuous. A level moment that addresses the newborn while it is pending still
 * applies to it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moveMomentsBy, patchMoment } from '../../../src/app/editor/ops';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { pitchAt, weightTargetAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, CompiledVoice, Piece } from '../../../src/core/types';
import { levelAt } from '../../../src/render/level';
import { piece, type MomentInput } from './compiler-fixtures';

const SPLIT: MomentInput = {
  type: 'split',
  at: 10,
  count: 3,
  notes: { kind: 'pitches', pitches: [52, 57, 64] },
  voicing: 'even',
  glide: { length: 0.4, stagger: 0.3 },
};
const QUIET: MomentInput = { type: 'level', at: 0, gain: 0.45, over: 0 };
const SWELL: MomentInput = { type: 'level', at: 10, gain: 0.75, over: 5 };

/** Newborns of the split (pool indices with their parent), from the trace. */
function forks(p: Piece): { score: CompiledScore; forks: { voice: number; parent: number }[] } {
  const { score, trace } = compileWithTrace(p);
  const out: { voice: number; parent: number }[] = [];
  for (const m of trace.moments) {
    for (const it of m.intents ?? []) {
      if (it.kind === 'birth' && it.parent !== undefined && it.parent >= 0)
        out.push({ voice: it.voice, parent: it.parent });
    }
  }
  return { score, forks: out };
}

function born(v: CompiledVoice): number {
  return v.lives[v.lives.length - 1].born;
}

/** max |level(a) − level(b)| over [t0, t1] in 10 ms steps. */
function levelGap(a: CompiledVoice, b: CompiledVoice, t0: number, t1: number): number {
  let worst = 0;
  for (let t = t0; t <= t1; t += 0.01) {
    worst = Math.max(worst, Math.abs(levelAt(a, t) - levelAt(b, t)));
  }
  return worst;
}

describe('a fork takes its parent level', () => {
  it('at its birth and through a ramp in progress (level before the split)', () => {
    const { score, forks: fs } = forks(piece({ start: [57], moments: [QUIET, SWELL, SPLIT] }));
    expect(fs.length).toBe(2);
    for (const f of fs) {
      const nb = score.voices[f.voice];
      const pa = score.voices[f.parent];
      const b = born(nb);
      expect(b).toBeGreaterThan(10);
      expect(b).toBeLessThan(10.4);
      expect(levelAt(nb, b)).toBeCloseTo(levelAt(pa, b), 12);
      expect(levelAt(nb, b)).toBeGreaterThan(0.45);
      expect(levelAt(nb, b)).toBeLessThan(0.75);
      expect(levelGap(nb, pa, b, 20)).toBeLessThan(1e-12);
      expect(levelAt(nb, 15)).toBeCloseTo(0.75, 12);
    }
  });

  it('when the level moment comes after the split at the same time', () => {
    const { score, forks: fs } = forks(piece({ start: [57], moments: [QUIET, SPLIT, SWELL] }));
    expect(fs.length).toBe(2);
    for (const f of fs) {
      const nb = score.voices[f.voice];
      const pa = score.voices[f.parent];
      expect(levelGap(nb, pa, born(nb), 20)).toBeLessThan(1e-12);
    }
  });

  it('when the split comes in the middle of a ramp', () => {
    const p = piece({ start: [57], moments: [QUIET, SWELL, { ...SPLIT, at: 12.5 }] });
    const { score, forks: fs } = forks(p);
    expect(fs.length).toBe(2);
    for (const f of fs) {
      const nb = score.voices[f.voice];
      const pa = score.voices[f.parent];
      expect(levelAt(nb, born(nb))).toBeCloseTo(0.45 + 0.3 * ((born(nb) - 10) / 5), 12);
      expect(levelGap(nb, pa, born(nb), 20)).toBeLessThan(1e-12);
    }
  });

  it('chord count forks too, and later level moments reach them', () => {
    const p = piece({
      start: [57],
      moments: [
        QUIET,
        {
          type: 'chord',
          at: 4,
          notes: { kind: 'pitches', pitches: [53, 57, 60, 64] },
          voicing: 'even',
          assign: 'ordered',
          count: 4,
        },
        { type: 'level', at: 8, gain: 0.9, over: 2 },
      ],
    });
    const { score, forks: fs } = forks(p);
    expect(fs.length).toBe(3);
    for (const f of fs) {
      const nb = score.voices[f.voice];
      expect(levelAt(nb, born(nb))).toBeCloseTo(0.45, 12);
      expect(levelGap(nb, score.voices[f.parent], born(nb), 14)).toBeLessThan(1e-12);
      expect(levelAt(nb, 11)).toBeCloseTo(0.9, 12);
    }
  });

  it('a level moment addressed to a pending newborn still applies to it', () => {
    // The top line (rank 2 of 3) is a newborn waiting out the stagger at 10.
    const top: MomentInput = {
      type: 'level',
      at: 10,
      gain: 0.2,
      over: 0,
      target: { rank: [2, 2] },
    };
    const { score, forks: fs } = forks(piece({ start: [57], moments: [QUIET, SPLIT, top] }));
    const high = fs.map((f) => score.voices[f.voice]).find((v) => pitchAt(v, 12) === 64)!;
    expect(born(high)).toBeGreaterThan(10);
    expect(levelAt(high, born(high))).toBeCloseTo(0.2, 12);
    expect(levelAt(score.voices[0], 12)).toBeCloseTo(0.45, 12);
  });

  it('a fork that joins its parent again hands back its weight unscaled', () => {
    const p = piece({
      start: [57],
      moments: [
        QUIET,
        { ...SPLIT, count: 2, notes: { kind: 'pitches', pitches: [57, 64] } },
        { type: 'unison', at: 20, pitch: 57, octaves: false },
      ],
    });
    const score = compile(p);
    const v1 = score.voices[0];
    // Before the fix the newborn sounded at 1 and handed over 1 · (1 / 0.45)² ≈ 4.9.
    expect(weightTargetAt(v1, 30)).toBeCloseTo(2, 9);
  });
});

describe('forks in the examples', () => {
  const dirs = ['../../../examples', '../../../examples/compositions'].map((d) =>
    join(import.meta.dirname, d),
  );
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.algorhythms.json'))) {
      it(`${f}: every fork starts at its parent's level`, () => {
        const r = parsePiece(readFileSync(join(dir, f), 'utf8'));
        if (!r.ok) throw new Error(r.errors.join('; '));
        const { score, trace } = compileWithTrace(r.piece);
        let n = 0;
        for (const m of trace.moments) {
          for (const it of m.intents ?? []) {
            if (it.kind !== 'birth' || it.parent === undefined || it.parent < 0) continue;
            const nb = score.voices[it.voice];
            const life = nb.lives.find((l) => l.born >= m.t - 1e-9);
            if (!life) continue;
            const pa = score.voices[it.parent];
            if (pitchAt(pa, life.born) === null) continue;
            expect(levelAt(nb, life.born), `${f} ${m.id} v${it.voice}`).toBeCloseTo(
              levelAt(pa, life.born),
              9,
            );
            n++;
          }
        }
        // The originals fork from sounding lines; of the compositions only Tide Pools does.
        if (dir === dirs[0] || f.startsWith('tide-pools')) expect(n).toBeGreaterThan(0);
      });
    }
  }
});

describe('incremental compile', () => {
  it('matches compile across edits of the level and the split', () => {
    const inc = createIncrementalCompiler();
    let p = piece({
      start: [57],
      moments: [
        QUIET,
        { id: 'sw', ...SWELL },
        { id: 'sp', ...SPLIT },
        { type: 'merge', at: 22, count: 1, which: 'top', fade: 1 },
      ],
    });
    expect(inc.compile(p)).toStrictEqual(compile(p));
    const edits: ((q: Piece) => Piece)[] = [
      (q) => moveMomentsBy(q, ['sp'], 1.7),
      (q) => patchMoment(q, 'sw', { gain: 0.3 }),
      (q) => moveMomentsBy(q, ['sw'], 2.4),
      (q) => patchMoment(q, 'sp', { count: 4 }),
      (q) => moveMomentsBy(q, ['sp'], -3),
    ];
    for (const e of edits) {
      p = e(p);
      expect(inc.compile(p)).toStrictEqual(compile(p));
    }
  });
});

describe('a line born with no parent starts at level 1', () => {
  const MELODY: MomentInput = {
    type: 'level',
    at: 1,
    gain: 0.3,
    over: 0,
    target: { part: 'Melody' },
  };

  /** v1, v3 Bass; v2, v4 Melody. Melody dies at 3 and comes back from silence at 10. */
  function reborn(level: MomentInput, after: MomentInput[] = []): Piece {
    const p = piece({
      pool: 4,
      start: [36, 72],
      moments: [
        { id: 'lv', ...level },
        { id: 'mg', type: 'merge', at: 3, count: 1, which: 'top', fade: 1 },
        {
          id: 'in',
          type: 'chord',
          at: 10,
          notes: { kind: 'pitches', pitches: [72] },
          voicing: 'even',
          assign: 'ordered',
          target: { part: 'Melody' },
        },
        ...after,
      ],
    });
    p.voices.forEach((v, i) => (v.part = i % 2 === 0 ? 'Bass' : 'Melody'));
    return p;
  }

  /** The Melody line, which lived twice. */
  function melody(p: Piece): { v: CompiledVoice; b: number } {
    const v = compile(p).voices.find((x) => x.lives.length === 2)!;
    expect(v.lives[0].died).toBeLessThan(10);
    return { v, b: born(v) };
  }

  it('a part coming in from silence plays at 1, not at its earlier level', () => {
    const { v, b } = melody(reborn(MELODY));
    expect(levelAt(v, 2)).toBeCloseTo(0.3, 12);
    expect(b).toBe(10);
    for (const t of [b, b + 1, 20]) expect(levelAt(v, t)).toBe(1);
  });

  it('an establishing chord after full silence plays at 1', () => {
    const p = piece({
      pool: 2,
      start: [57],
      moments: [
        { type: 'level', at: 1, gain: 0.3, over: 0 },
        { type: 'merge', at: 3, count: 0, which: 'top', fade: 1 },
        {
          type: 'chord',
          at: 10,
          notes: { kind: 'pitches', pitches: [60] },
          voicing: 'even',
          assign: 'ordered',
        },
      ],
    });
    const v = compile(p).voices[0];
    expect(v.lives.map((l) => l.born)).toEqual([0, 10]);
    expect(levelAt(v, 2)).toBeCloseTo(0.3, 12);
    expect(levelAt(v, 10)).toBe(1);
    expect(levelAt(v, 12)).toBe(1);
  });

  it('keeps a level moment that addresses it while pending', () => {
    const late: MomentInput = {
      type: 'level',
      at: 10,
      gain: 0.5,
      over: 0,
      target: { part: 'Melody' },
    };
    const { v, b } = melody(reborn(MELODY, [late]));
    expect(levelAt(v, b)).toBeCloseTo(0.5, 12);
    expect(levelAt(v, 20)).toBeCloseTo(0.5, 12);
  });

  it('a ramp in progress at the old death does not continue into the new life', () => {
    // 1 → 0.1 over 1…21 s: still running when the line dies and when it comes back.
    const { v, b } = melody(reborn({ ...MELODY, gain: 0.1, over: 20 }));
    expect(levelAt(v, 5)).toBeLessThan(0.9);
    for (const t of [b, 15, 21, 25]) expect(levelAt(v, t)).toBe(1);
  });

  it('a line that never had a level gets no entry', () => {
    const { v } = melody(reborn({ ...MELODY, target: { part: 'Bass' } }));
    expect(v.level).toEqual([]);
  });

  it('incremental compile matches compile across edits', () => {
    const inc = createIncrementalCompiler();
    let p = reborn({ ...MELODY, over: 6 }, [
      { id: 'lt', type: 'level', at: 12, gain: 0.6, over: 2, target: { part: 'Melody' } },
    ]);
    expect(inc.compile(p)).toStrictEqual(compile(p));
    const edits: ((q: Piece) => Piece)[] = [
      (q) => patchMoment(q, 'lv', { gain: 0.2 }),
      (q) => moveMomentsBy(q, ['in'], 2.5),
      (q) => moveMomentsBy(q, ['lt'], -4.5),
      (q) => moveMomentsBy(q, ['mg'], 1.2),
      (q) => patchMoment(q, 'lv', { over: 30 }),
      (q) => moveMomentsBy(q, ['in'], -3),
    ];
    for (const e of edits) {
      p = e(p);
      expect(inc.compile(p)).toStrictEqual(compile(p));
    }
  });
});
