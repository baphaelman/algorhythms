/**
 * The start is a moment (PLAN.md §11.3 revision 7; schema v2, M4.5-27): establishing moments
 * from silence, and transitional moments that have no effect there.
 */
import { describe, expect, it } from 'vitest';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { newPiece } from '../../../src/core/defaults';
import { withOpening } from '../opened-piece';
import { momentEffectAt, momentEffectsAt } from '../../../src/core/effect';
import type { CompiledScore, Moment, MomentType, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const silent = (moments: MomentInput[], pool = 8): Piece => piece({ start: [], pool, moments });
const sounding = (s: CompiledScore) => s.voices.filter((v) => v.lives.length > 0);
const noEffect = (s: CompiledScore, id: string) =>
  s.diagnostics.filter((d) => d.code === 'no-effect' && d.momentId === id).map((d) => d.message);
const chord = (at: number, notes: Moment extends never ? never : object, more = {}) =>
  ({ type: 'chord', at, notes, voicing: 'even', assign: 'ordered', ...more }) as MomentInput;

describe('establishing from silence', () => {
  it('the empty template is silent', () => {
    const s = compile(newPiece({ seed: 1 }));
    expect(sounding(s)).toEqual([]);
    expect(s.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('a one-note chord at 0: one line, a dot at the start of it', () => {
    const p = withOpening(newPiece({ seed: 1 }));
    const s = compile(p);
    expect(sounding(s).map((v) => v.id)).toEqual(['v1']);
    const v1 = s.voices[0];
    expect(v1.lives).toEqual([{ born: 0, fadeIn: 0, died: s.duration, fadeOut: 4 }]);
    expect(v1.segments).toEqual([
      { t0: 0, t1: s.duration, p0: 57, p1: 57, ease: 'linear', momentId: 'start0' },
    ]);
    expect(s.harmony?.[0]).toMatchObject({ t: 0, momentId: 'start0' });
    expect(s.diagnostics).toEqual([]);
    // Deleting it leaves silence.
    const none = compile({ ...p, moments: [] });
    expect(sounding(none)).toEqual([]);
  });

  it('a pitch list brings its voices in on their notes at its time, with no glide', () => {
    const s = compile(silent([chord(2, { kind: 'pitches', pitches: [64, 50, 57] }, { id: 'c' })]));
    const on = sounding(s);
    expect(on.map((v) => [v.id, v.segments[0].p0])).toEqual([
      ['v1', 50],
      ['v2', 57],
      ['v3', 64],
    ]);
    for (const v of on) {
      expect(v.lives[0]).toMatchObject({ born: 2, fadeIn: 0 });
      expect(v.segments.every((g) => g.p0 === g.p1 && g.momentId === 'c')).toBe(true);
    }
    expect(s.momentSpans).toEqual([{ id: 'c', start: 2, end: 2 }]);
  });

  it('a chord symbol gives one note per pitch class near the middle; count adds octaves', () => {
    const triad = compile(silent([chord(0, { kind: 'chord', symbol: 'Am' })]));
    const ps = sounding(triad).map((v) => v.segments[0].p0);
    expect(ps.map((p) => p % 12).sort()).toEqual([0, 4, 9]);
    expect(Math.max(...ps) - Math.min(...ps)).toBeLessThanOrEqual(12 + 9);
    const five = compile(silent([chord(0, { kind: 'chord', symbol: 'Am' }, { count: 5 })]));
    const qs = sounding(five).map((v) => v.segments[0].p0);
    expect(qs).toHaveLength(5);
    expect(new Set(qs).size).toBe(5); // distinct notes: octaves before unisons
  });

  it('byVoice with a { voices } target keeps each listed voice on its own pitch', () => {
    const s = compile(
      silent([
        chord(
          0,
          { kind: 'pitches', pitches: [70, 50] },
          { target: { voices: ['v4', 'v2'] }, byVoice: true },
        ),
      ]),
    );
    expect(sounding(s).map((v) => [v.id, v.segments[0].p0])).toEqual([
      ['v2', 50],
      ['v4', 70],
    ]);
  });

  it('a unison brings in one note (the tonic, or its listed voices as one line)', () => {
    const s = compile(silent([{ type: 'unison', at: 1, pitch: 'tonic', octaves: false }]));
    expect(sounding(s).map((v) => v.segments[0].p0 % 12)).toEqual([9]); // A dorian
    const all = compile(
      silent([
        {
          type: 'unison',
          at: 1,
          pitch: 60,
          octaves: false,
          target: { voices: ['v1', 'v2', 'v3'] },
        },
      ]),
    );
    const on = sounding(all);
    expect(on.map((v) => v.id)).toEqual(['v1']);
    expect(on[0].weight?.at(-1)?.w).toBe(3);
  });

  it('notes on one pitch become one line, weighted (distinct notes)', () => {
    const s = compile(silent([chord(0, { kind: 'pitches', pitches: [60, 60, 67] })]));
    const on = sounding(s);
    expect(on.map((v) => v.segments[0].p0)).toEqual([60, 67]);
    expect(on[0].weight?.at(-1)?.w).toBe(2);
  });

  it('a later chord after the silence glides as usual', () => {
    const s = compile(
      silent([
        chord(0, { kind: 'pitches', pitches: [50, 57] }),
        chord(2, { kind: 'pitches', pitches: [52, 59] }),
      ]),
    );
    expect(sounding(s).map((v) => v.segments.some((g) => g.p0 !== g.p1))).toEqual([true, true]);
  });

  it('incremental compile equals full compile when the opening is edited', () => {
    const p = silent([
      chord(0, { kind: 'pitches', pitches: [50, 57] }, { id: 'o' }),
      { type: 'shift', at: 2, by: 2, unit: 'semitones' },
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    q.moments[0] = { ...q.moments[0], notes: { kind: 'pitches', pitches: [48, 55, 60] } } as Moment;
    expect(inc.compile(q)).toEqual(compile(q));
    const r = { ...q, moments: q.moments.slice(1) };
    expect(inc.compile(r)).toEqual(compile(r));
  });
});

describe('transitional moments from silence: no effect', () => {
  const HINT = 'No effect: no note is sounding; start with a chord or a unison.';
  const cases: [MomentType, MomentInput][] = [
    ['note', { type: 'note', at: 1, from: 57, to: 59 }],
    ['note', { type: 'note', at: 1, changes: [{ from: 57, to: 59 }] } as MomentInput],
    ['shift', { type: 'shift', at: 1, by: 2, unit: 'scaleSteps' }],
    ['split', { type: 'split', at: 1, count: 3, voicing: 'even' }],
    [
      'split',
      { type: 'split', at: 1, count: 2, voicing: 'even', notes: { kind: 'chord', symbol: 'C' } },
    ],
    ['merge', { type: 'merge', at: 1, count: 1, which: 'top', fade: 1 }],
    ['spread', { type: 'spread', at: 1, factor: 2, around: 'mean', snap: 'scale' }],
    ['pin', { type: 'pin', at: 1, voice: 'v1', pitch: 60 }],
    ['walk', { type: 'walk', at: 1, until: 5, grid: 1, density: 1, steps: [1], stepGlide: 0.2 }],
  ];
  for (const [type, m] of cases) {
    it(`${type}: reports no-effect with the reason, and nothing sounds`, () => {
      const s = compile(silent([{ ...m, id: 'x' }]));
      expect(sounding(s)).toEqual([]);
      expect(noEffect(s, 'x')).toEqual([HINT]);
    });
  }

  it('a chord on the current notes is not establishing: nothing to set', () => {
    const s = compile(silent([chord(1, { kind: 'current' }, { id: 'x' })]));
    expect(noEffect(s, 'x')).toEqual([
      'No effect: no note is sounding; start with a chord or a unison.',
    ]);
  });

  it('a walk over a silence still steps once a chord comes in', () => {
    const s = compile(
      silent([
        { type: 'walk', at: 1, until: 9, grid: 1, density: 1, steps: [1], stepGlide: 0.2, id: 'w' },
        chord(3, { kind: 'pitches', pitches: [57] }),
      ]),
    );
    expect(s.walkSteps.length).toBeGreaterThan(0);
    expect(noEffect(s, 'w')).toEqual([]);
  });

  it('the palette greys out everything but chord, unison and key there', () => {
    const p = silent([]);
    const s = compile(p);
    const r = momentEffectsAt(p, s, 1, (type, at) => defaultMoment(type, at, 'new1', p, s));
    const on = (Object.keys(r) as MomentType[]).filter((k) => r[k].effect).sort();
    expect(on).toEqual(['chord', 'key', 'unison']);
    expect(r.split.reason).toBe('no note is sounding; start with a chord or a unison');
    // The palette's check agrees with the compiler for the establishing ones.
    const c = defaultMoment('chord', 1, 'new1', p, s);
    expect(momentEffectAt(p, s, c)).toEqual({ effect: true });
    expect(sounding(compile({ ...p, moments: [c] }))).toHaveLength(3);
  });
});
