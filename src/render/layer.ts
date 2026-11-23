/**
 * Offscreen layers for effects drawn in passes (glow, the end card's crossfade): a canvas of the
 * target's kind (a document canvas next to an HTML canvas, else an OffscreenCanvas), cached per
 * target and purpose and resized on demand. Null where none can be made (a test double, an
 * `SvgContext`): callers then draw a fallback.
 */

import type { Ctx2D } from './draw';

export interface Layer {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  g: CanvasRenderingContext2D;
}

const layers = new WeakMap<object, Map<string, Layer | null>>();

/** A layer `key` for `target`, at least w × h device px (cleared by the caller). */
export function layerFor(target: Ctx2D, key: string, w: number, h: number): Layer | null {
  let byKey = layers.get(target);
  if (!byKey) layers.set(target, (byKey = new Map()));
  let l = byKey.get(key);
  if (l === undefined) {
    l = makeLayer(target, Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    byKey.set(key, l);
  }
  if (!l) return null;
  if (l.canvas.width < w || l.canvas.height < h) {
    l.canvas.width = Math.max(l.canvas.width, Math.ceil(w));
    l.canvas.height = Math.max(l.canvas.height, Math.ceil(h));
  }
  return l;
}

function makeLayer(target: Ctx2D, w: number, h: number): Layer | null {
  try {
    if (typeof (target as Partial<CanvasRenderingContext2D>).drawImage !== 'function') return null;
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

/** Detection results per context type (its constructor): the probe runs once for each. */
const filterOk = new Map<unknown, boolean>();
let filterForced: boolean | null = null;

/** Test seam: force `canFilter`'s answer (null: detect for real); clears the cached results. */
export function forceCanFilter(v: boolean | null): void {
  filterForced = v;
  filterOk.clear();
}

/**
 * Whether `g` applies canvas `filter` (no in older Safari and Playwright's WebKit, where the
 * setter only adds a plain property, so the read-back alone passes): once per context, a 1 px dot
 * drawn under `blur(1px)` must spread to its neighbour. Draws on `g`, so callers clear after.
 */
export function canFilter(g: CanvasRenderingContext2D): boolean {
  if (filterForced !== null) return filterForced;
  const type = Object.getPrototypeOf(g)?.constructor ?? g;
  let ok = filterOk.get(type);
  if (ok === undefined) {
    try {
      const was = g.filter;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, 8, 8);
      g.filter = 'blur(1px)';
      ok = g.filter === 'blur(1px)';
      if (ok) {
        g.fillStyle = '#fff';
        g.fillRect(4, 4, 1, 1);
        ok = g.getImageData(6, 4, 1, 1).data[3] > 0;
      }
      g.filter = was ?? 'none';
      g.clearRect(0, 0, 8, 8);
      g.restore();
    } catch {
      ok = false;
    }
    filterOk.set(type, ok);
  }
  return ok;
}

/**
 * Blurs `src` (its top-left sw × sh px) into `dst` (cleared first) by radius r px: the canvas
 * `filter` where `filtered`, else three passes of a nine-tap ring averaged additively (`lighter`
 * at 1/9 each), ping-ponging through `tmp`, which approximates a Gaussian of the same radius.
 */
export function blurInto(
  dst: Layer,
  src: Layer,
  tmp: Layer | null,
  sw: number,
  sh: number,
  r: number,
  filtered: boolean,
): void {
  const d = dst.g;
  d.setTransform(1, 0, 0, 1, 0, 0);
  d.globalAlpha = 1;
  d.globalCompositeOperation = 'source-over';
  d.clearRect(0, 0, d.canvas.width, d.canvas.height);
  if (filtered) {
    d.filter = `blur(${r}px)`;
    d.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, sw, sh);
    d.filter = 'none';
    return;
  }
  // Per pass a centre tap and 8 on a ring of radius ρ: variance 4ρ²/9 per axis. Three passes at
  // ρ = r·√3/2 sum to r², the variance of `blur(r)` (CSS: r is the standard deviation).
  const ring = (r * Math.sqrt(3)) / 2;
  const passes = tmp ? 3 : 1;
  let from = src;
  for (let p = 0; p < passes; p++) {
    const to = p % 2 === passes % 2 ? (tmp as Layer) : dst;
    const t = to.g;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'source-over';
    t.globalAlpha = 1;
    t.clearRect(0, 0, t.canvas.width, t.canvas.height);
    t.globalCompositeOperation = 'lighter';
    t.globalAlpha = 1 / 9;
    t.drawImage(from.canvas, 0, 0, sw, sh, 0, 0, sw, sh);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + p * 0.39;
      t.drawImage(from.canvas, 0, 0, sw, sh, Math.cos(a) * ring, Math.sin(a) * ring, sw, sh);
    }
    t.globalCompositeOperation = 'source-over';
    t.globalAlpha = 1;
    from = to;
  }
}
