/**
 * Incremental compile (PLAN.md §7.10) on the benchmark piece and the examples: edits resume from a
 * checkpoint and give exactly `compile`'s result.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { moveMomentsBy, patchMoment, removeMoments } from '../../../src/app/editor/ops';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import { benchmarkPiece } from './compiler-bench-piece';
import { withStart } from './compiler-fixtures';

// Slowest test 1.1 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

const EXAMPLES = join(import.meta.dirname, '../../../examples');

function examples(): Piece[] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .sort()
    .map((f) => {
      const r = parsePiece(JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')));
      if (!r.ok) throw new Error(f);
      return r.piece;
    });
}

describe('incremental compile', () => {
  it('resumes edits at 10, 50 and 90 % of the benchmark piece with the same result', () => {
    const inc = createIncrementalCompiler();
    let p = benchmarkPiece();
    expect(inc.compile(p)).toStrictEqual(compile(p));
    expect(inc.stats.mode).toBe('full');
    for (const frac of [0.1, 0.5, 0.9]) {
      const m = p.moments[Math.floor(frac * p.moments.length)];
      p = moveMomentsBy(p, [m.id], 0.37);
      expect(inc.compile(p)).toStrictEqual(compile(p));
      expect(inc.stats.mode).toBe('resume');
      expect(inc.stats.from).toBeLessThanOrEqual(m.at);
      expect(inc.stats.from).toBeGreaterThan(m.at - 3);
      p = patchMoment(p, m.id, { glide: { length: 1.3 } });
      expect(inc.compile(p)).toStrictEqual(compile(p));
      expect(inc.stats.mode).toBe('resume');
    }
  });

  it('matches compile for moves and deletes across every example', () => {
    for (const piece of examples()) {
      const inc = createIncrementalCompiler();
      expect(inc.compile(piece)).toStrictEqual(compile(piece));
      const n = piece.moments.length;
      for (const j of [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]) {
        const id = piece.moments[j].id;
        for (const p of [
          moveMomentsBy(piece, [id], 0.5),
          moveMomentsBy(piece, [id], -0.5),
          removeMoments(piece, [id]),
          piece,
        ]) {
          expect(inc.compile(p)).toStrictEqual(compile(p));
        }
      }
    }
  });

  it("passes compile options through (crossings: 'allow')", () => {
    const inc = createIncrementalCompiler({ crossings: 'allow' });
    let p = benchmarkPiece();
    inc.compile(p);
    p = moveMomentsBy(p, [p.moments[120].id], -0.8);
    expect(inc.compile(p)).toStrictEqual(compile(p, { crossings: 'allow' }));
    expect(inc.stats.mode).toBe('resume');
  });

  it('compiles in full after a setup change, and after reset', () => {
    const inc = createIncrementalCompiler();
    const p = benchmarkPiece();
    inc.compile(p);
    const q = { ...p, key: { tonic: 'C', scale: 'major' } } as typeof p;
    expect(inc.compile(q)).toStrictEqual(compile(q));
    expect(inc.stats.mode).toBe('full');
    // The opening is a moment now (schema v2): changing it resumes from 0.
    const o = { ...q, moments: withStart(q, [{ voice: 'v2', pitch: 60 }]) };
    expect(inc.compile(o)).toStrictEqual(compile(o));
    expect(inc.stats.mode).toBe('resume');
    const r = { ...o, voices: o.voices.map((v, i) => (i === 3 ? { ...v, gain: 0.5 } : v)) };
    expect(inc.compile(r)).toStrictEqual(compile(r));
    expect(inc.stats.mode).toBe('resume');
    inc.reset();
    inc.compile(r);
    expect(inc.stats.mode).toBe('full');
  });
});
