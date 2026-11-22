/**
 * PLAN rev 10 (§6.2 `tune`): rests, re-struck repeated notes (`strike`) and `writtenIn`. Rests
 * cut the line's lives (fade out at the rest, the next note comes in on its pitch and strikes),
 * keep the voice, never merge, and a trailing rest leaves the line silent until a later moment
 * brings it back.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { REST_ATTACK, REST_FADE } from '../../../src/core/compiler/rests';
import { momentEffectAt } from '../../../src/core/effect';
import { tuneShift } from '../../../src/core/moments/tune';
import { pitchAt } from '../../../src/core/query';
import { parsePiece, stripDefaults } from '../../../src/core/schema';
import { hasFixedNotes } from '../../../src/core/transpose';
import type {
  CompiledScore,
  CompiledVoice,
  Moment,
  Piece,
  TuneMoment,
  TuneNote,
} from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };

function tune(notes: TuneNote[], fields: Partial<Omit<TuneMoment, 'id' | 'type'>> = {}) {
  return { type: 'tune', at: 2, notes, ...fields } as MomentInput;
}

function make(moments: MomentInput[], start = [48, 55, 60], pool = 6): Piece {
  const key = { tonic: 'C', scale: 'major' } as const;
  return piece({ pool, start, glide: GLIDE, end: { at: 12, fade: 1 }, moments, key });
}

/** Lives as [born, died] pairs. */
const spans = (v: CompiledVoice): [number, number | undefined][] =>
  v.lives.map((l) => [l.born, l.died]);

/** Every segment lies inside a life, and each life starts with a segment at its birth. */
function wellFormed(s: CompiledScore): void {
  for (const v of s.voices) {
    for (const g of v.segments) {
      const inside = v.lives.some((l) => g.t0 >= l.born && g.t1 <= (l.died ?? Infinity) + 1e-12);
      expect(inside).toBe(true);
    }
    for (const l of v.lives) expect(v.segments.some((g) => g.t0 === l.born)).toBe(true);
  }
}

const keyAt = (at: number, tonic: string) =>
  ({ type: 'key', at, key: { tonic, scale: 'major' } }) as MomentInput;

describe('tune rests: a rest in the middle', () => {
  const notes: TuneNote[] = [
    { pitch: 50, len: 1 },
    { rest: true, len: 1 },
    { pitch: 53, len: 1 },
  ];
  const s = compile(make([tune(notes)]));
  const v = s.voices[0];

  it('fades out at the rest start and comes back on the next note, same voice', () => {
    expect(spans(v)).toEqual([
      [0, 3 + REST_FADE],
      [4, 12],
    ]);
    expect(v.lives[0].fadeOut).toBeCloseTo(REST_FADE, 12);
    expect(v.lives[1].fadeIn).toBe(REST_ATTACK);
    wellFormed(s);
  });

  it('comes in on its own pitch, without a glide from the old one', () => {
    const first = v.segments.find((g) => g.t0 === 4)!;
    expect(first.p0).toBe(53);
    expect(first.p1).toBe(53);
    expect(pitchAt(v, 3.5)).toBeNull();
    expect(pitchAt(v, 4)).toBe(53);
    expect(pitchAt(v, 2.5)).toBe(50);
  });

  it('leaves the other lines alone', () => {
    expect(spans(s.voices[1])).toEqual([[0, 12]]);
    expect(spans(s.voices[2])).toEqual([[0, 12]]);
  });

  it('a short rest fades over half its length', () => {
    const r = compile(
      make([
        tune([
          { pitch: 50, len: 1 },
          { rest: true, len: 0.01 },
          { pitch: 53, len: 1 },
        ]),
      ]),
    );
    expect(spans(r.voices[0])[0][1]).toBeCloseTo(3.005, 12);
    expect(r.voices[0].lives[1].born).toBeCloseTo(3.01, 12);
  });

  it('never merges: another line arriving on the resting pitch stays apart', () => {
    // v2 (55) pinned onto v1's resting 50 during the rest.
    const r = compile(
      make([
        tune(notes),
        { type: 'pin', at: 3.2, voice: 'v2', pitch: 50, glide: { length: 0.2 } } as MomentInput,
      ]),
    );
    expect(spans(r.voices[0])).toEqual([
      [0, 3 + REST_FADE],
      [4, 12],
    ]);
    expect(spans(r.voices[1])).toEqual([[0, 12]]);
    expect(pitchAt(r.voices[1], 5)).toBe(50);
    expect(pitchAt(r.voices[0], 5)).toBe(53);
  });
});

describe('tune rests: leading and trailing', () => {
  it('a leading rest silences a sounding line; the first note brings it back', () => {
    const s = compile(
      make([
        tune([
          { rest: true, len: 1 },
          { pitch: 50, len: 1 },
        ]),
      ]),
    );
    expect(spans(s.voices[0])).toEqual([
      [0, 2 + REST_FADE],
      [3, 12],
    ]);
    expect(pitchAt(s.voices[0], 3)).toBe(50);
    wellFormed(s);
  });

  it('a trailing rest leaves the line silent until a later moment brings it back', () => {
    const t = tune([
      { pitch: 50, len: 1 },
      { rest: true, len: 1 },
    ]);
    const silent = compile(make([t]));
    expect(spans(silent.voices[0])).toEqual([[0, 3 + REST_FADE]]);
    // Still the tune's line: nothing else took its voice.
    expect(spans(silent.voices[3])).toEqual([]);
    const chord = { type: 'chord', at: 6, notes: { kind: 'pitches', pitches: [45, 55, 60] } };
    const back = compile(make([t, chord as MomentInput]));
    const v = back.voices[0];
    expect(spans(v)).toEqual([
      [0, 3 + REST_FADE],
      [6, 12],
    ]);
    expect(v.lives[1].fadeIn).toBeGreaterThanOrEqual(0.5);
    expect(pitchAt(v, 6)).toBe(45);
    wellFormed(back);
  });

  it('a leading rest on a silent part: the part comes in on the first note', () => {
    const p = make([]);
    p.voices.forEach((v, i) => (v.part = i < 3 ? 'Chords' : 'Melody'));
    p.moments.push({
      id: 'm0',
      type: 'tune',
      at: 2,
      target: { part: 'Melody' },
      notes: [
        { rest: true, len: 1 },
        { pitch: 72, len: 1 },
      ],
    } as Moment);
    const s = compile(p);
    expect(s.voices[3].lives.map((l) => l.born)).toEqual([3]);
    expect(pitchAt(s.voices[3], 3.5)).toBe(72);
  });

  it('a tune of rests only silences its line (an effect)', () => {
    const s = compile(make([tune([{ rest: true, len: 1 }])]));
    expect(spans(s.voices[0])).toEqual([[0, 2 + REST_FADE]]);
    expect(s.diagnostics.filter((d) => d.momentId === 'm0').map((d) => d.code)).toEqual([]);
  });
});

describe('tune: re-struck repeated notes', () => {
  const rep: TuneNote[] = [
    { pitch: 50, len: 1 },
    { pitch: 50, len: 1 },
    { pitch: 52, len: 1 },
  ];
  const strikes = (s: CompiledScore, v = 0) => (s.voices[v].pulse ?? []).filter((r) => r.restrike);

  it('a repeat strikes at its start, level unchanged', () => {
    expect(strikes(compile(make([tune(rep)])))).toEqual([
      { t: 3, accent: 1, decay: 0, floor: 1, strike: true, hit: true, restrike: true },
    ]);
  });

  it('strike: false holds it; with a rest between it comes in instead', () => {
    expect(strikes(compile(make([tune(rep, { strike: false })])))).toEqual([]);
    const withRest = compile(
      make([
        tune([
          { pitch: 50, len: 1 },
          { rest: true, len: 0.5 },
          { pitch: 50, len: 1 },
        ]),
      ]),
    );
    expect(strikes(withRest)).toEqual([]);
    expect(withRest.voices[0].lives.map((l) => l.born)).toEqual([0, 3.5]);
  });

  it('under land the repeat decides at its start', () => {
    const s = compile(make([tune(rep, { glide: { land: true, length: 0.5 } })]));
    expect(strikes(s).map((x) => x.t)).toEqual([3]);
  });

  it('not while a pulse drives the line (its hits strike)', () => {
    const pulse = { type: 'pulse', at: 0, until: 10, step: 0.5, pattern: [1], decay: 0.3 };
    const s = compile(make([{ ...pulse, floor: 0, mode: 'together' } as MomentInput, tune(rep)]));
    expect(strikes(s)).toEqual([]);
  });
});

describe('tune: writtenIn follows the key at `at`', () => {
  it('the smallest interval, −6…+5 (a tritone goes down)', () => {
    const k = (tonic: string) => ({ tonic, scale: 'major' }) as Piece['key'];
    expect(tuneShift('C', k('D'))).toBe(2);
    expect(tuneShift('C', k('F#'))).toBe(-6);
    expect(tuneShift('F#', k('C'))).toBe(-6);
    expect(tuneShift('C', k('F'))).toBe(5);
    expect(tuneShift('C', k('G'))).toBe(-5);
    expect(tuneShift('C', k('Bb'))).toBe(-2);
    expect(tuneShift('Db', k('C#'))).toBe(0);
    expect(tuneShift(undefined, k('D'))).toBe(0);
  });

  const notes: TuneNote[] = [
    { pitch: 50, len: 1 },
    { rest: true, len: 0.5 },
    { pitch: 52, len: 1 },
  ];

  it('transposes every note; absent is absolute', () => {
    const s = compile(make([keyAt(1, 'D'), tune(notes, { writtenIn: 'C' })]));
    expect(pitchAt(s.voices[0], 2.5)).toBe(52);
    expect(pitchAt(s.voices[0], 4)).toBe(54);
    const q = compile(make([keyAt(1, 'D'), tune(notes)]));
    expect(pitchAt(q.voices[0], 2.5)).toBe(50);
  });

  it('a key change inside the tune does not move it; one at `at` before it does', () => {
    const s = compile(make([keyAt(3, 'A'), tune(notes, { writtenIn: 'C' })]));
    expect(pitchAt(s.voices[0], 4)).toBe(52);
    const t = compile(make([keyAt(2, 'G'), tune(notes, { writtenIn: 'C' })]));
    expect(pitchAt(t.voices[0], 2.5)).toBe(45);
  });

  it('a tune that follows the key has no fixed notes for key carry', () => {
    expect(hasFixedNotes({ id: 'x', ...tune(notes, { writtenIn: 'C' }) } as Moment)).toBe(false);
    expect(hasFixedNotes({ id: 'x', ...tune(notes) } as Moment)).toBe(true);
  });

  it('the palette check reads sounding pitches, rests and repeats', () => {
    const p = make([]);
    const s = compile(p);
    const at = (m: MomentInput) => momentEffectAt(p, s, { ...m, id: 'x' } as Moment).effect;
    // v1 holds 48: written 46 in Bb sounds 48 in C (+2).
    expect(at(tune([{ pitch: 46, len: 1 }], { writtenIn: 'Bb' }))).toBe(false);
    expect(at(tune([{ pitch: 46, len: 1 }]))).toBe(true);
    expect(at(tune([{ rest: true, len: 1 }]))).toBe(true);
    const twice = [
      { pitch: 48, len: 1 },
      { pitch: 48, len: 1 },
    ];
    expect(at(tune(twice))).toBe(true);
    expect(at(tune(twice, { strike: false }))).toBe(false);
  });
});

describe('tune rests: incremental compile and schema', () => {
  it('incremental equals full across edits', () => {
    const chord = { type: 'chord', at: 9, notes: { kind: 'pitches', pitches: [45, 52, 57] } };
    const base = make([
      tune([
        { pitch: 50, len: 1 },
        { rest: true, len: 1 },
        { pitch: 53, len: 1 },
        { pitch: 53, len: 1 },
        { rest: true, len: 1 },
      ]),
      chord as MomentInput,
    ]);
    const inc = createIncrementalCompiler();
    const edits: ((p: Piece) => void)[] = [
      () => undefined,
      (p) => (p.moments[2].at = 8),
      (p) => ((p.moments[1] as TuneMoment).notes[1] = { pitch: 52, len: 1 }),
      (p) => ((p.moments[1] as TuneMoment).writtenIn = 'G'),
      (p) => ((p.moments[1] as TuneMoment).strike = false),
      (p) => ((p.moments[1] as TuneMoment).notes[3] = { rest: true, len: 1 }),
      (p) => (p.moments[2].at = 4.5),
    ];
    let p = base;
    for (const e of edits) {
      p = structuredClone(p);
      e(p);
      expect(inc.compile(p)).toEqual(compile(p));
    }
  });

  it('parses rests, strike and writtenIn; rejects bad ones; round-trips stripped', () => {
    const notes: TuneNote[] = [
      { pitch: 50, len: 1 },
      { rest: true, len: 0.5 },
    ];
    const json = JSON.parse(
      JSON.stringify(make([tune(notes, { strike: false, writtenIn: 'Eb' })])),
    );
    const r = parsePiece(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.piece.moments[1] as TuneMoment;
    expect(m.notes[1]).toEqual({ rest: true, len: 0.5 });
    expect(m.strike).toBe(false);
    expect(m.writtenIn).toBe('Eb');
    const back = parsePiece(stripDefaults(r.piece));
    expect(back.ok && back.piece).toEqual(r.piece);
    for (const bad of [{ rest: true }, { rest: false, len: 1 }, { rest: true, len: 0 }]) {
      const q = structuredClone(json);
      q.moments[1].notes = [bad];
      expect(parsePiece(q).ok).toBe(false);
    }
    const q = structuredClone(json);
    q.moments[1].writtenIn = 'H';
    expect(parsePiece(q).ok).toBe(false);
  });
});
