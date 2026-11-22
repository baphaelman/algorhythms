/**
 * Chord `count` keeps lines whole (M4.5-17; PLAN.md §6.2 chord row, §7.2, §7.4, §15 M4.5):
 * (a) under ordered voice leading no two sounding lines pass through each other;
 * (b) every voice that falls dormant ends its last glide on a surviving voice's pitch and stays
 *     on it while it fades (it follows that voice);
 * (c) every newborn starts on a sounding voice's pitch.
 *
 * Two generators: spaced pieces (each moment's glides end before the next point moment, walks
 * may hold chords), checked line by line over the whole score; and the dense general pieces of
 * compiler-arbitraries.ts with chord counts, checked for (b), (c) and, per moment, (a) for
 * newborns (which the general crossing property exempts at their first sample).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { compileWithTrace } from '../../../src/core/compiler/compile';
import { CHECK_SAMPLES } from '../../../src/core/interrupt';
import { newPiece } from '../../../src/core/defaults';
import { lifeAt, pitchAt } from '../../../src/core/query';
import type { CompiledScore, EaseRef, Moment, NoteSet, Piece } from '../../../src/core/types';
import { lineArtifacts } from '../../unit/core/line-artifacts';
import { pieceArb } from './compiler-arbitraries';
import { withStart } from '../../unit/core/compiler-fixtures';

// Slowest test 0.8 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

const RUNS = Number(process.env.PROP_RUNS ?? 200);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);

/** fc.assert; with DUMP_DIR set, a failing piece goes to $DUMP_DIR/<name>.json. */
function check(name: string, prop: fc.IProperty<[Piece]>): void {
  fc.assert(prop, {
    numRuns: RUNS,
    seed: SEED,
    path: process.env.PROP_PATH, // replay a reported failure (with PROP_SEED)
    endOnFailure: true,
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

const tenths = (lo: number, hi: number): fc.Arbitrary<number> =>
  fc.integer({ min: Math.round(lo * 10), max: Math.round(hi * 10) }).map((x) => x / 10);

const notesArb: fc.Arbitrary<NoteSet> = fc.oneof(
  fc.record({
    kind: fc.constant('chord' as const),
    symbol: fc.constantFrom('Am7', 'C', 'Dm9', 'G7', 'F#m7b5', 'C/E', 'V9', 'Esus4'),
  }),
  fc.record({
    kind: fc.constant('degrees' as const),
    degrees: fc.array(fc.integer({ min: 0, max: 11 }), { minLength: 1, maxLength: 5 }),
  }),
  fc.record({
    kind: fc.constant('pitches' as const),
    pitches: fc.array(fc.integer({ min: 36, max: 90 }), { minLength: 1, maxLength: 8 }),
  }),
  fc.constant({ kind: 'current' as const }),
);

type Draft = { gap: number } & Record<string, unknown>;

/** Moments of a spaced piece; `gap` is the time to the next one, set from the glide below. */
function draftArb(pool: number): fc.Arbitrary<Draft> {
  const chord = fc.record({
    type: fc.constant('chord'),
    notes: notesArb,
    voicing: fc.constantFrom('even', 'close', 'nearest'),
    assign: fc.constant('ordered'),
    count: fc.integer({ min: 1, max: pool }),
    gap: fc.constant(0),
  });
  return fc.oneof(
    { weight: 8, arbitrary: chord },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constant('split'),
        count: fc.integer({ min: 2, max: pool }),
        voicing: fc.constant('even'),
        gap: fc.constant(0),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constant('merge'),
        count: fc.integer({ min: 1, max: pool }),
        which: fc.constantFrom('top', 'bottom', 'inner', 'outer', 'random'),
        fade: tenths(0, 3),
        gap: fc.constant(0),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('unison'),
        pitch: fc.constantFrom('center', 'tonic'),
        octaves: fc.boolean(),
        gap: fc.constant(0),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('shift'),
        by: fc.integer({ min: -5, max: 5 }),
        unit: fc.constantFrom('semitones', 'scaleSteps'),
        gap: fc.constant(0),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('note'),
        from: fc.integer({ min: 48, max: 72 }),
        to: fc.integer({ min: 40, max: 80 }),
        order: fc.constant(true), // "Keep lines in order" (off, a note may cross by design)
        gap: fc.constant(0),
      }),
    },
    {
      // A walk region with the next moments inside it.
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('walk'),
        len: tenths(2, 12),
        grid: tenths(0.3, 1.2),
        density: tenths(0.2, 0.8),
        steps: fc.constantFrom([-2, -1, 1, 2], [-1, 1]),
        stepGlide: tenths(0.1, 0.5),
        gap: tenths(0.5, 3),
      }),
    },
  );
}

const spacedArb: fc.Arbitrary<Piece> = fc
  .record({
    seed: fc.integer({ min: 0, max: 0xffff }),
    pool: fc.integer({ min: 3, max: 12 }),
    length: tenths(0.5, 4),
    jitter: tenths(0, 0.5),
    stagger: tenths(0, 2),
    ease: fc.constantFrom<EaseRef>('smootherstep', 'smoothstep', 'cosine', 'linear', 'expo'),
    arrive: fc.constantFrom('together' as const, 'spread' as const),
    starts: fc.array(fc.integer({ min: 45, max: 75 }), { minLength: 1, maxLength: 4 }),
  })
  .chain((r) =>
    fc.array(draftArb(r.pool), { minLength: 2, maxLength: 9 }).map((drafts) => {
      const p = newPiece({ seed: r.seed, poolSize: r.pool });
      p.defaults.glide = {
        ...p.defaults.glide,
        length: r.length,
        jitter: r.jitter,
        stagger: r.stagger,
        ease: r.ease,
        arrive: r.arrive,
      };
      p.voices.forEach((v) => (v.range = [24, 108]));
      const starts = r.starts.slice(0, r.pool);
      // Glides end by at + stagger + length·(1 + jitter); leave a little more.
      const span = r.stagger + r.length * (1 + r.jitter) + 0.3;
      let at = 1;
      p.moments = drafts.map((d, i) => {
        const { gap, len, ...rest } = d;
        const m = { ...rest, id: `m${i}`, at } as Record<string, unknown>;
        if (d.type === 'walk') m.until = at + (len as number);
        at = Math.round((at + (d.type === 'walk' ? gap : span)) * 1000) / 1000;
        return m as unknown as Moment;
      });
      p.moments = withStart(p, starts);
      return p;
    }),
  );

/** The moment's ease is a bézier leaving [0, 1]: it overshoots, and may cross, by design. */
function overshoots(p: Piece, momentId: string): boolean {
  const e = p.moments.find((x) => x.id === momentId)?.glide?.ease ?? p.defaults.glide.ease;
  return typeof e === 'object' && (e.y1 < 0 || e.y1 > 1 || e.y2 < 0 || e.y2 > 1);
}

/** Deaths and births of every moment, from the trace: [moment time, survivor or parent]. */
function lifeEvents(p: Piece) {
  const { score, trace } = compileWithTrace(p);
  const into = new Map<number, [number, number][]>();
  const parent = new Map<number, [number, number][]>();
  const add = (m: Map<number, [number, number][]>, v: number, e: [number, number]) =>
    m.has(v) ? m.get(v)!.push(e) : m.set(v, [e]);
  for (const m of trace.moments) {
    for (const it of m.intents ?? []) {
      if (it.kind === 'death') add(into, it.voice, [m.t, it.into ?? -1]);
      if (it.kind === 'birth') add(parent, it.voice, [m.t, it.parent ?? -1]);
    }
  }
  return { score, trace, into, parent };
}

/** The last event of voice v at or before t: [moment time, survivor or parent (−1: none)]. */
function lastAt(m: Map<number, [number, number][]>, v: number, t: number): [number, number] {
  let r: [number, number] = [-Infinity, -1];
  for (const e of m.get(v) ?? []) if (e[0] <= t + 1e-9) r = e;
  return r;
}

const count = (m: Map<number, [number, number][]>): number =>
  [...m.values()].flat().filter(([, x]) => x >= 0).length;

/** (b) and (c), for voices that die into a survivor and newborns with a parent. */
function checkLives(
  score: CompiledScore,
  into: Map<number, [number, number][]>,
  parent: Map<number, [number, number][]>,
) {
  for (const a of lineArtifacts(score, { noCross: true })) {
    const v = score.voices.find((x) => x.id === a.voice)!;
    if (a.kind === 'death') {
      const [t, s] = lastAt(into, v.index, a.t);
      if (s < 0) continue; // nothing to merge into
      // The survivor itself fell silent first (it died into nothing).
      const died = lifeAt(v, a.t)?.died ?? Infinity;
      const own = lifeAt(score.voices[s], t);
      if (!own || (own.died ?? Infinity) < died) continue;
    }
    if (a.kind === 'birth' && lastAt(parent, v.index, a.t)[1] < 0) continue; // nothing sounding
    expect(a, `${a.kind} ${a.voice} at ${a.t}: ${a.detail}`).toBeUndefined();
  }
}

describe('chord count regressions', () => {
  // Seed −320129613 (path 300): v2 dies into v3 and rides it through a walk step; the unison at
  // 11.34 moves v3 with a tightened crossing scale, and v2 followed with scale 1 (other m₀).
  it('a follower on its survivor takes the survivor’s crossing scale', () => {
    const p = JSON.parse(
      readFileSync(
        new URL('./regressions/count-follow-seed-320129613.json', import.meta.url),
        'utf8',
      ),
    ) as Piece;
    const { score, into, parent } = lifeEvents(p);
    checkLives(score, into, parent);
    const [v2, v3] = [score.voices[1], score.voices[2]];
    // With merges crossfading (2026-11-21) v2 ends where it meets v3, before the unison: while it
    // still sounds it is on v3.
    for (let t = 11.483; t < 12.2; t += 0.01) {
      const p2 = pitchAt(v2, t);
      if (p2 !== null) expect(p2).toBe(pitchAt(v3, t));
    }
  });

  // Seed 412527772 (path 111): the chord at 1 forks v3 and v4 from v1 at 1.91 while v2, between
  // v1 and them, is unborn (2.48). The planner checked adjacent pairs only, so no pair saw v3/v4
  // fall under v1 (still gliding up on its steep expo) and cross back at 2.38.
  it('newborns stay above their parent while a sibling between them is unborn', () => {
    const p = JSON.parse(
      readFileSync(
        new URL('./regressions/count-unborn-sibling-seed412527772.json', import.meta.url),
        'utf8',
      ),
    ) as Piece;
    const { score, into, parent } = lifeEvents(p);
    checkLives(score, into, parent);
    expect(lineArtifacts(score).filter((a) => a.kind === 'cross')).toEqual([]);
    const [v1, v2, v3, v4] = score.voices;
    expect(lifeAt(v2, 2.3)).toBeNull();
    for (let t = 1; t < 3.2; t += 0.01) {
      const below = pitchAt(v1, t)!;
      for (const v of [v3, v4]) {
        const q = pitchAt(v, t);
        if (q !== null) expect(q, `${v.id} at ${t}`).toBeGreaterThanOrEqual(below - 1e-9);
      }
    }
  });
});

describe('chord count keeps lines whole (M4.5-17)', () => {
  it('spaced pieces: no crossings, no lines starting or stopping in mid-air', () => {
    let deaths = 0;
    let births = 0;
    check(
      'count-spaced',
      fc.property(spacedArb, (p) => {
        const { score, into, parent } = lifeEvents(p);
        deaths += count(into);
        births += count(parent);
        checkLives(score, into, parent);
        // (a) The planner may still report a crossing it cannot remove (carried velocity), and
        // folding a target by an octave (§7.8; or off a part-mate, `fold-apart`) may reorder lines.
        const exempt = ['crossing-unresolved', 'range-fold', 'range-too-narrow', 'fold-apart'];
        if (score.diagnostics.some((d) => exempt.includes(d.code))) return;
        // Under `arrive: 'spread'` a fast voice can pass a slow one just before both arrive,
        // between the planner's 64 check samples (§7.2; not specific to counts).
        if (p.defaults.glide.arrive === 'spread') return;
        // A walk step judges its neighbours by committed destination, so it may pass one still
        // gliding in, or about to start, from a point moment (§7.1): walk regions, and the
        // glides of moments inside them, are exempt here.
        const g = p.defaults.glide;
        const span = g.stagger + g.length * (1 + g.jitter) + 0.3;
        const walks = p.moments.flatMap((m) =>
          m.type === 'walk' ? [[m.at, m.until + m.stepGlide + span]] : [],
        );
        const inWalk = (t: number) => walks.some(([a, b]) => t >= a && t <= b);
        for (const a of lineArtifacts(score).filter((x) => x.kind === 'cross' && !inWalk(x.t))) {
          expect(a, `${a.voice}/${a.other} cross at ${a.t}: ${a.detail}`).toBeUndefined();
        }
      }),
    );
    expect(deaths).toBeGreaterThan(200);
    expect(births).toBeGreaterThan(200);
  });

  it('dense general pieces: deaths end on a survivor, births on a sounding voice', () => {
    check(
      'count-lives',
      fc.property(pieceArb(), (p) => {
        const { score, into, parent } = lifeEvents(p);
        checkLives(score, into, parent);
      }),
    );
  });

  it('dense general pieces: a newborn never starts on the far side of its order neighbour', () => {
    let checked = 0;
    check(
      'count-newborns',
      fc.property(pieceArb(), (p) => {
        const { score, trace } = compileWithTrace(p);
        const unresolved = new Set(
          score.diagnostics.filter((d) => d.code === 'crossing-unresolved').map((d) => d.momentId),
        );
        trace.moments.forEach((m, mi) => {
          const plan = m.plan;
          if (!plan || !plan.ordered || unresolved.has(m.id) || overshoots(p, m.id)) return;
          const born = new Set(
            (m.intents ?? []).filter((x) => x.kind === 'birth').map((x) => x.voice),
          );
          if (born.size === 0) return;
          // Newborns of an earlier moment not born yet cannot be parents (§7.4): a newborn
          // may then fork past them. Not checked.
          const waiting = trace.moments
            .slice(0, mi)
            .some((o) =>
              (o.intents ?? []).some(
                (x) => x.kind === 'birth' && lifeAt(score.voices[x.voice], m.t) === null,
              ),
            );
          if (waiting) return;
          const [ws, we] = plan.window;
          // Until a later moment, or a walk step, touches either voice.
          let until = we;
          for (const o of trace.moments.slice(mi + 1)) if (o.t < until) until = o.t;
          for (let k = 0; k + 1 < plan.order.length; k++) {
            const lo = score.voices[plan.order[k]];
            const hi = score.voices[plan.order[k + 1]];
            if (!born.has(lo.index) && !born.has(hi.index)) continue;
            let end = until;
            for (const v of [lo, hi]) {
              for (const g of v.segments) {
                if (g.t0 >= ws && g.t0 < end && g.momentId !== undefined && g.momentId !== m.id) {
                  end = g.t0;
                }
              }
            }
            checked++;
            // Lines that pass through each other (0.1 st: below the 64-sample check). Two lines
            // from one fork to one pitch may bow apart either way; that is not a crossing.
            let below = false;
            let above = false;
            for (let j = 0; j < CHECK_SAMPLES; j++) {
              const t = ws + ((we - ws) * j) / (CHECK_SAMPLES - 1);
              if (t > end) break;
              const a = pitchAt(lo, t);
              const b = pitchAt(hi, t);
              if (a === null || b === null) continue;
              if (a < b - 0.1) below = true;
              if (a > b + 0.1) above = true;
              expect(below && above, `${m.id}: ${lo.id}/${hi.id} cross at ${t}`).toBe(false);
            }
          }
        });
      }),
    );
    expect(checked).toBeGreaterThan(100);
  });
});
