/** Key changes carry forward to fixed notes (PLAN.md §6.2 `key`, owner 2026-11-21). */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import {
  carryKey,
  fixedNoteMoments,
  keyBefore,
  remapMoment,
  remapPc,
  remapPitch,
  remapSymbol,
  tonicShift,
} from '../../../src/core/transpose';
import type { ChordMoment, Key, Moment, NoteMoment, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const C: Key = { tonic: 'C', scale: 'major' };
const Cm: Key = { tonic: 'C', scale: 'minor' };
const D: Key = { tonic: 'D', scale: 'major' };
const Am: Key = { tonic: 'A', scale: 'minor' };

const chord = (at: number, notes: ChordMoment['notes'], extra: Partial<ChordMoment> = {}) =>
  ({ type: 'chord', at, notes, voicing: 'even', assign: 'ordered', ...extra }) as MomentInput;
const key = (at: number, k: Key, id?: string) => ({ type: 'key', at, key: k, id }) as MomentInput;
const byId = (p: Piece, id: string): Moment => p.moments.find((m) => m.id === id)!;

describe('remapPitch', () => {
  it('moves the tonic the shorter way, ties down', () => {
    expect(tonicShift(C, D)).toBe(2);
    expect(tonicShift(C, { tonic: 'B', scale: 'major' })).toBe(-1);
    expect(tonicShift(C, { tonic: 'G', scale: 'major' })).toBe(-5);
    expect(tonicShift(C, { tonic: 'F#', scale: 'major' })).toBe(-6);
    expect(tonicShift(D, C)).toBe(-2);
  });

  it('tonic only: same degree and octave', () => {
    expect([60, 64, 67, 71].map((p) => remapPitch(p, C, D))).toEqual([62, 66, 69, 73]);
    expect(remapPitch(64, C, { tonic: 'G', scale: 'major' })).toBe(59);
    expect(remapPitch(71, C, { tonic: 'F#', scale: 'major' })).toBe(65);
  });

  it('mode only: degrees keep their index', () => {
    expect([60, 62, 64, 65, 67, 69, 71].map((p) => remapPitch(p, C, Cm))).toEqual([
      60, 62, 63, 65, 67, 68, 70,
    ]);
    expect(remapPitch(63, Cm, C)).toBe(64);
  });

  it('tonic and mode together', () => {
    // C major → A minor: the tonic goes down 3; degree 2 (E) → C, degree 6 (B) → G.
    expect([60, 64, 71].map((p) => remapPitch(p, C, Am))).toEqual([57, 60, 67]);
  });

  it('chromatic notes keep their offset from the degree below; fractions survive', () => {
    expect(remapPitch(61, C, D)).toBe(63); // C♯ → D♯
    expect(remapPitch(63, C, Am)).toBe(60); // E♭ = D + 1 → B + 1 = C
    expect(remapPitch(66, Cm, C)).toBe(66); // F♯ = F + 1 in both
    expect(remapPitch(60.25, C, D)).toBe(62.25);
    expect(remapPitch(60.75, C, Cm)).toBe(60.75);
  });

  it('octave edges: the degree keeps the octave that starts at its tonic', () => {
    const B: Key = { tonic: 'B', scale: 'major' };
    const Db: Key = { tonic: 'C#', scale: 'major' };
    expect(remapPitch(59, C, Db)).toBe(60); // B3 → B♯3 (= C4)
    expect(remapPitch(59, C, B)).toBe(58); // B3 → A♯3
    expect(remapPitch(60, C, B)).toBe(59); // C4 → B3
    expect(remapPitch(47, C, B)).toBe(46);
    expect(remapPitch(-1, C, D)).toBe(1);
  });

  it('maps between scales of different sizes by nearest interval (ties down)', () => {
    const P: Key = { tonic: 'C', scale: 'pentatonic-major' };
    expect(remapPitch(65, C, P)).toBe(64); // F (5) → E (4)
    expect(remapPitch(71, C, P)).toBe(72); // B (11) → the next tonic
    expect(remapPitch(69, P, C)).toBe(69); // A (9) stays A
    expect(remapPitch(62.5, P, C)).toBe(62.5);
  });

  it('is the identity for the same key, and periodic by octave', () => {
    for (let p = 40; p < 80; p++) {
      expect(remapPitch(p, C, C)).toBe(p);
      expect(remapPitch(p + 12, C, Am)).toBe(remapPitch(p, C, Am) + 12);
    }
    expect(remapPc(4, C, Am)).toBe(0);
  });
});

describe('remapSymbol', () => {
  it('transposes letter roots and note basses when only the tonic changes', () => {
    const A: Key = { tonic: 'A', scale: 'lydian' };
    const E: Key = { tonic: 'E', scale: 'lydian' };
    expect(remapSymbol('Dmaj7#11', A, E)).toBe('Amaj7#11');
    expect(remapSymbol('C/E', C, D)).toBe('D/F#');
    expect(remapSymbol('Bb7', C, D)).toBe('C7');
    expect(remapSymbol('F♯m7b5', C, D)).toBe('G#m7b5');
  });

  it('needs a pitch list for a letter chord when the scale changes; Roman numerals stay', () => {
    expect(remapSymbol('Dm7', C, Cm)).toBeNull();
    expect(remapSymbol('ii7', C, Am)).toBe('ii7');
    expect(remapSymbol('I/E', C, Cm)).toBe('I/Eb');
  });
});

describe('remapMoment', () => {
  const p = piece({ pool: 4, start: [48, 55, 60, 64] });
  p.voices[0].range = [36, 62];
  const at = 1;

  it('pitch lists, unisons, notes, overrides', () => {
    const ch = { ...chord(at, { kind: 'pitches', pitches: [48, 52, 55] }), id: 'a' } as Moment;
    expect((remapMoment(p, ch, C, D).moment as ChordMoment).notes).toEqual({
      kind: 'pitches',
      pitches: [50, 54, 57],
    });
    const un = { id: 'u', type: 'unison', at, pitch: 64, octaves: false } as Moment;
    expect(remapMoment(p, un, C, Cm).moment).toMatchObject({ pitch: 63 });
    const tonic = { ...un, pitch: 'tonic' } as Moment;
    expect(remapMoment(p, tonic, C, D).moment).toBe(tonic);
    const one = { id: 'n', type: 'note', at, from: 64, to: 65 } as NoteMoment;
    expect(remapMoment(p, one, C, D).moment).toMatchObject({ from: 66, to: 67 });
    const many: NoteMoment = {
      id: 'g',
      type: 'note',
      at,
      changes: [
        { from: 60, to: 62 },
        { from: 64, to: 65 },
      ],
    };
    expect((remapMoment(p, many, C, D).moment as NoteMoment).changes).toEqual([
      { from: 62, to: 64 },
      { from: 66, to: 67 },
    ]);
    const ov = {
      ...chord(at, { kind: 'degrees', degrees: [0, 2, 4] }),
      id: 'o',
      overrides: [
        { voice: 2, pitch: 64 },
        { voice: 1, end: 2 },
      ],
    } as Moment;
    const r = remapMoment(p, ov, C, D).moment as ChordMoment;
    expect(r.notes).toEqual({ kind: 'degrees', degrees: [0, 2, 4] });
    expect(r.overrides).toEqual([
      { voice: 2, pitch: 66 },
      { voice: 1, end: 2 },
    ]);
  });

  it('named chords: root transposed, or a pitch list of what it voices after a scale change', () => {
    const named = { ...chord(at, { kind: 'chord', symbol: 'Fmaj7' }), id: 'c' } as ChordMoment;
    expect((remapMoment(p, named, C, D).moment as ChordMoment).notes).toEqual({
      kind: 'chord',
      symbol: 'Gmaj7',
    });
    const voiced = () => [53, 57, 60, 64];
    expect((remapMoment(p, named, C, Cm, { voiced }).moment as ChordMoment).notes).toEqual({
      kind: 'pitches',
      pitches: [53, 56, 60, 63],
    });
    const skipped = remapMoment(p, named, C, Cm);
    expect(skipped.skipped).toBe(true);
    expect((skipped.moment as ChordMoment).notes).toEqual(named.notes);
  });

  it('frozen chords remap both the frozen notes and what Unfreeze restores', () => {
    const frozen = {
      ...chord(at, { kind: 'pitches', pitches: [53, 57, 60] }),
      id: 'f',
      frozenFrom: { notes: { kind: 'chord', symbol: 'F' }, assign: 'free' },
    } as ChordMoment;
    const r = remapMoment(p, frozen, C, D).moment as ChordMoment;
    expect(r.notes).toEqual({ kind: 'pitches', pitches: [55, 59, 62] });
    expect(r.frozenFrom).toEqual({ notes: { kind: 'chord', symbol: 'G' }, assign: 'free' });
    const s = remapMoment(p, frozen, C, Cm);
    expect(s.skipped).toBe(false);
    const m = s.moment as ChordMoment;
    expect(m.frozenFrom?.notes).toEqual({ kind: 'pitches', pitches: [53, 56, 60] });
  });

  it("folds pins and frozen walk notes into their voice's range, with a report", () => {
    const pin = { id: 'p', type: 'pin', at, voice: 'v1', pitch: 60 } as Moment;
    const E: Key = { tonic: 'E', scale: 'major' };
    const r = remapMoment(p, pin, C, E);
    expect(r.moment).toMatchObject({ pitch: 52 });
    expect(r.folds).toEqual([{ momentId: 'p', voice: 0, pitch: 64, folded: 52, clamped: false }]);
    expect(remapMoment(p, { ...pin, voice: 'v2' } as Moment, C, E).folds).toEqual([]);
    const walk = {
      id: 'w',
      type: 'walk',
      at,
      until: 5,
      grid: 1,
      density: 0.5,
      steps: [-1, 1],
      stepGlide: 0.3,
      fixed: [
        { tick: 0, voice: 'v1', pitch: 62 },
        { tick: 1, voice: 'v3', pitch: 62 },
      ],
    } as Moment;
    const w = remapMoment(p, walk, C, D);
    expect(w.moment).toMatchObject({
      fixed: [
        { tick: 0, voice: 'v1', pitch: 52 },
        { tick: 1, voice: 'v3', pitch: 64 },
      ],
    });
    expect(w.folds).toHaveLength(1);
  });
});

describe('fixedNoteMoments and carryKey', () => {
  const build = () =>
    piece({
      pool: 4,
      start: [48, 55, 60, 64],
      key: C,
      moments: [
        { id: 'pinA', type: 'pin', at: 2, voice: 'v1', pitch: 50 },
        key(2, D, 'keyD'),
        { id: 'pinB', type: 'pin', at: 2, voice: 'v2', pitch: 57 },
        { ...chord(3, { kind: 'degrees', degrees: [0, 2, 4, 6] }), id: 'deg' },
        { id: 'uniT', type: 'unison', at: 4, pitch: 'tonic', octaves: true },
        { ...chord(5, { kind: 'pitches', pitches: [50, 57, 60, 64] }), id: 'pit' },
        { ...chord(6, { kind: 'chord', symbol: 'ii7' }), id: 'rom' },
        { ...key(7, Am, 'keyMuted'), muted: true } as MomentInput,
        { ...chord(8, { kind: 'chord', symbol: 'Am' }), id: 'nam' },
        key(10, Am, 'keyAm'),
        { id: 'pinC', type: 'pin', at: 11, voice: 'v1', pitch: 50 },
      ],
    });

  it('finds the fixed notes from the key moment to the next unmuted one', () => {
    const p = build();
    expect(fixedNoteMoments(p, 'keyD')).toEqual({ ids: ['pinB', 'pit', 'nam'], until: 10 });
    expect(fixedNoteMoments(p, 'keyAm')).toEqual({ ids: ['pinC'], until: null });
    expect(fixedNoteMoments(p, 'keyMuted').ids).toEqual([]);
    expect(fixedNoteMoments(p, 'deg').ids).toEqual([]);
    expect(keyBefore(p, 'keyD')).toEqual(C);
    expect(keyBefore(p, 'keyAm')).toEqual(D);
  });

  it('moves only the span’s fixed notes; key-relative moments stay', () => {
    const p = build();
    const r = carryKey(p, 'keyD', C);
    expect(r.moved).toEqual(['pinB', 'pit', 'nam']);
    expect(byId(r.piece, 'pinA')).toBe(byId(p, 'pinA'));
    expect(byId(r.piece, 'pinB')).toMatchObject({ pitch: 59 });
    expect(byId(r.piece, 'pit')).toMatchObject({ notes: { pitches: [52, 59, 62, 66] } });
    expect(byId(r.piece, 'nam')).toMatchObject({ notes: { symbol: 'Bm' } });
    for (const id of ['deg', 'uniT', 'rom', 'pinC']) expect(byId(r.piece, id)).toBe(byId(p, id));
    // The degree chord compiles to the same pitches before and after.
    const at = (s: ReturnType<typeof compile>) => s.harmony?.find((h) => h.momentId === 'deg')?.pcs;
    expect(at(compile(r.piece))).toEqual(at(compile(p)));
    expect(carryKey(p, 'keyD', D).piece).toBe(p);
  });
});

describe('carryKey: note points on held lines', () => {
  const notSounding = (p: Piece) =>
    compile(p).diagnostics.filter((d) => d.code === 'note-not-sounding');
  // v3 reaches E (64) before the key and holds it; the pin gives v1 E (52) inside the span.
  const build = (notes: MomentInput[]) =>
    piece({
      pool: 3,
      start: [48, 55, 60],
      key: C,
      moments: [
        { ...chord(1, { kind: 'pitches', pitches: [48, 55, 64] }), id: 'c1' },
        key(4, D, 'keyD'),
        { id: 'pin', type: 'pin', at: 5, voice: 'v1', pitch: 52 },
        ...notes,
      ],
    });

  it('keeps `from` on a line held from before the key; moves it on one set in the span', () => {
    const p = build([
      { id: 'held', type: 'note', at: 8, from: 64, to: 65 },
      { id: 'span', type: 'note', at: 9, from: 52, to: 50 },
    ]);
    expect(notSounding(p)).toEqual([]);
    const r = carryKey(p, 'keyD', C);
    expect(r.moved).toEqual(['pin', 'held', 'span']);
    expect(byId(r.piece, 'held')).toMatchObject({ from: 64, to: 67 });
    expect(byId(r.piece, 'span')).toMatchObject({ from: 54, to: 52 });
    expect(notSounding(r.piece)).toEqual([]);
  });

  it('decides each of grouped changes, and a note after a held line moved in the span', () => {
    const p = build([
      {
        id: 'both',
        type: 'note',
        at: 9,
        changes: [
          { from: 64, to: 65 },
          { from: 52, to: 50 },
        ],
      },
      // The first change moved v3 (in the span): its new note is remapped.
      { id: 'later', type: 'note', at: 14, from: 65, to: 64 },
    ]);
    expect(notSounding(p)).toEqual([]);
    const r = carryKey(p, 'keyD', C);
    expect((byId(r.piece, 'both') as NoteMoment).changes).toEqual([
      { from: 64, to: 67 },
      { from: 54, to: 52 },
    ]);
    expect(byId(r.piece, 'later')).toMatchObject({ from: 67, to: 66 });
    expect(notSounding(r.piece)).toEqual([]);
  });

  it('moves `from` when a fixed chord in the span restates the held note', () => {
    const p = build([
      { ...chord(6, { kind: 'pitches', pitches: [52, 55, 64] }), id: 'again' },
      { id: 'held', type: 'note', at: 8, from: 64, to: 65 },
    ]);
    const r = carryKey(p, 'keyD', C);
    expect(byId(r.piece, 'again')).toMatchObject({ notes: { pitches: [54, 57, 66] } });
    expect(byId(r.piece, 'held')).toMatchObject({ from: 66, to: 67 });
    expect(notSounding(r.piece)).toEqual([]);
  });
});
