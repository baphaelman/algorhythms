/**
 * The poster workspace's editing logic (PLAN.md §15 M14 P3): the form's poster fields in the
 * doc and back, selection from hits (groups vs Alt), snapping, align, placing boxes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import { DEFAULT_EXPORT_FORM, type ExportForm } from '../../../src/app/export-options';
import {
  changedFields,
  docWithForm,
  formWithDoc,
  onlyPosterDiffers,
  posterFields,
} from '../../../src/app/poster-doc';
import {
  CLEAR_MEMBER,
  alignBox,
  placeRect,
  selectedBoxes,
  selectionAt,
  selectionFrame,
  selectionOfHit,
  snapMove,
  snapResize,
  snapTargets,
  textName,
  withTextSize,
} from '../../../src/app/poster-select';
import { layerOf, layoutPoster, setMemberStyle, textsOf, type Rect } from '../../../src/render';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const lay = (doc?: PosterDoc) =>
  layoutPoster({
    compiled: KITE_C,
    piece: KITE,
    ...(doc ? { doc } : {}),
    look: { ...layoutPoster({ compiled: KITE_C, piece: KITE }).look, guides: true, guideLabels: true },
  });
const CTX = { dark: false, duration: KITE_C.duration, loop: null };

const form = (p: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_EXPORT_FORM, ...p });

describe('the form in the doc', () => {
  it('stores only what differs from the defaults, the theme resolved', () => {
    expect(docWithForm(undefined, posterFields(form()), CTX)).toEqual({ look: { theme: 'light' } });
    expect(docWithForm(undefined, posterFields(form()), { ...CTX, dark: true })).toEqual({
      look: { theme: 'dark' },
    });
    const d = docWithForm(
      undefined,
      posterFields(
        form({
          posterWidth: 2160,
          posterHeight: 2160,
          posterRows: 3,
          posterHud: ['key'],
          look: {
            ...DEFAULT_EXPORT_FORM.look,
            glow: 0.4,
            colours: { ...DEFAULT_EXPORT_FORM.look.colours, lines: 'one', one: '#336699' },
          },
        }),
      ),
      CTX,
    )!;
    expect(d.size).toEqual({ w: 2160, h: 2160 });
    expect(d.rows).toBe(3);
    expect(d.look).toEqual({
      theme: 'light',
      glow: 0.4,
      hud: ['key'],
      coloursForm: { lines: 'one', one: '#336699' },
    });
  });

  it('round-trips through formWithDoc over any viewer form', () => {
    const f = form({
      posterWidth: 2480,
      posterHeight: 3508,
      posterRows: 4,
      section: 'custom',
      sectionSpan: { start: 10, end: 40 },
      posterPieceRange: true,
      look: { ...DEFAULT_EXPORT_FORM.look, theme: 'dark', guides: true, lineWidth: 1.75 },
    });
    const d = docWithForm(undefined, posterFields(f), CTX)!;
    expect(d.section).toEqual({ start: 10, end: 40 });
    // Another viewer's remembered options don't leak in: the doc is over the defaults.
    const other = form({ posterRows: 7, look: { ...DEFAULT_EXPORT_FORM.look, glow: 0.9 } });
    const back = formWithDoc(other, d);
    expect(changedFields(posterFields(back), posterFields(f))).toEqual([]);
  });

  it('keeps the objects; a Look segment clears the groups it sets', () => {
    const doc: PosterDoc = {
      layers: [{ id: 'part:', hidden: true }],
      groups: { sectionLines: { visible: false, width: 2 }, momentLabels: { visible: true } },
      margins: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
    };
    const prev = posterFields(form());
    const next = posterFields(
      form({ look: { ...DEFAULT_EXPORT_FORM.look, sections: false, markers: true } }),
    );
    const d = docWithForm(doc, next, CTX, prev)!;
    expect(d.layers).toEqual(doc.layers);
    expect(d.margins).toEqual(doc.margins);
    expect(d.groups).toEqual({ sectionLines: { width: 2 }, momentLabels: { visible: true } });
  });

  it('a poster-only change needs no compile', () => {
    expect(onlyPosterDiffers(KITE, { ...KITE, poster: { rows: 2 } })).toBe(true);
    expect(onlyPosterDiffers(KITE, { ...KITE, poster: { rows: 2 }, moments: [] })).toBe(false);
    expect(onlyPosterDiffers(KITE, { ...KITE })).toBe(false);
  });
});

describe('selection', () => {
  const L = lay();

  it('a label selects its whole group; Alt one member', () => {
    const hz = L.objects.filter((o) => o.group === 'guideLabels');
    expect(hz.length).toBeGreaterThan(2);
    const o = hz[1];
    const cx = o.box.x + o.box.w / 2;
    const cy = o.box.y + o.box.h / 2;
    expect(selectionAt(L, cx, cy, false)).toEqual({ kind: 'group', group: 'guideLabels' });
    expect(selectionAt(L, cx, cy, true)).toEqual({
      kind: 'member',
      group: 'guideLabels',
      member: o.member,
    });
    // The group outlines every member; one member only itself.
    expect(selectedBoxes(L, { kind: 'group', group: 'guideLabels' })).toHaveLength(hz.length);
    expect(selectedBoxes(L, { kind: 'member', group: 'guideLabels', member: o.member })).toHaveLength(1);
  });

  it('layers and text boxes select themselves, with a frame for the handles', () => {
    const layerObj = L.objects.find((o) => o.type === 'layer')!;
    const sel = selectionOfHit(L, { object: layerObj, index: 0, group: 'layers', member: '' }, true);
    expect(sel.kind).toBe('layer');
    expect(selectionFrame(L, sel)).toEqual(layerOf(L, (sel as { id: string }).id)!.bounds);
    const title = L.objects.find((o) => o.type === 'text' && o.member === 'title')!;
    const t = selectionAt(L, title.box.x + 2, title.box.y + title.box.h / 2, false);
    expect(t).toEqual({ kind: 'text', id: 'title' });
    expect(selectionFrame(L, t)).toEqual(title.type === 'text' ? title.frame : null);
    expect(selectionFrame(L, { kind: 'group', group: 'guideLabels' })).toBeNull();
  });

  it('names text boxes', () => {
    expect(textName({ kind: 'title', text: '{name}' })).toBe('Title');
    expect(textName({ kind: 'free', text: 'Hello   there' })).toBe('Hello there');
  });
});

describe('snapping and align', () => {
  const L = lay();
  const T = snapTargets(L, null);

  it('a moved box snaps by an edge or its centre to the nearest line, per axis', () => {
    const box: Rect = { x: L.width / 2 - 52, y: 13, w: 100, h: 40 };
    const s = snapMove(box, T, 5);
    expect(s.box.x + s.box.w / 2).toBeCloseTo(L.width / 2);
    expect(s.guides.x).toBeCloseTo(L.width / 2);
    // Too far from anything: unchanged.
    const far = snapMove({ x: 401, y: 777, w: 3, h: 3 }, { xs: [0], ys: [0] }, 5);
    expect(far.box).toEqual({ x: 401, y: 777, w: 3, h: 3 });
    expect(far.guides).toEqual({});
  });

  it('a resize snaps the moving edge only', () => {
    const box: Rect = { x: 100, y: 100, w: 200, h: 100 };
    const s = snapResize(box, 'se', { dx: L.content.x + L.content.w - 300 - 3, dy: 0 }, T, 5);
    expect(box.x + box.w + s.dx).toBeCloseTo(L.content.x + L.content.w);
    expect(s.guides.x).toBeCloseTo(L.content.x + L.content.w);
    const w = snapResize(box, 'e', { dx: 0, dy: 50 }, { xs: [], ys: [150] }, 5);
    expect(w.dy).toBe(50); // an edge handle moves one axis
  });

  it('aligns against the margins', () => {
    const c = L.content;
    const b: Rect = { x: 10, y: 10, w: 100, h: 50 };
    expect(alignBox(b, c, 'left').x).toBe(c.x);
    expect(alignBox(b, c, 'right').x).toBe(c.x + c.w - 100);
    expect(alignBox(b, c, 'centre').x).toBe(c.x + (c.w - 100) / 2);
    expect(alignBox(b, c, 'bottom').y).toBe(c.y + c.h - 50);
    expect(alignBox(b, c, 'middle').y).toBe(c.y + (c.h - 50) / 2);
  });
});

describe('placing', () => {
  const L = lay();

  it('a moved layer lands where it was dragged', () => {
    const id = L.layers[0].id;
    const b = L.layers[0].bounds!;
    const to = { ...b, x: b.x + 120, y: b.y - 40, w: b.w * 0.5 };
    const d = placeRect(undefined, L, { kind: 'layer', id }, b, to);
    const L2 = lay(d);
    const got = layerOf(L2, id)!.bounds!;
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(got[k]).toBeCloseTo(to[k], 3);
  });

  it('a moved text box becomes placed, at the frame it was dragged to', () => {
    const o = L.objects.find((x) => x.type === 'text' && x.member === 'credit')!;
    const f = o.type === 'text' ? o.frame : o.box;
    const to = { ...f, x: f.x + 50, y: f.y + 300 };
    const d = placeRect(undefined, L, { kind: 'text', id: 'credit' }, f, to);
    expect(textsOf(d).find((t) => t.id === 'credit')!.box).toBeDefined();
    const o2 = lay(d).objects.find((x) => x.type === 'text' && x.member === 'credit')!;
    expect(o2.type === 'text' && o2.frame.y).toBeCloseTo(to.y, 3);
  });

  it('a moved label member is a nudge; Reset to group clears it', () => {
    const sel = { kind: 'member', group: 'guideLabels', member: 'x' } as const;
    const d = placeRect(undefined, L, sel, { x: 0, y: 0, w: 1, h: 1 }, { x: 24, y: -12, w: 1, h: 1 });
    const S = Math.min(L.width, L.height);
    expect(d!.members!.guideLabels!.x).toEqual({
      dx: Math.round((24 / S) * 1e4) / 1e4,
      dy: Math.round((-12 / S) * 1e4) / 1e4,
    });
    expect(setMemberStyle(d, 'guideLabels', 'x', CLEAR_MEMBER)?.members).toBeUndefined();
  });

  it('text size: an automatic box takes a style size; a placed one scales its box', () => {
    const auto = withTextSize(undefined, L, 'title', 0.05);
    expect(textsOf(auto).find((t) => t.id === 'title')!.style?.size).toBe(0.05);
    const placed: PosterDoc = {
      texts: [{ id: 'a', kind: 'free', text: 'Hi', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } }],
    };
    const d = withTextSize(placed, L, 'a', 0.08);
    const box = textsOf(d)[0].box!;
    const S = Math.min(L.width, L.height);
    expect(box.h).toBeCloseTo((0.08 * S * 1.2) / L.height, 6);
    expect(box.w / box.h).toBeCloseTo(0.2 / 0.05, 6);
  });
});
