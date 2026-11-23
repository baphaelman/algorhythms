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
 * `extStart` / `extEnd` px further along the line (to reach past a seam before it is cut).
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

/**
 * A PathSink that collects one closed outline (arcs flattened to within `tol`) and `emit`s it cut
 * to x0 ≤ x ≤ x1 (Sutherland–Hodgman; the winding inside the band is kept), so a seam is a
 * straight edge of the path rather than a clip: WebKit on macOS drew clipped frames differently
 * from one draw to the next (CI v66). Reused: no allocation once grown.
 */
export class CutSink implements PathSink {
  private ax = new Float64Array(64);
  private ay = new Float64Array(64);
  private bx = new Float64Array(64);
  private by = new Float64Array(64);
  private n = 0;
  private x0 = -Infinity;
  private x1 = Infinity;
  private tol = 0.05;

  /** Starts a new outline, cut to [x0, x1] (±Infinity: no cut on that side). */
  reset(x0: number, x1: number, tol: number): void {
    this.n = 0;
    this.x0 = x0;
    this.x1 = x1;
    this.tol = tol;
  }

  private push(x: number, y: number): void {
    if (this.n === this.ax.length) {
      const m = this.n * 2;
      const grow = (a: Float64Array) => {
        const b = new Float64Array(m);
        b.set(a);
        return b;
      };
      this.ax = grow(this.ax);
      this.ay = grow(this.ay);
      this.bx = new Float64Array(m);
      this.by = new Float64Array(m);
    }
    this.ax[this.n] = x;
    this.ay[this.n] = y;
    this.n++;
  }

  moveTo(x: number, y: number): void {
    this.n = 0;
    this.push(x, y);
  }

  lineTo(x: number, y: number): void {
    this.push(x, y);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false): void {
    const TAU = 2 * Math.PI;
    let d = ccw ? a0 - a1 : a1 - a0;
    if (d < 0) d += TAU * Math.ceil(-d / TAU);
    if (d > TAU) d = TAU;
    const step = r > this.tol ? 2 * Math.acos(1 - this.tol / r) : Math.PI;
    const m = Math.min(256, Math.max(1, Math.ceil(d / step)));
    const s = (ccw ? -d : d) / m;
    for (let j = 0; j <= m; j++) {
      const a = a0 + s * j;
      this.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }

  closePath(): void {}

  /** Adds the cut outline to `sink` as one closed subpath (nothing when the cut leaves none). */
  emit(sink: PathSink): void {
    if (this.x0 > -Infinity) this.cut(this.x0, 1);
    if (this.x1 < Infinity) this.cut(this.x1, -1);
    const { ax, ay, n } = this;
    if (n < 3) return;
    sink.moveTo(ax[0], ay[0]);
    for (let i = 1; i < n; i++) sink.lineTo(ax[i], ay[i]);
    sink.closePath();
  }

  /** Keeps the part with s·(x − c) ≥ 0, from a* into b*, then swaps them. */
  private cut(c: number, s: number): void {
    if (this.bx.length < 2 * this.n) {
      this.bx = new Float64Array(2 * this.n);
      this.by = new Float64Array(2 * this.n);
    }
    const { ax, ay, bx, by, n } = this;
    let m = 0;
    if (n > 0) {
      let px = ax[n - 1];
      let py = ay[n - 1];
      let pin = s * (px - c) >= 0;
      for (let i = 0; i < n; i++) {
        const x = ax[i];
        const y = ay[i];
        const xin = s * (x - c) >= 0;
        if (xin !== pin) {
          bx[m] = c;
          by[m] = py + ((y - py) * (c - px)) / (x - px);
          m++;
        }
        if (xin) {
          bx[m] = x;
          by[m] = y;
          m++;
        }
        px = x;
        py = y;
        pin = xin;
      }
    }
    this.ax = bx;
    this.ay = by;
    this.bx = ax;
    this.by = ay;
    this.n = m;
  }
}
