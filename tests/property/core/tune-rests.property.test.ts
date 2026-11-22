/**
 * Properties of tune rests, re-strikes and `writtenIn` (PLAN rev 10) over generated pieces: the
 * generator's tunes get every third note turned into a rest, and some `strike: false` or a
 * `writtenIn`. The output stays well formed (lives are contiguous runs of segments), pulse hits
 * land only on sounding lines, re-strikes sit on sounding lines, and incremental = full.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { lifeAt } from '../../../src/core/query';
import type { Moment, Piece, PitchClass, Segment, TuneMoment } from '../../../src/core/types';
import { pieceArb } from './compiler-arbitraries';

vi.setConfig({ testTimeout: 60_000 });

const RUNS = Number(process.env.PROP_RUNS ?? 150);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);
const TONICS: PitchClass[] = ['C', 'D', 'Eb', 'F#', 'A'];

function withRests(p: Piece): Piece {
  let j = 0;
  const moments = p.moments.map((m): Moment => {
    if (m.type !== 'tune') return m;
    j++;
    const t: TuneMoment = {
      ...m,
      notes: m.notes.map((n, k) => (k % 3 === 1 ? { rest: true, len: n.len } : n)),
    };
    if (j % 3 === 1) t.strike = false;
    if (j % 2 === 0) t.writtenIn = TONICS[j % TONICS.length];
    return t;
  });
  return { ...p, moments };
}

const arb = pieceArb({ parts: true }).map(withRests);

function check(prop: fc.IProperty<[Piece]>): void {
  fc.assert(prop, { numRuns: RUNS, seed: SEED, endOnFailure: true });
}

describe('tune rests (property)', () => {
  it('lives stay contiguous runs of segments; pool slots never overlap', () => {
    let rests = 0;
    check(
      fc.property(arb, (p) => {
        rests += p.moments.filter((m) => m.type === 'tune' && m.notes.some((n) => n.rest)).length;
        const s = compile(p);
        for (const v of s.voices) {
          let k = 0;
          for (let i = 0; i < v.lives.length; i++) {
            const life = v.lives[i];
            if (i > 0) expect(life.born).toBeGreaterThanOrEqual(v.lives[i - 1].died!);
            const segs: Segment[] = [];
            while (k < v.segments.length && v.segments[k].t0 < (life.died ?? Infinity)) {
              segs.push(v.segments[k++]);
            }
            expect(segs.length).toBeGreaterThan(0);
            expect(segs[0].t0).toBe(life.born);
            expect(segs[segs.length - 1].t1).toBe(life.died);
            for (let j = 1; j < segs.length; j++) {
              expect(segs[j].t0).toBe(segs[j - 1].t1);
              expect(segs[j].p0).toBe(segs[j - 1].p1);
            }
          }
          expect(k).toBe(v.segments.length);
        }
      }),
    );
    expect(rests).toBeGreaterThan(20);
  });

  it('pulse hits and re-strikes land on sounding lines only', () => {
    check(
      fc.property(arb, (p) => {
        const s = compile(p);
        for (const v of s.voices) {
          for (const r of v.pulse ?? []) {
            if (r.hit) expect(lifeAt(v, r.t), `${v.id} at ${r.t}`).not.toBeNull();
          }
        }
      }),
    );
  });

  it('incremental equals full when a tune is edited', () => {
    check(
      fc.property(arb, (p) => {
        const inc = createIncrementalCompiler();
        expect(inc.compile(p)).toEqual(compile(p));
        const i = p.moments.findIndex((m) => m.type === 'tune' && m.notes.length > 1);
        if (i < 0) return;
        const m = p.moments[i] as TuneMoment;
        const notes = m.notes.slice();
        notes[notes.length - 1] = { rest: true, len: notes[notes.length - 1].len };
        const q = { ...p, moments: p.moments.map((x, j) => (j === i ? { ...m, notes } : x)) };
        expect(inc.compile(q)).toEqual(compile(q));
      }),
    );
  });
});
