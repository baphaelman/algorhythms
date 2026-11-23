import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { activeAt, pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { ChordMoment, Moment, Piece, PulseMoment } from '../../../src/core/types';
import { newBlock, rowForKey, ROW_PALETTE } from '../../../src/app/editor/row-palette';
import {
  FLOAT_GLIDE,
  PIECE_KEY,
  arriveOf,
  asChord,
  relativeShapeOf,
  rewriteAsChord,
  rowOf,
  rowsOf,
  setAbsolute,
  setArrive,
  setNotesCount,
  setRelative,
  setTexture,
  textureMoment,
  type Block,
} from '../../../src/app/editor/rows';
import { likeTheVideo } from '../../../src/app/editor/video-template';

const ROOT = join(import.meta.dirname, '../../../examples');
const files = [
  ...readdirSync(ROOT)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => join(ROOT, f)),
  ...readdirSync(join(ROOT, 'compositions'))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => join(ROOT, 'compositions', f)),
];

function load(path: string): Piece {
  const r = parsePiece(readFileSync(path, 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const errors = (p: Piece): string[] =>
  compile(p)
    .diagnostics.filter((d) => d.level === 'error')
    .map((d) => d.message);

const allBlocks = (p: Piece): Block[] => rowsOf(p, compile(p)).rows.flatMap((r) => r.blocks);

const base = (moments: Moment[], extra: Partial<Piece> = {}): Piece => ({
  ...newPiece({ seed: 7, key: { tonic: 'C', scale: 'major' } }),
  moments,
  ...extra,
});

const chord = (
  id: string,
  at: number,
  symbol: string,
  more: Partial<ChordMoment> = {},
): ChordMoment => ({
  id,
  type: 'chord',
  at,
  notes: { kind: 'chord', symbol },
  voicing: 'even',
  assign: 'ordered',
  ...more,
});

describe('rowsOf on every example and composition', () => {
  it('finds them', () => expect(files.length).toBeGreaterThanOrEqual(15));
  for (const f of files) {
    const name = f.slice(ROOT.length + 1);
    it(`${name}: each moment is a block on exactly one row, or a dot; no writes`, () => {
      const piece = load(f);
      const score = compile(piece);
      const before = JSON.stringify(piece);
      const view = rowsOf(deepFreeze(piece), score);
      expect(JSON.stringify(piece)).toBe(before);
      const where = new Map<string, Set<string>>();
      for (const r of view.rows) {
        for (const b of r.blocks) {
          if (b.id === PIECE_KEY) continue;
          const key = `${r.row}/${r.part ?? '-'}`;
          if (!where.has(b.id)) where.set(b.id, new Set());
          where.get(b.id)!.add(key);
          expect(b.row).toBe(r.row);
          expect(b.end).toBeGreaterThanOrEqual(b.start);
          expect(b.label.length).toBeGreaterThan(0);
        }
      }
      const dots = new Set(view.dots.map((d) => d.id));
      for (const m of piece.moments) {
        const row = rowOf(m.type);
        if (row === null) {
          expect(dots.has(m.id), m.id).toBe(true);
          expect(where.has(m.id), m.id).toBe(false);
          continue;
        }
        expect(where.get(m.id)?.size, `${m.id} ${m.type}`).toBe(1);
        expect([...where.get(m.id)!][0].startsWith(row + '/')).toBe(true);
        const n = view.rows.flatMap((r) => r.blocks).filter((b) => b.id === m.id).length;
        expect(n).toBe(m.type === 'progression' ? m.chords.length : 1);
      }
      expect(view.rows.filter((r) => r.row === 'key')).toHaveLength(1);
      expect(view.rows.filter((r) => r.row === 'chords')).toHaveLength(1);
    });
  }
});

describe('extents', () => {
  it('chords chain by target; all ends every target; the last runs to the end', () => {
    const p = base([
      chord('aaaaaa', 0, 'C'),
      chord('bbbbbb', 4, 'F', { target: { voices: ['v1'] } }),
      chord('cccccc', 8, 'G'),
    ]);
    const s = compile(p);
    const by = new Map(
      rowsOf(p, s)
        .rows.flatMap((r) => r.blocks)
        .map((b) => [b.id, b]),
    );
    expect([by.get('aaaaaa')!.start, by.get('aaaaaa')!.end]).toEqual([0, 8]);
    expect([by.get('bbbbbb')!.start, by.get('bbbbbb')!.end]).toEqual([4, 8]);
    expect(by.get('cccccc')!.end).toBe(s.duration);
    // a and b overlap: two sub-rows.
    expect(by.get('aaaaaa')!.sub).not.toBe(by.get('bbbbbb')!.sub);
    expect(by.get('aaaaaa')!.label).toBe('C');
  });

  it('textures, melodies, levels and sounds end at their own end; keys chain', () => {
    const p = base([
      chord('aaaaaa', 0, 'C'),
      textureMoment('wander', { id: 'wwwwww', at: 1, until: 9 }, base([])),
      {
        id: 'tttttt',
        type: 'tune',
        at: 2,
        notes: [
          { pitch: 72, len: 1 },
          { pitch: 74, len: 2 },
        ],
      },
      { id: 'llllll', type: 'level', at: 3, gain: 0.5, over: 2 },
      { id: 'ssssss', type: 'timbre', at: 4, preset: 'glass', fade: 3 },
      { id: 'kkkkkk', type: 'key', at: 5, key: { tonic: 'G', scale: 'major' } },
    ]);
    const s = compile(p);
    const v = rowsOf(p, s);
    const by = new Map(v.rows.flatMap((r) => r.blocks).map((b) => [b.id, b]));
    expect([by.get('wwwwww')!.end, by.get('wwwwww')!.label]).toEqual([9, 'Wander']);
    expect(by.get('tttttt')!.end).toBe(5);
    expect([by.get('llllll')!.end, by.get('llllll')!.label]).toEqual([5, '50%']);
    expect(by.get('ssssss')!.end).toBe(7);
    expect([by.get(PIECE_KEY)!.start, by.get(PIECE_KEY)!.end]).toEqual([0, 5]);
    expect(by.get('kkkkkk')!.end).toBe(s.duration);
    expect(v.rows.map((r) => r.row)).toEqual([
      'key',
      'chords',
      'texture',
      'melody',
      'level',
      'sound',
    ]);
  });

  it('a progression is a run of chord blocks', () => {
    const p = base([
      {
        id: 'pppppp',
        type: 'progression',
        at: 0,
        chords: [
          { notes: 'I', len: 2 },
          { notes: 'IV', len: 2 },
          { notes: 'V', len: 2 },
        ],
        voicing: 'even',
        assign: 'ordered',
      },
    ]);
    const bs = allBlocks(p).filter((b) => b.id === 'pppppp');
    expect(bs.map((b) => [b.index, b.start, b.label, b.legacy])).toEqual([
      [0, 0, 'C', true],
      [1, 2, 'F', true],
      [2, 4, 'G', true],
    ]);
    expect(bs[1].end).toBe(4);
  });

  it('labels legacy and relative blocks', () => {
    const p = base([
      chord('aaaaaa', 0, 'C', { count: 4 }),
      { id: 'uuuuuu', type: 'unison', at: 4, pitch: 'center', octaves: false },
      { id: 'ssssss', type: 'split', at: 8, count: 5, voicing: 'even' },
      { id: 'mmmmmm', type: 'merge', at: 12, count: 2, which: 'top', fade: 1 },
      { id: 'tttttt', type: 'shift', at: 16, by: 2, unit: 'scaleSteps' },
      { id: 'rrrrrr', type: 'spread', at: 20, factor: -1, around: 'mean', snap: 'scale' },
      { id: 'nnnnnn', type: 'pin', at: 22, voice: 'v1', pitch: 60 },
    ]);
    const v = rowsOf(p, compile(p));
    const by = new Map(v.rows.flatMap((r) => r.blocks).map((b) => [b.id, b]));
    expect(by.get('aaaaaa')!.detail).toBe('4 notes');
    expect(by.get('uuuuuu')!.label).toBe('one note');
    expect(by.get('ssssss')!.label).toBe('5 notes');
    expect(by.get('mmmmmm')!.label).toBe('2 notes');
    expect(by.get('tttttt')!.label).toBe('+2 steps');
    expect(by.get('rrrrrr')!.label).toBe('upside down');
    expect(v.dots).toEqual([{ id: 'nnnnnn', type: 'pin', at: 22, muted: false }]);
  });
});

describe('parts rows', () => {
  it('part rows per part; All only when used; Key and Chords shared', () => {
    const p = base([
      chord('aaaaaa', 0, 'C', { target: { part: 'Chords' } }),
      textureMoment('arpeggio', { id: 'pppppp', at: 0, until: 4 }, base([])),
      {
        id: 'tttttt',
        type: 'tune',
        at: 0,
        notes: [{ pitch: 72, len: 2 }],
        target: { part: 'Melody' },
      },
      { id: 'llllll', type: 'level', at: 0, gain: 0.5, over: 1 },
    ]);
    (p.moments[1] as PulseMoment).target = { parts: ['Chords'] };
    p.voices = p.voices.map((v, i) => ({ ...v, part: i < 2 ? 'Melody' : 'Chords' }));
    const v = rowsOf(p, compile(p));
    expect(v.rows.map((r) => `${r.row}:${r.part ?? '-'}`)).toEqual([
      'key:-',
      'chords:-',
      'texture:Melody',
      'texture:Chords',
      'melody:Melody',
      'melody:Chords',
      'level:Melody',
      'level:Chords',
      'level:',
      'sound:Melody',
      'sound:Chords',
    ]);
    const tex = v.rows.find((r) => r.row === 'texture' && r.part === 'Chords')!;
    expect(tex.blocks.map((b) => b.label)).toEqual(['Arpeggio']);
  });
});

describe('chord block conversions', () => {
  const defaults = newPiece({ seed: 1 }).defaults.glide;

  it('Arrive: land, float, custom round-trip', () => {
    const m = chord('aaaaaa', 0, 'C');
    expect(arriveOf(m, defaults)).toBe('custom');
    const f = setArrive(m, 'float', defaults);
    expect(arriveOf(f, defaults)).toBe('float');
    expect(f.glide).toEqual(FLOAT_GLIDE);
    const l = setArrive(f, 'land', defaults);
    expect(arriveOf(l, defaults)).toBe('land');
    expect(l.glide).toEqual({ land: true });
    const c = setArrive(l, 'custom', defaults);
    expect(arriveOf(c, defaults)).toBe('custom');
    expect(setArrive(c, 'custom', defaults)).toBe(c);
  });

  it('Notes: n, relative shapes and back compile', () => {
    const a = chord('aaaaaa', 0, 'C');
    const b = setNotesCount(chord('bbbbbb', 4, 'Am7'), 1, 12);
    expect(b.count).toBe(1);
    expect(setNotesCount(b, 40, 12).count).toBe(12);
    const up = setRelative({ ...chord('cccccc', 8, 'F'), label: 'x' }, { kind: 'upside-down' });
    expect(up).toMatchObject({ type: 'spread', factor: -1, id: 'cccccc', at: 8, label: 'x' });
    expect(relativeShapeOf(up)).toEqual({ kind: 'upside-down' });
    const moved = setRelative(up, { kind: 'moved', by: -2, unit: 'scaleSteps' });
    expect(relativeShapeOf(moved)).toEqual({ kind: 'moved', by: -2, unit: 'scaleSteps' });
    const wide = setRelative(moved, { kind: 'spacing', factor: 1.5 });
    const back = setAbsolute(wide, { kind: 'chord', symbol: 'G' });
    expect(back).toMatchObject({ type: 'chord', id: 'cccccc', label: 'x' });
    for (const ms of [
      [a, b],
      [a, up],
      [a, moved],
      [a, wide],
      [a, back],
    ] as Moment[][]) {
      expect(errors(base(ms))).toEqual([]);
    }
  });

  it('legacy unison, split, merge rewrite as chords that compile', () => {
    const p = base([
      chord('aaaaaa', 0, 'Cmaj7'),
      { id: 'uuuuuu', type: 'unison', at: 4, pitch: 'center', octaves: false },
      { id: 'ssssss', type: 'split', at: 8, count: 5, voicing: 'even' },
      { id: 'mmmmmm', type: 'merge', at: 12, count: 2, which: 'outer', fade: 1 },
      { id: 'oooooo', type: 'unison', at: 16, pitch: 'tonic', octaves: true },
    ]);
    const s = compile(p);
    for (const id of ['uuuuuu', 'ssssss', 'mmmmmm', 'oooooo']) {
      const r = rewriteAsChord(p, s, id);
      expect(r.id).toBe(id);
      const m = r.piece.moments.find((x) => x.id === id)!;
      expect(m.type).toBe('chord');
      expect(errors(r.piece)).toEqual([]);
      expect(p.moments.find((x) => x.id === id)!.type).not.toBe('chord');
    }
    // Unison on the center: one note on the mean of the sounding pitches.
    const u = asChord(p.moments[1], p, s) as ChordMoment;
    const ps = activeAt(s, 3.999).map((i) => pitchAt(s.voices[i], 3.999)!);
    expect(u.count).toBe(1);
    expect(u.notes).toEqual({
      kind: 'pitches',
      pitches: [Math.round(ps.reduce((x, y) => x + y, 0) / ps.length)],
    });
    // Split: one more voice sounding after it, as before.
    const sp = rewriteAsChord(p, s, 'ssssss').piece;
    expect(activeAt(compile(sp), 10).length).toBe(activeAt(s, 10).length);
    // A non-legacy moment is left alone.
    expect(rewriteAsChord(p, s, 'aaaaaa').piece).toBe(p);
  });

  it('a progression freezes into chord blocks that sound the same', () => {
    const p = base([
      {
        id: 'pppppp',
        type: 'progression',
        at: 0,
        chords: [
          { notes: 'I', len: 3 },
          { notes: 'vi', len: 3 },
          { notes: 'IV', len: 3 },
        ],
        voicing: 'even',
        assign: 'ordered',
      },
    ]);
    const s = compile(p);
    let n = 1;
    const r = rewriteAsChord(p, s, 'pppppp', 1, () => n++ * 7919);
    expect(r.piece.moments.map((m) => m.type)).toEqual(['chord', 'chord', 'chord']);
    expect(r.id).toBe(r.piece.moments[1].id);
    // Same sound; only the segments' moment ids differ.
    const strip = (x: unknown) => JSON.stringify(x).replace(/"momentId":"[^"]*"/g, '');
    expect(strip(compile(r.piece).voices)).toBe(strip(s.voices));
  });
});

describe('textures', () => {
  it('Arpeggio restarts each bar; Pulse is together; Hold deletes; all compile', () => {
    const p = base([chord('aaaaaa', 0, 'Cmaj7')], {
      view: { ...newPiece({ seed: 1 }).view, gridBpm: 120, meter: 4 },
    });
    const arp = textureMoment('arpeggio', { id: 'xxxxxx', at: 0, until: 8 }, p) as PulseMoment;
    expect(arp).toMatchObject({ step: 0.25, mode: 'updown', restart: 2 });
    expect(arp.pattern).toHaveLength(8);
    expect(arp.order).toBeUndefined();
    const pulse = setTexture(arp, 'pulse', p)!;
    expect(pulse).toMatchObject({ type: 'pulse', mode: 'together', id: 'xxxxxx', until: 8 });
    const wander = setTexture(pulse, 'wander', p)!;
    expect(wander).toMatchObject({ type: 'walk', over: 'chord', until: 8, grid: 0.5 });
    expect(setTexture(wander, 'wander', p)).toBe(wander);
    expect(setTexture(wander, 'hold', p)).toBeNull();
    for (const t of [arp, pulse, wander])
      expect(errors({ ...p, moments: [...p.moments, t] })).toEqual([]);
  });
});

describe('palette', () => {
  it('six rows, letters, and a default block per row that compiles', () => {
    expect(ROW_PALETTE.map((e) => e.name)).toEqual([
      'Chord',
      'Texture',
      'Melody',
      'Level',
      'Sound',
      'Key',
    ]);
    const none = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(rowForKey({ ...none, key: 't' })).toBe('texture');
    expect(rowForKey({ ...none, key: 'u' })).toBeNull();
    const p = base([chord('aaaaaa', 0, 'C', { count: 3 })]);
    const s = compile(p);
    for (const [i, e] of ROW_PALETTE.entries()) {
      const m = newBlock(e.row, 4, `new00${i}`, p, s);
      expect(rowOf(m.type)).toBe(e.row);
      expect(errors({ ...p, moments: [...p.moments, m] })).toEqual([]);
    }
    const c = newBlock('chords', 4, 'zzzzzz', p, s, () => ({ kind: 'chord', symbol: 'Am' }));
    expect(c).toMatchObject({ notes: { kind: 'chord', symbol: 'Am' }, glide: { land: true } });
    const t = newBlock('texture', 1, 'yyyyyy', p, s) as PulseMoment;
    expect(t.until).toBe(s.duration);
  });
});

describe('"Like the video" template', () => {
  it('six Float chord blocks and one Wander; no split, merge or unison; compiles', () => {
    const p = likeTheVideo({ seed: 3 });
    const types = p.moments.map((m) => m.type);
    expect(types).toEqual(['chord', 'chord', 'chord', 'chord', 'chord', 'chord', 'walk']);
    expect(
      p.moments.filter((m) => m.type === 'chord').map((m) => arriveOf(m, p.defaults.glide)),
    ).toEqual(Array(6).fill('float'));
    expect(p.moments.map((m) => (m as ChordMoment).count)).toEqual([1, 6, 6, 6, 1, 7, undefined]);
    expect(errors(p)).toEqual([]);
    expect(parsePiece(serializePiece(p)).ok).toBe(true);
    const s = compile(p);
    const pcAt = (t: number) =>
      activeAt(s, t).map((i) => ((Math.round(pitchAt(s.voices[i], t)!) % 12) + 12) % 12);
    expect(pcAt(1)).toEqual([9]); // A
    expect(pcAt(5)).toEqual([9]);
    expect(activeAt(s, 11).length).toBe(6);
    expect(pcAt(29)).toEqual([4]); // E
    expect(activeAt(s, 35).length).toBe(7);
    const v = rowsOf(p, s);
    expect(v.rows.find((r) => r.row === 'chords')!.blocks).toHaveLength(6);
    expect(v.rows.find((r) => r.row === 'texture')!.blocks.map((b) => b.label)).toEqual(['Wander']);
  });
});
