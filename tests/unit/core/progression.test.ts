/**
 * PLAN rev 10 (§6.2 `progression`): a progression compiles exactly as the chord moments it stands
 * for (`progressionChords`), with the key read at each chord's time, counts, one-line parts,
 * parts entering from silence, land, diagnostics named by chord, and incremental = full.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import {
  progressionChordSeed,
  progressionChords,
  progressionEnd,
} from '../../../src/core/moments/progression';
import { momentSeed } from '../../../src/core/rng';
import { parsePiece } from '../../../src/core/schema';
import type {
  CompiledScore,
  Moment,
  Piece,
  ProgressionMoment,
  VoiceSelector,
} from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0.3, stagger: 0.4, ease: 'smootherstep' as const };

type ProgInput = Omit<ProgressionMoment, 'id'> & { id?: string };

const prog = (chords: [string, number][], extra: Partial<ProgInput> = {}): ProgInput => ({
  type: 'progression',
  at: 1,
  chords: chords.map(([notes, len]) => ({ notes, len })),
  voicing: 'even',
  assign: 'ordered',
  ...extra,
});

function band(moments: MomentInput[], start = [48, 60, 64, 67]): Piece {
  const p = piece({
    pool: 8,
    start,
    glide: GLIDE,
    end: { at: 30, fade: 1 },
    key: { tonic: 'C', scale: 'major' },
    moments,
  });
  p.voices.forEach(
    (v, i) => (v.part = i === 0 || i === 7 ? 'Bass' : i === 6 ? 'Melody' : 'Chords'),
  );
  return p;
}

/** `p` with its progression `id` replaced by hand-written chord moments (ids `${id}c${k}`). */
function handWritten(p: Piece, id: string): Piece {
  const moments: Moment[] = [];
  for (const m of p.moments) {
    if (m.id !== id || m.type !== 'progression') moments.push(m);
    else progressionChords(m, p.seed).forEach((c, k) => moments.push({ ...c, id: `${id}c${k}` }));
  }
  return { ...p, moments };
}

/** The score's voices with segment moment ids dropped (they name different moments). */
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
  expect(a.harmony?.map((h) => [h.t, h.label])).toEqual(b.harmony?.map((h) => [h.t, h.label]));
  expect(a.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  return a;
}

const PARTS: [string, VoiceSelector | undefined][] = [
  ['all', undefined],
  ['a part', { part: 'Chords' }],
  ['a one-line part (root in the bass)', { part: 'Bass' }],
];

describe('progression ≡ chord moments', () => {
  for (const [name, target] of PARTS) {
    it(`on ${name}`, () => {
      const p = band([
        prog(
          [
            ['IV', 2],
            ['V7', 2],
            ['iii', 1.5],
            ['vi', 2],
          ],
          target ? { target } : {},
        ),
        { type: 'shift', at: 9, by: 1, unit: 'scaleSteps' },
      ]);
      expectEquivalent(p, 'm0');
    });
  }

  it('with register, close voicing, free assign and a count', () => {
    const p = band([
      prog(
        [
          ['Dm9', 2],
          ['G13', 2],
          ['Cmaj7', 3],
        ],
        { register: [50, 80], voicing: 'close', assign: 'free', count: 6 },
      ),
    ]);
    const s = expectEquivalent(p, 'm0');
    expect(chordAt(s, 8)).toHaveLength(6);
  });

  it('a count that shrinks, then a later chord at the same count', () => {
    const p = band(
      [
        prog(
          [
            ['C', 2],
            ['F', 2],
          ],
          { count: 2 },
        ),
      ],
      [48, 55, 60, 64, 67],
    );
    const s = expectEquivalent(p, 'm0');
    expect(chordAt(s, 4.5)).toHaveLength(2);
    expect(chordAt(s, 8)).toHaveLength(2);
  });

  it('with land at every chord', () => {
    const p = band([
      prog(
        [
          ['ii7', 2],
          ['V7', 2],
          ['I', 2],
        ],
        { glide: { land: true } },
      ),
    ]);
    const s = expectEquivalent(p, 'm0');
    // Each chord arrives on its own start.
    expect(
      chordAt(s, 3)
        .map((x) => x % 12)
        .sort((a, b) => a - b),
    ).toEqual([2, 5, 7, 11]);
  });

  it('a part entering from silence', () => {
    const p = band([
      prog(
        [
          ['I', 2],
          ['IV', 2],
        ],
        { target: { part: 'Melody' }, at: 2 },
      ),
    ]);
    const s = expectEquivalent(p, 'm0');
    expect(s.voices[6].lives.length).toBe(1);
  });

  it('from silence (the first chord establishes)', () => {
    const p = band([], []);
    p.moments = [
      {
        ...prog(
          [
            ['Am', 2],
            ['F', 2],
            ['C', 2],
          ],
          { at: 0 },
        ),
        id: 'p',
      } as Moment,
    ];
    const s = expectEquivalent(p, 'p');
    expect(chordAt(s, 1).length).toBeGreaterThan(0);
  });

  it('seeds: chord k is progressionChordSeed(seed, k)', () => {
    const p = band([
      prog([
        ['I', 1],
        ['V', 1],
      ]),
    ]);
    const m = p.moments.find((x) => x.type === 'progression')!;
    const seed = momentSeed(p.seed, m.id, m.seed);
    expect(progressionChords(m as ProgressionMoment, p.seed).map((c) => c.seed)).toEqual([
      progressionChordSeed(seed, 0),
      progressionChordSeed(seed, 1),
    ]);
  });
});

describe('progression timing and key', () => {
  it('numerals read the key at each chord’s own time', () => {
    const p = band([
      prog([
        ['I', 2],
        ['I', 2],
        ['I', 2],
      ]),
      { type: 'key', at: 2.5, key: { tonic: 'D', scale: 'major' } },
      { type: 'key', at: 4.5, key: { tonic: 'F', scale: 'major' } },
    ]);
    const s = expectEquivalent(p, 'm0');
    const hs = s.harmony!.filter((h) => h.momentId === 'm0');
    // Each chord's notes lie on the tonic triad of the key at its time.
    const triads = [
      [0, 4, 7],
      [2, 6, 9],
      [5, 9, 0],
    ];
    hs.forEach((h, k) => {
      expect(h.pcs.every((pc) => triads[k].includes(pc))).toBe(true);
      expect(h.bass === triads[k][0] || h.pcs.includes(triads[k][0])).toBe(true);
    });
    expect(s.harmony?.filter((h) => h.momentId === 'm0').map((h) => h.t)).toEqual([1, 3, 5]);
  });

  it('one span from the first move to the end; the piece lasts past the last chord', () => {
    const p = band([
      prog([
        ['I', 2],
        ['IV', 9],
      ]),
    ]);
    p.end = { fade: 1 };
    const s = compile(p);
    const spans = s.momentSpans.filter((x) => x.id === 'm0');
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBeCloseTo(1, 2);
    expect(spans[0].end).toBe(
      progressionEnd({
        at: 1,
        chords: [
          { notes: 'I', len: 2 },
          { notes: 'IV', len: 9 },
        ],
      }),
    );
    expect(s.duration).toBeGreaterThanOrEqual(12);
  });

  it('a muted progression does nothing', () => {
    const base = compile(band([]));
    const s = compile(band([prog([['IV', 2]], { muted: true })]));
    expect(sound(s)).toEqual(sound(base));
  });
});

describe('progression diagnostics', () => {
  it('a bad symbol names its chord by position', () => {
    const s = compile(
      band([
        prog([
          ['IV', 2],
          ['Xq', 2],
          ['V', 2],
        ]),
      ]),
    );
    const d = s.diagnostics.filter((x) => x.momentId === 'm0' && x.level === 'error');
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe('chord-parse');
    expect(d[0].message).toMatch(/^Chord 2 \(Xq\): /);
    // The other chords still play.
    expect(s.harmony?.filter((h) => h.momentId === 'm0')).toHaveLength(2);
  });

  it('no duplicate-id warning for its own chords', () => {
    const s = compile(
      band([
        prog([
          ['IV', 2],
          ['V', 2],
        ]),
      ]),
    );
    expect(s.diagnostics.some((d) => d.code === 'duplicate-moment-id')).toBe(false);
  });

  it('invalid lengths: progression-invalid', () => {
    const p = band([prog([['IV', 2]])]);
    (p.moments[1] as ProgressionMoment).chords[0].len = 0;
    const s = compile(p);
    expect(s.diagnostics.find((d) => d.momentId === 'm0')?.code).toBe('progression-invalid');
  });

  it('no-effect only when every chord has none', () => {
    // C E G sounding: "I, IV" holds then moves; "I, I" never moves.
    const near = { voicing: 'nearest' as const };
    const moving = compile(
      band(
        [
          prog(
            [
              ['I', 2],
              ['IV', 2],
            ],
            near,
          ),
        ],
        [60, 64, 67],
      ),
    );
    expect(moving.diagnostics.some((d) => d.code === 'no-effect' && d.momentId === 'm0')).toBe(
      false,
    );
    const still = compile(
      band(
        [
          prog(
            [
              ['I', 2],
              ['I', 2],
            ],
            near,
          ),
        ],
        [60, 64, 67],
      ),
    );
    const ne = still.diagnostics.filter((d) => d.code === 'no-effect' && d.momentId === 'm0');
    expect(ne).toHaveLength(1);
    expect(ne[0].message).toMatch(/^Chord 1 \(I\): No effect/);
    const empty = compile(band([prog([])]));
    expect(empty.diagnostics.find((d) => d.momentId === 'm0')?.code).toBe('no-effect');
  });

  it('the palette effect check', () => {
    const p = band([], [60, 64, 67]);
    const s = compile(p);
    const near = { voicing: 'nearest' as const };
    const m = {
      ...prog(
        [
          ['I', 2],
          ['IV', 2],
        ],
        near,
      ),
      id: 'x',
    } as Moment;
    expect(momentEffectAt(p, s, m).effect).toBe(true);
    const same = { ...prog([['I', 2]], near), id: 'x' } as Moment;
    expect(momentEffectAt(p, s, same).effect).toBe(false);
  });
});

describe('progression schema and incremental', () => {
  it('parses with defaults and checks the count', () => {
    const p = band([
      { type: 'progression', at: 1, chords: [{ notes: 'IV', len: 2 }] } as MomentInput,
    ]);
    const r = parsePiece(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = r.piece.moments[1] as ProgressionMoment;
      expect(m.voicing).toBe('even');
      expect(m.assign).toBe('ordered');
    }
    const big = band([prog([['IV', 2]], { count: 99 })]);
    expect(parsePiece(JSON.parse(JSON.stringify(big))).ok).toBe(false);
  });

  it('incremental = full across edits of a progression', () => {
    const inc = createIncrementalCompiler();
    const steps: Piece[] = [];
    const base = band([
      { type: 'shift', at: 0.5, by: 2, unit: 'semitones' },
      prog(
        [
          ['IV', 2],
          ['V', 2],
          ['iii', 2],
          ['vi', 2],
        ],
        { at: 2 },
      ),
      { type: 'key', at: 5, key: { tonic: 'A', scale: 'minor' } },
      {
        type: 'chord',
        at: 12,
        notes: { kind: 'chord', symbol: 'i' },
        voicing: 'even',
        assign: 'ordered',
      },
    ]);
    steps.push(base);
    const edit = (f: (m: ProgressionMoment) => void): void => {
      const p = structuredClone(steps[steps.length - 1]);
      f(p.moments.find((m) => m.type === 'progression') as ProgressionMoment);
      steps.push(p);
    };
    edit((m) => (m.chords[2].notes = 'ii'));
    edit((m) => (m.chords[3].len = 3));
    edit((m) => m.chords.push({ notes: 'I', len: 1 }));
    edit((m) => (m.count = 5));
    edit((m) => m.chords.splice(1, 1));
    edit((m) => (m.at = 3));
    edit((m) => (m.muted = true));
    for (const p of steps) {
      const a = inc.compile(p);
      expect(a).toEqual(compile(p));
    }
  });
});

describe('walk over chord follows progression chords', () => {
  it('each step lands on a tone of the progression chord in effect', () => {
    const walk: MomentInput = {
      type: 'walk',
      at: 0.5,
      until: 12,
      grid: 0.5,
      density: 0.8,
      steps: [-2, -1, 1, 2],
      stepGlide: 0.2,
      over: 'chord',
      target: { part: 'Melody' },
    } as MomentInput;
    const p = band(
      [
        prog(
          [
            ['I', 3],
            ['IV', 3],
            ['V7', 3],
          ],
          { target: { part: 'Chords' } },
        ),
        walk,
      ],
      [48, 60, 64, 67, 76],
    );
    // v5 (on 76) carries the walk.
    p.voices[4].part = 'Melody';
    const s = compile(p);
    const id = p.moments.find((m) => m.type === 'walk')!.id;
    const steps = s.walkSteps.filter((w) => w.momentId === id && w.from !== w.to);
    expect(steps.length).toBeGreaterThan(3);
    const tones = (t: number): number[] => (t < 4 ? [0, 4, 7] : t < 7 ? [5, 9, 0] : [7, 11, 2, 5]);
    for (const st of steps) expect(tones(st.t)).toContain(((Math.round(st.to) % 12) + 12) % 12);
    // The same as with the chords written out.
    expect(s.walkSteps).toEqual(compile(handWritten(p, 'm0')).walkSteps);
  });
});
