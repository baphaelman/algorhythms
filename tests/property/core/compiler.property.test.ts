/**
 * Compiler property tests (PLAN.md §14) over randomly generated valid pieces.
 *
 * Every property runs RUNS pieces (fast-check, seeded by Vitest's run so failures shrink and
 * replay). See compiler-arbitraries.ts for what the pieces contain.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { parsePiece } from '../../../src/core/schema';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  compile as compileRaw,
  compileWithTrace as compileWithTraceRaw,
  type CompileTrace,
} from '../../../src/core/compiler/compile';
import { CHECK_SAMPLES } from '../../../src/core/interrupt';
import { pulseGainAt } from '../../../src/core/pulse';
import { lifeAt, pitchAt } from '../../../src/core/query';
import { evalSegment, evalSegmentVelocity } from '../../../src/core/segment';
import { easeCodeOf, easeRaw, bezierOf } from '../../../src/core/ease';
import type { CompiledScore, Piece, Segment } from '../../../src/core/types';
import { pieceArb } from './compiler-arbitraries';

// Slowest test 1.8 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

const RUNS = Number(process.env.PROP_RUNS ?? 300);
// Reproducible by default; set PROP_SEED=random (or a number) to explore other pieces.
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);

/**
 * Compile time per generated piece (ms), logged as the slowest. Asserted against this budget only
 * with ALGORHYTHMS_PERF_STRICT=1: wall-clock budgets fail under machine load, compile speed is
 * gated by compiler-perf.test.ts (perf project), and a compile that never returns is caught by
 * the property watchdog (tests/support/fast-check.ts) with its seed and path. Typical is < 1 ms.
 */
const COMPILE_BUDGET_MS = 50;
const STRICT = !!process.env.ALGORHYTHMS_PERF_STRICT;
let slowest = 0;
afterAll(() => console.log(`compiler properties: slowest compile ${slowest.toFixed(2)} ms`));

function timed<R>(f: () => R): R {
  const t = performance.now();
  const r = f();
  const ms = performance.now() - t;
  if (ms > slowest) slowest = ms;
  if (STRICT) expect(ms, 'compile time (ms)').toBeLessThan(COMPILE_BUDGET_MS);
  return r;
}
const compile = (p: Piece): CompiledScore => timed(() => compileRaw(p));
const compileWithTrace = (p: Piece): ReturnType<typeof compileWithTraceRaw> =>
  timed(() => compileWithTraceRaw(p));

/**
 * fc.assert, and when the DUMP_DIR environment variable is set, writes a failing piece to
 * $DUMP_DIR/<name>.json for debugging.
 */
function check<T>(name: string, prop: fc.IProperty<[T]>, numRuns: number): void {
  fc.assert(prop, {
    numRuns,
    seed: SEED,
    path: process.env.PROP_PATH, // replay a reported failure (with PROP_SEED)
    endOnFailure: true, // report at once; shrinking these pieces is slow
    reporter: (out) => {
      if (!out.failed) return;
      const dir = process.env.DUMP_DIR;
      if (dir && out.counterexample) {
        writeFileSync(`${dir}/${name}.json`, JSON.stringify(out.counterexample[0], null, 1));
      }
      throw new Error(`${String(out.errorInstance)}\n${fc.defaultReportMessage(out)}`);
    },
  });
}

/** The moment's effective ease is a bézier that leaves [0, 1] (it overshoots by design). */
function overshootingEase(p: Piece, momentId: string): boolean {
  const m = p.moments.find((x) => x.id === momentId);
  const e = m?.glide?.ease ?? p.defaults.glide.ease;
  return typeof e === 'object' && (e.y1 < 0 || e.y1 > 1 || e.y2 < 0 || e.y2 > 1);
}

/**
 * How far the segment's ease alone (m0 = 0) can leave [min(p0, p1), max(p0, p1)] of its plan: a
 * bézier's y lies within its control hull [min(0, y1, y2), max(1, y1, y2)]; named eases stay in
 * [0, 1].
 */
function ownOvershoot(g: Segment): { up: number; down: number } {
  const end = g.curve ? g.curve : { t1: g.t1, p1: g.p1 };
  if (typeof g.ease !== 'object') return { up: 0, down: 0 };
  const eMin = Math.min(0, g.ease.y1, g.ease.y2);
  const eMax = Math.max(1, g.ease.y1, g.ease.y2);
  const a = g.p0 + (end.p1 - g.p0) * eMin;
  const b = g.p0 + (end.p1 - g.p0) * eMax;
  return {
    up: Math.max(0, Math.max(a, b) - Math.max(g.p0, end.p1)),
    down: Math.max(0, Math.min(g.p0, end.p1) - Math.min(a, b)),
  };
}

/** The planned glide's end (cut segments keep it in `curve`). */
const plannedEnd = (s: Segment): { t1: number; p1: number } =>
  s.curve ? s.curve : { t1: s.t1, p1: s.p1 };

/**
 * Whether segment g of voice v follows a survivor (M4.5-17): a dying voice's segments after its
 * death glide copy the moves of the voice it merges into. A survivor move starting with the death
 * glide (a walk tick at the merge's time) replaces that glide, so none is left.
 */
function isFollow(trace: CompileTrace, score: CompiledScore, v: number, g: Segment): boolean {
  const voice = score.voices[v];
  for (const m of trace.moments) {
    if (m.t > g.t0) break;
    if (!(m.intents ?? []).some((it) => it.kind === 'death' && it.voice === v)) continue;
    const died = lifeAt(voice, m.t)?.died ?? Infinity;
    const glide = voice.segments.find((x) => x.momentId === m.id && x.t0 >= m.t);
    if (g.t0 < died && (glide ? g.t0 > glide.t0 : g.t0 >= m.t)) return true;
  }
  return false;
}

/** Counts for the crossing property (pairs checked, crossings not caused by a bézier's own overshoot). */
interface CrossingStats {
  pairsChecked: number;
  unresolved: number;
}

/** §7.2: under `ordered`, adjacent targeted voices never cross mid-glide unless reported. */
function checkCrossings(p: Piece, stats: CrossingStats): void {
  const { score, trace } = compileWithTrace(p);
  trace.moments.forEach((m, mi) => {
    const plan = m.plan;
    if (!plan || !plan.ordered || plan.order.length < 2) return;
    // A later moment targeting a voice cancels its pending moves (§7.1): the guarantee
    // covers this moment's plan only until then.
    const takeover = (v: number): number => {
      for (const o of trace.moments.slice(mi + 1)) {
        if (o.type !== 'level' && o.targeted.includes(v)) return o.t;
      }
      return Infinity;
    };
    const reported = score.diagnostics.some(
      (d) => d.momentId === m.id && d.code === 'crossing-unresolved',
    );
    const [ws, we] = plan.window;
    // Dying voices merge into a survivor and follow it (M4.5-17): two merging into the same
    // voice end on one line, and their order on the way does not matter.
    const into = new Map<number, number>();
    for (const it of m.intents ?? []) if (it.kind === 'death') into.set(it.voice, it.into ?? -1);
    // Revision 8: lines sent to one note join there on arrival, so they too end as one line (two
    // converging on it may touch out of order by a hair as they meet).
    const target = new Map<number, number>();
    for (const it of m.intents ?? []) if (it.kind !== 'death') target.set(it.voice, it.to);
    // A dying voice goes where its survivor goes: a later moment that moves the survivor takes
    // the dying voice over too (its death glide, started later, aims at the new destination).
    const takeoverOf = (v: number): number => {
      const s = into.get(v);
      return s !== undefined && s >= 0 ? Math.min(takeover(v), takeover(s)) : takeover(v);
    };
    for (let k = 0; k + 1 < plan.order.length; k++) {
      const lo = score.voices[plan.order[k]];
      const hi = score.voices[plan.order[k + 1]];
      if (!plan.movers.includes(lo.index) && !plan.movers.includes(hi.index)) continue;
      const a = into.get(lo.index);
      if (a !== undefined && a >= 0 && a === into.get(hi.index)) continue;
      const qa = target.get(lo.index);
      if (qa !== undefined && qa === target.get(hi.index)) continue;
      // The window ends when a later moment (or walk) takes over either voice.
      let end = Math.min(we, takeoverOf(lo.index), takeoverOf(hi.index));
      for (const v of [lo, hi]) {
        for (const g of v.segments) {
          if (g.t0 >= ws && g.momentId !== undefined && g.momentId !== m.id && g.t0 < end) {
            end = g.t0;
          }
        }
      }
      let ref = false;
      let crossed = false;
      for (let j = 0; j < CHECK_SAMPLES; j++) {
        const t = ws + ((we - ws) * j) / (CHECK_SAMPLES - 1);
        if (t > end) break;
        const a = pitchAt(lo, t);
        const b = pitchAt(hi, t);
        if (a === null || b === null) continue;
        if (!ref) {
          ref = true;
          if (a > b + 1e-9) break; // already out of order at the moment: exempt
          stats.pairsChecked++;
          continue;
        }
        if (a > b + 1e-9) crossed = true;
      }
      if (crossed) {
        if (!overshootingEase(p, m.id)) stats.unresolved++;
        expect(reported, `moment ${m.id} crosses ${lo.id}/${hi.id} without a report`).toBe(true);
      }
    }
  });
}

/** §7.8: targets and carried velocity stay in range (newborns and bézier ornaments exempt). */
function checkRanges(p: Piece): void {
  const s = compile(p);
  for (const v of s.voices) {
    const [lo, hi] = p.voices[v.index].range;
    // A newborn starts on its parent's pitch (§7.4), which may lie outside its own range;
    // it is exempt until its path first starts a segment inside the range.
    let outsideSinceBirth = false;
    let prevOwn = 0;
    let outsideSinceOwn = false;
    v.segments.forEach((g) => {
      const end = plannedEnd(g);
      const isBirth = v.lives.some((l) => l.born === g.t0);
      const inside = g.p0 >= lo && g.p0 <= hi;
      if (isBirth) outsideSinceBirth = !inside;
      else if (inside) outsideSinceBirth = false;
      const birthHold = outsideSinceBirth && end.p1 === g.p0;
      if (!birthHold) {
        expect(end.p1).toBeGreaterThanOrEqual(lo);
        expect(end.p1).toBeLessThanOrEqual(hi);
      }
      // Carried velocity never leaves the range; a bézier's own overshoot may (it is the
      // user's ornament, like the allowance in the L test), and a move interrupting it
      // there starts outside but never goes further out.
      const own = ownOvershoot(g);
      // Still outside after a chain of quick interruptions that began in a bézier's overshoot.
      if (!inside) {
        expect(outsideSinceBirth || prevOwn > 0 || outsideSinceOwn).toBe(true);
        outsideSinceOwn = true;
      } else outsideSinceOwn = false;
      prevOwn = own.up + own.down;
      const bandLo = Math.min(lo, g.p0) - own.down - 1e-9;
      const bandHi = Math.max(hi, g.p0) + own.up + 1e-9;
      for (let j = 0; j < CHECK_SAMPLES; j++) {
        const t = g.t0 + ((g.t1 - g.t0) * j) / (CHECK_SAMPLES - 1);
        const y = evalSegment(g, t);
        // Assert only on a violation: an expect() per sample dominated this test's run time.
        if (y < bandLo || y > bandHi) {
          expect(y, `${v.id} at ${t}`).toBeGreaterThanOrEqual(bandLo);
          expect(y, `${v.id} at ${t}`).toBeLessThanOrEqual(bandHi);
        }
      }
    });
  }
}

/** Pieces that once failed a property (or hung); each must now pass every check. */
const REGRESSIONS = new URL('./regressions/', import.meta.url);

describe('compiler regressions (pieces that once failed)', () => {
  const files = readdirSync(REGRESSIONS)
    .filter((f) => f.endsWith('.json'))
    .sort();
  it('has fixtures', () => expect(files.length).toBeGreaterThanOrEqual(3));
  for (const f of files) {
    it(f, () => {
      const p = JSON.parse(readFileSync(new URL(f, REGRESSIONS), 'utf8')) as Piece;
      expect(p.version).toBe(2);
      const stats: CrossingStats = { pairsChecked: 0, unresolved: 0 };
      checkCrossings(p, stats);
      checkRanges(p);
      const s = compile(p);
      for (const v of s.voices) {
        for (const g of v.segments) {
          expect(Number.isFinite(g.p0) && Number.isFinite(g.p1), `${v.id} pitch`).toBe(true);
        }
      }
    });
  }
});

describe('compiler properties (§14)', () => {
  it('is deterministic: same piece, same score; JSON round trips do not matter', () => {
    check(
      'determinism',
      fc.property(pieceArb(), (p) => {
        const a = compile(p);
        const b = compile(JSON.parse(JSON.stringify(p)) as Piece);
        expect(b).toEqual(a);
        expect(JSON.stringify(compile(p))).toBe(JSON.stringify(a));
      }),
      RUNS,
    );
  });

  it('C⁰ everywhere: lives are contiguous runs of segments with exact joins', () => {
    check(
      'c0',
      fc.property(pieceArb({ varyRanges: true }), (p) => {
        const s = compile(p);
        for (const v of s.voices) {
          let k = 0;
          for (const life of v.lives) {
            const segs: Segment[] = [];
            while (k < v.segments.length && v.segments[k].t0 < (life.died ?? Infinity)) {
              segs.push(v.segments[k++]);
            }
            expect(segs.length).toBeGreaterThan(0);
            expect(segs[0].t0).toBe(life.born);
            expect(segs[segs.length - 1].t1).toBe(life.died);
            for (let i = 0; i < segs.length; i++) {
              const g = segs[i];
              expect(g.t1).toBeGreaterThan(g.t0);
              expect(evalSegment(g, g.t0)).toBe(g.p0);
              expect(evalSegment(g, g.t1)).toBe(g.p1);
              // Inside the segment the curve approaches p1 continuously at the cut.
              const near = evalSegment(g, g.t1 - (g.t1 - g.t0) * 1e-9);
              expect(Math.abs(near - g.p1)).toBeLessThan(1e-5);
              if (i > 0) {
                expect(g.t0).toBe(segs[i - 1].t1);
                expect(g.p0).toBe(segs[i - 1].p1);
              }
            }
          }
          expect(k).toBe(v.segments.length);
        }
      }),
      RUNS,
    );
  });

  it('C¹ at interruptions, except joins flagged clamped (§7.5)', () => {
    let joins = 0;
    let clampedJoins = 0;
    check(
      'c1',
      fc.property(pieceArb(), (p) => {
        const s = compile(p);
        for (const v of s.voices) {
          for (let i = 1; i < v.segments.length; i++) {
            const prev = v.segments[i - 1];
            const next = v.segments[i];
            if (!prev.curve || next.t0 !== prev.t1) continue; // not an interruption
            joins++;
            if (next.clamped) {
              clampedJoins++;
              continue;
            }
            const vl = evalSegmentVelocity(prev, prev.t1);
            const vr = evalSegmentVelocity(next, next.t0);
            expect(Math.abs(vl - vr)).toBeLessThanOrEqual(1e-6 * (1 + Math.abs(vl)));
          }
        }
      }),
      RUNS,
    );
    expect(joins).toBeGreaterThan(50); // the generator really interrupts glides
    expect(clampedJoins).toBeLessThan(joins);
  });

  it('no crossings within the targeted set under ordered (pairwise sampling, §7.2)', () => {
    const stats: CrossingStats = { pairsChecked: 0, unresolved: 0 };
    check(
      'crossing',
      fc.property(pieceArb(), (p) => checkCrossings(p, stats)),
      RUNS,
    );
    expect(stats.pairsChecked).toBeGreaterThan(500);
    // A bézier whose y leaves [0, 1] overshoots by itself, so equal timing cannot stop lines
    // swapping (§7.2's algebra needs 0 ≤ e ≤ 1); those are reported but not counted here. Other
    // unresolvable crossings (carried velocity that tightening cannot fix) must stay rare.
    expect(stats.unresolved / stats.pairsChecked).toBeLessThan(0.002);
  });

  it('overshoot never exceeds its limit L (§7.5)', () => {
    let checked = 0;
    check(
      'overshoot',
      fc.property(pieceArb({ varyRanges: true }), (p) => {
        const { score, trace } = compileWithTrace(p);
        // A note moment plans twice (its return), so look limits up by the segment's start.
        const limits = new Map<string, { t: number; up: number; down: number }[]>();
        for (const m of trace.moments) {
          for (const l of m.plan?.limits ?? []) {
            const k = `${m.id}/${l.voice}`;
            limits.set(k, [...(limits.get(k) ?? []), { t: m.t, up: l.up, down: l.down }]);
          }
        }
        for (const v of score.voices) {
          const range = p.voices[v.index].range;
          for (const g of v.segments) {
            if (!g.m0 || isFollow(trace, score, v.index, g)) continue; // a copy of another's
            checked++;
            const end = plannedEnd(g);
            const lo = Math.min(g.p0, end.p1);
            const hi = Math.max(g.p0, end.p1);
            const lim = (limits.get(`${g.momentId}/${v.index}`) ?? [])
              .filter((l) => l.t <= g.t0)
              .reduce((a, l) => (a.t > l.t ? a : l), { t: -Infinity, up: 1, down: 1 });
            const roomUp = Math.max(0, range[1] - hi);
            const roomDown = Math.max(0, lo - range[0]);
            const up = Math.min(1, lim.up, roomUp);
            const down = Math.min(1, lim.down, roomDown);
            // The ease's own overshoot (béziers) is allowed on top.
            const code = easeCodeOf(g.ease);
            const bz = bezierOf(g.ease);
            let ownUp = hi;
            let ownDown = lo;
            for (let i = 0; i < CHECK_SAMPLES; i++) {
              const x = i / (CHECK_SAMPLES - 1);
              const b = g.p0 + (end.p1 - g.p0) * easeRaw(code, x, bz.x1, bz.y1, bz.x2, bz.y2);
              ownUp = Math.max(ownUp, b);
              ownDown = Math.min(ownDown, b);
            }
            for (let i = 0; i < CHECK_SAMPLES; i++) {
              const x = i / (CHECK_SAMPLES - 1);
              const t = g.t0 + (end.t1 - g.t0) * x;
              const full: Segment = { ...g, t1: end.t1, p1: end.p1, curve: undefined };
              const y = evalSegment(full, t);
              expect(y).toBeLessThanOrEqual(ownUp + up + 1e-9);
              expect(y).toBeGreaterThanOrEqual(ownDown - down - 1e-9);
            }
          }
        }
      }),
      RUNS,
    );
    expect(checked).toBeGreaterThan(100);
  });

  it('ranges are respected (§7.8)', () => {
    check('ranges', fc.property(pieceArb({ varyRanges: true }), checkRanges), RUNS);
  });

  it('pool limits are respected: one pool slot never holds two lives at once', () => {
    check(
      'pool',
      fc.property(pieceArb(), (p) => {
        const s = compile(p);
        expect(s.voices.length).toBe(p.voices.length);
        s.voices.forEach((v, i) => {
          expect(v.index).toBe(i);
          expect(v.id).toBe(p.voices[i].id);
          for (let k = 1; k < v.lives.length; k++) {
            expect(v.lives[k].born).toBeGreaterThanOrEqual(v.lives[k - 1].died!);
          }
        });
        // At any segment boundary, no more voices sound than the pool holds.
        const times = s.voices.flatMap((v) => v.lives.map((l) => l.born + 1e-6));
        for (const t of times) {
          const n = s.voices.filter((v) => pitchAt(v, t) !== null).length;
          expect(n).toBeLessThanOrEqual(p.voices.length);
        }
      }),
      RUNS,
    );
  });

  it('overlap semantics: walk steps never overwrite a point moment (§7.1)', () => {
    let resumed = 0;
    check(
      'overlap',
      fc.property(pieceArb({ maxT: 25 }), (p) => {
        const { score, trace } = compileWithTrace(p);
        const walks = new Set(p.moments.filter((m) => m.type === 'walk').map((m) => m.id));
        const isWalk = (g: Segment): boolean => g.momentId !== undefined && walks.has(g.momentId);
        for (const v of score.voices) {
          for (let i = 0; i + 1 < v.segments.length; i++) {
            const g = v.segments[i];
            const next = v.segments[i + 1];
            // Walks step only idle voices: a running move is never cut by a walk step.
            if (next.t0 === g.t1 && next.t0 < plannedEnd(g).t1 && !isWalk(g)) {
              if (isFollow(trace, score, v.index, next)) continue;
              expect(isWalk(next), `${v.id}: walk step cuts ${g.momentId} at ${next.t0}`).toBe(
                false,
              );
            }
          }
          // Count walk steps that follow a point moment's move (holds in between).
          let lastMover: Segment | null = null;
          for (const g of v.segments) {
            if (g.momentId === undefined) continue;
            if (isWalk(g) && lastMover && !isWalk(lastMover)) resumed++;
            lastMover = g;
          }
        }
        // A voice with a pending (staggered) move from a point moment does not walk before it.
        trace.moments.forEach((m, mi) => {
          if (!m.plan) return;
          // A note's return is a later run of the same moment: its moves are not this run's.
          const ret = trace.moments.slice(mi + 1).find((o) => o.id === m.id);
          const until = ret ? ret.t : Infinity;
          for (const vi of m.plan.movers) {
            const v = score.voices[vi];
            const own = v.segments.find((g) => g.momentId === m.id && g.t0 >= m.t && g.t0 < until);
            if (!own) continue; // cancelled by a later moment
            for (const g of v.segments) {
              if (isWalk(g) && g.t0 >= m.t && g.t0 < own.t0) {
                throw new Error(`${v.id} walks at ${g.t0} with ${m.id}'s move pending`);
              }
            }
          }
        });
      }),
      RUNS,
    );
    expect(resumed).toBeGreaterThan(20); // walks really resume after point moments
  });

  it('seed isolation: moving moment A leaves moment B’s draws and moves unchanged (§7.7)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        fc.constantFrom('random' as const, 'low-first' as const, 'center-out' as const),
        (seed, a1, a2, order) => {
          // B moves v1..v3 by an explicit selector; A (a split and a merge on the other voices,
          // with an empty target so it never touches v1..v3) changes the voice count elsewhere.
          const make = (aAt: number): Piece => {
            const p: Piece = JSON.parse(JSON.stringify(basePiece)) as Piece;
            p.seed = seed;
            p.defaults.glide.order = order;
            p.moments = [
              ...p.moments,
              {
                id: 'Aaaaaa',
                type: 'split',
                at: aAt / 4,
                count: 8,
                target: { voices: ['v4'] },
                voicing: 'even',
                notes: { kind: 'pitches', pitches: [80, 82, 84, 86, 88] },
              },
              {
                id: 'Mmmmmm',
                type: 'merge',
                at: aAt / 4 + 6,
                count: 4,
                which: 'top',
                fade: 1,
                target: { rank: [4, 9] },
              },
              {
                id: 'Bbbbbb',
                type: 'chord',
                at: 12,
                target: { voices: ['v1', 'v2', 'v3'] },
                notes: { kind: 'chord', symbol: 'Dm9' },
                voicing: 'even',
                assign: 'ordered',
                register: [50, 70],
              },
            ];
            return p;
          };
          const sa = compile(make(a1));
          const sb = compile(make(a2));
          for (const id of ['v1', 'v2', 'v3']) {
            const pick = (s: CompiledScore): unknown[] =>
              s.voices
                .find((v) => v.id === id)!
                .segments.filter((g) => g.momentId === 'Bbbbbb')
                .map((g) => ({ t0: g.t0, p0: g.p0, end: plannedEnd(g), m0: g.m0, ease: g.ease }));
            expect(pick(sb)).toEqual(pick(sa));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('note moments: one note changes, in order unless `order` is off; returns run (§6.2 note)', () => {
    let applied = 0;
    let returns = 0;
    check(
      'note',
      fc.property(pieceArb(), (p) => {
        const { score, trace } = compileWithTrace(p);
        const seen = new Set<string>();
        for (const m of trace.moments) {
          if (m.type !== 'note' || !m.plan || !m.intents) continue;
          if (seen.has(m.id)) returns++;
          else applied++;
          seen.add(m.id);
          // Revision 8: with stacked lines the note acts on logical voices (one per voice a line
          // stands for), so the line-level intents may differ in number.
          const its = m.logical ?? m.intents;
          if (its === m.intents) expect(m.intents.length).toBe(m.targeted.length);
          const nm = p.moments.find((x) => x.id === m.id);
          // Overrides are hand edits: they may add moves and make the plan unordered.
          if (nm?.overrides?.length) continue;
          const ordered = nm?.type === 'note' && nm.order === true;
          expect(m.plan.ordered).toBe(ordered);
          // Without `order`, only the voice sounding `from` moves; the rest may be out of order.
          if (!ordered) continue;
          // Intents list the voices low to high by destination; unless range folding moved a
          // target, their targets are in the same order (ordered voice leading, §7.2).
          // A stacked line's copy is folded per logical voice (`folded`); when that copy never
          // becomes a pool voice (pool exhausted), no pool target folds and no diagnostic says so.
          const folded =
            its!.some((it) => it.folded) ||
            score.diagnostics.some(
              (d) =>
                d.momentId === m.id && (d.code === 'range-fold' || d.code === 'range-too-narrow'),
            );
          if (folded) continue;
          for (let k = 1; k < its!.length; k++) {
            expect(its![k].to).toBeGreaterThanOrEqual(its![k - 1].to);
          }
        }
      }),
      RUNS,
    );
    expect(applied).toBeGreaterThan(20);
    expect(returns).toBeGreaterThan(5);
  });

  it('pulse records: sorted, gains in 0..1, hits only sounding voices, one per arpeggio step', () => {
    let pulsed = 0;
    check(
      'pulse',
      fc.property(pieceArb(), (p) => {
        const s = compile(p);
        const hitsAt = new Map<string, number>();
        for (const v of s.voices) {
          const r = v.pulse ?? [];
          if (r.length > 0) pulsed++;
          for (let i = 0; i < r.length; i++) {
            if (i > 0) expect(r[i].t).toBeGreaterThanOrEqual(r[i - 1].t);
            expect(r[i].accent).toBeGreaterThanOrEqual(0);
            expect(r[i].accent).toBeLessThanOrEqual(1);
            expect(r[i].floor).toBeGreaterThanOrEqual(0);
            expect(r[i].floor).toBeLessThanOrEqual(1);
            const g = pulseGainAt(v, r[i].t + r[i].decay / 2);
            expect(g).toBeGreaterThanOrEqual(0);
            expect(g).toBeLessThanOrEqual(1);
            if (!r[i].hit) continue;
            expect(r[i].accent).toBeGreaterThan(0);
            expect(lifeAt(v, r[i].t), `hit on silent ${v.id} at ${r[i].t}`).not.toBeNull();
            hitsAt.set(String(r[i].t), (hitsAt.get(String(r[i].t)) ?? 0) + 1);
          }
        }
        // With only arpeggio pulses (and no two overlapping), each step hits one voice.
        const pulses = p.moments.filter((m) => m.type === 'pulse' && !m.muted);
        if (pulses.length === 1 && pulses[0].type === 'pulse' && pulses[0].mode !== 'together') {
          for (const n of hitsAt.values()) expect(n).toBe(1);
        }
      }),
      RUNS,
    );
    expect(pulsed).toBeGreaterThan(5);
  });

  it('every diagnostic has a stable kebab-case code and no generated piece errors out', () => {
    check(
      'diagnostics',
      fc.property(pieceArb(), (p) => {
        const s = compile(p);
        for (const d of s.diagnostics) {
          expect(d.code).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
          expect(['info', 'warn', 'error']).toContain(d.level);
        }
      }),
      RUNS,
    );
  });
});

const basePiece: Piece = (() => {
  const p = JSON.parse(
    JSON.stringify({
      format: 'algorhythms',
      version: 1,
      meta: { title: 't', created: '', modified: '' },
      seed: 1,
      tuning: { referenceHz: 440, system: { kind: '12tet' } },
      key: { tonic: 'D', scale: 'dorian' },
      defaults: {
        glide: { length: 3, jitter: 0.3, stagger: 1.2, order: 'random', ease: 'smootherstep' },
      },
      voices: Array.from({ length: 12 }, (_, i) => ({
        id: `v${i + 1}`,
        timbre: 'glass',
        pan: 'auto',
        gain: 1,
        range: [36, 96],
      })),
      start: [
        { voice: 'v1', pitch: 50 },
        { voice: 'v2', pitch: 57 },
        { voice: 'v3', pitch: 62 },
        { voice: 'v4', pitch: 80 },
      ],
      moments: [],
      timbres: {},
      mix: {},
      end: { fade: 4 },
      view: { window: 20, colors: 'ink', hud: true },
    }),
  ) as Piece;
  // A version 1 piece: its `start` becomes the opening chord (schema v2).
  const r = parsePiece(p);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
})();
