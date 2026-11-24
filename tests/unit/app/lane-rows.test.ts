/**
 * The lane's rows (PLAN §6.4, M10b-3): `laneBlocks` and `laneRowsLayout` lay the row model out in
 * px. Includes the M10 acceptance line: every example and composition shows each of its moments as
 * a block or a dot on exactly one row.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { parsePiece } from '../../../src/core/schema';
import type { ChordMoment, Moment, Piece } from '../../../src/core/types';
import {
  ART_SUB_H,
  CHORD_SUB_H,
  DOT_H,
  LABEL_GAP,
  LABEL_INSET,
  LEVEL_CURVE_H,
  MARKER_HALF,
  ROW_PAD,
  SUB_H,
  blockBoxPx,
  blockLabelPx,
  labelRoomPx,
  laneBlocks,
  laneRowsLayout,
  rowKey,
  type LaneBlock,
} from '../../../src/app/editor/lane';
import { PIECE_KEY, rowsOf } from '../../../src/app/editor/rows';

const ROOT = join(import.meta.dirname, '../../../examples');
const files = [
  ...readdirSync(ROOT)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => join(ROOT, f)),
  ...['songs', 'experiments'].flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => f.endsWith('.algorhythms.json'))
      .map((f) => join(ROOT, d, f)),
  ),
];

function load(path: string): Piece {
  const r = parsePiece(readFileSync(path, 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

const base = (moments: Moment[], extra: Partial<Piece> = {}): Piece => ({
  ...newPiece({ seed: 7, key: { tonic: 'C', scale: 'major' } }),
  moments,
  ...extra,
});

const chord = (id: string, at: number, more: Partial<ChordMoment> = {}): ChordMoment => ({
  id,
  type: 'chord',
  at,
  notes: { kind: 'degrees', degrees: [0, 2, 4] },
  voicing: 'even',
  assign: 'ordered',
  ...more,
});

const layout = (p: Piece, pps = 40, ghost?: LaneBlock) =>
  laneRowsLayout(rowsOf(p, compile(p)), pps, ghost);

const titles = (L: ReturnType<typeof layout>): string[] =>
  L.rows.map((r) => (r.group ? `${r.group} ${r.title}` : r.title));

describe('rows shown', () => {
  it('Key, Chords and Texture always; Melody, Level and Sound only with a block', () => {
    const p = base([chord('c1', 0)]);
    expect(titles(layout(p))).toEqual(['Key', 'Chords', 'Texture']);
    const q = base([
      chord('c1', 0),
      { id: 'l1', type: 'level', at: 2, gain: 0.5, over: 1 },
      { id: 't1', type: 'timbre', at: 3, preset: 'glass', fade: 0 },
    ]);
    expect(titles(layout(q))).toEqual(['Key', 'Chords', 'Texture', 'Level', 'Sound']);
  });

  it('a ghost shows its hidden row while it is there, in row order', () => {
    const p = base([chord('c1', 0)]);
    const ghost: LaneBlock = { id: 'probe', row: 'melody', start: 2, end: 4, label: 'melody' };
    const L = layout(p, 40, ghost);
    expect(titles(L)).toEqual(['Key', 'Chords', 'Texture', 'Melody']);
    expect(L.ghost).toEqual({ row: 'melody', sub: 0, top: L.rows[3].top + ROW_PAD });
    expect(layout(p).ghost).toBeUndefined();
  });

  it('row heights: sub-rows × height + padding; the first Level row has a curve band; tops add up', () => {
    const p = base([
      chord('c1', 0),
      chord('c2', 1, { target: { rank: [0, 0] } }),
      { id: 'l1', type: 'level', at: 2, gain: 0.5, over: 1 },
    ]);
    const L = layout(p);
    const [key, chords, texture, level] = L.rows;
    expect(key.height).toBe(SUB_H + 2 * ROW_PAD);
    // c1 (all) runs to the end; c2 (another target) overlaps it → two sub-rows.
    expect(chords.subRows).toBe(2);
    expect(chords.height).toBe(2 * CHORD_SUB_H + 2 * ROW_PAD);
    expect(texture.height).toBe(ART_SUB_H + 2 * ROW_PAD);
    expect(level.height).toBe(LEVEL_CURVE_H + ART_SUB_H + 2 * ROW_PAD);
    // The level block sits under the curve's band, never across it.
    expect(L.blocks.get('l1')?.top).toBe(level.top + ROW_PAD + LEVEL_CURVE_H);
    for (let i = 1; i < L.rows.length; i++)
      expect(L.rows[i].top).toBe(L.rows[i - 1].top + L.rows[i - 1].height);
    expect(L.height).toBe(level.top + level.height);
    expect(L.blocks.get('c1')).toEqual({ row: 'chords', sub: 0, top: chords.top + ROW_PAD });
    expect(L.blocks.get('c2')).toEqual({
      row: 'chords',
      sub: 1,
      top: chords.top + ROW_PAD + CHORD_SUB_H,
    });
    expect(L.blocks.get(PIECE_KEY)?.row).toBe('key');
  });
});

describe('blocks', () => {
  it('chords chain to the next chord; textures and levels end on their own', () => {
    const p = base([
      chord('c1', 0),
      chord('c2', 4),
      { ...walkAt('w1', 1, 3) },
      { id: 'l1', type: 'level', at: 2, gain: 0.5, over: 1.5 },
    ]);
    const b = new Map(laneBlocks(rowsOf(p, compile(p))).map((x) => [x.id, x]));
    expect([b.get('c1')?.start, b.get('c1')?.end]).toEqual([0, 4]);
    expect([b.get('w1')?.row, b.get('w1')?.start, b.get('w1')?.end]).toEqual(['texture', 1, 3]);
    expect([b.get('l1')?.start, b.get('l1')?.end]).toEqual([2, 3.5]);
  });

  it('a progression is one lane block holding one block per chord (same moment)', () => {
    const p = base([
      {
        id: 'pr',
        type: 'progression',
        at: 0,
        chords: [
          { notes: 'I', len: 2 },
          { notes: 'IV', len: 2 },
          { notes: 'V', len: 1 },
        ],
      } as Moment,
    ]);
    const blocks = laneBlocks(rowsOf(p, compile(p))).filter((x) => x.id === 'pr');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].row).toBe('chords');
    expect(blocks[0].chords?.map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, blocks[0].end],
    ]);
  });

  it('box: the band on chained rows; the label too where blocks end on their own', () => {
    const c: LaneBlock = { id: 'c', row: 'chords', start: 1, end: 1.25, label: 'Cmaj7' };
    expect(blockBoxPx(c, 100)).toEqual([100, 125]);
    expect(blockBoxPx({ ...c, end: 1 }, 100)).toEqual([100, 105]);
    const l: LaneBlock = { id: 'l', row: 'level', start: 1, end: 1, label: '55%' };
    const [a, z] = blockBoxPx(l, 100);
    expect(a).toBe(100);
    expect(z - a).toBeGreaterThan(30);
  });

  it('label room: up to the next marker less a gap; own-end rows keep the reserved label', () => {
    // A chord from 1 s to 2 s at 100 px/s: the next marker's left edge is at 200 - MARKER_HALF.
    const c: LaneBlock = { id: 'c', row: 'chords', start: 1, end: 2, label: 'Cmaj7' };
    const room = labelRoomPx(c, 1, 100);
    expect(100 + LABEL_INSET + room).toBe(200 - MARKER_HALF - LABEL_GAP);
    // Narrower than a character: Lane.tsx hides it.
    expect(labelRoomPx({ ...c, end: 1.1 }, 1, 100)).toBeLessThan(0);
    // A level point block: its stacking box reserves the label, so the label fits it.
    const l: LaneBlock = { id: 'l', row: 'level', start: 1, end: 1, label: '55%' };
    const r = labelRoomPx(l, 1, 100);
    expect(r).toBeGreaterThanOrEqual(3 * 6);
    expect(100 + LABEL_INSET + r).toBeLessThanOrEqual(blockBoxPx(l, 100)[1] - MARKER_HALF);
    expect(100 + LABEL_INSET + r).toBeLessThan(100 + blockLabelPx(l));
    // A long texture block: its end, not the estimate, bounds the label.
    const t: LaneBlock = { id: 't', row: 'texture', start: 1, end: 5, label: 'Walk' };
    expect(labelRoomPx(t, 1, 100)).toBe(500 - MARKER_HALF - LABEL_GAP - 100 - LABEL_INSET);
  });

  it('chained blocks that touch share a sub-row', () => {
    const p = base([chord('c1', 0), chord('c2', 1), chord('c3', 2)]);
    const L = layout(p, 40);
    expect(['c1', 'c2', 'c3'].map((id) => L.blocks.get(id)?.sub)).toEqual([0, 0, 0]);
    expect(L.rows[1].subRows).toBe(1);
  });

  it('own-end rows stack a point block whose label would cover the next', () => {
    const p = base([
      chord('c1', 0),
      { id: 'l1', type: 'level', at: 2, gain: 0.5, over: 0 },
      { id: 'l2', type: 'level', at: 2.2, gain: 0.7, over: 0 },
    ]);
    const L = layout(p, 40);
    expect([L.blocks.get('l1')?.sub, L.blocks.get('l2')?.sub]).toEqual([0, 1]);
    // Zoomed in far enough, they share one sub-row.
    const W = layout(p, 2000);
    expect([W.blocks.get('l1')?.sub, W.blocks.get('l2')?.sub]).toEqual([0, 0]);
  });
});

describe('dots', () => {
  it('note and pin moments are dots on top of the Chords row, stacked when they touch', () => {
    const p = base([
      chord('c1', 0, { notes: { kind: 'pitches', pitches: [60, 64, 67] } }),
      { id: 'n1', type: 'note', at: 2, from: 64, to: 65 } as Moment,
      { id: 'n2', type: 'note', at: 2.05, from: 60, to: 62 } as Moment,
      { id: 'p1', type: 'pin', at: 5, pitch: 67 } as Moment,
    ]);
    const L = layout(p, 40);
    const chords = L.rows.find((r) => r.row === 'chords')!;
    expect(chords.dotRows).toBe(2);
    expect(L.dots.get('n1')).toEqual({ row: 'chords', sub: 0, top: chords.top + ROW_PAD });
    expect(L.dots.get('n2')).toEqual({ row: 'chords', sub: 1, top: chords.top + ROW_PAD + DOT_H });
    expect(L.dots.get('p1')?.sub).toBe(0);
    // Blocks sit under the dots.
    expect(L.blocks.get('c1')?.top).toBe(chords.top + ROW_PAD + 2 * DOT_H);
    expect(chords.height).toBe(2 * ROW_PAD + 2 * DOT_H + CHORD_SUB_H);
    expect(L.blocks.has('n1')).toBe(false);
  });
});

describe('part rows', () => {
  const parted = (moments: Moment[]): Piece => {
    const p = base(moments);
    return {
      ...p,
      voices: p.voices.map((v, i) => ({ ...v, part: i < 2 ? 'Bass' : 'Lead' })),
    };
  };

  it('one row per part under its group; Texture shows only rows with a block, else its first', () => {
    const p = parted([
      chord('c1', 0),
      { ...walkAt('w1', 1, 3), target: { part: 'Lead' } },
      { id: 'l1', type: 'level', at: 2, gain: 0.5, over: 1, target: { part: 'Bass' } },
      { id: 'l2', type: 'level', at: 2, gain: 0.5, over: 1 },
    ]);
    const L = layout(p);
    expect(titles(L)).toEqual(['Key', 'Chords', 'Texture Lead', 'Level Bass', 'All']);
    expect(L.blocks.get('w1')?.row).toBe(rowKey('texture', 'Lead'));
    expect(L.blocks.get('l1')?.row).toBe('level:Bass');
    expect(L.blocks.get('l2')?.row).toBe('level:');
    const q = parted([chord('c1', 0)]);
    expect(titles(layout(q))).toEqual(['Key', 'Chords', 'Texture Bass']);
  });
});

function walkAt(id: string, at: number, until: number): Moment {
  return {
    id,
    type: 'walk',
    at,
    until,
    grid: 0.5,
    density: 0.5,
    steps: [-1, 1],
    stepGlide: 0.2,
  } as Moment;
}

describe('M10 acceptance: every moment on exactly one row', () => {
  for (const f of files) {
    it(f.slice(ROOT.length + 1), () => {
      const p = load(f);
      const score = compile(p);
      const view = rowsOf(p, score);
      const L = laneRowsLayout(view, 40);
      const shown = new Set(L.rows.map((r) => r.key));
      for (const m of p.moments) {
        // The rows that show it: its block(s) (a progression's chords share one row) or its dot.
        const rows = new Set(
          view.rows
            .filter((r) => r.blocks.some((b) => b.id === m.id))
            .map((r) => rowKey(r.row, r.part)),
        );
        const dot = view.dots.some((d) => d.id === m.id);
        expect(rows.size + (dot ? 1 : 0), `${m.id} (${m.type})`).toBe(1);
        const place = dot ? L.dots.get(m.id) : L.blocks.get(m.id);
        expect(place, `${m.id} (${m.type}) placed`).toBeDefined();
        expect(shown.has(place!.row), `${m.id} on a shown row`).toBe(true);
        if (!dot) expect(place!.row).toBe([...rows][0]);
      }
    });
  }
});
