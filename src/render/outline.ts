/**
 * Variable-width line outlines (PLAN.md §11.3 "Thickness transitions", owner 2026-11-21). A
 * sampled centre line with a width per point is drawn as one filled shape: both sides offset by
 * ±w/2 along the normal, round ends only where the caller says the line truly starts or ends,
 * straight (butt) ends elsewhere, so pieces drawn side by side or end to end join without seams.
 * Pure geometry: no canvas, writes into a path sink.
 */

/** The part of a 2D path a canvas context and a test double both provide. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  closePath(): void;
}

/** Largest miter stretch of the half width at a bend. */
const MITER_MAX = 2;

/**
 * Per-point unit normals (nx, ny) and offsets h (half width, stretched at bends so the line keeps
 * its width through them) of the centre line (x, y) with widths w, points 0..n-1. The normal is
 * the tangent turned a quarter clockwise on screen (down for a line going right). End points use
 * their one segment, so two pieces that meet at a shared point get the same edge there when they
 * continue in the same direction.
 */
export function outlineFrame(
  x: Float64Array,
  y: Float64Array,
  w: Float64Array,
  n: number,
  nx: Float64Array,
  ny: Float64Array,
  h: Float64Array,
): void {
  // Last non-zero segment direction, for points with a zero-length neighbour.
  let px = 1;
  let py = 0;
  // The previous point's outgoing unit direction before the fallbacks: this point's incoming one.
  let rx = 0;
  let ry = 0;
  for (let i = 0; i < n; i++) {
    let ix = rx;
    let iy = ry;
    let ox = 0;
    let oy = 0;
    if (i + 1 < n) {
      ox = x[i + 1] - x[i];
      oy = y[i + 1] - y[i];
      const l = Math.sqrt(ox * ox + oy * oy);
      if (l > 1e-9) {
        ox /= l;
        oy /= l;
      } else {
        ox = 0;
        oy = 0;
      }
    }
    rx = ox;
    ry = oy;
    if (ix === 0 && iy === 0) {
      ix = ox;
      iy = oy;
    }
    if (ox === 0 && oy === 0) {
      ox = ix;
      oy = iy;
    }
    if (ix === 0 && iy === 0) {
      ix = ox = px;
      iy = oy = py;
    }
    let tx = ix + ox;
    let ty = iy + oy;
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
    } else {
      tx = ix; // a reversal: keep the incoming direction
      ty = iy;
    }
    nx[i] = -ty;
    ny[i] = tx;
    // cos of half the bend: the segment's normal against the averaged one.
    const c = -iy * nx[i] + ix * ny[i];
    const k = c > 1 / MITER_MAX ? 1 / c : MITER_MAX;
    h[i] = (w[i] / 2) * (i === 0 || i === n - 1 ? 1 : k);
    px = ox;
    py = oy;
  }
}

/**
 * Adds the outline of points i0..i1 (i1 > i0) to `sink` as one closed subpath: one side forward,
 * the end (a half disc of radius w/2 when `capEnd`, else straight across), the other side back,
 * the start likewise. Uses the arrays `outlineFrame` filled. A straight start or end is pushed
 * `extStart` / `extEnd` px further along the line (to reach under a clip at a seam).
 */
export function outlinePath(
  sink: PathSink,
  x: Float64Array,
  y: Float64Array,
  nx: Float64Array,
  ny: Float64Array,
  h: Float64Array,
  i0: number,
  i1: number,
  capStart: boolean,
  capEnd: boolean,
  extStart = 0,
  extEnd = 0,
): void {
  // The tangent is the normal turned back a quarter: (ny, −nx).
  const s0 = capStart ? 0 : extStart;
  const s1 = capEnd ? 0 : extEnd;
  sink.moveTo(x[i0] + nx[i0] * h[i0] - ny[i0] * s0, y[i0] + ny[i0] * h[i0] + nx[i0] * s0);
  for (let i = i0 + 1; i < i1; i++) sink.lineTo(x[i] + nx[i] * h[i], y[i] + ny[i] * h[i]);
  sink.lineTo(x[i1] + nx[i1] * h[i1] + ny[i1] * s1, y[i1] + ny[i1] * h[i1] - nx[i1] * s1);
  if (capEnd && h[i1] > 0) {
    // From the normal side, through the forward direction, to the other side.
    const a = Math.atan2(ny[i1], nx[i1]);
    sink.arc(x[i1], y[i1], h[i1], a, a - Math.PI, true);
  } else {
    sink.lineTo(x[i1] - nx[i1] * h[i1] + ny[i1] * s1, y[i1] - ny[i1] * h[i1] - nx[i1] * s1);
  }
  for (let i = i1 - 1; i > i0; i--) sink.lineTo(x[i] - nx[i] * h[i], y[i] - ny[i] * h[i]);
  sink.lineTo(x[i0] - nx[i0] * h[i0] - ny[i0] * s0, y[i0] - ny[i0] * h[i0] + nx[i0] * s0);
  if (capStart && h[i0] > 0) {
    const a = Math.atan2(-ny[i0], -nx[i0]);
    sink.arc(x[i0], y[i0], h[i0], a, a - Math.PI, true);
  }
  sink.closePath();
}
