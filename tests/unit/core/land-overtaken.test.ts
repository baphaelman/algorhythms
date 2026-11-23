/**
 * Land always arrives (owner, 2026-11-23; PLAN §5 `Glide.land`, §11 "Always lands"; build log
 * "Land always arrives"): an earlier moment never takes a land moment's lines. A land moment whose
 * lead-in would start before an earlier moment on its lines decides after it, and on the lines
 * that moment moves its glide starts when that move arrives. `land-overtaken` is left for two land
 * moments setting one line at one marker. Supersedes the "Land overtaken" diagnostic of v64.
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
  /** b's notes: a's shifted by `d` semitones. */
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

/** The sorted pitches of the part's lines at t. */
function linesAt(s: CompiledScore, c: Case, t: number): number[] {
  return s.voices
    .slice(0, c.lines)
    .map((v) => pitchAt(v, t) ?? NaN)
    .sort((x, y) => x - y);
}

const overtaken = (s: CompiledScore, id = 'b') =>
  s.diagnostics.filter((d) => d.code === 'land-overtaken' && d.momentId === id);

const near = (xs: number[], ys: number[]): boolean =>
  xs.length === ys.length && xs.every((x, k) => Math.abs(x - ys[k]) < 1e-6);

/** b's lines are on its notes at its marker. */
const arrived = (s: CompiledScore, c: Case): boolean => near(linesAt(s, c, bAt(c)), bNotes(c));

/** Two land chords at one marker: the one deciding first keeps the lines (genuinely contested). */
const contested = (c: Case): boolean => c.aLand && bAt(c) === c.aAt;

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

/** Segments of moment `id` that move, on the first voice. */
const glidesOf = (s: CompiledScore, id: string) =>
  s.voices[0].segments.filter((g) => g.momentId === id && g.p0 !== g.p1);

describe('land always arrives', () => {
  it('the report: a land chord 0.3 s after a chord ends lands, and the chord is heard', () => {
    // b (at 3.3, glide 2) would start at 1.3, before a (at 2): it waits for a, which arrives at
    // 3, and glides from there.
    const s = compile(build(CASE));
    expect(linesAt(s, CASE, 1.99)).toEqual([60]); // nothing moves before a's marker
    expect(linesAt(s, CASE, 3)).toEqual([64]); // a arrives
    expect(arrived(s, CASE)).toBe(true);
    const [b] = glidesOf(s, 'b');
    expect(b.t0).toBeCloseTo(3, 9);
    expect(b.t1).toBeCloseTo(3.3, 9);
    expect(glidesOf(s, 'a')[0].t0).toBe(2);
    expect(s.diagnostics.filter((d) => d.code === 'land-overtaken')).toEqual([]);
    expect(s.diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
  });

  it('unchanged when the lead-in starts after the earlier chord decides', () => {
    // b decides at 2.3 (after a at 2) and interrupts a's move, as before.
    const c = { ...CASE, bLen: 1 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    expect(glidesOf(s, 'b')[0].t0).toBe(2.3);
    expect(overtaken(s)).toEqual([]);
  });

  it('no room: the earlier glide is cut to leave the land glide 0.1 s', () => {
    // a arrives at 3, b lands at 3.05.
    const c = { ...CASE, gap: 0.05 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    const [b] = glidesOf(s, 'b');
    expect(b.t0).toBeCloseTo(2.95, 9);
    expect(b.t1).toBeCloseTo(3.05, 9);
  });

  it('the earlier glide arriving after the marker gives way too', () => {
    // a (at 2, glide 3) would arrive at 5; b lands at 3.3 (gap −1.7 from a's arrival).
    const c = { ...CASE, aLen: 3, gap: -1.7 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    expect(glidesOf(s, 'b')[0].t0).toBeCloseTo(3.2, 9);
    expect(overtaken(s)).toEqual([]);
  });

  it('a land moment that waits reads what the earlier moment did', () => {
    // b: shift +2 landing at 10 (lead 3); a: shift +5 at 8. a goes first (60 → 65), then b
    // from a's note (67), not a from b's.
    const shift = (at: number, by: number, land: boolean, id: string): MomentInput => ({
      id,
      type: 'shift',
      at,
      by,
      unit: 'semitones',
      glide: { land, length: land ? 3 : 1 },
    });
    const s = compile(
      piece({
        start: [60],
        glide: { length: 1, jitter: 0, stagger: 0 },
        end: { at: 30, fade: 1 },
        moments: [shift(10, 2, true, 'b'), shift(8, 5, false, 'a')],
      }),
    );
    const v = s.voices[0];
    expect(pitchAt(v, 9)).toBe(65);
    expect(pitchAt(v, 10)).toBe(67);
    const [b] = v.segments.filter((g) => g.momentId === 'b');
    expect(b.t0).toBe(9);
  });

  it('lines the earlier moment does not move: the lead-in starts after its decision', () => {
    // a moves Mel; b lands every line (Mel and Bass) at 3.3: Mel from a's arrival, Bass from 2.
    const c = { ...CASE };
    const p = build(c);
    delete (p.moments[2] as { target?: unknown }).target;
    (p.moments[2] as { notes: unknown }).notes = { kind: 'pitches', pitches: [43, 67] };
    const s = compile(p);
    expect(pitchAt(s.voices[0], 3.3)).toBe(67);
    expect(pitchAt(s.voices[1], 3.3)).toBe(43);
    const bass = s.voices[1].segments.find((g) => g.momentId === 'b' && g.p0 !== g.p1)!;
    expect(bass.t0).toBeGreaterThan(2);
    expect(bass.t0).toBeLessThan(2 + 1e-9);
    expect(glidesOf(s, 'b')[0].t0).toBeCloseTo(3, 9);
  });

  it('no diagnostic when the earlier chord leaves the lines heading to the land notes', () => {
    const c = { ...CASE, d: 0 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    expect(overtaken(s)).toEqual([]);
  });

  it('a staggered lead-in waits too', () => {
    // b (at 6.7, stagger 6) would decide at 0.2: it waits for a (at 2), both lines arrive.
    const c: Case = { ...CASE, lines: 2, part: false, gap: 3.7, bLen: 0.5, stagger: 6 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    expect(linesAt(s, c, 3)).toEqual(A);
    expect(overtaken(s)).toEqual([]);
  });

  it('equal markers: two land chords on one line, the first to decide keeps it', () => {
    // Both at 3: b (lead 2) decides at 1, a (lead 1) at 2 and leaves the line to b.
    const c = { ...CASE, aAt: 3, aLand: true, gap: 0 };
    const s = compile(build(c));
    expect(arrived(s, c)).toBe(true);
    expect(overtaken(s)).toEqual([]);
    const [d] = overtaken(s, 'a');
    expect(d).toMatchObject({ level: 'info', code: 'land-overtaken', momentId: 'a' });
    expect(d.message).toContain("'b'");
    expect(d.message).toContain('Two land moments');
  });

  it('equal markers (Switchyard): the other moment moves only its other lines', () => {
    // At 120: a land shift of everything (lead 0.35) and a land unison of the bass (lead 1.1,
    // decides first). The bass lands on the unison's note, the rest shift.
    const p = piece({
      pool: 4,
      start: [43, 60, 64],
      glide: { length: 3, jitter: 0.2, stagger: 0.8 },
      end: { at: 125, fade: 1 },
      moments: [
        {
          id: 'shift',
          type: 'shift',
          at: 120,
          by: 3,
          unit: 'scaleSteps',
          glide: { length: 0.3, stagger: 0.05, land: true },
        },
        {
          id: 'bass',
          type: 'unison',
          at: 120,
          target: { part: 'Bass' },
          pitch: 40,
          octaves: false,
          glide: { length: 0.3, land: true },
        },
      ],
    });
    p.voices.forEach((v, i) => (v.part = i === 0 ? 'Bass' : 'Keys'));
    const s = compile(p);
    expect(pitchAt(s.voices[0], 120)).toBe(40);
    expect(pitchAt(s.voices[1], 120)).not.toBe(60);
    expect(pitchAt(s.voices[2], 120)).not.toBe(64);
    expect(overtaken(s, 'shift')).toHaveLength(1);
    expect(s.diagnostics.filter((d) => d.code === 'no-effect')).toEqual([]);
  });

  describe('matrix: arrives by its marker', () => {
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
        const msg = JSON.stringify(c);
        if (contested(c)) {
          // Exactly one of the two lands its lines; the other says it left them.
          const a = near(linesAt(s, c, c.aAt), A.slice(0, c.lines));
          expect(a !== arrived(s, c), msg).toBe(true);
          expect(overtaken(s, a ? 'b' : 'a'), msg).toHaveLength(1);
          continue;
        }
        expect(arrived(s, c), msg).toBe(true);
        expect(overtaken(s), msg).toEqual([]);
        // a is heard where there is room: its notes sound when it arrives.
        if (!c.aLand && c.gap >= 0.1 && bAt(c) - c.bLen - c.stagger < c.aAt)
          expect(near(linesAt(s, c, aEnd(c)), A.slice(0, c.lines)), msg).toBe(true);
      }
    });
  });

  it('property: a land chord always arrives by its marker (seeded)', () => {
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
        const msg = JSON.stringify(c);
        if (contested(c)) {
          expect(overtaken(s, 'a').length + overtaken(s, 'b').length, msg).toBe(1);
          return;
        }
        expect(arrived(s, c), msg).toBe(true);
        expect(overtaken(s), msg).toEqual([]);
      }),
      { numRuns: 300, seed: 1122 },
    );
  });

  it('incremental compile equals a full compile across edits that make and clear the wait', () => {
    const inc = createIncrementalCompiler();
    let q = build({ ...CASE, lines: 2, part: true });
    expect(inc.compile(q)).toEqual(compile(q));
    const edits: ((p: Piece) => void)[] = [
      (p) => (p.moments[2].glide = { land: true, length: 0.5 }), // no wait
      (p) => (p.moments[2].glide = { land: true, length: 3 }), // waits for a
      (p) => (p.moments[1].at = 0.5), // a before b's lead-in: no wait
      (p) => (p.moments[1].at = 2.5), // waits again
      (p) => (p.moments[1].target = { part: 'Bass' }), // a moves only the bass: no wait
      (p) => (p.moments[1].target = { part: 'Mel' }),
      (p) => p.moments.push({ ...p.moments[2], id: 'b2', at: 4.5 } as Piece['moments'][number]),
      (p) => (p.moments[2].at = 4.5), // equal markers with b2
      (p) => p.moments.splice(1, 1), // a goes: b and b2 decide alone
    ];
    for (const edit of edits) {
      q = structuredClone(q);
      edit(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });

  it('incremental: an edit after a land moment in the array that changes its wait', () => {
    // b, then level moments (checkpoints between b's lead-in start and a), then a: editing a moves
    // b's decision, and the resume must come before b's old and new decision.
    const inc = createIncrementalCompiler();
    let q = build({ ...CASE, lines: 2, part: true });
    const levels = Array.from(
      { length: 6 },
      (_, k) =>
        ({ id: `x${k}`, type: 'level', at: 1.4 + 0.1 * k, gain: 1 }) as Piece['moments'][number],
    );
    q.moments = [q.moments[0], q.moments[2], ...levels, q.moments[1]];
    const a = q.moments.length - 1;
    expect(inc.compile(q)).toEqual(compile(q));
    const edits: ((p: Piece) => void)[] = [
      (p) => (p.moments[a].target = { part: 'Bass' }), // b no longer waits
      (p) => (p.moments[a].target = { part: 'Mel' }), // b waits again
      (p) => (p.moments[a].at = 1.2), // a before b's lead-in
      (p) => (p.moments[a].at = 2.6),
    ];
    for (const edit of edits) {
      q = structuredClone(q);
      edit(q);
      expect(inc.compile(q)).toEqual(compile(q));
      expect(inc.stats.mode).toBe('resume');
    }
  });
});
