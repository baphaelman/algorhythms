/**
 * A land moment (PLAN §5 `Glide.land`, §11.3) decides at its lead-in start, so an earlier moment
 * on the same lines can be decided after it and send them elsewhere before they arrive (build log
 * R9-2: "no special precedence"). That is by design, but it must not be silent:
 * `land-overtaken` (build log, "Land overtaken").
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { pitchAt } from '../../../src/core/query';
import type { CompiledScore, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

interface Case {
  /** Lines in the part (1 or 2). */
  lines: 1 | 2;
  /** Target `{ part: 'Mel' }` (with an untargeted Bass line) instead of every voice. */
  part: boolean;
  count: boolean;
  /** The earlier chord a: its time, glide length and whether it lands too. */
  aAt: number;
  aLen: number;
  aLand: boolean;
  /** b lands `gap` after a's arrival, with this glide. */
  gap: number;
  bLen: number;
  stagger: number;
  jitter: number;
  /** b's notes: a's shifted by `d` semitones (never 0). */
  d: number;
}

const BASE = 60;
const A = [64, 71];

function chord(at: number, pitches: number[], glide: object, id: string, c: Case): MomentInput {
  return {
    id,
    type: 'chord',
    at,
    notes: { kind: 'pitches', pitches },
    voicing: 'even',
    assign: 'ordered',
    glide,
    ...(c.part ? { target: { part: 'Mel' } } : {}),
    ...(c.count ? { count: c.lines } : {}),
  } as MomentInput;
}

/** a's arrival: `aAt` when it lands, else aAt + aLen. */
const aEnd = (c: Case): number => (c.aLand ? c.aAt : c.aAt + c.aLen);
const bAt = (c: Case): number => aEnd(c) + c.gap;
const bNotes = (c: Case): number[] => A.slice(0, c.lines).map((p) => p + c.d);

function build(c: Case): Piece {
  const mel = c.lines === 1 ? [BASE] : [BASE, BASE + 7];
  const p = piece({
    pool: 6,
    start: c.part ? [...mel, 40] : mel,
    glide: { length: 1, jitter: c.jitter, stagger: 0 },
    end: { at: bAt(c) + 10, fade: 1 },
    moments: [
      chord(c.aAt, A.slice(0, c.lines), { length: c.aLen, land: c.aLand }, 'a', c),
      chord(bAt(c), bNotes(c), { land: true, length: c.bLen, stagger: c.stagger }, 'b', c),
    ],
  });
  if (c.part) p.voices.forEach((v, i) => (v.part = i === c.lines ? 'Bass' : 'Mel'));
  return p;
}

/** The sorted pitches of the part's lines just after b's marker. */
function landedAt(s: CompiledScore, c: Case): number[] {
  const t = bAt(c) + 1e-3;
  return s.voices
    .slice(0, c.lines)
    .map((v) => pitchAt(v, t) ?? NaN)
    .sort((x, y) => x - y);
}

const overtaken = (s: CompiledScore) =>
  s.diagnostics.filter((d) => d.code === 'land-overtaken' && d.momentId === 'b');

/** b arrived on its notes by its marker. */
const arrived = (s: CompiledScore, c: Case): boolean =>
  landedAt(s, c).every((p, k) => Math.abs(p - bNotes(c)[k]) < 1e-6);

const CASE: Case = {
  lines: 1,
  part: true,
  count: false,
  aAt: 2,
  aLen: 1,
  aLand: false,
  gap: 0.3,
  bLen: 2,
  stagger: 0,
  jitter: 0,
  d: 3,
};

describe('land-overtaken', () => {
  it('the report: a land chord 0.3 s after a chord ends, one voice in a part', () => {
    // b (at 3.3, glide 2) decides at 1.3, before a (at 2): a takes the line, b never arrives.
    const s = compile(build(CASE));
    expect(landedAt(s, CASE)).toEqual([64]);
    const [d] = overtaken(s);
    expect(d).toMatchObject({ level: 'info', code: 'land-overtaken', momentId: 'b' });
    expect(d.message).toContain("'a'");
    expect(d.message).toContain('1.3 s');
  });

  it('no diagnostic when the lead-in starts after the earlier chord decides', () => {
    // b decides at 2.3 (after a at 2) and interrupts a's move: it arrives at its marker.
    const c = { ...CASE, bLen: 1 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    expect(overtaken(s)).toEqual([]);
    expect(s.diagnostics.filter((x) => x.level !== 'info')).toEqual([]);
  });

  it('no diagnostic when the earlier chord leaves the lines heading to the land notes', () => {
    const c = { ...CASE, d: 0 };
    const s = compile(build(c));
    expect(overtaken(s)).toEqual([]);
  });

  it('equal markers: a land moment whose longer lead-in puts it first is overtaken too', () => {
    // Both at 3: a (lead 1) decides at 2, b (lead 2) at 1, so a, earlier in the array, wins.
    const c = { ...CASE, aAt: 3, aLand: true, gap: 0 };
    const s = compile(build(c));
    expect(landedAt(s, c)).toEqual([64]);
    expect(overtaken(s)).toHaveLength(1);
  });

  it('a staggered move cancelled before it starts counts', () => {
    // b (at 6.7) decides at 0.2 with stagger 6: its later line starts after 3.2, so it is still
    // pending when a decides at 2 and cancels it.
    const c: Case = { ...CASE, lines: 2, part: false, gap: 3.7, bLen: 0.5, stagger: 6 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(false);
    expect(overtaken(s)).toHaveLength(1);
    expect(overtaken(s)[0].message).toContain('2 lines');
  });

  describe('matrix: arrives by its marker, or says why not', () => {
    const cases: Case[] = [];
    for (const lines of [1, 2] as const)
      for (const part of [false, true])
        for (const count of [false, true])
          for (const aLand of [false, true])
            for (const gap of [0, 0.1, 0.3, 0.5, 1])
              for (const bLen of [0.5, 1, 2, 4])
                for (const stagger of [0, 1])
                  cases.push({ ...CASE, lines, part, count, aLand, gap, bLen, stagger });
    it(`${cases.length} cases`, () => {
      for (const c of cases) {
        const s = compile(build(c));
        const tb = Math.max(0, bAt(c) - c.bLen - c.stagger);
        const ta = c.aLand ? c.aAt - c.aLen : c.aAt;
        const msg = JSON.stringify(c);
        // Overtaken exactly when b decides before a; otherwise it arrives.
        expect(overtaken(s).length > 0, msg).toBe(tb < ta);
        expect(arrived(s, c), msg).toBe(!(tb < ta));
      }
    });
  });

  it('property: a land chord arrives by its marker or raises land-overtaken (seeded)', () => {
    const caseArb: fc.Arbitrary<Case> = fc.record({
      lines: fc.constantFrom(1 as const, 2 as const),
      part: fc.boolean(),
      count: fc.boolean(),
      aAt: fc.double({ min: 1, max: 6, noNaN: true }),
      aLen: fc.double({ min: 0.1, max: 3, noNaN: true }),
      aLand: fc.boolean(),
      gap: fc.double({ min: 0, max: 1, noNaN: true }),
      bLen: fc.double({ min: 0.1, max: 4, noNaN: true }),
      stagger: fc.double({ min: 0, max: 1.5, noNaN: true }),
      jitter: fc.constantFrom(0, 0.2),
      d: fc.constantFrom(-5, -3, -2, -1, 1, 2, 3, 5),
    });
    fc.assert(
      fc.property(caseArb, (c) => {
        const s = compile(build(c));
        // Exactly one of the two, never neither (the reported silent drop) nor both.
        expect(arrived(s, c), JSON.stringify(c)).toBe(overtaken(s).length === 0);
      }),
      { numRuns: 300, seed: 1122 },
    );
  });

  it('incremental compile equals a full compile across edits that make and clear it', () => {
    const inc = createIncrementalCompiler();
    let q = build({ ...CASE, lines: 2, part: true });
    expect(inc.compile(q)).toEqual(compile(q));
    const edits: ((p: Piece) => void)[] = [
      (p) => (p.moments[2].glide = { land: true, length: 0.5 }), // clears it
      (p) => (p.moments[2].glide = { land: true, length: 3 }), // makes it again
      (p) => (p.moments[1].at = 0.5), // a before b's lead-in: clears it
      (p) => (p.moments[1].at = 2.5),
    ];
    for (const edit of edits) {
      q = structuredClone(q);
      edit(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });
});
