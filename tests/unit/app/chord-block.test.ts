import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type {
  ChordMoment,
  Moment,
  Piece,
  ProgressionMoment,
  PulseMoment,
} from '../../../src/core/types';
import {
  chordBlockView,
  editBlockIn,
  fillProgressionIn,
} from '../../../src/app/editor/chord-block';
import { paletteMoment } from '../../../src/app/editor/row-palette';
import { PALETTE } from '../../../src/app/editor/shortcuts';
import {
  arriveOf,
  rowOf,
  setArrive,
  setNotesCount,
  setRelative,
  setTexture,
  textureOf,
} from '../../../src/app/editor/rows';

const base = (moments: Moment[]): Piece => ({
  ...newPiece({ seed: 7, key: { tonic: 'C', scale: 'major' } }),
  moments,
});

const chord = (id: string, at: number, symbol: string, more: Partial<ChordMoment> = {}) =>
  ({
    id,
    type: 'chord',
    at,
    notes: { kind: 'chord', symbol },
    voicing: 'even',
    assign: 'ordered',
    ...more,
  }) as ChordMoment;

const errors = (p: Piece): string[] =>
  compile(p)
    .diagnostics.filter((d) => d.level === 'error')
    .map((d) => d.message);

/** A deterministic id source. */
const ids = (): (() => number) => {
  let n = 1;
  return () => n++ * 0x9e3779b1;
};

describe('palette (§6.4)', () => {
  it('six rows; each adds a block on its own row that compiles; Chord lands, Texture arpeggiates', () => {
    expect(PALETTE.map((e) => [e.name, e.key])).toEqual([
      ['Chord', 'C'],
      ['Texture', 'T'],
      ['Melody', 'M'],
      ['Level', 'L'],
      ['Sound', 'S'],
      ['Key', 'K'],
    ]);
    const p = base([chord('aaaaaa', 0, 'C', { count: 3 })]);
    const s = compile(p);
    for (const [i, e] of PALETTE.entries()) {
      const m = paletteMoment(e.type, 4, `new00${i}`, p, s);
      expect(rowOf(m.type)).toBe(e.row);
      expect(errors({ ...p, moments: [...p.moments, m] })).toEqual([]);
    }
    const c = paletteMoment('chord', 4, 'zzzzzz', p, s);
    expect(arriveOf(c, p.defaults.glide)).toBe('land');
    // M10a's theory default: a numeral symbol.
    expect(c.notes.kind).toBe('chord');
    const t = paletteMoment('pulse', 4, 'yyyyyy', p, s) as PulseMoment;
    expect(textureOf(t)).toBe('arpeggio');
    // Moment types off the palette keep today's defaults.
    expect(paletteMoment('walk', 4, 'xxxxxx', p, s).type).toBe('walk');
  });
});

describe('chord block view', () => {
  it('a chord is itself; shift/spread are relative; unison and progression chord k stand for chords', () => {
    const c = chord('aaaaaa', 0, 'C', { count: 4 });
    const u: Moment = { id: 'uuuuuu', type: 'unison', at: 4, pitch: 'tonic', octaves: false };
    const sh: Moment = { id: 'ssssss', type: 'shift', at: 6, by: 2, unit: 'scaleSteps' };
    const sp: Moment = {
      id: 'pppppp',
      type: 'spread',
      at: 7,
      factor: -1,
      around: 'mean',
      snap: 'scale',
    };
    const pr: ProgressionMoment = {
      id: 'rrrrrr',
      type: 'progression',
      at: 8,
      chords: [
        { notes: 'IV', len: 2 },
        { notes: 'V', len: 2 },
      ],
      voicing: 'even',
      assign: 'ordered',
    };
    const p = base([c, u, sh, sp, pr]);
    const s = compile(p);
    expect(chordBlockView(p, s, c)).toEqual({ chord: c, shape: null, legacy: false });
    expect(chordBlockView(p, s, u).chord).toMatchObject({
      type: 'chord',
      count: 1,
      notes: { kind: 'degrees', degrees: [0] },
    });
    expect(chordBlockView(p, s, u).legacy).toBe(true);
    expect(chordBlockView(p, s, sh).shape).toEqual({ kind: 'moved', by: 2, unit: 'scaleSteps' });
    expect(chordBlockView(p, s, sp).shape).toEqual({ kind: 'upside-down' });
    const v1 = chordBlockView(p, s, pr, 1);
    expect(v1.chord).toMatchObject({ at: 10, notes: { kind: 'chord', symbol: 'V' } });
  });
});

describe('chord block edits', () => {
  const u: Moment = {
    id: 'uuuuuu',
    type: 'unison',
    at: 4,
    pitch: 'tonic',
    octaves: false,
    seed: 9,
  };
  const p = base([chord('aaaaaa', 0, 'C', { count: 4 }), u]);
  const s = compile(p);
  const pool = p.voices.length;

  it('an edit that changes nothing leaves a legacy block alone (same piece)', () => {
    const r = editBlockIn(p, s, u.id, 0, (m) =>
      m.type === 'chord' ? setNotesCount(m, 1, pool) : m,
    );
    expect(r.piece).toBe(p);
  });

  it('editing a legacy unison rewrites it as a chord, id and seed kept, then applies the edit', () => {
    const r = editBlockIn(p, s, u.id, 0, (m) =>
      m.type === 'chord' ? setNotesCount(m, 3, pool) : m,
    );
    expect(r.id).toBe(u.id);
    const m = r.piece.moments.find((x) => x.id === u.id)!;
    expect(m).toMatchObject({ type: 'chord', count: 3, seed: 9 });
    expect(errors(r.piece)).toEqual([]);
  });

  it('Arrive Float on a legacy block; Upside down on a chord', () => {
    const f = editBlockIn(p, s, u.id, 0, (m) => setArrive(m, 'float', p.defaults.glide));
    const m = f.piece.moments.find((x) => x.id === u.id)!;
    expect(m.type).toBe('chord');
    expect(arriveOf(m, p.defaults.glide)).toBe('float');
    const up = editBlockIn(p, s, 'aaaaaa', 0, (x) => setRelative(x, { kind: 'upside-down' }));
    expect(up.piece.moments.find((x) => x.id === 'aaaaaa')).toMatchObject({
      type: 'spread',
      factor: -1,
    });
  });

  it('progression chord k: freezes into chord moments, the edit lands on chord k', () => {
    const pr: ProgressionMoment = {
      id: 'rrrrrr',
      type: 'progression',
      at: 4,
      chords: [
        { notes: 'IV', len: 2 },
        { notes: 'V', len: 2 },
      ],
      voicing: 'even',
      assign: 'ordered',
    };
    const q = base([chord('aaaaaa', 0, 'C', { count: 3 }), pr]);
    const r = editBlockIn(q, compile(q), pr.id, 1, (m) =>
      m.type === 'chord' ? setNotesCount(m, 1, q.voices.length) : m,
    );
    expect(r.piece.moments.some((x) => x.type === 'progression')).toBe(false);
    const edited = r.piece.moments.find((x) => x.id === r.id) as ChordMoment;
    expect(edited).toMatchObject({ at: 6, count: 1, notes: { kind: 'chord', symbol: 'V' } });
  });
});

describe('typed chords fill a run of chord blocks', () => {
  it('"IV 2, V 2" from a chord: two plain chords, the first keeps the id, inner blocks go', () => {
    const p = {
      ...base([
        chord('aaaaaa', 0, 'C', { count: 3, glide: { land: true } }),
        chord('bbbbbb', 1, 'Am'),
        chord('cccccc', 9, 'G'),
      ]),
    };
    p.view = { ...p.view, gridBpm: 60 };
    const r = fillProgressionIn(
      p,
      compile(p),
      'aaaaaa',
      0,
      [
        { notes: 'IV', len: 2 },
        { notes: 'V', len: 2 },
      ],
      ids(),
    )!;
    expect(r.ids[0]).toBe('aaaaaa');
    const chords = r.piece.moments.filter((m) => m.type === 'chord') as ChordMoment[];
    expect(chords.map((m) => [m.at, m.notes.kind === 'chord' && m.notes.symbol])).toEqual([
      [0, 'IV'],
      [2, 'V'],
      [9, 'G'],
    ]);
    // Both keep the block's glide and count.
    expect(chords[1]).toMatchObject({ count: 3, glide: { land: true } });
    expect(r.piece.moments.some((m) => m.type === 'progression')).toBe(false);
    expect(errors(r.piece)).toEqual([]);
  });

  it('from a legacy unison: rewritten, then filled', () => {
    const p = base([
      chord('aaaaaa', 0, 'C', { count: 3 }),
      { id: 'uuuuuu', type: 'unison', at: 4, pitch: 'tonic', octaves: false },
    ]);
    const r = fillProgressionIn(
      p,
      compile(p),
      'uuuuuu',
      0,
      [
        { notes: 'ii', len: 1 },
        { notes: 'V7', len: 1 },
      ],
      ids(),
    )!;
    const run = r.piece.moments.filter((m) => m.at >= 4);
    expect(run.map((m) => [m.type, m.at])).toEqual([
      ['chord', 4],
      ['chord', 5],
    ]);
    expect(fillProgressionIn(p, compile(p), 'uuuuuu', 0, [])).toBeNull();
  });
});

describe('texture switching', () => {
  it('Arpeggio → Wander → Hold keeps the region, then deletes', () => {
    const p = base([chord('aaaaaa', 0, 'C', { count: 3 })]);
    const arp = paletteMoment('pulse', 0, 'tttttt', p, compile(p)) as PulseMoment;
    const wander = setTexture(arp, 'wander', p)!;
    expect(wander).toMatchObject({ type: 'walk', id: 'tttttt', at: arp.at, until: arp.until });
    expect(textureOf(wander)).toBe('wander');
    expect(setTexture(wander, 'hold', p)).toBeNull();
  });
});
