/**
 * Selecting and placing things on the poster's artboard (PLAN.md §15 M14 "Everything drawn is
 * an object you can select", "Resizing", "Margins"): what a click selects, what a selection
 * outlines, snapping while moving and resizing, align to the margins. Pure, in artboard px.
 */

import type {
  PosterBox,
  PosterDoc,
  PosterGroup,
  PosterMemberStyle,
  PosterText,
} from '../core/types';
import {
  groupObjects,
  hitTest,
  layerBoxFor,
  layerOf,
  layerRowBoxFor,
  putText,
  rowAt,
  rowBoxFor,
  setLayer,
  setLayerRow,
  setMemberStyle,
  setRowBox,
  textBoxFor,
  textsOf,
  type Handle,
  type PosterHit,
} from '../render/poster-edit';
import { posterMeasure } from './poster-export';
import {
  LINE_HEIGHT,
  isLabelGroup,
  isMarkGroup,
  textDefaults,
  textFont,
  textPad,
  type PosterLayout,
  type Rect,
  type TextObject,
} from '../render/poster-layout';

/**
 * What is selected: a music layer (with `row`, that layer in one row only), a row as a block,
 * a text box, a whole label or line group, one member of a group (Alt-click), or the background
 * (a click on the paper where nothing is: its gradient's handles show).
 */
export type PosterSelection =
  | { kind: 'background' }
  | { kind: 'layer'; id: string; row?: number }
  | { kind: 'row'; row: number }
  | { kind: 'text'; id: string }
  | { kind: 'group'; group: PosterGroup }
  | { kind: 'member'; group: PosterGroup; member: string };

export function sameSelection(a: PosterSelection | null, b: PosterSelection | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The selection a hit makes: a label or line selects its whole group, or (Alt) itself; a
 * layer's lines select that layer in their row, or (Alt) in every row. With one row, the layer.
 */
export function selectionOfHit(
  layout: PosterLayout,
  hit: PosterHit,
  alt: boolean,
): PosterSelection {
  const o = hit.object;
  if (o.type === 'layer') {
    const id = layout.layers[o.layer].id;
    return alt || layout.rows.length < 2
      ? { kind: 'layer', id }
      : { kind: 'layer', id, row: o.row };
  }
  if (o.type === 'text') return { kind: 'text', id: o.member };
  return alt
    ? { kind: 'member', group: o.group, member: o.member }
    : { kind: 'group', group: o.group };
}

/**
 * What a click at (x, y) selects: the topmost object; else, with two rows or more, the row
 * under it (its empty plot or label zone); else the background.
 */
export function selectionAt(
  layout: PosterLayout,
  x: number,
  y: number,
  alt: boolean,
  tolerance?: number,
): PosterSelection | null {
  const hit = hitTest(layout, x, y, tolerance);
  if (hit) return selectionOfHit(layout, hit, alt);
  const r = layout.rows.length > 1 ? rowAt(layout, x, y) : null;
  return r ? { kind: 'row', row: r.index } : { kind: 'background' };
}

/** A text object's frame (the box its handles sit on). */
function textFrame(layout: PosterLayout, id: string): Rect | null {
  for (const o of layout.objects) if (o.type === 'text' && o.member === id) return o.frame;
  return null;
}

/**
 * The box a selection moves and resizes by (layer: its lines' bounds, in one row or all; row:
 * its rect; text: its frame; one label: its box, moved only), or null (a group, or nothing drawn).
 */
export function selectionFrame(layout: PosterLayout, sel: PosterSelection | null): Rect | null {
  if (!sel) return null;
  if (sel.kind === 'layer') {
    const L = layerOf(layout, sel.id);
    return (sel.row === undefined ? L?.bounds : L?.rowBounds[sel.row]) ?? null;
  }
  if (sel.kind === 'row') return layout.rows[sel.row]?.rect ?? null;
  if (sel.kind === 'text') return textFrame(layout, sel.id);
  if (sel.kind === 'member' && isLabelGroup(sel.group)) {
    const o = groupObjects(layout, sel.group, sel.member)[0];
    return o ? o.box : null;
  }
  return null;
}

/** Whether the selection has resize handles (layers, rows and text boxes). */
export const resizable = (sel: PosterSelection | null): boolean =>
  sel?.kind === 'layer' || sel?.kind === 'row' || sel?.kind === 'text';

/** The outlines a selection draws: every member of a group, else the selection's frame. */
export function selectedBoxes(layout: PosterLayout, sel: PosterSelection | null): Rect[] {
  if (!sel) return [];
  if (sel.kind === 'group' || sel.kind === 'member') {
    // Marks are drawn by the layers: nothing of their own to outline.
    if (isMarkGroup(sel.group)) return [];
    const m = sel.kind === 'member' ? sel.member : undefined;
    return groupObjects(layout, sel.group, m).map((o) => o.box);
  }
  if (sel.kind === 'text') {
    const r = textOutline(layout, sel.id);
    return r ? [r] : [];
  }
  const f = selectionFrame(layout, sel);
  return f ? [f] : [];
}

/**
 * The box the selection's outline draws (a text box's outline, else its frame): what it snaps
 * by. Its edges are the frame's moved by a constant, so a snapped shift of it is the frame's.
 */
export function drawnFrame(layout: PosterLayout, sel: PosterSelection | null): Rect | null {
  if (sel?.kind === 'text') return textOutline(layout, sel.id);
  return selectionFrame(layout, sel);
}

// ---------------------------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------------------------

/** Lines a moving box snaps to (artboard px). */
export interface SnapTargets {
  xs: number[];
  ys: number[];
}

/**
 * The snap lines for moving `sel`, on what the artboard draws: the artboard's edges and centre,
 * the margins (the content box's edges and centre), every other layer's pieces in each row (for
 * a layer in one row, its other rows' too), every other text box's outline (`textOutline`), and
 * the other rows' (for a row). Each box gives its edges and centre.
 */
export function snapTargets(layout: PosterLayout, sel: PosterSelection | null): SnapTargets {
  const W = layout.width;
  const H = layout.height;
  const c = layout.content;
  const xs = [0, W / 2, W, c.x, c.x + c.w / 2, c.x + c.w];
  const ys = [0, H / 2, H, c.y, c.y + c.h / 2, c.y + c.h];
  const add = (r: Rect | null) => {
    if (!r) return;
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  };
  for (const L of layout.layers) {
    if (L.hidden) continue;
    if (sel?.kind === 'layer' && sel.id === L.id) {
      if (sel.row !== undefined) L.rowBounds.forEach((b, i) => i !== sel.row && add(b));
    } else if (sel?.kind !== 'row') L.rowBounds.forEach(add);
  }
  if (sel?.kind === 'row') for (const r of layout.rows) if (r.index !== sel.row) add(r.rect);
  for (const o of layout.objects) {
    if (o.type === 'text' && !(sel?.kind === 'text' && sel.id === o.member))
      add(textOutline(layout, o.member));
  }
  return { xs, ys };
}

/** The nearest target to any of `vals` within `tol`: the shift to it and the line hit. */
function nearest(
  vals: readonly number[],
  targets: readonly number[],
  tol: number,
): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const v of vals) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
  }
  return best;
}

/** Guide lines a snap shows (artboard px). */
export interface SnapGuides {
  x?: number;
  y?: number;
}

/** A moved box snapped by its edges and centre to the targets, each axis on its own. */
export function snapMove(
  box: Rect,
  targets: SnapTargets,
  tol: number,
): { box: Rect; guides: SnapGuides } {
  const sx = nearest([box.x, box.x + box.w / 2, box.x + box.w], targets.xs, tol);
  const sy = nearest([box.y, box.y + box.h / 2, box.y + box.h], targets.ys, tol);
  const guides: SnapGuides = {};
  if (sx) guides.x = sx.at;
  if (sy) guides.y = sy.at;
  return { box: { ...box, x: box.x + (sx?.d ?? 0), y: box.y + (sy?.d ?? 0) }, guides };
}

/**
 * A resize drag's (dx, dy) snapped so the moving edges land on targets: the handle's edge
 * (`e`: right, `w`: left, `s`: bottom, `n`: top) after the drag, each axis on its own.
 */
export function snapResize(
  box: Rect,
  handle: Handle,
  delta: { dx: number; dy: number },
  targets: SnapTargets,
  tol: number,
): { dx: number; dy: number; guides: SnapGuides } {
  const guides: SnapGuides = {};
  let { dx, dy } = delta;
  const ex = handle.includes('e') ? box.x + box.w : handle.includes('w') ? box.x : null;
  const ey = handle.includes('s') ? box.y + box.h : handle.includes('n') ? box.y : null;
  if (ex !== null) {
    const s = nearest([ex + dx], targets.xs, tol);
    if (s) {
      dx += s.d;
      guides.x = s.at;
    }
  }
  if (ey !== null) {
    const s = nearest([ey + dy], targets.ys, tol);
    if (s) {
      dy += s.d;
      guides.y = s.at;
    }
  }
  return { dx, dy, guides };
}

// ---------------------------------------------------------------------------------------------
// Align
// ---------------------------------------------------------------------------------------------

export type AlignTo = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** `box` aligned against the margins (the content box). */
export function alignBox(box: Rect, content: Rect, how: AlignTo): Rect {
  switch (how) {
    case 'left':
      return { ...box, x: content.x };
    case 'centre':
      return { ...box, x: content.x + (content.w - box.w) / 2 };
    case 'right':
      return { ...box, x: content.x + content.w - box.w };
    case 'top':
      return { ...box, y: content.y };
    case 'middle':
      return { ...box, y: content.y + (content.h - box.h) / 2 };
    case 'bottom':
      return { ...box, y: content.y + content.h - box.h };
  }
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const GROUP_NAMES: Readonly<Record<PosterGroup, string>> = {
  sectionLabels: 'Section labels',
  momentLabels: 'Moment labels',
  rowLabels: 'Row times',
  guideLabels: 'Hz labels',
  pitchLabels: 'Pitch guide labels',
  hud: 'HUD readouts',
  sectionLines: 'Section lines',
  momentLines: 'Moment lines',
  guideLines: 'Octave guides',
  pitchLines: 'Pitch guides',
  beatLines: 'Bar and beat lines',
  rowNames: 'Row labels',
  pulseMarks: 'Pulse marks',
};

/** A text box's name in the panels: its kind, or its first words. */
export function textName(t: Pick<PosterText, 'kind' | 'text'>): string {
  if (t.kind === 'title') return 'Title';
  if (t.kind === 'subtitle') return 'Subtitle';
  if (t.kind === 'credit') return 'Credits';
  const s = t.text.replace(/\s+/g, ' ').trim();
  return s ? (s.length > 24 ? `${s.slice(0, 23)}…` : s) : 'Text';
}

/** The text box `id` of the doc (the defaults when it has none). */
export const textOf = (doc: PosterDoc | undefined, id: string): PosterText | undefined =>
  textsOf(doc).find((t) => t.id === id);

/** Whether the selection still names something in the doc's layout (pruned after undo). */
export function selectionExists(
  layout: PosterLayout,
  doc: PosterDoc | undefined,
  sel: PosterSelection,
): boolean {
  // A line without a layer of its own (or hidden) is still listed: it stays selectable.
  if (sel.kind === 'row') return sel.row < layout.rows.length;
  if (sel.kind === 'layer') {
    if (sel.row !== undefined && sel.row >= layout.rows.length) return false;
    return sel.id.startsWith('line:') || layout.layers.some((l) => l.id === sel.id);
  }
  if (sel.kind === 'text') return textOf(doc, sel.id) !== undefined;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------------------------

/** Nudges are stored to this many decimals (fractions of the shorter side). */
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * The doc with the selection's frame (`from`, in `layout`) moved or resized to `to` (artboard
 * px): a layer's box (`layerBoxFor`) or its box in one row (`layerRowBoxFor`), a row's box, a
 * text box's box (`textBoxFor`; an automatic box becomes a placed one), or one label's nudge.
 * Unchanged for a group or a layer that draws nothing.
 */
export function placeRect(
  doc: PosterDoc | undefined,
  layout: PosterLayout,
  sel: PosterSelection,
  from: Rect,
  to: Rect,
): PosterDoc | undefined {
  if (sel.kind === 'layer' && sel.row !== undefined) {
    const r = layout.rows[sel.row];
    const box = r && layerRowBoxFor(layout, sel.id, sel.row, to);
    return box ? setLayerRow(doc, sel.id, r.key, box) : doc;
  }
  if (sel.kind === 'layer') {
    const box = layerBoxFor(layout, sel.id, to);
    return box ? setLayer(doc, sel.id, { box }) : doc;
  }
  if (sel.kind === 'row') {
    const r = layout.rows[sel.row];
    return r ? setRowBox(doc, r.key, rowBoxFor(layout, to)) : doc;
  }
  if (sel.kind === 'text') {
    const t = textOf(doc, sel.id);
    return t ? placeText(doc, layout, t, from, to) : doc;
  }
  if (sel.kind === 'member') {
    const S = Math.min(layout.width, layout.height);
    const m = doc?.members?.[sel.group]?.[sel.member];
    const dx = round4((m?.dx ?? 0) + (to.x - from.x) / S);
    const dy = round4((m?.dy ?? 0) + (to.y - from.y) / S);
    return setMemberStyle(doc, sel.group, sel.member, {
      dx: dx === 0 ? undefined : dx,
      dy: dy === 0 ? undefined : dy,
    });
  }
  return doc;
}

const textObject = (layout: PosterLayout, id: string): TextObject | undefined => {
  for (const o of layout.objects) if (o.type === 'text' && o.member === id) return o;
  return undefined;
};

/**
 * Text box `t` with its frame `from` moved or resized to `to`. An automatic box (in the text
 * band) becomes a placed one as wide as its text (`sizing: 'auto'`). A sized box: a change of
 * height scales its type (an auto box stays as wide as its text, a wrapping one takes `to`'s
 * width); a change of width alone makes it wrap at that width. A box without `sizing` takes
 * `to` (its type follows the height).
 */
function placeText(
  doc: PosterDoc | undefined,
  layout: PosterLayout,
  t: PosterText,
  from: Rect,
  to: Rect,
): PosterDoc | undefined {
  const box = textBoxFor(layout, to);
  const sizing = t.sizing ?? (t.box ? undefined : 'auto');
  if (!sizing) return putText(doc, { ...t, box });
  const S = Math.min(layout.width, layout.height);
  const o = textObject(layout, t.id);
  const size0 = o ? o.size / S : (t.style?.size ?? textDefaults(t.kind).size);
  const dh = from.h > 0 && Math.abs(to.h - from.h) > 1e-6;
  const dw = Math.abs(to.w - from.w) > 1e-6;
  const size = dh ? (size0 * to.h) / from.h : size0;
  return putText(doc, {
    ...t,
    box,
    sizing: !dh && dw ? 'wrap' : sizing,
    style: { ...t.style, size: Math.round(size * 1e5) / 1e5 },
  });
}

/**
 * A new text box ("Text", in the free kind's type) with its top left at (x, y): as wide as its
 * text, or `width` wide with wrapping lines (a drag with the Text tool).
 */
export function newText(
  layout: PosterLayout,
  id: string,
  x: number,
  y: number,
  width?: number,
): PosterText {
  const r = newTextRect(layout, x, y, width);
  return {
    id,
    kind: 'free',
    text: 'Text',
    sizing: width === undefined ? 'auto' : 'wrap',
    box: textBoxFor(layout, r),
  };
}

/** Where `newText` puts its box (artboard px): kept on the artboard. */
export function newTextRect(layout: PosterLayout, x: number, y: number, width?: number): Rect {
  const S = Math.min(layout.width, layout.height);
  const size = textDefaults('free').size * S;
  const h = LINE_HEIGHT * size;
  const w = Math.max(1, width ?? posterMeasure()('Text', textFont(layout, 'free', size), 0));
  return {
    x: Math.max(0, Math.min(x, layout.width - Math.min(w, layout.width))),
    y: Math.max(0, Math.min(y, layout.height - h)),
    w,
    h,
  };
}

/** The side space a new text box's outline adds to its frame (`textOutline`), artboard px. */
export const newTextPad = (layout: PosterLayout): number =>
  textPad(textDefaults('free').size * Math.min(layout.width, layout.height));

/** `r` widened by `pad` on the left and right: a text frame's outline. */
export const outlineOf = (r: Rect, pad: number): Rect => ({
  x: r.x - pad,
  y: r.y,
  w: r.w + 2 * pad,
  h: r.h,
});

/**
 * The Text tool's ghost at the pointer (x, y): the new box's frame and the outline it will draw
 * (`box`, what the ghost shows), snapped by that outline unless `tol` is 0.
 */
export function textGhost(
  layout: PosterLayout,
  x: number,
  y: number,
  tol: number,
): { box: Rect; frame: Rect; guides: SnapGuides } {
  const pad = newTextPad(layout);
  const r = newTextRect(layout, x, y);
  if (!(tol > 0)) return { box: outlineOf(r, pad), frame: r, guides: {} };
  const s = snapMove(outlineOf(r, pad), snapTargets(layout, null), tol);
  return { box: s.box, frame: { ...r, x: s.box.x + pad, y: s.box.y }, guides: s.guides };
}

/**
 * The outline a selected text box draws (artboard px): its frame, widened by the space its line
 * box leaves above and below the ink, so the gap round the text is even.
 */
export function textOutline(layout: PosterLayout, id: string): Rect | null {
  const o = textObject(layout, id);
  if (!o) return null;
  const p = textPad(o.size);
  return { x: o.frame.x - p, y: o.frame.y, w: o.frame.w + 2 * p, h: o.frame.h };
}

/**
 * The doc with the selection moved by (dx, dy) artboard px from where the doc has it (so a
 * quick run of nudges adds up before the artboard redraws): a stored box shifts; an automatic
 * one is placed from `layout` first.
 */
export function nudgeDoc(
  doc: PosterDoc | undefined,
  layout: PosterLayout,
  sel: PosterSelection,
  dx: number,
  dy: number,
): PosterDoc | undefined {
  const shift = (b: PosterBox, fw: number, fh: number): PosterBox => ({
    ...b,
    x: b.x + dx / fw,
    y: b.y + dy / fh,
  });
  if (sel.kind === 'layer' && sel.row !== undefined) {
    const r = layout.rows[sel.row];
    const fr = layerOf(layout, sel.id)?.frames[sel.row];
    const box = r && doc?.layers?.find((l) => l.id === sel.id)?.rows?.[r.key];
    if (box && fr?.base) return setLayerRow(doc, sel.id, r.key, shift(box, fr.base.w, fr.base.h));
  } else if (sel.kind === 'row') {
    const r = layout.rows[sel.row];
    const box = r && doc?.rowBoxes?.[r.key];
    if (box) return setRowBox(doc, r.key, shift(box, layout.width, layout.height));
  } else if (sel.kind === 'layer') {
    const box = doc?.layers?.find((l) => l.id === sel.id)?.box;
    const L = layerOf(layout, sel.id);
    if (box && L) {
      const frame = L.kind === 'line' ? layerOf(layout, `part:${L.part}`)?.box : null;
      const fw = frame ? frame.w : layout.width;
      const fh = frame ? frame.h : layout.height;
      return setLayer(doc, sel.id, { box: shift(box, fw, fh) });
    }
  } else if (sel.kind === 'text') {
    const t = textOf(doc, sel.id);
    if (t?.box) return putText(doc, { ...t, box: shift(t.box, layout.width, layout.height) });
  }
  const f = selectionFrame(layout, sel);
  return f ? placeRect(doc, layout, sel, f, { ...f, x: f.x + dx, y: f.y + dy }) : doc;
}

/** Every member style field, cleared: "Reset to group". */
export const CLEAR_MEMBER: { [K in keyof Required<PosterMemberStyle>]: undefined } = {
  visible: undefined,
  size: undefined,
  weight: undefined,
  colour: undefined,
  opacity: undefined,
  side: undefined,
  along: undefined,
  offset: undefined,
  width: undefined,
  dashed: undefined,
  extent: undefined,
  travels: undefined,
  dx: undefined,
  dy: undefined,
};

/**
 * The type size of text box `id` (a fraction of the shorter side): an automatic box's style
 * size; a placed box sizes to its height, so its box scales (from its top left).
 */
export function textSizeOf(layout: PosterLayout, id: string): number {
  const S = Math.min(layout.width, layout.height);
  const o = layout.objects.find((x) => x.type === 'text' && x.member === id);
  return o && o.type === 'text' ? o.size / S : 0;
}

export function withTextSize(
  doc: PosterDoc | undefined,
  layout: PosterLayout,
  id: string,
  size: number,
): PosterDoc | undefined {
  const t = textOf(doc, id);
  if (!t || !(size > 0)) return doc;
  if (!t.box || t.sizing) return putText(doc, { ...t, style: { ...t.style, size } });
  const S = Math.min(layout.width, layout.height);
  const lines = Math.max(1, t.text.split('\n').length);
  const h = (size * S * lines * LINE_HEIGHT) / layout.height;
  const k = t.box.h > 0 ? h / t.box.h : 1;
  return putText(doc, { ...t, box: { ...t.box, w: t.box.w * k, h } });
}
