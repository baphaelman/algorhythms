/**
 * `no-effect` (PLAN.md §7.9, revision 6) and the palette helper `momentEffectsAt` (§11.3).
 */
import { describe, expect, it } from 'vitest';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { compile } from '../../../src/core/compiler/compile';
import { DIAGNOSTIC_CODES } from '../../../src/core/compiler/diagnostics';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt, momentEffectsAt } from '../../../src/core/effect';
import type { CompiledScore, Moment, MomentType, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const noEffect = (s: CompiledScore, id: string) =>
  s.diagnostics.filter((d) => d.code === 'no-effect' && d.momentId === id);

/** Compiles `start` + one moment `x` at t = 1; returns its no-effect messages. */
function check(start: number[], m: MomentInput, opts: Parameters<typeof piece>[0] = {}): string[] {
  const p = piece({ start, ...opts, moments: [...(opts.moments ?? []), { ...m, id: 'x' }] });
  return noEffect(compile(p), 'x').map((d) => d.message);
}

const UNI = [57, 57, 57, 57];
const CHORD = [57, 60, 64, 67];

describe('no-effect diagnostic', () => {
  it('is registered as info', () => {
    expect(DIAGNOSTIC_CODES['no-effect'].level).toBe('info');
  });

  it('merge on a unison', () => {
    expect(check(UNI, { type: 'merge', at: 1, count: 1, which: 'top', fade: 1 })).toEqual([
      'No effect: all voices already on one pitch.',
    ]);
    expect(check([57], { type: 'merge', at: 1, count: 1, which: 'top', fade: 1 })).toEqual([
      'No effect: only one voice is sounding.',
    ]);
  });

  it('unison on a unison', () => {
    for (const pitch of [57, 'center', 'tonic'] as const)
      expect(check(UNI, { type: 'unison', at: 1, pitch, octaves: false })).toEqual([
        'No effect: all voices already on one pitch.',
      ]);
  });

  it('split at the pool size', () => {
    expect(check(CHORD, { type: 'split', at: 1, count: 6, voicing: 'even' }, { pool: 4 })).toEqual([
      'No effect: every pool voice is already sounding.',
    ]);
  });

  it('shift by 0', () => {
    for (const unit of ['semitones', 'scaleSteps'] as const)
      expect(check(CHORD, { type: 'shift', at: 1, by: 0, unit })).toEqual([
        'No effect: shift by 0.',
      ]);
  });

  it('chord to the current chord', () => {
    expect(
      check(CHORD, {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: CHORD },
        voicing: 'even',
        assign: 'ordered',
      }),
    ).toEqual(['No effect: the voices already sound this chord.']);
  });

  it('pin, spread, key and level with nothing to do', () => {
    expect(check(CHORD, { type: 'pin', at: 1, voice: 'v2', pitch: 60 })).toEqual([
      'No effect: the voice is already on that pitch.',
    ]);
    expect(check(UNI, { type: 'spread', at: 1, factor: 2, around: 'mean', snap: 'none' })).toEqual([
      'No effect: all voices already on one pitch.',
    ]);
    expect(check(CHORD, { type: 'key', at: 1, key: { tonic: 'A', scale: 'dorian' } })).toEqual([
      'No effect: the piece is already in this key.',
    ]);
    expect(check(CHORD, { type: 'level', at: 1, gain: 1, over: 1 })).toEqual([
      'No effect: the voices are already at this level.',
    ]);
    expect(
      check(
        CHORD,
        { type: 'level', at: 3, gain: 0.5, over: 1 },
        { moments: [{ type: 'level', at: 1, gain: 0.5, over: 1 }] },
      ),
    ).toHaveLength(1);
  });

  it('non-cases', () => {
    const cases: MomentInput[] = [
      { type: 'merge', at: 1, count: 2, which: 'top', fade: 1 },
      { type: 'unison', at: 1, pitch: 'center', octaves: false },
      { type: 'split', at: 1, count: 6, voicing: 'even' },
      { type: 'shift', at: 1, by: 2, unit: 'scaleSteps' },
      { type: 'shift', at: 1, by: 12, unit: 'semitones' },
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'chord', symbol: 'Dm' },
        voicing: 'even',
        assign: 'ordered',
      },
      { type: 'spread', at: 1, factor: 1.5, around: 'mean', snap: 'scale' },
      { type: 'pin', at: 1, voice: 'v2', pitch: 62 },
      { type: 'key', at: 1, key: { tonic: 'D', scale: 'dorian' } },
      { type: 'level', at: 1, gain: 0.5, over: 1 },
      { type: 'walk', at: 1, until: 9, grid: 1, density: 0.5, steps: [-1, 1], stepGlide: 0.3 },
    ];
    for (const m of cases) expect(check(CHORD, m), m.type).toEqual([]);
    // A split from a unison that only doubles the parents' pitch is not heard either.
    expect(
      check([57, 57], {
        type: 'split',
        at: 1,
        count: 4,
        notes: { kind: 'pitches', pitches: [57] },
        voicing: 'even',
      }),
    ).toEqual(['No effect: the new voices only double their parents.']);
  });

  it('a moment that changes pending targets has an effect', () => {
    // The chord's staggered moves have not all started at 1.05; the unison replaces them.
    const s = compile(
      piece({
        start: CHORD,
        glide: { stagger: 2, length: 2 },
        moments: [
          {
            id: 'c',
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'Dm7' },
            voicing: 'even',
            assign: 'ordered',
          },
          { id: 'u', type: 'unison', at: 1.05, pitch: 62, octaves: false },
          { id: 'u2', type: 'unison', at: 1.1, pitch: 62, octaves: false },
        ],
      }),
    );
    expect(noEffect(s, 'u')).toEqual([]);
    expect(noEffect(s, 'u2')).toHaveLength(1);
  });

  it('is not raised next to an error', () => {
    expect(check([57], { type: 'pin', at: 1, voice: 'v5', pitch: 60 })).toEqual([]);
  });

  it('incremental compile reports the same', () => {
    const p = piece({
      start: UNI,
      moments: [
        { id: 'a', type: 'merge', at: 1, count: 2, which: 'top', fade: 1 },
        { id: 'b', type: 'shift', at: 5, by: 0, unit: 'semitones' },
        { id: 'c', type: 'split', at: 9, count: 5, voicing: 'even' },
      ],
    });
    const inc = createIncrementalCompiler();
    inc.compile(p);
    const q = structuredClone(p);
    (q.moments[1] as Extract<Moment, { type: 'shift' }>).by = 3;
    expect(inc.compile(q)).toEqual(compile(q));
    expect(noEffect(compile(q), 'b')).toEqual([]);
    expect(noEffect(compile(p), 'b')).toHaveLength(1);
  });
});

describe('momentEffectsAt (palette)', () => {
  const effects = (p: Piece, t: number) => {
    const s = compile(p);
    return momentEffectsAt(p, s, t, (type, at) => defaultMoment(type, at, 'new1', p, s));
  };
  const off = (r: Record<MomentType, { effect: boolean }>) =>
    (Object.keys(r) as MomentType[]).filter((k) => !r[k].effect).sort();

  it('one voice on the tonic', () => {
    const r = effects(piece({ start: [57], pool: 4 }), 2);
    expect(off(r)).toEqual(['merge', 'spread', 'unison']);
    expect(r.merge.reason).toBe('only one voice is sounding');
    expect(r.unison.reason).toBe('the voice is already on that pitch');
  });

  it('after a unison: merge, unison and spread are greyed', () => {
    const p = piece({
      start: CHORD,
      end: { at: 30, fade: 1 },
      moments: [{ type: 'unison', at: 1, pitch: 60, octaves: false }],
    });
    const r = effects(p, 10);
    expect(off(r)).toEqual(['merge', 'spread', 'unison']);
    expect(r.merge.reason).toBe('all voices already on one pitch');
    // Mid-glide (moves still pending or running), the unison's targets already count.
    expect(off(effects(p, 1.2))).toEqual(['merge', 'spread', 'unison']);
  });

  it('a full pool greys split', () => {
    const r = effects(piece({ start: CHORD, pool: 4 }), 2);
    expect(off(r)).toEqual(['split']);
    expect(r.split.reason).toBe('every pool voice is already sounding');
  });

  it('nothing sounding', () => {
    const p = piece({
      start: [57],
      end: { at: 30, fade: 1 },
      moments: [{ type: 'merge', at: 1, count: 0, which: 'top', fade: 1 }],
    });
    const r = effects(p, 8);
    expect(off(r)).toEqual(
      ['chord', 'level', 'merge', 'pin', 'shift', 'split', 'spread', 'unison', 'walk'].sort(),
    );
    expect(r.chord.reason).toBe('no voice is sounding');
  });

  it('agrees with the compiler at settled times', () => {
    const p = piece({
      start: [50, 57, 62],
      pool: 6,
      end: { at: 40, fade: 1 },
      moments: [
        { type: 'split', at: 1, count: 6, voicing: 'even' },
        { type: 'unison', at: 8, pitch: 'center', octaves: false },
        { type: 'merge', at: 15, count: 2, which: 'outer', fade: 1 },
        { type: 'key', at: 22, key: { tonic: 'D', scale: 'aeolian' } },
        {
          type: 'chord',
          at: 25,
          notes: { kind: 'chord', symbol: 'Dm7' },
          voicing: 'even',
          assign: 'ordered',
        },
      ],
    });
    const s = compile(p);
    for (const t of [0.5, 7, 14, 21, 24, 33]) {
      for (const type of [
        'chord',
        'unison',
        'split',
        'merge',
        'shift',
        'spread',
        'pin',
        'key',
        'level',
      ] as MomentType[]) {
        const m = defaultMoment(type, t, 'probe', p, s);
        const q = structuredClone(p);
        q.moments.push(m);
        const compiled = noEffect(compile(q), 'probe').length === 0;
        expect(momentEffectAt(p, s, m).effect, `${type} at ${t}`).toBe(compiled);
      }
    }
  });
});
