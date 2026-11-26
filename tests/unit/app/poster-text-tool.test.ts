/**
 * The Text tool and text box sizing (M14 follow-up, owner 2026-11-25): a new box is as wide as
 * its text (`sizing: 'auto'`) or wraps at a dragged width; the selection outline hugs the text;
 * moving and resizing keep the sizing; the ghost snaps.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc, PosterText } from '../../../src/core/types';
import {
  newText,
  newTextRect,
  placeRect,
  selectedBoxes,
  textGhost,
  textOutline,
  withTextSize,
} from '../../../src/app/poster-select';
import {
  layoutPoster,
  putText,
  refitPoster,
  textsOf,
  type PosterLayout,
  type Rect,
} from '../../../src/render';
import { textPad, wrapLine, type TextObject } from '../../../src/render/poster-layout';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const lay = (doc?: PosterDoc): PosterLayout =>
  layoutPoster({ compiled: KITE_C, piece: KITE, ...(doc ? { doc } : {}) });
const textObj = (L: PosterLayout, id: string): TextObject =>
  L.objects.find((o): o is TextObject => o.type === 'text' && o.member === id)!;
const L0 = lay();
const S = Math.min(L0.width, L0.height);
const add = (t: PosterText, doc?: PosterDoc) => putText(doc, t);

describe('a new text box', () => {
  it('a click: "Text" in the free type, as wide as its text, its frame hugging the ink', () => {
    const t = newText(L0, 'text1', 400, 500);
    expect(t).toMatchObject({ kind: 'free', text: 'Text', sizing: 'auto' });
    const L = lay(add(t));
    const o = textObj(L, 'text1');
    expect(o.size).toBeCloseTo(0.03 * S, 6);
    expect(o.frame.x).toBeCloseTo(400, 3);
    expect(o.frame.y).toBeCloseTo(500, 3);
    // As wide as the ink (no box wider than its text), as tall as one line.
    expect(o.frame.w).toBeCloseTo(o.box.w, 6);
    expect(o.frame.h).toBeCloseTo(1.2 * o.size, 6);
  });

  it('a drag: that width, lines wrap and the box grows down', () => {
    const t = newText(L0, 'text1', 400, 500, 300);
    expect(t.sizing).toBe('wrap');
    const words = 'one two three four five six seven eight nine ten';
    const L = lay(add({ ...t, text: words }));
    const o = textObj(L, 'text1');
    expect(o.frame.w).toBeCloseTo(300, 3);
    expect(o.runs.length).toBeGreaterThan(1);
    expect(o.frame.h).toBeCloseTo(o.runs.length * 1.2 * o.size, 6);
    expect(o.runs.map((x) => x.text).join(' ')).toBe(words);
    // The type keeps its size (it does not shrink to fit).
    expect(o.size).toBeCloseTo(0.03 * S, 6);
  });

  it('typing grows an auto box: wider for longer text, taller for more lines', () => {
    const t = newText(L0, 'text1', 400, 500);
    const a = textObj(lay(add(t)), 'text1').frame;
    const b = textObj(lay(add({ ...t, text: 'A much longer line of text' })), 'text1').frame;
    const c = textObj(lay(add({ ...t, text: 'Two\nlines' })), 'text1').frame;
    expect(b.w).toBeGreaterThan(a.w * 3);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(c.h).toBeCloseTo(2 * a.h, 6);
  });

  it('stays on the artboard', () => {
    const rr = newTextRect(L0, L0.width - 2, L0.height - 2);
    expect(rr.x + rr.w).toBeLessThanOrEqual(L0.width + 1e-9);
    expect(rr.y + rr.h).toBeLessThanOrEqual(L0.height + 1e-9);
  });
});

describe('the selection outline', () => {
  it('hugs the text with an even gap: the frame, widened by the line box space', () => {
    const t = newText(L0, 'text1', 400, 500);
    const L = lay(add(t));
    const o = textObj(L, 'text1');
    const out = textOutline(L, 'text1')!;
    const p = textPad(o.size);
    expect(selectedBoxes(L, { kind: 'text', id: 'text1' })).toEqual([out]);
    // The gap round the ink: left and right p, top and bottom the line box's own.
    expect(o.box.x - out.x).toBeCloseTo(p, 6);
    expect(out.x + out.w - (o.box.x + o.box.w)).toBeCloseTo(p, 6);
    expect(o.box.y - out.y).toBeCloseTo(p, 6);
    expect(out.y + out.h - (o.box.y + o.box.h)).toBeCloseTo(p, 6);
  });

  it('every default text box hugs its text, and still does after a move or a resize', () => {
    for (const id of ['title', 'credit']) {
      const f = textObj(L0, id).frame;
      const check = (L: PosterLayout) => {
        const o = textObj(L, id);
        const out = textOutline(L, id)!;
        expect(out.w - o.box.w).toBeCloseTo(2 * textPad(o.size), 4);
        expect(out.h - o.box.h).toBeCloseTo(2 * textPad(o.size), 4);
      };
      check(L0);
      const moved = placeRect(undefined, L0, { kind: 'text', id }, f, { ...f, x: f.x + 80 });
      expect(textsOf(moved).find((t) => t.id === id)!.sizing).toBe('auto');
      check(lay(moved));
      const L1 = lay(moved);
      const f1 = textObj(L1, id).frame;
      const big: Rect = { ...f1, w: f1.w * 1.5, h: f1.h * 1.5 };
      const resized = placeRect(moved, L1, { kind: 'text', id }, f1, big);
      const L2 = lay(resized);
      check(L2);
      expect(textObj(L2, id).size).toBeCloseTo(textObj(L1, id).size * 1.5, 1);
    }
  });
});

describe('moving and resizing a sized box', () => {
  const t = newText(L0, 'text1', 400, 500);
  const doc = add({ ...t, text: 'Hello there' });
  const L = lay(doc);
  const f = textObj(L, 'text1').frame;
  const sel = { kind: 'text', id: 'text1' } as const;

  it('a move keeps it auto', () => {
    const d = placeRect(doc, L, sel, f, { ...f, x: f.x + 10, y: f.y + 20 });
    const o = textObj(lay(d), 'text1');
    expect(textsOf(d).find((x) => x.id === 'text1')!.sizing).toBe('auto');
    expect(o.frame.x).toBeCloseTo(f.x + 10, 3);
    expect(o.frame.y).toBeCloseTo(f.y + 20, 3);
  });

  it('a height change scales the type; a width change alone makes it wrap at that width', () => {
    const tall = placeRect(doc, L, sel, f, { ...f, h: f.h * 2, w: f.w * 2 });
    expect(textObj(lay(tall), 'text1').size).toBeCloseTo(textObj(L, 'text1').size * 2, 2);
    const wide = placeRect(doc, L, sel, f, { ...f, w: f.w * 0.5 });
    const tw = textsOf(wide).find((x) => x.id === 'text1')!;
    expect(tw.sizing).toBe('wrap');
    const o = textObj(lay(wide), 'text1');
    expect(o.frame.w).toBeCloseTo(f.w * 0.5, 2);
    expect(o.runs.length).toBe(2);
  });

  it('the panel size sets the style size; Re-fit drops the box and the sizing', () => {
    const d = withTextSize(doc, L, 'text1', 0.06);
    expect(textObj(lay(d), 'text1').size).toBeCloseTo(0.06 * S, 6);
    const back = textsOf(refitPoster(d)).find((x) => x.id === 'text1')!;
    expect(back.box).toBeUndefined();
    expect(back.sizing).toBeUndefined();
  });

  it('a right-aligned auto box grows to the left', () => {
    const right = add({ ...t, style: { align: 'right' } });
    const a = textObj(lay(right), 'text1').frame;
    const b = textObj(
      lay(add({ ...t, text: 'Longer text', style: { align: 'right' } })),
      'text1',
    ).frame;
    expect(b.x + b.w).toBeCloseTo(a.x + a.w, 6);
    expect(b.x).toBeLessThan(a.x);
  });
});

describe('the ghost', () => {
  it('is the new box at the pointer, snapped to the margins (not with tol 0)', () => {
    const c = L0.content;
    const g = textGhost(L0, c.x + 3, 700, 6);
    expect(g.box.x).toBeCloseTo(c.x, 6);
    expect(g.guides.x).toBeCloseTo(c.x, 6);
    expect(textGhost(L0, c.x + 3, 700, 0).box.x).toBeCloseTo(c.x + 3, 6);
    expect(g.box.h).toBeCloseTo(newTextRect(L0, 0, 0).h, 6);
  });
});

describe('wrapLine', () => {
  const w = (s: string) => s.length;
  it('breaks at spaces; a long word stays whole', () => {
    expect(wrapLine('aa bb cc', 5, w)).toEqual(['aa bb', 'cc']);
    expect(wrapLine('abcdefgh ij', 4, w)).toEqual(['abcdefgh', 'ij']);
    expect(wrapLine('', 4, w)).toEqual(['']);
  });
});
