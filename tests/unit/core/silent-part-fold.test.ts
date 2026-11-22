/**
 * composing.md §3 #4 and #6 (2026-11-22): a chord, unison or tune brings a silent part in
 * partway through; folding a target into its range never merges a line into another of its
 * part.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { pitchAt } from '../../../src/core/query';
import type { CompiledScore, Diagnostic, Moment, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };

/** v1–v3 "Pad" (sounding from 0 on C E G), v4–v6 "Bells" (silent). */
function parted(moments: MomentInput[], pool = 6): Piece {
  const p = piece({ pool, start: [48, 52, 55], glide: GLIDE, end: { at: 12, fade: 1 }, moments });
  p.voices.forEach((v, i) => (v.part = i < 3 ? 'Pad' : 'Bells'));
  for (const v of p.voices.slice(3)) v.range = [67, 91];
  return p;
}

const BELLS = { part: 'Bells' };
const diags = (s: CompiledScore, id = 'm0'): Diagnostic[] =>
  s.diagnostics.filter((d) => d.momentId === id);
const born = (s: CompiledScore): string[] =>
  s.voices.filter((v) => v.lives.length > 0).map((v) => v.id);
/** Lines sounding at t, by pitch. */
const heard = (s: CompiledScore, t: number): number[] =>
  s.voices
    .map((v) => pitchAt(v, t))
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);

describe('a silent part brought in partway through (#4)', () => {
  const without = compile(parted([]));

  it('a chord on it: its lines are born on the chord, fading in, no glide', () => {
    const s = compile(
      parted([
        {
          type: 'chord',
          voicing: 'even',
          assign: 'ordered',
          at: 4,
          target: BELLS,
          notes: { kind: 'chord', symbol: 'F' },
        },
      ]),
    );
    expect(diags(s)).toEqual([]);
    expect(born(s)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    const bells = s.voices.slice(3);
    for (const v of bells) {
      expect(v.lives).toHaveLength(1);
      expect(v.lives[0].born).toBe(4);
      expect(v.lives[0].fadeIn).toBe(0.5); // as a chord count's parentless births
      expect(v.segments.every((g) => g.p0 === g.p1)).toBe(true);
    }
    expect(bells.map((v) => v.segments[0].p0 % 12).sort()).toEqual([0, 5, 9]);
    // The Pad is untouched.
    expect(s.voices.slice(0, 3)).toEqual(without.voices.slice(0, 3));
  });

  it('a unison on it: one line on the pitch', () => {
    const s = compile(
      parted([{ type: 'unison', at: 4, target: BELLS, pitch: 79, octaves: false }]),
    );
    expect(diags(s)).toEqual([]);
    expect(born(s)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(s.voices[3].lives[0]).toMatchObject({ born: 4, fadeIn: 0.5 });
    expect(pitchAt(s.voices[3], 5)).toBe(79);
  });

  it('a tune on it: one line, born at its first note, then the tune', () => {
    const notes = [
      { pitch: 72, len: 1 },
      { pitch: 76, len: 1 },
      { pitch: 74, len: 1 },
    ];
    const s = compile(parted([{ type: 'tune', at: 4, target: BELLS, notes }]));
    expect(diags(s)).toEqual([]);
    expect(born(s)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(s.voices[3].lives[0]).toMatchObject({ born: 4, fadeIn: 0.5 });
    expect([4.5, 5.5, 6.5].map((t) => pitchAt(s.voices[3], t))).toEqual([72, 76, 74]);
    expect(s.voices.slice(0, 3)).toEqual(without.voices.slice(0, 3));
  });

  it('at the opening, parts come in together, none fading in', () => {
    const notes = [{ pitch: 72, len: 1 }];
    const s = compile(parted([{ type: 'tune', at: 0, target: BELLS, notes }]));
    expect(diags(s)).toEqual([]);
    expect(born(s)).toEqual(['v1', 'v2', 'v3', 'v4']);
    for (const v of s.voices.slice(0, 4)) expect(v.lives[0]).toMatchObject({ born: 0, fadeIn: 0 });
    expect(s.voices.slice(0, 3)).toEqual(without.voices.slice(0, 3));
  });

  it('a land chord on it comes in at its marker, as an opening chord does', () => {
    const s = compile(
      parted([
        {
          type: 'chord',
          voicing: 'even',
          assign: 'ordered',
          at: 4,
          target: BELLS,
          notes: { kind: 'pitches', pitches: [72] },
          glide: { length: 2, land: true },
        },
      ]),
    );
    expect(diags(s)).toEqual([]);
    expect(s.voices[3].lives[0].born).toBe(4);
  });

  it('a chord with count still births as before (parentless, at its time)', () => {
    const s = compile(
      parted([
        {
          type: 'chord',
          voicing: 'even',
          assign: 'ordered',
          at: 4,
          target: BELLS,
          notes: { kind: 'pitches', pitches: [72] },
          count: 1,
        },
      ]),
    );
    expect(born(s)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(s.voices[3].lives[0]).toMatchObject({ born: 4, fadeIn: 0.5 });
  });

  it('once in, the part takes moments as usual', () => {
    const s = compile(
      parted([
        { type: 'unison', at: 4, target: BELLS, pitch: 79, octaves: false },
        { type: 'shift', at: 6, target: BELLS, by: 2, unit: 'semitones' },
      ]),
    );
    expect(pitchAt(s.voices[3], 8)).toBe(81);
    expect(diags(s, 'm1')).toEqual([]);
  });

  it('the palette check agrees', () => {
    const p = parted([]);
    const s = compile(p);
    const at = (m: MomentInput) => momentEffectAt(p, s, { ...m, id: 'x' } as Moment);
    expect(
      at({
        type: 'chord',
        voicing: 'even',
        assign: 'ordered',
        at: 4,
        target: BELLS,
        notes: { kind: 'chord', symbol: 'F' },
      }),
    ).toEqual({
      effect: true,
    });
    expect(at({ type: 'unison', at: 4, target: BELLS, pitch: 79, octaves: false })).toEqual({
      effect: true,
    });
    expect(at({ type: 'tune', at: 4, target: BELLS, notes: [{ pitch: 72, len: 1 }] })).toEqual({
      effect: true,
    });
    expect(at({ type: 'shift', at: 4, target: BELLS, by: 2, unit: 'semitones' })).toEqual({
      effect: false,
      reason: "the part 'Bells' is silent here; bring it in with a chord, a unison or a tune",
    });
  });

  it('incremental compile equals full compile', () => {
    const p = parted([
      {
        type: 'chord',
        voicing: 'even',
        assign: 'ordered',
        at: 4,
        target: BELLS,
        notes: { kind: 'chord', symbol: 'F' },
      },
      {
        type: 'tune',
        at: 2,
        target: { part: 'Lead' },
        notes: [
          { pitch: 60, len: 1 },
          { pitch: 62, len: 1 },
        ],
      },
      { type: 'shift', at: 7, by: 1, unit: 'scaleSteps' },
    ]);
    p.voices[5].part = 'Lead';
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    q.moments[1] = { ...q.moments[1], at: 5 };
    expect(inc.compile(q)).toEqual(compile(q));
    const r = structuredClone(q);
    r.moments[2] = { ...r.moments[2], at: 3 } as Moment;
    expect(inc.compile(r)).toEqual(compile(r));
  });
});

describe('moments that still do nothing on a silent target warn (#4)', () => {
  const one = (m: MomentInput, p = parted([m])): Diagnostic[] =>
    diags(compile(p)).filter((d) => d.code === 'no-effect');

  it('a shift on a silent part says how to bring it in', () => {
    expect(one({ type: 'shift', at: 4, target: BELLS, by: 2, unit: 'semitones' })).toEqual([
      {
        level: 'warn',
        code: 'no-effect',
        momentId: 'm0',
        message:
          "No effect: the part 'Bells' is silent here; bring it in with a chord, a unison or a tune.",
      },
    ]);
  });

  it('a chord on the current notes of a silent part', () => {
    expect(
      one({
        type: 'chord',
        voicing: 'even',
        assign: 'ordered',
        at: 4,
        target: BELLS,
        notes: { kind: 'current' },
      }),
    ).toMatchObject([{ level: 'warn' }]);
  });

  it('from silence, and on silent voices', () => {
    const p = piece({
      pool: 4,
      start: [],
      moments: [{ type: 'shift', at: 1, by: 2, unit: 'semitones' }],
    });
    expect(diags(compile(p))).toEqual([
      {
        level: 'warn',
        code: 'no-effect',
        momentId: 'm0',
        message: 'No effect: no note is sounding; start with a chord or a unison.',
      },
    ]);
    expect(
      one({ type: 'shift', at: 4, target: { voices: ['v5'] }, by: 2, unit: 'semitones' }),
    ).toMatchObject([{ level: 'warn', message: 'No effect: it targets no sounding note.' }]);
  });

  it('level moments on a silent part stay info', () => {
    const d = diags(compile(parted([{ type: 'level', at: 4, target: BELLS, gain: 0.5, over: 1 }])));
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => x.level === 'info')).toBe(true);
  });
});

describe('folding never merges lines of a part (#6)', () => {
  /** One part ("A"), range [lo, hi], lines on `start`. */
  const one = (start: number[], range: [number, number], moments: MomentInput[]): Piece => {
    const p = piece({ pool: 6, start, glide: GLIDE, range, end: { at: 10, fade: 1 }, moments });
    for (const v of p.voices) v.part = 'A';
    return p;
  };
  const lines = (s: CompiledScore): number =>
    s.voices.filter((v) => v.lives.some((l) => l.born <= 9 && (l.died ?? Infinity) > 9)).length;
  const apart = (s: CompiledScore, id = 'm0') =>
    diags(s, id).filter((d) => d.code === 'fold-apart');

  it('a shift past the range onto a part-mate: the next octave if free', () => {
    // v2 74 + 12 → 86 folds to 74, where v1 is: the next octave down (62) is free.
    const s = compile(
      one(
        [74, 79],
        [50, 80],
        [{ type: 'shift', at: 2, target: { voices: ['v2'] }, by: 7, unit: 'semitones' }],
      ),
    );
    expect(heard(s, 9)).toEqual([62, 74]);
    expect(lines(s)).toBe(2);
    expect(apart(s)).toMatchObject([{ level: 'warn' }]);
  });

  it('else the nearest free scale step (ties towards the target)', () => {
    // v2 67 + 7 → 74 folds to 62, v1's note; 50 is out of range: the nearest free step is 60 or
    // 64, the tie goes up, towards 74.
    const s = compile(
      one(
        [62, 67],
        [55, 70],
        [{ type: 'shift', at: 2, target: { voices: ['v2'] }, by: 7, unit: 'semitones' }],
      ),
    );
    expect(heard(s, 9)).toEqual([62, 64]);
    expect(lines(s)).toBe(2);
    expect(apart(s)).toHaveLength(1);
  });

  it('onto a line moving there in the same moment', () => {
    // Lines an octave apart filling their range: + 2 sends the top one to 74, folded to 62,
    // where the bottom one goes. Both keep sounding.
    const s = compile(
      one([60, 72], [60, 72], [{ type: 'shift', at: 2, by: 2, unit: 'semitones' }]),
    );
    expect(heard(s, 9)).toEqual([62, 64]);
    expect(lines(s)).toBe(2);
    expect(apart(s)).toHaveLength(1);
  });

  it('a line of another part on the fold target is no clash', () => {
    const p = one(
      [62, 67],
      [55, 70],
      [{ type: 'shift', at: 2, target: { voices: ['v2'] }, by: 7, unit: 'semitones' }],
    );
    p.voices[0].part = 'B';
    const s = compile(p);
    expect(heard(s, 9)).toEqual([62, 62]);
    expect(apart(s)).toEqual([]);
    expect(diags(s).map((d) => d.code)).toContain('range-fold');
  });

  it('an establishing chord: notes folded onto each other stay two lines', () => {
    const s = compile(
      one(
        [],
        [50, 70],
        [
          {
            type: 'chord',
            voicing: 'even',
            assign: 'ordered',
            at: 0,
            notes: { kind: 'pitches', pitches: [62, 74] },
          },
        ],
      ),
    );
    expect(heard(s, 1)).toEqual([50, 62]);
    expect(apart(s)).toHaveLength(1);
  });

  it('a unison gathers lines: its folds may merge them', () => {
    // Octaves of 59: 52 → 47 folds to 59, where 64 goes.
    const s = compile(
      one([52, 64], [50, 70], [{ type: 'unison', at: 2, pitch: 59, octaves: true }]),
    );
    expect(heard(s, 9)).toEqual([59]);
    expect(apart(s)).toEqual([]);
  });

  it('incremental compile equals full compile', () => {
    const p = one(
      [60, 64, 67, 72],
      [55, 72],
      [
        { type: 'shift', at: 2, by: 3, unit: 'scaleSteps' },
        { type: 'shift', at: 4, by: 2, unit: 'scaleSteps' },
      ],
    );
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    q.moments[2] = { ...q.moments[2], at: 3 } as Moment;
    expect(inc.compile(q)).toEqual(compile(q));
    expect(lines(compile(q))).toBe(4);
  });
});
