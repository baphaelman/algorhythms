/**
 * The poster artboard's zoom and pan (owner, poster notes round 3, item 7): pure view math. A
 * view is a zoom (CSS px per poster px: 1 = 100 %) and the poster point at the box's centre;
 * `fit` = the view follows the box and the poster's size (the workspace opens at Fit, and ⇧1
 * returns to it). View state only, never stored in the piece.
 */

import { artboardFit } from './poster-workspace';

export interface ArtboardView {
  fit: boolean;
  zoom: number;
  /** The poster point (poster px) at the box's centre. */
  cx: number;
  cy: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Poster {
  width: number;
  height: number;
}

/** The Fit view: the whole poster inside the padded box, centred. */
export function fitView(box: Size, poster: Poster): ArtboardView {
  return {
    fit: true,
    zoom: artboardFit(box, poster).w / poster.width,
    cx: poster.width / 2,
    cy: poster.height / 2,
  };
}

/** Zoom limits: a quarter of Fit up to 800 % (at least 4× Fit, for tiny posters). */
export function zoomLimits(box: Size, poster: Poster): { min: number; max: number } {
  const f = fitView(box, poster).zoom;
  return { min: f / 4, max: Math.max(8, f * 4) };
}

/** `v` with its zoom inside the limits and the box's centre over the poster. */
export function clampView(v: ArtboardView, box: Size, poster: Poster): ArtboardView {
  if (v.fit) return fitView(box, poster);
  const { min, max } = zoomLimits(box, poster);
  return {
    fit: false,
    zoom: Math.min(max, Math.max(min, v.zoom)),
    cx: Math.min(poster.width, Math.max(0, v.cx)),
    cy: Math.min(poster.height, Math.max(0, v.cy)),
  };
}

/** The poster point under box point (sx, sy) (box CSS px from its top left). */
export function posterPoint(v: ArtboardView, box: Size, sx: number, sy: number) {
  return { x: v.cx + (sx - box.w / 2) / v.zoom, y: v.cy + (sy - box.h / 2) / v.zoom };
}

/**
 * Zoom to `zoom` (clamped) keeping the poster point under box point (sx, sy) where it is;
 * without a point, around the box's centre.
 */
export function zoomAt(
  v: ArtboardView,
  zoom: number,
  box: Size,
  poster: Poster,
  at: { x: number; y: number } = { x: box.w / 2, y: box.h / 2 },
): ArtboardView {
  const { min, max } = zoomLimits(box, poster);
  const z = Math.min(max, Math.max(min, zoom));
  const p = posterPoint(v, box, at.x, at.y);
  return clampView(
    {
      fit: false,
      zoom: z,
      cx: p.x - (at.x - box.w / 2) / z,
      cy: p.y - (at.y - box.h / 2) / z,
    },
    box,
    poster,
  );
}

/** Moves the poster by (dx, dy) CSS px on screen (a drag right moves it right). */
export function panBy(
  v: ArtboardView,
  dx: number,
  dy: number,
  box: Size,
  poster: Poster,
): ArtboardView {
  return clampView(
    { fit: false, zoom: v.zoom, cx: v.cx - dx / v.zoom, cy: v.cy - dy / v.zoom },
    box,
    poster,
  );
}

/** The zoom ⌘+ and ⌘− step through. */
export const ZOOM_STEPS = [
  0.02,
  0.03,
  0.05,
  0.1,
  0.125,
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  1,
  1.5,
  2,
  3,
  4,
  6,
  8,
] as const;

/** The next step in (`dir` 1) or out (-1) from `zoom`, clamped to the limits. */
export function stepZoom(zoom: number, dir: 1 | -1, box: Size, poster: Poster): number {
  const { min, max } = zoomLimits(box, poster);
  const next =
    dir > 0
      ? (ZOOM_STEPS.find((s) => s > zoom * 1.01) ?? max)
      : ([...ZOOM_STEPS].reverse().find((s) => s < zoom / 1.01) ?? min);
  return Math.min(max, Math.max(min, next));
}

/** The page's box inside the artboard box (CSS px). At Fit, exactly `artboardFit`, centred. */
export function pageRect(v: ArtboardView, box: Size, poster: Poster) {
  const f = v.fit ? artboardFit(box, poster) : null;
  const w = f ? f.w : poster.width * v.zoom;
  const h = f ? f.h : poster.height * v.zoom;
  const left = f ? (box.w - w) / 2 : box.w / 2 - v.cx * v.zoom;
  const top = f ? (box.h - h) / 2 : box.h / 2 - v.cy * v.zoom;
  return { left, top, w, h };
}

/**
 * The canvas for a page: only the part of the page inside the box, in device px (`x`, `y`
 * from the page's top left), and the device px per poster px it is drawn at. A page wholly in
 * view is the whole poster, sized as the artboard always drew it.
 */
export function visibleRegion(
  page: { left: number; top: number; w: number; h: number },
  box: Size,
  poster: Poster,
  dpr: number,
): { x: number; y: number; w: number; h: number; scale: number; whole: boolean } {
  const inX = page.left >= 0 && page.left + page.w <= box.w + 0.5;
  if (inX && page.top >= 0 && page.top + page.h <= box.h + 0.5) {
    const w = Math.max(1, Math.round(page.w * dpr));
    return {
      x: 0,
      y: 0,
      w,
      h: Math.max(1, Math.round((poster.height * w) / poster.width)),
      scale: w / poster.width,
      whole: true,
    };
  }
  const scale = (page.w * dpr) / poster.width;
  const x0 = Math.floor(Math.max(0, -page.left) * dpr);
  const y0 = Math.floor(Math.max(0, -page.top) * dpr);
  const x1 = Math.ceil(Math.min(page.w, box.w - page.left) * dpr);
  const y1 = Math.ceil(Math.min(page.h, box.h - page.top) * dpr);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), scale, whole: false };
}

/** "64 %". */
export function zoomText(zoom: number): string {
  return `${Math.round(zoom * 100)} %`;
}
