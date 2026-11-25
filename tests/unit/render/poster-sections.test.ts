/** Rows by sections, row labels and the pulse marks' group (M14 P5). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import {
  EXPORT_LOOK,
  GROUP_FIELDS,
  POSTER_GROUPS,
  layoutPoster,
  posterIssues,
  posterSectionItems,
  posterTimeAt,
  sectionRows,
  setGroupStyle,
  setRowSection,
  setRowsBy,
  type LabelObject,
  type Look,
} from '../../../src/render';
import { intersects } from '../../../src/render/poster-layout';
import { MIN_SECTION } from '../../../src/render/section';

const ROOT = join(import.meta.dirname, '../../..');
function song(name: string): Piece {
  const r = parsePiece(
    JSON.parse(readFileSync(join(ROOT, 'examples/songs', `${name}.algorhythms.json`), 'utf8')),
  );
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

describe('sectionRows', () => {
  const S = [
    { id: 'b', t: 20, label: 'Verse' },
    { id: 'a', t: 0, label: 'Intro' },
    { id: 'c', t: 40, label: 'Chorus' },
    { id: 'd', t: 60, label: 'Verse' },
  ];

  it('each section starts a row, in time order, labelled as the section', () => {
    const { items, rows } = sectionRows(S, undefined, 0, 80);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows).toEqual([
      { start: 0, end: 20, id: 'a', label: 'Intro' },
      { start: 20, end: 40, id: 'b', label: 'Verse' },
      { start: 40, end: 60, id: 'c', label: 'Chorus' },
      { start: 60, end: 80, id: 'd', label: 'Verse' },
    ]);
    expect(items[0].canJoin).toBe(false);
    expect(items.every((i) => i.starts && i.newRow)).toBe(true);
  });

  it('New row off joins the row before; row labels are stored over the section label', () => {
    const { items, rows } = sectionRows(S, { c: { join: true }, d: { label: 'A′' } }, 0, 80);
    expect(rows.map((r) => [r.start, r.end, r.label])).toEqual([
      [0, 20, 'Intro'],
      [20, 60, 'Verse'],
      [60, 80, 'A′'],
    ]);
    expect(items.find((i) => i.id === 'c')).toMatchObject({ newRow: false, starts: false });
  });

  it('music before the first section is a row of its own (start)', () => {
    const { items, rows } = sectionRows(
      S.filter((s) => s.id !== 'a'),
      { start: { label: 'Pre' } },
      0,
      80,
    );
    expect(items[0]).toMatchObject({ id: 'start', section: '', label: 'Pre', canJoin: false });
    expect(rows[0]).toEqual({ start: 0, end: 20, id: 'start', label: 'Pre' });
  });

  it('only the sections inside the span; the first one there opens it', () => {
    const { items, rows } = sectionRows(S, undefined, 25, 65);
    expect(items.map((i) => i.id)).toEqual(['start', 'c', 'd']);
    expect(rows.map((r) => [r.start, r.end])).toEqual([
      [25, 40],
      [40, 60],
      [60, 65],
    ]);
  });

  it('caps: at most 8 rows, none under MIN_SECTION (the shortest joins its neighbour)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, t: i * 10, label: `S${i}` }));
    many.push({ id: 'tiny', t: 115, label: 'Tiny' });
    const { items, rows } = sectionRows(many, undefined, 0, 116);
    expect(rows.length).toBeLessThanOrEqual(8);
    for (const r of rows) expect(r.end - r.start).toBeGreaterThanOrEqual(MIN_SECTION);
    expect(rows[0].start).toBe(0);
    expect(rows.at(-1)!.end).toBe(116);
    for (let i = 1; i < rows.length; i++) expect(rows[i].start).toBe(rows[i - 1].end);
    expect(items.find((i) => i.id === 'tiny')!.starts).toBe(false);
    expect(items.filter((i) => i.starts)).toHaveLength(rows.length);
  });
});

describe('layout by sections', () => {
  const piece = song('kite-day');
  const compiled = compile(piece);
  const doc: PosterDoc = setRowsBy(undefined, 'sections')!;

  it('rows start at the sections, share one time scale and are left-aligned', () => {
    const L = layoutPoster({ compiled, piece, doc });
    const items = posterSectionItems(compiled, piece, doc);
    const starts = items.filter((i) => i.starts);
    expect(L.rows.map((r) => r.start)).toEqual(starts.map((i) => i.t));
    expect(L.rows.map((r) => r.section)).toEqual(starts.map((i) => i.id));
    expect(L.rows.length).toBeGreaterThan(1);
    const pps = L.rows.map((r) => r.plot.w / (r.end - r.start));
    for (const v of pps) expect(v).toBeCloseTo(pps[0], 6);
    for (const r of L.rows) expect(r.plot.x).toBeCloseTo(L.rows[0].plot.x, 9);
    expect(L.sectionRows).toEqual(items);
  });

  it('the playhead (posterTimeAt) runs through each section row on one time scale', () => {
    const L = layoutPoster({ compiled, piece, doc });
    const pps = L.rows[0].plot.w / (L.rows[0].end - L.rows[0].start);
    for (const r of L.rows) {
      const mid = (r.start + r.end) / 2;
      const at = posterTimeAt(L, mid)!;
      expect(at.row).toBe(r.index);
      expect(at.x).toBeCloseTo(r.plot.x + (mid - r.start) * pps, 6);
      expect(at.y0).toBe(r.plot.y);
    }
  });

  it('row labels sit left of each row, clear of the Hz labels and inside the margins', () => {
    const busy: Look = { ...EXPORT_LOOK, hud: [], guides: true, guideLabels: true };
    let d = setRowSection(doc, L0().rows[1].section!, { label: 'A′' });
    d = setRowSection(d, L0().rows[0].section!, { label: 'Opening' });
    const L = layoutPoster({ compiled, piece, doc: d, look: busy });
    const names = L.objects.filter(
      (o): o is LabelObject => o.type === 'label' && o.group === 'rowNames',
    );
    expect(names.map((n) => n.runs[0].text)).toEqual(
      L.rows.map((r) => r.name).filter((t): t is string => !!t),
    );
    expect(names[0].runs[0].text).toBe('Opening');
    expect(names[1].runs[0].text).toBe('A′');
    const guides = L.objects.filter((o) => o.type === 'label' && o.group === 'guideLabels');
    expect(guides.length).toBeGreaterThan(0);
    for (const n of names) {
      const row = L.rows[n.row!];
      expect(n.box.x + n.box.w).toBeLessThan(row.plot.x);
      expect(n.box.x).toBeGreaterThanOrEqual(L.content.x - 0.5);
      expect(n.box.y).toBeGreaterThanOrEqual(row.rect.y);
      for (const g of guides) expect(intersects(n.box, g.box)).toBe(false);
    }
    expect(posterIssues(L)).toEqual([]);
  });

  it('row labels are a label group: restyled as one, hidden by default with equal rows', () => {
    const big = setGroupStyle(doc, 'rowNames', { size: 1.5, colour: '#aa0000' });
    const L = layoutPoster({ compiled, piece, doc: big });
    const names = L.objects.filter(
      (o): o is LabelObject => o.type === 'label' && o.group === 'rowNames',
    );
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n.colour).toBe('#aa0000');
      expect(n.size).toBeCloseTo(14 * 1.5 * L.unit, 9);
    }
    const equal = layoutPoster({ compiled, piece, base: { rows: 3 } });
    expect(equal.labels.rowNames.visible).toBe(false);
    expect(equal.objects.some((o) => o.group === 'rowNames')).toBe(false);
    expect(equal.sectionRows).toBeNull();
  });

  function L0() {
    return layoutPoster({ compiled, piece, doc });
  }
});

describe('pulse marks group', () => {
  const piece = song('kite-day');
  const compiled = compile(piece);

  it('is registered among the groups with its fields', () => {
    expect(POSTER_GROUPS).toContain('pulseMarks');
    expect(POSTER_GROUPS).toContain('rowNames');
    expect(GROUP_FIELDS.pulseMarks).toEqual(['visible', 'size', 'width', 'opacity', 'colour']);
    for (const g of POSTER_GROUPS) expect(GROUP_FIELDS[g]).toContain('visible');
  });

  it('its style reaches the drawing (style.pulseStyle); visibility follows the Look', () => {
    const plain = layoutPoster({ compiled, piece });
    expect(plain.marks.pulseMarks).toEqual({ visible: true, size: 1, width: 1, opacity: 1 });
    expect(plain.style.pulseStyle).toBeUndefined();
    expect(plain.style.pulseMarks).toBeUndefined();
    const doc = setGroupStyle(undefined, 'pulseMarks', {
      size: 2,
      width: 1.5,
      opacity: 0.4,
      colour: '#ff00aa',
    });
    const L = layoutPoster({ compiled, piece, doc });
    expect(L.style.pulseStyle).toEqual({ size: 2, width: 1.5, opacity: 0.4, colour: '#ff00aa' });
    const off = layoutPoster({
      compiled,
      piece,
      doc: setGroupStyle(doc, 'pulseMarks', { visible: false }),
    });
    expect(off.style.pulseMarks).toBe(false);
    const lookOff = layoutPoster({
      compiled,
      piece,
      look: { ...EXPORT_LOOK, hud: [], pulseMarks: false },
    });
    expect(lookOff.marks.pulseMarks.visible).toBe(false);
    expect(lookOff.style.pulseMarks).toBe(false);
  });
});

describe('a picture in the doc', () => {
  it('becomes the background, over the Look background', () => {
    const piece = song('kite-day');
    const compiled = compile(piece);
    const doc: PosterDoc = { picture: { src: 'data:image/png;base64,AAAA', w: 8, h: 4, dim: 0.3 } };
    const L = layoutPoster({ compiled, piece, doc });
    expect(L.style.paint?.background).toMatchObject({
      kind: 'picture',
      picture: { fit: 'cover', x: 0.5, y: 0.5, dim: 0.3, w: 8, h: 4 },
    });
  });
});
