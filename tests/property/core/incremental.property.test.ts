/**
 * Incremental compile (PLAN.md §7.10): after every edit of a random edit sequence, the
 * incremental compiler's result deep-equals a fresh `compile`.
 */
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  insertMoments,
  moveMomentsBy,
  patchMoment,
  removeMoments,
  type MomentPatch,
} from '../../../src/app/editor/ops';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import type { Glide, Moment, Piece } from '../../../src/core/types';
import { glideArb, momentArb, pieceArb, type Draft } from './compiler-arbitraries';

const RUNS = Number(process.env.PROP_RUNS ?? 150);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);

const IDS = Array.from({ length: 16 }, (_, i) => `v${i + 1}`);

type Edit =
  | { kind: 'move'; j: number; dt: number }
  | { kind: 'replace'; j: number; draft: Draft; keepAt: boolean }
  | { kind: 'glide'; j: number; glide: Glide }
  | { kind: 'add'; draft: Draft }
  | { kind: 'delete'; j: number }
  | { kind: 'swap'; a: number; b: number }
  | { kind: 'mute'; j: number }
  | { kind: 'gain'; v: number; gain: number }
  | { kind: 'start'; pitch: number }
  | { kind: 'clone' };

const tenths = (lo: number, hi: number): fc.Arbitrary<number> =>
  fc.integer({ min: lo * 10, max: hi * 10 }).map((x) => x / 10);

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ kind: fc.constant('move' as const), j: fc.nat(), dt: tenths(-10, 10) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('replace' as const),
      j: fc.nat(),
      draft: momentArb(IDS, 40),
      keepAt: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('glide' as const), j: fc.nat(), glide: glideArb }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('add' as const), draft: momentArb(IDS, 40) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), j: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('swap' as const), a: fc.nat(), b: fc.nat() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('mute' as const), j: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('gain' as const), v: fc.nat(), gain: tenths(0, 2) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('start' as const),
      pitch: fc.integer({ min: 40, max: 80 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'clone' as const }) },
);

let fresh = 0;

/** Applies an edit the way the editor does (ops.ts keeps moments sorted), or raw (swap). */
function apply(p: Piece, e: Edit): Piece {
  const ms = p.moments;
  const pick = (j: number): Moment | undefined => (ms.length > 0 ? ms[j % ms.length] : undefined);
  switch (e.kind) {
    case 'move': {
      const m = pick(e.j);
      return m ? moveMomentsBy(p, [m.id], e.dt) : p;
    }
    case 'replace': {
      const m = pick(e.j);
      if (!m) return p;
      const next = { ...e.draft, id: m.id, ...(e.keepAt ? { at: m.at } : {}) } as Moment;
      if (next.type === 'walk' && e.keepAt) next.until = m.at + (next.until - e.draft.at);
      return { ...p, moments: ms.map((x) => (x === m ? next : x)) };
    }
    case 'glide': {
      const m = pick(e.j);
      return m && m.type !== 'key' ? patchMoment(p, m.id, { glide: e.glide } as MomentPatch) : p;
    }
    case 'add':
      return insertMoments(p, [{ ...e.draft, id: `n${fresh++}` } as Moment]);
    case 'delete': {
      const m = pick(e.j);
      return m ? removeMoments(p, [m.id]) : p;
    }
    case 'swap': {
      if (ms.length < 2) return p;
      const a = e.a % ms.length;
      const b = e.b % ms.length;
      const next = ms.slice();
      [next[a], next[b]] = [next[b], next[a]];
      return { ...p, moments: next };
    }
    case 'mute': {
      const m = pick(e.j);
      return m ? patchMoment(p, m.id, { muted: m.muted ? undefined : true } as MomentPatch) : p;
    }
    case 'gain': {
      const v = e.v % p.voices.length;
      return { ...p, voices: p.voices.map((d, i) => (i === v ? { ...d, gain: e.gain } : d)) };
    }
    case 'start':
      return { ...p, start: [{ voice: p.voices[0].id, pitch: e.pitch }] };
    case 'clone':
      return JSON.parse(JSON.stringify(p)) as Piece;
  }
}

describe('incremental compile', () => {
  it('equals a full compile after every edit of a random edit sequence', () => {
    let steps = 0;
    let resumed = 0;
    fc.assert(
      fc.property(
        pieceArb({ maxMoments: 20 }),
        fc.array(editArb, { minLength: 1, maxLength: 10 }),
        (piece, edits) => {
          const inc = createIncrementalCompiler();
          let p = piece;
          const history: Piece[] = [p];
          let last = inc.compile(p);
          expect(last).toStrictEqual(compile(p));
          for (const e of edits) {
            p = apply(p, e);
            history.push(p);
            const lastJson = JSON.stringify(last);
            const got = inc.compile(p);
            steps++;
            if (inc.stats.mode === 'resume') resumed++;
            // structuredClone: fast-check builds some objects without a prototype; a resumed score may
            // hold the equal objects of an earlier piece (a JSON clone, say).
            const want = structuredClone(compile(p));
            // With DUMP_DIR set, the pieces compiled so far go to $DUMP_DIR/incremental.json.
            const dir = process.env.DUMP_DIR;
            if (dir && !isDeepStrictEqual(structuredClone(got), want))
              writeFileSync(`${dir}/incremental.json`, JSON.stringify(history));
            expect(structuredClone(got)).toStrictEqual(want);
            // Earlier results are never mutated (the app may still be playing them).
            expect(JSON.stringify(last)).toBe(lastJson);
            last = got;
          }
        },
      ),
      { numRuns: RUNS, seed: SEED, path: process.env.PROP_PATH, endOnFailure: true },
    );
    console.log(`incremental: ${resumed}/${steps} edits resumed from a checkpoint`);
    expect(resumed).toBeGreaterThan(steps / 3);
  }, 120_000);
});
