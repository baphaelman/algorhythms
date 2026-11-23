/**
 * The ghost layer (owner report 2026-11-21, "artifacts in front of the playhead where lines
 * split"): future lines are translucent, so where strands overlap at a merge or a split their
 * alpha stacked into a dark knot. In a box around each such overlap, the strands' future is drawn
 * at full strength into an offscreen layer, which is composited once at the ghost opacity: there
 * it looks like the past, faded. Elsewhere they are drawn directly, clipped out of the boxes.
 * Other lines, and the past, are drawn as before.
 */

import { pitchAt } from '../core/query';
import type { CompiledVoice, Seconds } from '../core/types';
import { pitchToY, timeToX, xToTime } from './camera';
import type { Ctx2D } from './draw';
import { lineColor } from './palettes';
import { bundlesOf, geometryAt, type Bundle, type StrandFrame } from './strands';
import type { ScoreStyle, View } from './types';

interface Layer {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  g: CanvasRenderingContext2D;
}
/** One frame's ghost boxes and the layer they are drawn in. */
export interface Ghost {
  layer: Layer;
  /** Disjoint boxes in device px, [x0, y0, x1, y1, …]. */
  boxes: number[];
  /** 1 for the voices drawn through the layer: the strands of the boxes' bundles. */
  strands: Uint8Array;
  /**
   * Device px of the target at the layer's origin: the layer covers only the boxes' hull, so it
   * is snapshotted and cleared at that size each frame, not the whole canvas's (whole px: the
   * drawing in it is the same).
   */
  ox: number;
  oy: number;
}
/** Per target context; null where no layer can be made (the future is then drawn directly). */
const layers = new WeakMap<object, Layer | null>();
/** Ghost boxes reach this far (CSS px) past the strands they cover. */
const BOX_PAD = 3;
/**
 * Traces into the layer reach this far (CSS px) past a box, so their round ends stay outside it;
 * boxes start at most this far left of the playhead (the future's round ends).
 */
const TRACE_PAD = 8;
/** Step of the search for where a bundle's strands stop overlapping, px. */
const SCAN_PX = 3;
const BOXES: number[] = [];
let STRANDS = new Uint8Array(0);
const BOX = [0, 0, 0, 0];

function makeLayer(target: Ctx2D, w: number, h: number): Layer | null {
  try {
    const doc = (target.canvas as Partial<HTMLCanvasElement> | undefined)?.ownerDocument;
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (doc) {
      canvas = doc.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    } else if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
    } else {
      return null;
    }
    const g = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    return g ? { canvas, g } : null;
  } catch {
    return null;
  }
}

interface CachedBox {
  pps: number;
  pLo: number;
  pHi: number;
  padT: number;
  padB: number;
  height: number;
  base: number;
  box: number[];
}
/** `overlapBox` by bundle, for the scale it was found at (constant while the camera follows). */
const boxCache = new WeakMap<Bundle, CachedBox>();

/**
 * Where bundle b's strands may overlap in this view, as [t0, y0, t1, y1] (time, CSS px) in `box`:
 * from the bundle time out over its span (`Bundle.lo`..`hi`) until every strand is a pixel clear
 * of its neighbours, and the strands' extent over that time.
 */
function overlapBox(
  voices: readonly CompiledVoice[],
  view: View,
  sf: StrandFrame,
  b: Bundle,
  base: number,
  box: number[],
): void {
  const { pps, pLo, pHi, padT, padB, height } = view;
  const c = boxCache.get(b);
  if (
    c &&
    c.pps === pps &&
    c.pLo === pLo &&
    c.pHi === pHi &&
    c.padT === padT &&
    c.padB === padB &&
    c.height === height &&
    c.base === base
  ) {
    for (let i = 0; i < 4; i++) box[i] = c.box[i];
    return;
  }
  const dir = b.split ? 1 : -1;
  const end = b.split ? b.hi : b.lo;
  const step = SCAN_PX / pps;
  let y0 = Infinity;
  let y1 = -Infinity;
  let tau: Seconds;
  for (let k = 0; ; k++) {
    tau = b.t + dir * k * step;
    if (dir * (tau - end) > 0) tau = end;
    // At the bundle time: the limit from the strands' side.
    const side = k === 0 ? dir : 0;
    let clear = true;
    let above = -Infinity; // lower edge of the strand above (members run top to bottom)
    for (const m of b.members) {
      const v = voices[m.v];
      const p = pitchAt(v, tau + side * 1e-6);
      if (p === null) continue;
      const q = geometryAt(sf, v, tau, side);
      const hw = (q.u * base) / 2;
      const y = pitchToY(view, p) + q.off * base;
      if (y - hw < y0) y0 = y - hw;
      if (y + hw > y1) y1 = y + hw;
      if (y - hw < above + 1) clear = false;
      above = y + hw;
    }
    if ((clear && k > 0) || tau === end) break;
  }
  box[0] = Math.min(b.t, tau);
  box[1] = y0;
  box[2] = Math.max(b.t, tau);
  box[3] = y1;
  boxCache.set(b, { pps, pLo, pHi, padT, padB, height, base, box: box.slice() });
}

/** Adds a box to disjoint boxes ([x0, y0, x1, y1, …]), merging any it touches into their hull. */
function addBox(boxes: number[], x0: number, y0: number, x1: number, y1: number): void {
  for (let i = 0; i < boxes.length;) {
    if (boxes[i] <= x1 && boxes[i + 2] >= x0 && boxes[i + 1] <= y1 && boxes[i + 3] >= y0) {
      x0 = Math.min(x0, boxes[i]);
      y0 = Math.min(y0, boxes[i + 1]);
      x1 = Math.max(x1, boxes[i + 2]);
      y1 = Math.max(y1, boxes[i + 3]);
      boxes.splice(i, 4);
      i = 0; // the hull may now touch an earlier box
    } else {
      i += 4;
    }
  }
  boxes.push(x0, y0, x1, y1);
}

/**
 * The ghost of this frame's future: boxes where strands may overlap ahead of the playhead, and the
 * layer, sized to the target canvas; null when there are none or no layer can be made.
 */
export function ghostOf(
  target: Ctx2D,
  voices: readonly CompiledVoice[],
  view: View,
  sf: StrandFrame,
  base: number,
  dpr: number,
): Ghost | null {
  const w = Math.ceil(view.width * dpr);
  const h = Math.ceil(view.height * dpr);
  const from = Math.max(0, Math.floor((view.xHead - TRACE_PAD) * dpr));
  BOXES.length = 0;
  if (STRANDS.length < voices.length) STRANDS = new Uint8Array(voices.length);
  STRANDS.fill(0);
  for (const b of bundlesOf(sf)) {
    if (!(b.hi > view.t && b.lo < view.tR)) continue;
    overlapBox(voices, view, sf, b, base, BOX);
    const x0 = Math.max(from, Math.floor((timeToX(view, BOX[0]) - BOX_PAD) * dpr));
    const x1 = Math.min(w, Math.ceil((timeToX(view, BOX[2]) + BOX_PAD) * dpr));
    const y0 = Math.max(0, Math.floor((BOX[1] - BOX_PAD) * dpr));
    const y1 = Math.min(h, Math.ceil((BOX[3] + BOX_PAD) * dpr));
    if (!(x1 > x0 && y1 > y0)) continue;
    addBox(BOXES, x0, y0, x1, y1);
    for (const m of b.members) STRANDS[m.v] = 1;
  }
  if (BOXES.length === 0) return null;
  let ox = Infinity;
  let oy = Infinity;
  let ex = 0;
  let ey = 0;
  for (let i = 0; i < BOXES.length; i += 4) {
    ox = Math.min(ox, BOXES[i]);
    oy = Math.min(oy, BOXES[i + 1]);
    ex = Math.max(ex, BOXES[i + 2]);
    ey = Math.max(ey, BOXES[i + 3]);
  }
  const lw = layerSize(ex - ox, w);
  const lh = layerSize(ey - oy, h);
  let l = layers.get(target);
  if (l === undefined) {
    l = makeLayer(target, lw, lh);
    layers.set(target, l);
  }
  if (!l) return null;
  // Grown to fit; shrunk only when far too big, so a hull that varies does not resize every frame.
  let cw = l.canvas.width;
  let ch = l.canvas.height;
  if (cw * ch > 4 * lw * lh) {
    cw = lw;
    ch = lh;
  } else {
    cw = Math.max(cw, lw);
    ch = Math.max(ch, lh);
  }
  if (cw !== l.canvas.width || ch !== l.canvas.height) {
    l.canvas.width = cw;
    l.canvas.height = ch;
  }
  return { layer: l, boxes: BOXES, strands: STRANDS, ox, oy };
}

/** Layer side for a hull `n` device px long on a canvas side `max` long: rounded up to 128 px. */
function layerSize(n: number, max: number): number {
  return Math.max(1, Math.min(max, Math.ceil(n / 128) * 128));
}

/**
 * Adds the boxes (device px; all, or the one at `only`) to g's path, in CSS px, cut to x ≥ `from`
 * (device px).
 */
function boxPath(
  g: CanvasRenderingContext2D,
  boxes: readonly number[],
  dpr: number,
  only = -1,
  from = 0,
): void {
  for (let i = only < 0 ? 0 : only; i < (only < 0 ? boxes.length : only + 4); i += 4) {
    const x0 = Math.max(boxes[i], from);
    if (boxes[i + 2] <= x0) continue;
    g.rect(
      x0 / dpr,
      boxes[i + 1] / dpr,
      (boxes[i + 2] - x0) / dpr,
      (boxes[i + 3] - boxes[i + 1]) / dpr,
    );
  }
}

/** Draws the part of voice v's future within [lo, hi] on ctx at `alpha`. */
export type FutureTrace = (
  ctx: CanvasRenderingContext2D,
  v: CompiledVoice,
  alpha: number,
  lo: Seconds,
  hi: Seconds,
) => void;

/**
 * False when nothing of voice v drawn over [lo, hi] can reach the band y0..y1 (CSS px): it is not
 * traced into that box. Conservative: true when unsure.
 */
export type Reach = (v: CompiledVoice, lo: Seconds, hi: Seconds, y0: number, y1: number) => boolean;

/**
 * Draws the future through the ghost at `alpha`, right of `cut` (CSS px on the device grid; the
 * playhead): other lines directly onto g; the strands outside the boxes directly too (under one
 * clip), inside them at full strength into the layer, which is composited once. One clip at a
 * time, and none under the composite (WebKit on macOS: see CutSink).
 */
export function drawGhost(
  g: CanvasRenderingContext2D,
  gh: Ghost,
  voices: readonly CompiledVoice[],
  style: ScoreStyle,
  view: View,
  dpr: number,
  gradient: CanvasGradient | null,
  layerGradient: CanvasGradient | null,
  alpha: number,
  trace: FutureTrace,
  reach?: Reach,
  cut = -Infinity,
): void {
  const { boxes, strands, ox, oy } = gh;
  // The cut in whole device px, and in CSS px.
  const cx = Math.min(Math.ceil(view.width * dpr), Math.max(0, Math.round(cut * dpr)));
  const x0 = cx / dpr;
  for (let pass = 0; pass < 2; pass++) {
    g.save();
    if (pass === 1 || cx > 0) {
      g.beginPath();
      g.rect(x0, 0, Math.max(0, view.width - x0), view.height);
      if (pass === 1) {
        boxPath(g, boxes, dpr, -1, cx);
        g.clip('evenodd');
      } else {
        g.clip();
      }
    }
    for (const v of voices) {
      if (v.segments.length === 0 || strands[v.index] !== pass) continue;
      g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
      trace(g, v, alpha, -Infinity, Infinity);
    }
    g.restore();
  }

  const L = gh.layer.g;
  L.save();
  L.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 0; i < boxes.length; i += 4) {
    L.clearRect(
      boxes[i] - ox,
      boxes[i + 1] - oy,
      boxes[i + 2] - boxes[i],
      boxes[i + 3] - boxes[i + 1],
    );
  }
  L.setTransform(dpr, 0, 0, dpr, -ox, -oy);
  L.lineJoin = 'round';
  L.lineCap = 'round';
  const pad = TRACE_PAD / view.pps;
  for (let i = 0; i < boxes.length; i += 4) {
    if (boxes[i + 2] <= cx) continue;
    L.save();
    L.beginPath();
    boxPath(L, boxes, dpr, i);
    L.clip();
    const lo = xToTime(view, boxes[i] / dpr) - pad;
    const hi = xToTime(view, boxes[i + 2] / dpr) + pad;
    const y0 = boxes[i + 1] / dpr;
    const y1 = boxes[i + 3] / dpr;
    for (const v of voices) {
      if (v.segments.length === 0 || strands[v.index] !== 1) continue;
      // Each box holds a few strands; the others pass elsewhere (most of the layer's paths).
      if (reach && !reach(v, lo, hi, y0, y1)) continue;
      L.strokeStyle = layerGradient ?? lineColor(style, v.index) ?? style.tokens.ink;
      trace(L, v, 1, lo, hi);
    }
    L.restore();
  }
  L.restore();

  // Composited right of the cut by the source rectangle, not a clip.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = alpha;
  for (let i = 0; i < boxes.length; i += 4) {
    const x = Math.max(boxes[i], cx);
    const y = boxes[i + 1];
    const w = boxes[i + 2] - x;
    const h = boxes[i + 3] - y;
    if (w <= 0) continue;
    g.drawImage(gh.layer.canvas, x - ox, y - oy, w, h, x, y, w, h);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalAlpha = 1;
}
