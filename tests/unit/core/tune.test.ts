/**
 * R9-4 (PLAN §6.2 `tune`, revision 9): a melody on one line. Note timing and holding, the
 * portamento (default 0.1 s, capped at the note), land, targeting, crossing, merges within the
 * line's part, range folds, empty and invalid tunes, no-effect, the palette check, incremental =
 * full, transposition and the schema.
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { pieceDecisionTime } from '../../../src/core/compiler/glide';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { linesAt, pitchAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import { hasFixedNotes, remapMoment } from '../../../src/core/transpose';
import type {
  CompiledScore,
  Moment,
  Piece,
  Segment,
  TuneMoment,
  TuneNote,
} from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const START = [48, 55, 60];
const NOTES: TuneNote[] = [
  { pitch: 50, len: 1 },
  { pitch: 64, len: 0.5 },
  { pitch: 62, len: 1 },
];

function tune(fields: Partial<Omit<TuneMoment, 'id' | 'type'>> = {}): MomentInput {
  return { type: 'tune', at: 2, notes: structuredClone(NOTES), ...fields } as MomentInput;
}

function make(moments: MomentInput[], start: number[] = START, pool = 6): Piece {
  return piece({ pool, start, glide: GLIDE, end: { at: 12, fade: 1 }, moments });
}

/** v1–v3 "Chords", v4–v6 "Melody"; the opening sounds v1–v4. */
function parted(moments: MomentInput[], start = [48, 55, 60, 72]): Piece {
  const p = make(moments, start, 6);
  p.voices.forEach((v, i) => (v.part = i < 3 ? 'Chords' : 'Melody'));
  return p;
}

/** A voice's moves (segments that change pitch) of moment `id`. */
const moves = (s: CompiledScore, v: number, id = 'm0'): Segment[] =>
  s.voices[v].segments.filter((g) => g.momentId === id && g.p0 !== g.p1);

const codes = (s: CompiledScore, id = 'm0'): string[] =>
  s.diagnostics.filter((d) => d.momentId === id).map((d) => d.code);

describe('tune: notes in turn', () => {
  const s = compile(make([tune()]));

  it('moves the first line in pitch order to each note at its start, 0.1 s glides', () => {
    const mv = moves(s, 0);
    expect(mv.map((g) => [g.t0, g.p1])).toEqual([
      [2, 50],
      [3, 64],
      [3.5, 62],
    ]);
    for (const g of mv) expect(g.t1 - g.t0).toBeCloseTo(0.1, 12);
    expect(moves(s, 1)).toEqual([]);
    expect(moves(s, 2)).toEqual([]);
  });

  it('holds each note for its length', () => {
    expect(pitchAt(s.voices[0], 2.1)).toBe(50);
    expect(pitchAt(s.voices[0], 2.99)).toBe(50);
    expect(pitchAt(s.voices[0], 3.45)).toBe(64);
    expect(pitchAt(s.voices[0], 4.4)).toBe(62);
    // The last note holds on (like a pin).
    expect(pitchAt(s.voices[0], 11)).toBe(62);
  });

  it('crosses other lines without merging or reordering them', () => {
    expect(chordAt(s, 3.3)).toEqual([55, 60, 64]);
    expect(linesAt(s, 3.3)).toBe(3);
    // The next note stays on the same line, although it is no longer the lowest.
    expect(pitchAt(s.voices[0], 4)).toBe(62);
    expect(pitchAt(s.voices[1], 4)).toBe(55);
  });

  it('spans the whole tune and counts as activity', () => {
    expect(s.momentSpans.find((x) => x.id === 'm0')).toEqual({ id: 'm0', start: 2, end: 4.5 });
    const open = make([tune()]);
    open.end = { fade: 0 };
    expect(compile(open).duration).toBeCloseTo(4.5 + 4, 9);
    expect(codes(s)).toEqual([]);
  });

  it('traces each note as an unordered pin-like move', () => {
    const { trace } = compileWithTrace(make([tune()]));
    const ts = trace.moments.filter((m) => m.id === 'm0');
    expect(ts.map((m) => m.t)).toEqual([2, 3, 3.5]);
    for (const m of ts) {
      expect(m.type).toBe('tune');
      expect(m.targeted).toEqual([0]);
      expect(m.plan?.ordered).toBe(false);
    }
  });

  it('does not change the HUD harmony', () => {
    const base = compile(make([]));
    expect(s.harmony).toEqual(base.harmony);
  });
});

describe('tune: glide', () => {
  it("uses the moment's glide length, capped at the note's length", () => {
    const s = compile(
      make([
        tune({
          glide: { length: 0.3 },
          notes: [
            { pitch: 50, len: 1 },
            { pitch: 52, len: 0.2 },
            { pitch: 53, len: 1 },
          ],
        }),
      ]),
    );
    expect(moves(s, 0).map((g) => +(g.t1 - g.t0).toFixed(9))).toEqual([0.3, 0.2, 0.3]);
  });

  it("ignores the piece's stagger and jitter (one line), unless the moment sets them", () => {
    const p = piece({
      pool: 6,
      start: START,
      glide: { length: 2, jitter: 0.5, stagger: 1 },
      end: { at: 12, fade: 0 },
      moments: [tune()],
    });
    const s = compile(p);
    for (const g of moves(s, 0)) expect(g.t1 - g.t0).toBeCloseTo(0.1, 12);
    expect(moves(s, 0)[0].t0).toBe(2);
  });

  it('with land, each note arrives on its start; a glide starts no earlier than the note before', () => {
    const s = compile(
      make([
        tune({
          glide: { land: true },
          notes: [
            { pitch: 50, len: 1 },
            { pitch: 64, len: 0.05 },
            { pitch: 62, len: 1 },
          ],
        }),
      ]),
    );
    const mv = moves(s, 0);
    expect(mv.map((g) => +g.t1.toFixed(9))).toEqual([2, 3, 3.05]);
    expect(mv.map((g) => +g.t0.toFixed(9))).toEqual([1.9, 2.9, 3]);
    expect(pitchAt(s.voices[0], 2)).toBe(50);
    expect(pitchAt(s.voices[0], 3)).toBe(64);
    // It decides at its lead-in start.
    const p = make([tune({ glide: { land: true } })]);
    expect(pieceDecisionTime(p, p.moments[1])).toBeCloseTo(1.9, 12);
    expect(s.momentSpans.find((x) => x.id === 'm0')!.start).toBeCloseTo(1.9, 12);
  });

  it('a land tune at 0 with nothing sounding before it waits for its marker', () => {
    const p = make([tune({ at: 0, glide: { land: true } })]);
    const s = compile(p);
    expect(moves(s, 0)[0].t0).toBe(0);
  });
});

describe('tune: targeting', () => {
  it('a { part } target plays on that part', () => {
    const s = compile(parted([tune({ target: { part: 'Melody' } })]));
    expect(moves(s, 3).map((g) => g.p1)).toEqual([50, 64, 62]);
    for (const v of [0, 1, 2]) expect(moves(s, v)).toEqual([]);
  });

  it('a voices target plays on the lowest of them', () => {
    const s = compile(make([tune({ target: { voices: ['v3', 'v2'] } })]));
    expect(moves(s, 1).map((g) => g.p1)).toEqual([50, 64, 62]);
  });

  it('a later moment can move the line; the next note brings it back', () => {
    const s = compile(
      make([tune(), { type: 'shift', at: 3.2, by: -1, unit: 'semitones', glide: { length: 0.1 } }]),
    );
    expect(pitchAt(s.voices[0], 3.45)).toBeCloseTo(63, 9);
    expect(pitchAt(s.voices[0], 4.4)).toBe(62);
  });

  it('targets nothing: no-effect', () => {
    const s = compile(make([tune({ target: { voices: ['v6'] } })]));
    expect(codes(s)).toContain('no-effect');
    expect(s.diagnostics.find((d) => d.code === 'no-effect')!.message).toMatch(
      /targets no sounding note/,
    );
  });

  it('from silence: no-effect', () => {
    const p = make([tune({ at: 2 })]);
    p.moments = p.moments.filter((m) => m.type === 'tune');
    const s = compile(p);
    expect(codes(s)).toContain('no-effect');
    expect(s.voices.every((v) => v.lives.length === 0)).toBe(true);
  });
});

describe('tune: with walks and pulses', () => {
  it('a walk never steps the tune line while the tune plays, and does after', () => {
    const walk: MomentInput = {
      type: 'walk',
      at: 1,
      until: 9,
      grid: 0.25,
      density: 1,
      steps: [-1, 1],
      stepGlide: 0.1,
    };
    const high: TuneNote[] = [
      { pitch: 80, len: 1 },
      { pitch: 84, len: 0.5 },
      { pitch: 82, len: 1 },
    ];
    const s = compile(make([tune({ notes: high }), walk]));
    const stepsOf = (v: string) => s.walkSteps.filter((w) => w.voice === v).map((w) => w.t);
    expect(stepsOf('v1').some((t) => t < 2)).toBe(true);
    expect(stepsOf('v1').some((t) => t >= 2 && t < 4.5)).toBe(false);
    expect(stepsOf('v1').some((t) => t >= 4.5)).toBe(true);
    expect(pitchAt(s.voices[0], 4.4)).toBe(82);
    // The other lines go on walking.
    expect(stepsOf('v2').some((t) => t >= 2 && t < 4.5)).toBe(true);
  });

  it('a line that merges into the tune line is left alone by walks too', () => {
    const walk: MomentInput = {
      type: 'walk',
      at: 1,
      until: 9,
      grid: 0.25,
      density: 1,
      steps: [-1, 1],
      stepGlide: 0.1,
    };
    const s = compile(make([tune(), walk]));
    // The tune lands on a walking line's 62 at 3.5 and merges into it; it holds 62 to the end.
    const holder = s.voices.findIndex((v) => pitchAt(v, 4.4) === 62);
    expect(holder).toBeGreaterThanOrEqual(0);
    expect(
      s.walkSteps.filter((w) => w.voice === s.voices[holder].id && w.t > 3.5 && w.t < 4.5),
    ).toEqual([]);
  });

  it('a pulse on the line hits it while the tune moves it', () => {
    const pulse: MomentInput = {
      type: 'pulse',
      at: 2,
      until: 4,
      step: 0.5,
      pattern: [1],
      decay: 0.2,
      floor: 0,
      mode: 'together',
      target: { voices: ['v1'] },
    };
    const s = compile(make([tune(), pulse]));
    expect((s.voices[0].pulse ?? []).filter((r) => r.hit).map((r) => r.t)).toEqual([
      2, 2.5, 3, 3.5,
    ]);
    expect(moves(s, 0).map((g) => g.p1)).toEqual([50, 64, 62]);
  });
});

describe('tune: distinct notes', () => {
  const onto: TuneNote[] = [
    { pitch: 60, len: 1 },
    { pitch: 66, len: 1 },
  ];

  it("landing on another part's resting pitch does not merge", () => {
    const s = compile(parted([tune({ target: { part: 'Melody' }, notes: onto })]));
    expect(linesAt(s, 2.5)).toBe(4);
    expect(chordAt(s, 2.5)).toEqual([48, 55, 60, 60]);
    expect(pitchAt(s.voices[3], 3.5)).toBe(66);
    expect(pitchAt(s.voices[2], 3.5)).toBe(60);
  });

  it('without parts it merges, and the tune goes on on the merged line', () => {
    const s = compile(make([tune({ target: { voices: ['v1'] }, notes: onto })]));
    expect(linesAt(s, 2.5)).toBe(2);
    // The line that was there first survives and carries the rest of the tune.
    expect(pitchAt(s.voices[2], 3.5)).toBe(66);
    expect(chordAt(s, 3.5)).toEqual([55, 66]);
  });

  it('merges with a line of its own part', () => {
    const p = parted([tune({ target: { voices: ['v4'] }, notes: onto })]);
    p.voices[2].part = 'Melody'; // v3 (60) and v4 (72) are Melody
    const s = compile(p);
    expect(linesAt(s, 2.5)).toBe(3);
    // v3 was there first: it survives and plays the rest of the tune.
    expect(pitchAt(s.voices[2], 3.5)).toBe(66);
    expect(chordAt(s, 3.5)).toEqual([48, 55, 66]);
  });
});

describe('tune: pitches and problems', () => {
  it('folds a note outside the range by octave (range-fold)', () => {
    const p = make([
      tune({
        notes: [
          { pitch: 110, len: 1 },
          { pitch: 20, len: 1 },
        ],
      }),
    ]);
    const s = compile(p);
    expect(pitchAt(s.voices[0], 2.5)).toBe(86);
    expect(pitchAt(s.voices[0], 3.5)).toBe(44);
    expect(codes(s)).toContain('range-fold');
  });

  it('an empty tune has no effect', () => {
    const s = compile(make([tune({ notes: [] })]));
    const d = s.diagnostics.find((x) => x.momentId === 'm0');
    expect(d?.code).toBe('no-effect');
    expect(d?.message).toMatch(/no notes/);
    expect(s.momentSpans.find((x) => x.id === 'm0')).toEqual({ id: 'm0', start: 2, end: 2 });
  });

  it('a tune whose notes are all where the line is has no effect', () => {
    const s = compile(
      make([
        tune({
          notes: [
            { pitch: 48, len: 1 },
            { pitch: 48, len: 1 },
          ],
        }),
      ]),
    );
    expect(codes(s)).toEqual(['no-effect']);
    // One moving note is enough.
    const t = compile(
      make([
        tune({
          notes: [
            { pitch: 48, len: 1 },
            { pitch: 50, len: 1 },
          ],
        }),
      ]),
    );
    expect(codes(t)).toEqual([]);
  });

  it('bad notes: tune-invalid (error), the moment is skipped', () => {
    for (const notes of [
      [{ pitch: Number.NaN, len: 1 }],
      [{ pitch: 60, len: 0 }],
      [{ pitch: 60, len: -1 }],
      'x' as unknown as TuneNote[],
    ]) {
      const s = compile(make([tune({ notes })]));
      expect(codes(s)).toEqual(['tune-invalid']);
      expect(moves(s, 0)).toEqual([]);
    }
  });
});

describe('tune: the palette check', () => {
  const p = make([]);
  const s = compile(p);
  const at = (m: MomentInput) => momentEffectAt(p, s, { ...m, id: 'x' } as Moment);

  it('agrees with the compiler', () => {
    expect(at(tune()).effect).toBe(true);
    expect(at(tune({ notes: [] }))).toEqual({ effect: false, reason: 'the tune has no notes' });
    expect(at(tune({ notes: [{ pitch: 48, len: 1 }] })).effect).toBe(false);
    expect(at(tune({ target: { voices: ['v6'] } })).effect).toBe(false);
    for (const m of [tune(), tune({ notes: [] }), tune({ notes: [{ pitch: 48, len: 1 }] })]) {
      const q = make([m]);
      const c = compile(q);
      expect(c.diagnostics.some((d) => d.code === 'no-effect')).toBe(
        !momentEffectAt(make([]), compile(make([])), q.moments[1]).effect,
      );
    }
  });
});

describe('tune: incremental compile', () => {
  it('equals the full compile across edits', () => {
    const p = make([
      tune(),
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: [47, 55, 59] },
        voicing: 'even',
        assign: 'ordered',
      },
      { type: 'shift', at: 3.2, by: 2, unit: 'semitones', target: { voices: ['v2'] } },
      tune({ at: 6, glide: { land: true }, target: { voices: ['v3'] } }),
      {
        type: 'chord',
        at: 8,
        notes: { kind: 'pitches', pitches: [45, 52, 57] },
        voicing: 'even',
        assign: 'ordered',
      },
    ]);
    const inc = createIncrementalCompiler();
    const check = (q: Piece): void => expect(inc.compile(q)).toEqual(compile(q));
    check(p);
    const edits: ((q: Piece) => void)[] = [
      (q) => ((q.moments[1] as TuneMoment).notes[1].pitch = 66),
      (q) => ((q.moments[4] as TuneMoment).notes[0].len = 0.25),
      (q) => (q.moments[5].at = 7.5),
      (q) => (q.moments[3].at = 2.5),
      (q) => (q.moments[1] as TuneMoment).notes.push({ pitch: 70, len: 2 }),
      (q) => (q.moments[4].glide = { land: false }),
    ];
    let q = p;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      check(q);
      // The same piece again resumes from the last checkpoint.
      check(q);
      expect(inc.stats.mode).toBe('resume');
    }
  });
});

describe('tune: transposition and schema', () => {
  it('its notes are fixed notes that move with a key change', () => {
    const m = make([tune()]).moments[1];
    expect(hasFixedNotes(m)).toBe(true);
    expect(hasFixedNotes({ ...m, notes: [] } as Moment)).toBe(false);
    const p = make([tune()]);
    const r = remapMoment(p, m, { tonic: 'C', scale: 'major' }, { tonic: 'D', scale: 'major' });
    expect((r.moment as TuneMoment).notes.map((n) => n.pitch)).toEqual([52, 66, 64]);
  });

  it('parses with defaults and round-trips', () => {
    const p = make([tune()]);
    const r = parsePiece(JSON.stringify(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.piece.moments[1]).toEqual(p.moments[1]);
    const bare = parsePiece(
      JSON.stringify({ ...p, moments: [{ id: 't', type: 'tune', at: 1, extra: 1 }] }),
    );
    expect(bare.ok && bare.piece.moments[0]).toEqual({
      id: 't',
      type: 'tune',
      at: 1,
      extra: 1,
      notes: [],
    });
    const bad = parsePiece(
      JSON.stringify({
        ...p,
        moments: [{ id: 't', type: 'tune', at: 1, notes: [{ pitch: 60, len: 0 }] }],
      }),
    );
    expect(bad.ok).toBe(false);
  });
});
