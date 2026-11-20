/**
 * `glide.arrive` (PLAN.md §5, §7.2 "Arrive together", revision 6).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { sharedEnd } from '../../../src/core/compiler/glide';
import { pitchAt } from '../../../src/core/query';
import { momentSeed } from '../../../src/core/rng';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { CompiledScore, GlideOrder, Moment, Piece } from '../../../src/core/types';
import { canonicalJson, hashString } from '../../golden/canonical';
import { piece } from './compiler-fixtures';

const EXAMPLES = join(import.meta.dirname, '../../../examples');

/** Golden hashes before revision 6 (every move ended at its own start + jittered length). */
const PRE_REV6: Record<string, string> = {
  'clockwork-heron.algorhythms.json': '3c2665b69df22274',
  'lanterns-over-salt-flats.algorhythms.json': 'c4db88c56394475b',
  'seven-doors-in-fog.algorhythms.json': '8bfcabb32d5a6ba2',
  'the-cartographers-rain.algorhythms.json': 'fa23faa06bd13149',
  'tidewater-hymn.algorhythms.json': 'fe278f2c72eff05f',
};

function loadExample(file: string): Piece {
  const parsed = parsePiece(JSON.parse(readFileSync(join(EXAMPLES, file), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.piece;
}

/** The piece with `arrive: 'spread'` on the defaults and on every moment glide. */
function forceSpread(p: Piece): Piece {
  const q = structuredClone(p);
  q.defaults.glide.arrive = 'spread';
  for (const m of q.moments) if (m.glide) m.glide.arrive = 'spread';
  return q;
}

/** Ends of the segments a moment wrote (excluding later interruptions). */
function moveEnds(s: CompiledScore, id: string): number[] {
  const out: number[] = [];
  for (const v of s.voices)
    for (const g of v.segments) if (g.momentId === id && g.p0 !== g.p1) out.push(g.t1);
  return out;
}
function moveStarts(s: CompiledScore, id: string): number[] {
  const out: number[] = [];
  for (const v of s.voices)
    for (const g of v.segments) if (g.momentId === id && g.p0 !== g.p1) out.push(g.t0);
  return out;
}
const spreadOf = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);

const ORDERS: GlideOrder[] = ['random', 'low-first', 'high-first', 'center-out', 'outside-in'];
const GLIDE = { length: 3, jitter: 0.4, stagger: 1.5, ease: 'smootherstep' as const };

describe('arrive: spread reproduces the pre-revision-6 output', () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.algorhythms.json'));
  it.each(files)('%s', (file) => {
    const s = compile(forceSpread(loadExample(file)));
    // Revision 6 also adds `no-effect` diagnostics; everything else must be unchanged.
    s.diagnostics = s.diagnostics.filter((d) => d.code !== 'no-effect');
    expect(hashString(canonicalJson(s))).toBe(PRE_REV6[file]);
  });
});

describe('arrive: together', () => {
  it.each(ORDERS)('order %s: every voice of a moment lands within 1 ms', (order) => {
    for (const seed of [1, 2, 3, 2611]) {
      const p = piece({
        seed,
        start: [48, 55, 60, 64, 67, 72],
        glide: { ...GLIDE, order },
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'pitches', pitches: [50, 57, 62, 65, 69, 74] },
            voicing: 'even',
            assign: 'ordered',
          },
          { type: 'shift', at: 9, by: -5, unit: 'semitones' },
          { type: 'split', at: 17, count: 9, voicing: 'even' },
          { type: 'merge', at: 25, count: 3, which: 'outer', fade: 1 },
        ],
      });
      const s = compile(p);
      expect(s.diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
      for (const m of p.moments) {
        const ends = moveEnds(s, m.id);
        expect(ends.length, m.id).toBeGreaterThan(1);
        expect(spreadOf(ends), `${order} ${m.id}`).toBeLessThan(1e-3);
        // Stagger still spreads the starts.
        expect(spreadOf(moveStarts(s, m.id)), `${order} ${m.id}`).toBeGreaterThan(0.1);
        // The shared end is at + stagger + the jittered length.
        const seedM = momentSeed(p.seed, m.id, m.seed);
        const glide = { ...p.defaults.glide };
        expect(ends[0]).toBeCloseTo(sharedEnd(m.at, glide, seedM), 9);
      }
    }
  });

  it('is the default, also for files without the field', () => {
    const p = piece({ start: [55, 60, 64], glide: GLIDE });
    delete p.defaults.glide.arrive;
    p.moments = [{ id: 'c', type: 'shift', at: 1, by: 3, unit: 'semitones' }];
    const parsed = parsePiece(JSON.parse(JSON.stringify(p)));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.piece.defaults.glide.arrive).toBe('together');
    for (const q of [p, parsed.piece])
      expect(spreadOf(moveEnds(compile(q), 'c'))).toBeLessThan(1e-9);
  });

  it("a moment's own glide can choose spread", () => {
    const p = piece({ start: [55, 60, 64, 67], glide: GLIDE });
    p.moments = [
      { id: 'c', type: 'shift', at: 1, by: 3, unit: 'semitones', glide: { arrive: 'spread' } },
    ];
    expect(spreadOf(moveEnds(compile(p), 'c'))).toBeGreaterThan(0.1);
  });

  it('keeps the crossing guarantee, and its fix-up keeps the common end', () => {
    // Wide parallel leaps: an early low starter overtakes a late high one unless re-timed.
    let fixed = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const p = piece({
        seed,
        start: [48, 50, 52, 54, 56, 58],
        glide: { length: 2, jitter: 0.3, stagger: 2, order: 'low-first', ease: 'linear' },
        moments: [{ id: 'up', type: 'shift', at: 1, by: 12, unit: 'semitones' }],
      });
      const { score, trace } = compileWithTrace(p);
      expect(score.diagnostics.map((d) => d.code)).not.toContain('crossing-unresolved');
      const ends = moveEnds(score, 'up');
      expect(spreadOf(ends)).toBeLessThan(1e-9);
      const starts = moveStarts(score, 'up');
      if (new Set(starts).size < starts.length) fixed++;
      expect(trace.moments[0].plan?.order.length).toBe(6);
      // Sampled: lines stay in order throughout.
      for (let t = 1; t <= ends[0]; t += 0.01) {
        const ps = score.voices.slice(0, 6).map((v) => pitchAt(v, t)!);
        for (let k = 0; k + 1 < ps.length; k++) expect(ps[k]).toBeLessThanOrEqual(ps[k + 1] + 1e-9);
      }
    }
    expect(fixed).toBeGreaterThan(0); // the fix-up ran (shared start) in some cases
  });

  it('interruption still cuts individual voices', () => {
    const p = piece({
      start: [55, 60, 64],
      glide: { length: 4, jitter: 0.2, stagger: 1, ease: 'smootherstep' },
      moments: [
        { id: 'a', type: 'shift', at: 1, by: 5, unit: 'semitones' },
        { id: 'b', type: 'pin', at: 3, voice: 'v2', pitch: 61 },
      ],
    });
    const s = compile(p);
    const a = s.voices.map((v) => v.segments.filter((g) => g.momentId === 'a'));
    // v2's glide from `a` is cut at 3 by the pin; v1 and v3 still land together.
    expect(a[1][0].t1).toBe(3);
    expect(a[0][0].t1).toBeCloseTo(a[2][0].t1, 12);
    expect(a[0][0].t1).toBeGreaterThan(3);
    const pin = s.voices[1].segments.find((g) => g.momentId === 'b')!;
    expect(pin.t0).toBe(3);
    expect(pin.p1).toBe(61);
  });

  it('incremental compile equals full compile', () => {
    const p = piece({
      start: [48, 55, 60, 64],
      glide: GLIDE,
      moments: [
        {
          type: 'chord',
          at: 1,
          notes: { kind: 'chord', symbol: 'Dm7' },
          voicing: 'even',
          assign: 'ordered',
        },
        { type: 'split', at: 5, count: 7, voicing: 'even' },
        { type: 'shift', at: 9, by: 2, unit: 'scaleSteps' },
        { type: 'merge', at: 14, count: 3, which: 'top', fade: 1 },
      ],
    });
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    (q.moments[2] as Extract<Moment, { type: 'shift' }>).by = -3;
    q.moments[3].glide = { arrive: 'spread' };
    expect(inc.compile(q)).toEqual(compile(q));
    expect(inc.stats.mode).toBe('resume');
  });

  it('round-trips through the schema', () => {
    const p = piece({ glide: { arrive: 'spread' } });
    p.moments = [
      { id: 'x', type: 'shift', at: 1, by: 1, unit: 'semitones', glide: { arrive: 'together' } },
    ];
    const parsed = parsePiece(JSON.parse(serializePiece(p)));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.piece.defaults.glide.arrive).toBe('spread');
    expect(parsed.piece.moments[0].glide?.arrive).toBe('together');
    const bad = parsePiece({
      ...JSON.parse(serializePiece(p)),
      defaults: { glide: { arrive: 'soon' } },
    });
    // An unknown value is not accepted silently.
    expect(bad.ok && bad.warnings.length === 0).toBe(false);
  });
});
