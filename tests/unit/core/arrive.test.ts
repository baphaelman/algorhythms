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

/**
 * Golden hashes before revision 6 (every move ended at its own start + jittered length). Three
 * changed with M4.5-17: newborns that forked out of order with a sibling or parent (a small
 * crossing) now take its timing. All five changed with M4.5-29 (revision 8 "Distinct notes":
 * stacked voices merge into weighted lines), and again with M4.5-29a (counts count lines, merges
 * pass weight, chords take free octaves before merging), and with M4.5-27 by what is not heard
 * (the opening chord's span, its harmony entry and the opening holds' moment id), and with R9-2
 * (revision 9: births and deaths take ranked stagger offsets). Seeds-4: a seven-doors newborn forks 35 ms earlier (out of order with a line across unborn siblings).
 */
const PRE_REV6: Record<string, string> = {
  'clockwork-heron.algorhythms.json': '9d98073e330c1969',
  // M4.5-30: LnSpr1 hits both range edges; it no longer folds.
  'lanterns-over-salt-flats.algorhythms.json': 'a7dadff1eeb2170a',
  'seven-doors-in-fog.algorhythms.json': 'a165bee54335f1e0',
  'the-cartographers-rain.algorhythms.json': '2d3e402461f31d48',
  'tidewater-hymn.algorhythms.json': '04b09bca4988d167',
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
      for (const m of p.moments.slice(1)) {
        // (moments[0] is the opening chord: no moves)
        const ends = moveEnds(s, m.id);
        expect(ends.length, m.id).toBeGreaterThan(1);
        expect(spreadOf(ends), `${order} ${m.id}`).toBeLessThan(1e-3);
        // Stagger still spreads the starts.
        expect(spreadOf(moveStarts(s, m.id)), `${order} ${m.id}`).toBeGreaterThan(0.1);
        // The shared end is the latest drawn start + the jittered length. Crossing fix-ups only
        // move starts earlier, so it lies at or after the latest actual start + that length, and
        // never after at + stagger + that length.
        const seedM = momentSeed(p.seed, m.id, m.seed);
        const glide = { ...p.defaults.glide };
        const last = Math.max(...moveStarts(s, m.id));
        expect(ends[0]).toBeGreaterThanOrEqual(sharedEnd(last, glide, seedM) - 1e-9);
        expect(ends[0]).toBeLessThanOrEqual(sharedEnd(m.at + glide.stagger, glide, seedM) + 1e-9);
      }
    }
  });

  it('a single voice ends at at + the jittered length (pin, one-voice shift)', () => {
    const p = piece({
      start: [55, 60, 64],
      glide: { length: 3, jitter: 0.4, stagger: 2, ease: 'smootherstep' },
      moments: [
        { id: 'pin', type: 'pin', at: 1, voice: 'v2', pitch: 62 },
        { id: 'one', type: 'shift', at: 8, by: 2, unit: 'semitones', target: { voices: ['v3'] } },
      ],
    });
    const s = compile(p);
    for (const m of p.moments.slice(1)) {
      const seedM = momentSeed(p.seed, m.id, m.seed);
      expect(moveStarts(s, m.id)).toEqual([m.at]);
      expect(moveEnds(s, m.id)[0]).toBeCloseTo(sharedEnd(m.at, p.defaults.glide, seedM), 12);
      expect(moveEnds(s, m.id)[0]).toBeLessThanOrEqual(m.at + 3 * 1.4);
    }
  });

  it('the shared end follows the latest start, not at + stagger', () => {
    // Two voices far apart (no crossing fix-up): the later start + the moment's length.
    for (let seed = 1; seed <= 20; seed++) {
      const p = piece({
        seed,
        start: [48, 72],
        glide: { length: 2, jitter: 0.2, stagger: 3, ease: 'smootherstep' },
        moments: [{ id: 'c', type: 'shift', at: 1, by: 1, unit: 'semitones' }],
      });
      const s = compile(p);
      const starts = moveStarts(s, 'c');
      const ends = moveEnds(s, 'c');
      const end = sharedEnd(Math.max(...starts), p.defaults.glide, momentSeed(p.seed, 'c'));
      expect(ends[0]).toBeCloseTo(end, 12);
      expect(ends[1]).toBeCloseTo(end, 12);
      expect(Math.max(...starts)).toBeLessThan(1 + 3);
    }
  });

  it('is the default, also for files without the field', () => {
    const p = piece({ start: [55, 60, 64], glide: GLIDE });
    delete p.defaults.glide.arrive;
    p.moments = [...p.moments, { id: 'c', type: 'shift', at: 1, by: 3, unit: 'semitones' }];
    const parsed = parsePiece(JSON.parse(JSON.stringify(p)));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.piece.defaults.glide.arrive).toBe('together');
    for (const q of [p, parsed.piece])
      expect(spreadOf(moveEnds(compile(q), 'c'))).toBeLessThan(1e-9);
  });

  it("a moment's own glide can choose spread", () => {
    const p = piece({ start: [55, 60, 64, 67], glide: GLIDE });
    p.moments = [
      ...p.moments, // the opening
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
      expect(trace.moments[1].plan?.order.length).toBe(6);
      // Lines stay in order at the planner's 64 check points (§7.2: the sampled check is the
      // authority), and within 0.05 semitone between them (linear glides can touch over a few
      // ms between samples; this was so before M4.5-10 too).
      for (let j = 0; j < 64; j++) {
        const t = 1 + ((ends[0] - 1) * j) / 63;
        const ps = score.voices.slice(0, 6).map((v) => pitchAt(v, t)!);
        for (let k = 0; k + 1 < ps.length; k++) expect(ps[k]).toBeLessThanOrEqual(ps[k + 1] + 1e-9);
      }
      for (let t = 1; t <= ends[0]; t += 0.005) {
        const ps = score.voices.slice(0, 6).map((v) => pitchAt(v, t)!);
        for (let k = 0; k + 1 < ps.length; k++) expect(ps[k]).toBeLessThanOrEqual(ps[k + 1] + 0.05);
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
    (q.moments[3] as Extract<Moment, { type: 'shift' }>).by = -3;
    q.moments[4].glide = { arrive: 'spread' };
    expect(inc.compile(q)).toEqual(compile(q));
    expect(inc.stats.mode).toBe('resume');
  });

  it('round-trips through the schema', () => {
    const p = piece({ glide: { arrive: 'spread' } });
    p.moments = [
      ...p.moments, // the opening
      { id: 'x', type: 'shift', at: 1, by: 1, unit: 'semitones', glide: { arrive: 'together' } },
    ];
    const parsed = parsePiece(JSON.parse(serializePiece(p)));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.piece.defaults.glide.arrive).toBe('spread');
    expect(parsed.piece.moments.find((m) => m.id === 'x')!.glide?.arrive).toBe('together');
    const bad = parsePiece({
      ...JSON.parse(serializePiece(p)),
      defaults: { glide: { arrive: 'soon' } },
    });
    // An unknown value is not accepted silently.
    expect(bad.ok && bad.warnings.length === 0).toBe(false);
  });
});
