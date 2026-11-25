/**
 * Pure editing helpers for the poster workspace (PLAN.md §15 M14): resize handles, hit-testing,
 * the "Re-fit layout" check, where time sits on the poster, the automated layout check, and
 * small `PosterDoc` updates that keep the doc compact (only what differs from the defaults).
 * Everything works on a `PosterLayout` (poster-layout.ts) in artboard px.
 */

import type {
  PosterBox,
  PosterDoc,
  PosterGroup,
  PosterGroupStyle,
  PosterLayer,
  PosterMargins,
  PosterMemberStyle,
  PosterText,
  Seconds,
} from '../core/types';
import {
  DEFAULT_POSTER_TEXTS,
  inside,
  intersects,
  mapRect,
  toFractions,
  union,
  type LayerLayout,
  type PosterLayout,
  type PosterObject,
  type Rect,
} from './poster-layout';

// ---------------------------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------------------------

/** A resize handle: the four corners and the four edge midpoints. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export interface ResizeOptions {
  /** Keep the box's proportions. */
  shift?: boolean;
  /** Scale from the centre (the opposite side moves too). */
  alt?: boolean;
  /** Smallest width and height. @default 8 */
  min?: number;
}

/**
 * The box after dragging `handle` by (dx, dy): a corner moves two edges, an edge handle one,
 * the opposite side staying put (Alt: the centre stays put, both sides move). Shift keeps the
 * proportions: a corner follows the axis that changed more, an edge scales the other axis with
 * it about the box's centre line. Never smaller than `min` (nor flipped).
 */
export function resizeBox(
  box: Rect,
  handle: Handle,
  delta: { dx: number; dy: number },
  opts: ResizeOptions = {},
): Rect {
  const min = opts.min ?? 8;
  const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  const k = opts.alt ? 2 : 1;
  const w0 = Math.max(1e-9, box.w);
  const h0 = Math.max(1e-9, box.h);
  // Sizes without Shift are summed, not scaled, so whole-px drags give whole-px boxes.
  let w = hx ? Math.max(min, box.w + hx * delta.dx * k) : box.w;
  let h = hy ? Math.max(min, box.h + hy * delta.dy * k) : box.h;
  if (opts.shift) {
    const fx = w / w0;
    const fy = h / h0;
    const f = Math.max(
      hx && hy ? (Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy) : hx ? fx : fy,
      min / w0,
      min / h0,
    );
    w = w0 * f;
    h = h0 * f;
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = w === box.w ? box.x : opts.alt || !hx ? cx - w / 2 : hx > 0 ? box.x : box.x + box.w - w;
  const y = h === box.h ? box.y : opts.alt || !hy ? cy - h / 2 : hy > 0 ? box.y : box.y + box.h - h;
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------------------------

/** What a point on the artboard hits: the object, its group and member, and its index. */
export interface PosterHit {
  object: PosterObject;
  index: number;
  group: PosterObject['group'];
  member: string;
}

/**
 * The topmost object at (x, y) (artboard px), or null: text boxes and labels by their boxes,
 * layers by each row's box of lines and guide and marker lines, both within `tolerance` px
 * (default 1.5 units).
 */
export function hitTest(
  layout: PosterLayout,
  x: number,
  y: number,
  tolerance = 1.5 * layout.unit,
): PosterHit | null {
  const objs = layout.objects;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    const box = o.type === 'text' ? union(o.box, o.frame)! : o.box;
    const t =
      o.type === 'line' ? Math.max(tolerance, o.width / 2) : o.type === 'layer' ? tolerance : 0;
    if (x >= box.x - t && x <= box.x + box.w + t && y >= box.y - t && y <= box.y + box.h + t) {
      return { object: o, index: i, group: o.group, member: o.member };
    }
  }
  return null;
}

/** Every object of a group (all members), or of one member: what a group selection outlines. */
export function groupObjects(
  layout: PosterLayout,
  group: PosterObject['group'],
  member?: string,
): PosterObject[] {
  return layout.objects.filter(
    (o) => o.group === group && (member === undefined || o.member === member),
  );
}

// ---------------------------------------------------------------------------------------------
// Layers and text boxes: boxes from on-screen edits
// ---------------------------------------------------------------------------------------------

/** A layer's layout by id. */
export function layerOf(layout: PosterLayout, id: string): LayerLayout | undefined {
  return layout.layers.find((l) => l.id === id);
}

/**
 * The box to store for layer `id` so that its lines' bounds become `bounds` (artboard px):
 * the inverse of the layer's mapping, as a fraction of the artboard (a part) or of its part's
 * box (a line). Use it after `resizeBox` on `layer.bounds`, or a move of it. Null when the layer
 * draws nothing.
 */
export function layerBoxFor(layout: PosterLayout, id: string, bounds: Rect): PosterBox | null {
  const L = layerOf(layout, id);
  if (!L || !L.bounds) return null;
  // bounds = map(b0) through box: solve the new box per axis.
  const b = L.bounds;
  const kx = b.w > 0 ? bounds.w / b.w : 1;
  const ky = b.h > 0 ? bounds.h / b.h : 1;
  const box: Rect = {
    x: bounds.x - (b.x - L.box.x) * kx,
    y: bounds.y - (b.y - L.box.y) * ky,
    w: L.box.w * kx,
    h: L.box.h * ky,
  };
  if (L.kind === 'line') {
    const part = layerOf(layout, `part:${L.part}`);
    return toFractions(box, part ? part.box : artboard(layout));
  }
  return toFractions(box, artboard(layout));
}

/** A text box's stored box for an on-screen frame (artboard px). */
export function textBoxFor(layout: PosterLayout, frame: Rect): PosterBox {
  return toFractions(frame, artboard(layout));
}

function artboard(layout: PosterLayout): Rect {
  return { x: 0, y: 0, w: layout.width, h: layout.height };
}

/** Layer `id`'s bounds if its box were `box` (fractions as `layerBoxFor` gives). */
export function boundsWithBox(layout: PosterLayout, id: string, box: PosterBox): Rect | null {
  const L = layerOf(layout, id);
  if (!L || !L.bounds) return null;
  const frame =
    L.kind === 'line'
      ? (layerOf(layout, `part:${L.part}`)?.box ?? artboard(layout))
      : artboard(layout);
  const to: Rect = {
    x: frame.x + box.x * frame.w,
    y: frame.y + box.y * frame.h,
    w: box.w * frame.w,
    h: box.h * frame.h,
  };
  return mapRect(L.bounds, L.box, to);
}

// ---------------------------------------------------------------------------------------------
// Re-fit hint, the automated check
// ---------------------------------------------------------------------------------------------

/** Ids of the visible text boxes that cover a visible layer's lines. */
export function textsOverMusic(layout: PosterLayout): string[] {
  const music: Rect[] = [];
  for (const o of layout.objects) if (o.type === 'layer') music.push(o.box);
  const out: string[] = [];
  for (const o of layout.objects) {
    if (o.type === 'text' && music.some((m) => intersects(o.box, m))) out.push(o.member);
  }
  return out;
}

/** Whether any text box covers the music: the workspace's "Re-fit layout" hint. */
export function overlapsMusic(layout: PosterLayout): boolean {
  return textsOverMusic(layout).length > 0;
}

/** A problem the automated layout check reports. */
export interface PosterIssue {
  kind: 'clipped' | 'outside' | 'overlap' | 'overMusic';
  /** `group/member` of the text (two for an overlap). */
  what: string[];
}

const nameOf = (o: PosterObject): string => `${o.group}/${o.member}`;

/**
 * Every rule the default poster must keep (§15 M14 acceptance): no text clipped by the artboard,
 * none outside the margins, none over other text, no text box over the music.
 */
export function posterIssues(layout: PosterLayout): PosterIssue[] {
  const out: PosterIssue[] = [];
  const text = layout.objects.filter((o) => o.type === 'text' || o.type === 'label');
  const board = artboard(layout);
  for (const o of text) {
    if (!inside(o.box, board)) out.push({ kind: 'clipped', what: [nameOf(o)] });
    else if (!inside(o.box, layout.content)) out.push({ kind: 'outside', what: [nameOf(o)] });
  }
  for (let i = 0; i < text.length; i++) {
    for (let j = i + 1; j < text.length; j++) {
      if (intersects(text[i].box, text[j].box))
        out.push({ kind: 'overlap', what: [nameOf(text[i]), nameOf(text[j])] });
    }
  }
  for (const id of textsOverMusic(layout)) out.push({ kind: 'overMusic', what: [`texts/${id}`] });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time on the poster
// ---------------------------------------------------------------------------------------------

/** Where time t is on one layer: the slice's x and vertical extent, artboard px. */
export interface LayerSlice {
  layer: string;
  x: number;
  y0: number;
  y1: number;
}

/** Where time t is on the poster: its row, the x and extent in the row's plot, and per layer. */
export interface PosterTimeSlice {
  row: number;
  x: number;
  y0: number;
  y1: number;
  /** Each visible layer that has lines in this row around t (after its transform). */
  layers: LayerSlice[];
}

/**
 * Where time `t` sits on the poster (a video playing through it follows this): the row that
 * shows t (a break belongs to the later row; the last row keeps its end), and for each visible
 * layer with lines there the slice's x and vertical extent after the layer's box. Null when t is
 * outside the poster's span.
 */
export function posterTimeAt(layout: PosterLayout, t: Seconds): PosterTimeSlice | null {
  const rows = layout.rows;
  const last = rows.length - 1;
  const r = rows.find((row, i) => t >= row.start && (t < row.end || (i === last && t <= row.end)));
  if (!r) return null;
  const f = (t - r.start) / Math.max(1e-9, r.end - r.start);
  const layers: LayerSlice[] = [];
  for (const L of layout.layers) {
    if (L.hidden) continue;
    const b = L.rowBounds[r.index];
    const fr = L.frames[r.index]?.rect;
    if (!b || !fr) continue;
    const x = fr.x + f * fr.w;
    if (x < b.x || x > b.x + b.w) continue;
    layers.push({ layer: L.id, x, y0: fr.y, y1: fr.y + fr.h });
  }
  return {
    row: r.index,
    x: r.plot.x + f * r.plot.w,
    y0: r.plot.y,
    y1: r.plot.y + r.plot.h,
    layers,
  };
}

// ---------------------------------------------------------------------------------------------
// Doc updates (pure; each returns a new doc, or undefined when nothing differs from the defaults)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

/** `o` without undefined fields; undefined when nothing is left. */
function pruned<T extends object>(o: T): T | undefined {
  const out: Rec = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/** The doc with field `k` set (or removed when undefined); undefined when the doc is empty. */
function withField<K extends keyof PosterDoc>(
  doc: PosterDoc | undefined,
  k: K,
  v: PosterDoc[K] | undefined,
): PosterDoc | undefined {
  return pruned({ ...doc, [k]: v } as PosterDoc);
}

/** Sets the artboard size, rows, section or piece range (undefined clears it). */
export function setPosterField<K extends 'size' | 'rows' | 'section' | 'pieceRange'>(
  doc: PosterDoc | undefined,
  k: K,
  v: PosterDoc[K] | undefined,
): PosterDoc | undefined {
  return withField(doc, k, v);
}

/** Sets the margins (fractions of the shorter side); linked margins all take `top`. */
export function setMargins(
  doc: PosterDoc | undefined,
  m: PosterMargins | undefined,
): PosterDoc | undefined {
  if (!m) return withField(doc, 'margins', undefined);
  const linked = m.linked !== false;
  const v: PosterMargins = linked
    ? { top: m.top, right: m.top, bottom: m.top, left: m.top }
    : { top: m.top, right: m.right, bottom: m.bottom, left: m.left, linked: false };
  return withField(doc, 'margins', v);
}

/** Merges Look overrides (undefined removes one). */
export function setPosterLook(
  doc: PosterDoc | undefined,
  patch: Record<string, unknown>,
): PosterDoc | undefined {
  return withField(doc, 'look', pruned({ ...doc?.look, ...patch }));
}

/** Patches layer `id` (a field set to undefined goes back to its default). */
export function setLayer(
  doc: PosterDoc | undefined,
  id: string,
  patch: Partial<Omit<PosterLayer, 'id'>>,
): PosterDoc | undefined {
  const list = doc?.layers ?? [];
  const i = list.findIndex((l) => l.id === id);
  const { id: _id, ...prev } = i >= 0 ? list[i] : { id };
  const merged = pruned({ ...prev, ...patch });
  const next = list.slice();
  if (merged) {
    const l: PosterLayer = { id, ...merged };
    if (i >= 0) next[i] = l;
    else next.push(l);
  } else if (i >= 0) next.splice(i, 1);
  return withField(doc, 'layers', next.length > 0 ? next : undefined);
}

/** Part layers drawn back to front in this order (ids `part:<name>`). */
export function setLayerOrder(
  doc: PosterDoc | undefined,
  order: readonly string[],
): PosterDoc | undefined {
  const list = doc?.layers ?? [];
  const by = new Map(list.map((l) => [l.id, l]));
  const next: PosterLayer[] = order.map((id) => by.get(id) ?? { id });
  for (const l of list) if (!order.includes(l.id)) next.push(l);
  return withField(doc, 'layers', next.length > 0 ? next : undefined);
}

/** The doc's text boxes (the defaults when it has none). */
export function textsOf(doc: PosterDoc | undefined): PosterText[] {
  return (doc?.texts ?? DEFAULT_POSTER_TEXTS).map((t) => ({ ...t }));
}

/** Adds or replaces a text box (by id). */
export function putText(doc: PosterDoc | undefined, text: PosterText): PosterDoc | undefined {
  const list = textsOf(doc);
  const i = list.findIndex((t) => t.id === text.id);
  if (i >= 0) list[i] = text;
  else list.push(text);
  return withTexts(doc, list);
}

/** Removes a text box. */
export function removeText(doc: PosterDoc | undefined, id: string): PosterDoc | undefined {
  return withTexts(
    doc,
    textsOf(doc).filter((t) => t.id !== id),
  );
}

/** A text id not used yet: `text1`, `text2`, … */
export function newTextId(doc: PosterDoc | undefined): string {
  const used = new Set(textsOf(doc).map((t) => t.id));
  let k = 1;
  while (used.has(`text${k}`)) k++;
  return `text${k}`;
}

function withTexts(doc: PosterDoc | undefined, list: PosterText[]): PosterDoc | undefined {
  const same =
    list.length === DEFAULT_POSTER_TEXTS.length &&
    list.every((t, i) => JSON.stringify(t) === JSON.stringify(DEFAULT_POSTER_TEXTS[i]));
  return withField(doc, 'texts', same ? undefined : list);
}

/** Merges a group's style (undefined fields go back to the default). */
export function setGroupStyle(
  doc: PosterDoc | undefined,
  group: PosterGroup,
  patch: PosterGroupStyle,
): PosterDoc | undefined {
  const groups = { ...doc?.groups };
  const s = pruned({ ...groups[group], ...patch });
  if (s) groups[group] = s;
  else delete groups[group];
  return withField(doc, 'groups', pruned(groups));
}

/** Merges one member's style (Alt-click): undefined fields go back to the group's. */
export function setMemberStyle(
  doc: PosterDoc | undefined,
  group: PosterGroup,
  member: string,
  patch: PosterMemberStyle,
): PosterDoc | undefined {
  const members = { ...doc?.members };
  const g = { ...members[group] };
  const s = pruned({ ...g[member], ...patch });
  if (s) g[member] = s;
  else delete g[member];
  if (Object.keys(g).length > 0) members[group] = g;
  else delete members[group];
  return withField(doc, 'members', pruned(members));
}

/**
 * Re-fit layout: text boxes go back to the text band (their boxes cleared) and, with `layers`,
 * layers back to the music area (their boxes cleared).
 */
export function refitPoster(
  doc: PosterDoc | undefined,
  opts: { layers?: boolean } = {},
): PosterDoc | undefined {
  let out = doc;
  if (doc?.texts) {
    out = withTexts(
      out,
      doc.texts.map((t) => {
        const { box: _box, ...rest } = t;
        return rest;
      }),
    );
  }
  if (opts.layers) for (const l of doc?.layers ?? []) out = setLayer(out, l.id, { box: undefined });
  return out;
}
