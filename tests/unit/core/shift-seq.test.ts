/**
 * M13 "Shift sequence": a shift moment with `seq` planes through its steps, each compiling exactly
 * as the hand-written shift moment it stands for (`shiftSteps`), in either unit, with land, on a
 * part; one span to its end; diagnostics named by step; schema, canonical rules and incremental
 * = full.
 */
import { describe, expect, it } from 'vitest';
import { canonicalPiece } from '../../../src/core/canonical';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import {
  shiftSeqEnd,
  shiftSeqStarts,
  shiftStepSeed,
  shiftSteps,
} from '../../../src/core/moments/shift';
import { momentSeed } from '../../../src/core/rng';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, Moment, Piece, ShiftMoment } from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 0.6, jitter: 0.3, stagger: 0.4, ease: 'smootherstep' as const };

type ShiftInput = Omit<ShiftMoment, 'id'> & { id?: string };

const seq = (steps: [number, number][], extra: Partial<ShiftInput> = {}): ShiftInput => ({
  type: 'shift',
  at: 1,
  by: steps[0]?.[0] ?? 0,
  unit: 'scaleSteps',
  seq: steps.map(([by, len]) => ({ by, len })),
  ...extra,
});

function band(moments: MomentInput[], start = [48, 60, 64, 67]): Piece {
  const p = piece({
    pool: 6,
    start,
    glide: GLIDE,
    end: { at: 30, fade: 1 },
    key: { tonic: 'C', scale: 'major' },
    moments,
  });
  p.voices.forEach((v, i) => (v.part = i === 0 ? 'Bass' : 'Chords'));
  return p;
}

/** `p` with shift sequence `id` replaced by hand-written shift moments (ids `${id}s${k}`). */
function handWritten(p: Piece, id: string): Piece {
  const moments: Moment[] = [];
  for (const m of p.moments) {
    if (m.id !== id || m.type !== 'shift') moments.push(m);
    else shiftSteps(m, p.seed).forEach((s, k) => moments.push({ ...s, id: `${id}s${k}` }));
  }
  return { ...p, moments };
}

function sound(s: CompiledScore): unknown {
  return s.voices.map((v) => ({
    ...v,
    segments: v.segments.map(({ momentId: _, ...rest }) => rest),
  }));
}

function expectEquivalent(p: Piece, id: string): CompiledScore {
  const a = compile(p);
  const b = compile(handWritten(p, id));
  expect(sound(a)).toEqual(sound(b));
  expect(a.duration).toBe(b.duration);
  expect(a.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  return a;
}

const DOO_WOP: [number, number][] = [
  [-2, 2],
  [-1, 2],
  [-1, 2],
  [1, 1],
  [1, 1],
  [1, 1],
  [1, 2],
];

describe('shift sequence ≡ shift moments', () => {
  it('planes through every step (scale steps)', () => {
    const p = band([seq(DOO_WOP)]);
    const s = expectEquivalent(p, 'm0');
    // Net −2 + −1 + −1 + 4 = 0 scale steps: it ends where it started.
    expect(chordAt(s, 0.9)).toEqual(chordAt(s, 20));
    // After the first step: −2 scale steps of C major.
    expect(chordAt(s, 2.9)).toEqual([45, 57, 60, 64]);
    // Each step moves from its own start (within its stagger and jitter).
    const t0s = s.voices.flatMap((v) =>
      v.segments.filter((g) => g.momentId === 'm0' && g.p0 !== g.p1).map((g) => g.t0),
    );
    const starts = shiftSeqStarts({ at: 1, seq: DOO_WOP.map(([by, len]) => ({ by, len })) });
    for (const t of starts.slice(0, -1))
      expect(t0s.some((x) => x >= t - 1e-9 && x < t + 0.5)).toBe(true);
  });

  it('in semitones, on a part, with land', () => {
    const p = band([
      seq(
        [
          [-1, 1.5],
          [-1, 1.5],
          [2, 2],
        ],
        { unit: 'semitones', target: { part: 'Chords' }, glide: { land: true } },
      ),
    ]);
    const s = expectEquivalent(p, 'm0');
    // The Bass line (voice 0) never moves; step 1 lands on its start, before step 2 leads in;
    // the others are back at 60 64 67 after the last step.
    expect(chordAt(s, 1.2)).toEqual([48, 59, 63, 66]);
    expect(chordAt(s, 10)).toEqual([48, 60, 64, 67]);
  });

  it('seeds: step k is shiftStepSeed(seed, k); `by` is ignored', () => {
    const p = band([seq(DOO_WOP.slice(0, 2), { by: 7 })]);
    const m = p.moments.find((x) => x.type === 'shift') as ShiftMoment;
    const seed = momentSeed(p.seed, m.id, m.seed);
    expect(shiftSteps(m, p.seed).map((x) => [x.by, x.seed, x.seq])).toEqual([
      [-2, shiftStepSeed(seed, 0), undefined],
      [-1, shiftStepSeed(seed, 1), undefined],
    ]);
    const s = compile(p);
    expect(chordAt(s, 10)).toEqual(chordAt(compile(band([seq([[-3, 3]])])), 10));
  });

  it('an empty sequence is one shift by `by`; a muted one does nothing', () => {
    const plain = compile(band([{ type: 'shift', at: 1, by: 2, unit: 'scaleSteps' }]));
    const empty = compile(band([seq([], { by: 2 })]));
    expect(sound(empty)).toEqual(sound(plain));
    const base = compile(band([]));
    expect(sound(compile(band([seq(DOO_WOP, { muted: true })])))).toEqual(sound(base));
  });
});

describe('shift sequence span, diagnostics and effect', () => {
  it('one span from the first move to its end', () => {
    const p = band([seq(DOO_WOP)]);
    p.end = { fade: 1 };
    const s = compile(p);
    const spans = s.momentSpans.filter((x) => x.id === 'm0');
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBeGreaterThanOrEqual(1);
    expect(spans[0].start).toBeLessThan(1.5);
    expect(spans[0].end).toBe(
      shiftSeqEnd({ at: 1, seq: DOO_WOP.map(([by, len]) => ({ by, len })) }),
    );
    expect(s.diagnostics.some((d) => d.code === 'duplicate-moment-id')).toBe(false);
  });

  it('invalid steps: shift-invalid', () => {
    const p = band([seq([[1, 2]])]);
    (p.moments[1] as ShiftMoment).seq![0].len = 0;
    const s = compile(p);
    expect(s.diagnostics.find((d) => d.momentId === 'm0')?.code).toBe('shift-invalid');
  });

  it('no-effect only when every step has none, named by step', () => {
    const moving = compile(
      band([
        seq([
          [0, 1],
          [1, 1],
        ]),
      ]),
    );
    expect(moving.diagnostics.some((d) => d.code === 'no-effect' && d.momentId === 'm0')).toBe(
      false,
    );
    const still = compile(
      band([
        seq([
          [0, 1],
          [0, 1],
        ]),
      ]),
    );
    const ne = still.diagnostics.filter((d) => d.code === 'no-effect' && d.momentId === 'm0');
    expect(ne).toHaveLength(1);
    expect(ne[0].message).toMatch(/^Step 1 \(0\): No effect/);
  });

  it('the palette effect check', () => {
    const p = band([], [60, 64, 67]);
    const s = compile(p);
    const m = (steps: [number, number][]) => ({ ...seq(steps, { at: 2 }), id: 'x' }) as Moment;
    expect(
      momentEffectAt(
        p,
        s,
        m([
          [0, 1],
          [2, 1],
        ]),
      ).effect,
    ).toBe(true);
    expect(
      momentEffectAt(
        p,
        s,
        m([
          [0, 1],
          [0, 1],
        ]),
      ).effect,
    ).toBe(false);
  });
});

describe('shift sequence schema, canonical and incremental', () => {
  it('parses, rejects bad lengths, rounds lengths to 1 µs', () => {
    const p = band([seq(DOO_WOP)]);
    const r = parsePiece(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect((r.piece.moments[1] as ShiftMoment).seq).toEqual(
        p.moments[1].type === 'shift' && p.moments[1].seq,
      );
    const bad = band([seq([[1, -1]])]);
    expect(parsePiece(JSON.parse(JSON.stringify(bad))).ok).toBe(false);
    const fine = band([seq([[1 / 3, 0.1234567891]])]);
    const c = canonicalPiece(fine).moments[1] as ShiftMoment;
    expect(c.seq).toEqual([{ by: 0.333333333333, len: 0.123457 }]);
  });

  it('incremental = full across edits of a sequence', () => {
    const inc = createIncrementalCompiler();
    const steps: Piece[] = [];
    steps.push(
      band([
        { type: 'shift', at: 0.5, by: 2, unit: 'semitones' },
        seq(DOO_WOP, { at: 2 }),
        { type: 'key', at: 5, key: { tonic: 'A', scale: 'minor' } },
      ]),
    );
    const edit = (f: (m: ShiftMoment) => void): void => {
      const p = structuredClone(steps[steps.length - 1]);
      f(p.moments.find((m) => m.type === 'shift' && m.seq) as ShiftMoment);
      steps.push(p);
    };
    edit((m) => (m.seq![2].by = 3));
    edit((m) => (m.seq![3].len = 3));
    edit((m) => m.seq!.push({ by: -2, len: 1 }));
    edit((m) => (m.unit = 'semitones'));
    edit((m) => m.seq!.splice(1, 1));
    edit((m) => (m.at = 3));
    edit((m) => (m.muted = true));
    for (const p of steps) expect(inc.compile(p)).toEqual(compile(p));
  });
});
