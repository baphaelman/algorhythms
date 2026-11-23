/**
 * HUD placement (PLAN.md §12 "Exports you can shape"): each readout is a box placed on the frame.
 * A position is stored relative to the nearest of nine anchors (corners, edge midpoints, centre)
 * with an offset as a fraction of the frame, so one layout carries across 16:9, 9:16, 1:1 and
 * poster sizes; a box is always clamped inside the frame. Pure geometry in layout px.
 */

import type { HudItem } from './types';

/** Corners, edge midpoints and centre: top-left … bottom-right. */
export type HudAnchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

export const HUD_ANCHORS: readonly HudAnchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

/**
 * Where a readout sits: the box's anchor point (its left/centre/right, top/middle/bottom) is at
 * the frame's anchor point plus (x·width, y·height).
 */
export interface HudPos {
  anchor: HudAnchor;
  x: number;
  y: number;
}

/** Positions by readout; a readout without one takes its default slot (today's two columns). */
export type HudLayout = Partial<Record<HudItem, HudPos>>;

export interface HudRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudSize {
  width: number;
  height: number;
}

/** A box's height and its text's baseline below the box's top, layout px. */
export const HUD_BOX_H = 14;
export const HUD_BASELINE = 10.5;
/** Narrowest box (a readout with little or no text still has something to grab). */
export const HUD_MIN_W = 24;

const FACTORS: Readonly<Record<HudAnchor, readonly [number, number]>> = {
  tl: [0, 0],
  t: [0.5, 0],
  tr: [1, 0],
  l: [0, 0.5],
  c: [0.5, 0.5],
  r: [1, 0.5],
  bl: [0, 1],
  b: [0.5, 1],
  br: [1, 1],
};

/** The anchor's place across and down the frame (and the box), 0, 0.5 or 1 each. */
export function anchorFactors(a: HudAnchor): readonly [number, number] {
  return FACTORS[a] ?? FACTORS.bl;
}

/** The anchor at (fx, fy), each 0, 0.5 or 1. */
function anchorAt(fx: number, fy: number): HudAnchor {
  return HUD_ANCHORS.find((a) => FACTORS[a][0] === fx && FACTORS[a][1] === fy) ?? 'c';
}

/** A box's top-left kept inside the frame (a box wider than the frame sits at its left). */
export function clampBox(
  x: number,
  y: number,
  w: number,
  h: number,
  frame: HudSize,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(x, frame.width - w)),
    y: Math.max(0, Math.min(y, frame.height - h)),
  };
}

/** Top-left of a w × h box at `pos` in the frame, clamped inside it. */
export function placeBox(
  pos: HudPos,
  w: number,
  h: number,
  frame: HudSize,
): { x: number; y: number } {
  const [ax, ay] = anchorFactors(pos.anchor);
  const x = (ax + fin(pos.x)) * frame.width - ax * w;
  const y = (ay + fin(pos.y)) * frame.height - ay * h;
  return clampBox(x, y, w, h, frame);
}

const fin = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Which third of [0, 1] `v` is in: 0, 0.5 or 1. */
const third = (v: number): number => (v < 1 / 3 ? 0 : v > 2 / 3 ? 1 : 0.5);

/**
 * The position of a box at top-left (x, y): the anchor nearest its centre (by thirds of the
 * frame) and the offset from it. The box is clamped inside the frame first.
 */
export function posOfBox(x: number, y: number, w: number, h: number, frame: HudSize): HudPos {
  const W = frame.width;
  const H = frame.height;
  const c = clampBox(x, y, w, h, frame);
  const fx = third((c.x + w / 2) / W);
  const fy = third((c.y + h / 2) / H);
  return { anchor: anchorAt(fx, fy), x: (c.x + fx * w) / W - fx, y: (c.y + fy * h) / H - fy };
}

/** A snap target hit while dragging: the guide lines to draw (frame px), if any. */
export interface HudGuides {
  /** A vertical guide at this x. */
  x?: number;
  /** A horizontal guide at this y. */
  y?: number;
}

/**
 * Snaps a dragged box (top-left x, y) to the frame's margins (`margin` in from each side), its
 * centre lines and the other boxes' edges, each axis separately, within `tol` px. Returns the
 * snapped top-left and the guides of the targets hit.
 */
export function snapBox(
  box: HudRect,
  frame: HudSize,
  margin: number,
  others: readonly HudRect[],
  tol: number,
): { x: number; y: number; guides: HudGuides } {
  const W = frame.width;
  const H = frame.height;
  const xs: [number, number][] = [
    [margin, margin],
    [W - margin - box.w, W - margin],
    [W / 2 - box.w / 2, W / 2],
  ];
  const ys: [number, number][] = [
    [margin, margin],
    [H - margin - box.h, H - margin],
    [H / 2 - box.h / 2, H / 2],
  ];
  for (const o of others) {
    const r = o.x + o.w;
    const b = o.y + o.h;
    xs.push([o.x, o.x], [r, r], [o.x - box.w, o.x], [r - box.w, r]);
    ys.push([o.y, o.y], [b, b], [o.y - box.h, o.y], [b - box.h, b]);
  }
  const guides: HudGuides = {};
  const pick = (v: number, list: [number, number][]): [number, number] | null => {
    let best: [number, number] | null = null;
    let d = tol;
    for (const c of list) {
      const e = Math.abs(c[0] - v);
      if (e <= d) {
        d = e;
        best = c;
      }
    }
    return best;
  };
  const sx = pick(box.x, xs);
  const sy = pick(box.y, ys);
  if (sx) guides.x = sx[1];
  if (sy) guides.y = sy[1];
  const c = clampBox(sx ? sx[0] : box.x, sy ? sy[0] : box.y, box.w, box.h, frame);
  return { ...c, guides };
}

/** Whether two boxes overlap (or come within `gap` px). */
function overlaps(a: HudRect, b: HudRect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
  );
}

/**
 * A free spot for a w × h box: stacked in from the bottom-left, bottom-right, top-left, then
 * top-right margin corner, the first that overlaps no other box; else the frame's centre.
 */
export function freeSpot(
  w: number,
  h: number,
  frame: HudSize,
  margin: number,
  others: readonly HudRect[],
): HudPos {
  const W = frame.width;
  const H = frame.height;
  const corners: [number, number, number][] = [
    [margin, H - margin - h, -1],
    [W - margin - w, H - margin - h, -1],
    [margin, margin, 1],
    [W - margin - w, margin, 1],
  ];
  for (const [x, y0, dir] of corners) {
    for (let k = 0; ; k++) {
      const y = y0 + dir * k * h;
      if (y < 0 || y + h > H) break;
      const r = { x, y, w, h };
      if (!others.some((o) => overlaps(r, o, 0))) return posOfBox(x, y, w, h, frame);
    }
  }
  return posOfBox(W / 2 - w / 2, H / 2 - h / 2, w, h, frame);
}

/** A stored position, or undefined when it is not one. */
export function parseHudPos(v: unknown): HudPos | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (!HUD_ANCHORS.includes(r.anchor as HudAnchor)) return undefined;
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return undefined;
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return undefined;
  const lim = (n: number): number => Math.max(-1, Math.min(1, n));
  return { anchor: r.anchor as HudAnchor, x: lim(r.x), y: lim(r.y) };
}

/** Words for a position, for screen readers: "bottom right, 3 % from the right, 4 % from the bottom". */
export function hudPosText(pos: HudPos): string {
  const [fx, fy] = anchorFactors(pos.anchor);
  const pct = (v: number): string => `${Math.round(Math.abs(v) * 100)} %`;
  const v = fy === 0 ? 'top' : fy === 1 ? 'bottom' : 'middle';
  const h = fx === 0 ? 'left' : fx === 1 ? 'right' : 'centre';
  const name = pos.anchor === 'c' ? 'centre' : fy === 0.5 ? h : fx === 0.5 ? v : `${v} ${h}`;
  const parts = [name];
  if (fx !== 0.5) parts.push(`${pct(pos.x)} from the ${h}`);
  else if (Math.abs(pos.x) >= 0.005)
    parts.push(`${pct(pos.x)} ${pos.x < 0 ? 'left' : 'right'} of centre`);
  if (fy !== 0.5) parts.push(`${pct(pos.y)} from the ${v}`);
  else if (Math.abs(pos.y) >= 0.005)
    parts.push(`${pct(pos.y)} ${pos.y < 0 ? 'above' : 'below'} centre`);
  return parts.join(', ');
}
