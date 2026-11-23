/**
 * A recording 2D context that writes SVG (PLAN.md §12 "Poster export"): the subset of
 * `CanvasRenderingContext2D` that `drawScore` uses — paths (moveTo, lineTo, quadratic and cubic
 * curves, arc, rect, closePath), stroke, fill, fillRect, clearRect, clip, fillText, measureText,
 * line styles and dashes, alpha, linear and radial gradients, save/restore and transforms. Pure:
 * no DOM.
 *
 * Coordinates are written in device pixels (the transform is applied as points are added, as a
 * canvas does), so the SVG's viewBox is the canvas's pixel size. Text stays `<text>`. OKLCH
 * colours are converted to sRGB hex so other SVG tools read them. Consecutive opaque, undashed
 * strokes with identical style are merged into one `<path>`.
 *
 * `filter` takes only `blur(Npx)` (an SVG `feGaussianBlur` over the whole canvas; the glow).
 * Not supported: drawImage, patterns, conic gradients, shadows, other filters and composite
 * modes other than source-over (drawScore's ghost layer uses drawImage; the poster never needs
 * it). clearRect only clears when it covers the whole canvas.
 */

/** Approximate advance of one character of a monospace font, in ems. */
export const MONO_ADVANCE = 0.6;

type Matrix = [number, number, number, number, number, number];

/**
 * A gradient made by `SvgContext.createLinearGradient` or `createRadialGradient` (structurally a
 * CanvasGradient). Radial: from the circle (x0, y0, r0) to (x1, y1, r1).
 */
export class SvgGradient {
  readonly stops: { at: number; color: string }[] = [];
  constructor(
    readonly x0: number,
    readonly y0: number,
    readonly x1: number,
    readonly y1: number,
    readonly radial?: { r0: number; r1: number },
  ) {}
  addColorStop(offset: number, color: string): void {
    if (!(offset >= 0 && offset <= 1)) throw new RangeError('offset out of range');
    this.stops.push({ at: offset, color });
  }
}

type Paint = string | SvgGradient;

interface State {
  m: Matrix;
  globalAlpha: number;
  strokeStyle: Paint;
  fillStyle: Paint;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  miterLimit: number;
  lineDashOffset: number;
  dash: number[];
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  letterSpacing: string;
  globalCompositeOperation: string;
  /** Clip-path id in effect, or ''. */
  clip: string;
  /** Canvas `filter`: 'none' or `blur(Npx)`. */
  filter: string;
}

function initialState(): State {
  return {
    m: [1, 0, 0, 1, 0, 0],
    globalAlpha: 1,
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    dash: [],
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    globalCompositeOperation: 'source-over',
    clip: '',
    filter: 'none',
  };
}

/** A number for an attribute: two decimals, no trailing zeros, no "-0". */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? '0' : String(r);
}

/** Characters XML 1.0 does not allow, dropped from text. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** Escapes text for XML content and double-quoted attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `#rrggbb` of an sRGB triple 0..1 (clipped). */
function hex(r: number, g: number, b: number): string {
  const c = (x: number): string => {
    const v = Math.round(Math.min(1, Math.max(0, x)) * 255);
    return v.toString(16).padStart(2, '0');
  };
  return `#${c(r)}${c(g)}${c(b)}`;
}

function gamma(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Linear sRGB of OKLCH (Ottosson's OKLab matrices). */
function oklchLinear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * Colour string for SVG: `oklch(L C h [/ a])` and `rgb[a](r, g, b[, a])` become sRGB hex (the
 * alpha returned separately), anything else is kept. Out of
 * gamut, each channel is clipped: that is how Chromium draws these on a canvas (2 dB closer to
 * the PNG than CSS chroma reduction; build log M9-a). The alpha of an OKLCH colour is returned
 * separately.
 */
export function svgColor(color: string): { color: string; alpha: number } {
  const rgb =
    /^\s*rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)\s*$/i.exec(
      color,
    );
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4]));
    return { color: hex(+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255), alpha: a };
  }
  const m =
    /^\s*oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([-\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)\s*$/i.exec(
      color,
    );
  if (!m) return { color, alpha: 1 };
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = Number(m[4]);
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const [r, g, b] = oklchLinear(L, C, h);
  return { color: hex(gamma(r), gamma(g), gamma(b)), alpha };
}

/** True for a colour that paints nothing (`transparent`, or an explicit zero alpha). */
function invisible(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === 'transparent') return true;
  if (/^#[0-9a-f]{8}$/.test(c)) return c.endsWith('00');
  if (/^#[0-9a-f]{4}$/.test(c)) return c.endsWith('0');
  const a = /[,/]\s*(0*\.?0+)%?\s*\)$/.exec(c);
  return a !== null && Number(a[1]) === 0 && /^(rgba?|hsla?|oklch|oklab|lab|lch)\(/.test(c);
}

/** Parsed canvas font shorthand: `[style] [weight] <size>px <family>`. */
function parseFont(font: string): { style: string; weight: string; size: number; family: string } {
  const m =
    /^\s*((?:(?:italic|oblique|normal|bold|bolder|lighter|small-caps|\d{3})\s+)*)([\d.]+)px(?:\/[\d.]+\w*)?\s+(.+)$/i.exec(
      font,
    );
  if (!m) return { style: '', weight: '', size: 10, family: 'sans-serif' };
  let style = '';
  let weight = '';
  for (const w of m[1].trim().split(/\s+/)) {
    if (w === 'italic' || w === 'oblique') style = w;
    else if (/^\d{3}$|^bold(er)?$|^lighter$/.test(w)) weight = w;
  }
  return { style, weight, size: Number(m[2]), family: m[3].trim() };
}

function px(s: string): number {
  const m = /^\s*(-?[\d.]+)px\s*$/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** Output options of `SvgContext.toSvg`. */
export interface SvgOutput {
  /** Prepend `<?xml version="1.0" encoding="UTF-8"?>`. @default true */
  xmlDeclaration?: boolean;
}

/** The recording context. See the file comment for what it supports. */
export class SvgContext {
  readonly canvas: { width: number; height: number };
  private s: State = initialState();
  private stack: State[] = [];
  private els: string[] = [];
  private defs: string[] = [];
  private gradIds = new Map<string, string>();
  private ids = 0;
  /** Current path (device px), its last command letter, and whether it has a current point. */
  private d: string[] = [];
  private last = '';
  private open = false;
  /** A stroke waiting to be merged with an identical next one: its attributes and path. */
  private pendingAttrs = '';
  private pendingD: string[] = [];

  constructor(width: number, height: number) {
    this.canvas = { width, height };
  }

  // --- state -------------------------------------------------------------------------------

  get globalAlpha(): number {
    return this.s.globalAlpha;
  }
  set globalAlpha(v: number) {
    if (Number.isFinite(v) && v >= 0 && v <= 1) this.s.globalAlpha = v;
  }
  get strokeStyle(): Paint {
    return this.s.strokeStyle;
  }
  set strokeStyle(v: Paint) {
    this.s.strokeStyle = v;
  }
  get fillStyle(): Paint {
    return this.s.fillStyle;
  }
  set fillStyle(v: Paint) {
    this.s.fillStyle = v;
  }
  get lineWidth(): number {
    return this.s.lineWidth;
  }
  set lineWidth(v: number) {
    if (Number.isFinite(v) && v > 0) this.s.lineWidth = v;
  }
  get lineCap(): CanvasLineCap {
    return this.s.lineCap;
  }
  set lineCap(v: CanvasLineCap) {
    this.s.lineCap = v;
  }
  get lineJoin(): CanvasLineJoin {
    return this.s.lineJoin;
  }
  set lineJoin(v: CanvasLineJoin) {
    this.s.lineJoin = v;
  }
  get miterLimit(): number {
    return this.s.miterLimit;
  }
  set miterLimit(v: number) {
    if (Number.isFinite(v) && v > 0) this.s.miterLimit = v;
  }
  get lineDashOffset(): number {
    return this.s.lineDashOffset;
  }
  set lineDashOffset(v: number) {
    if (Number.isFinite(v)) this.s.lineDashOffset = v;
  }
  get font(): string {
    return this.s.font;
  }
  set font(v: string) {
    this.s.font = v;
  }
  get textAlign(): CanvasTextAlign {
    return this.s.textAlign;
  }
  set textAlign(v: CanvasTextAlign) {
    this.s.textAlign = v;
  }
  get textBaseline(): CanvasTextBaseline {
    return this.s.textBaseline;
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.s.textBaseline = v;
  }
  get letterSpacing(): string {
    return this.s.letterSpacing;
  }
  set letterSpacing(v: string) {
    this.s.letterSpacing = v;
  }
  get filter(): string {
    return this.s.filter;
  }
  set filter(v: string) {
    this.s.filter = /^blur\(\d+(\.\d+)?px\)$/.test(v) ? v : 'none';
  }
  get globalCompositeOperation(): string {
    return this.s.globalCompositeOperation;
  }
  set globalCompositeOperation(v: string) {
    this.s.globalCompositeOperation = v;
  }

  setLineDash(segments: readonly number[]): void {
    if (segments.some((x) => !Number.isFinite(x) || x < 0)) return;
    this.s.dash = segments.length % 2 ? [...segments, ...segments] : [...segments];
  }
  getLineDash(): number[] {
    return [...this.s.dash];
  }

  save(): void {
    this.stack.push({ ...this.s, m: [...this.s.m] as Matrix, dash: [...this.s.dash] });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) this.s = s;
  }

  // --- transforms --------------------------------------------------------------------------

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.s.m = [a, b, c, d, e, f];
  }
  resetTransform(): void {
    this.s.m = [1, 0, 0, 1, 0, 0];
  }
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    const [a, b, c, d, e, f] = this.s.m;
    return { a, b, c, d, e, f };
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const [A, B, C, D, E, F] = this.s.m;
    this.s.m = [
      A * a + C * b,
      B * a + D * b,
      A * c + C * d,
      B * c + D * d,
      A * e + C * f + E,
      B * e + D * f + F,
    ];
  }
  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }
  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }
  rotate(angle: number): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }

  private tx(x: number, y: number): [number, number] {
    const m = this.s.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  /** Length scale of the transform (√|det|). */
  private scaleOf(): number {
    const m = this.s.m;
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  }
  /** Uniform scale + translation (no rotation, shear or reflection). */
  private uniform(): boolean {
    const m = this.s.m;
    return m[1] === 0 && m[2] === 0 && m[0] === m[3] && m[0] > 0;
  }

  // --- paths ------------------------------------------------------------------------------

  beginPath(): void {
    this.d = [];
    this.last = '';
    this.open = false;
  }
  private cmd(c: string, ...xy: number[]): void {
    const nums = xy.map(num).join(' ');
    if (c === this.last && c !== 'M') this.d.push(' ' + nums);
    else this.d.push(c + nums);
    this.last = c;
  }
  moveTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const [X, Y] = this.tx(x, y);
    this.cmd('M', X, Y);
    this.open = true;
  }
  /** Device-space line to (X, Y), or a move when the path has no current point. */
  private lineDev(X: number, Y: number): void {
    if (!this.open) {
      this.cmd('M', X, Y);
      this.open = true;
    } else this.cmd('L', X, Y);
  }
  lineTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const [X, Y] = this.tx(x, y);
    this.lineDev(X, Y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!this.open) this.moveTo(cpx, cpy);
    const [A, B] = this.tx(cpx, cpy);
    const [X, Y] = this.tx(x, y);
    this.cmd('Q', A, B, X, Y);
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.open) this.moveTo(c1x, c1y);
    const [A, B] = this.tx(c1x, c1y);
    const [C, D] = this.tx(c2x, c2y);
    const [X, Y] = this.tx(x, y);
    this.cmd('C', A, B, C, D, X, Y);
  }
  closePath(): void {
    if (!this.open) return;
    this.d.push('Z');
    this.last = 'Z';
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
    this.moveTo(x, y);
  }
  /**
   * Canvas `arc`: a line from the current point to the arc's start (a move if there is none),
   * then the arc, as SVG arcs of at most half a turn (cubic Béziers under a non-uniform
   * transform).
   */
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    if (![x, y, r, a0, a1].every(Number.isFinite)) return;
    if (r < 0) throw new RangeError('negative radius');
    const TAU = Math.PI * 2;
    let sweep: number;
    if (!ccw) sweep = a1 - a0 >= TAU ? TAU : (((a1 - a0) % TAU) + TAU) % TAU;
    else sweep = -(a0 - a1 >= TAU ? TAU : (((a0 - a1) % TAU) + TAU) % TAU);
    const [X0, Y0] = this.tx(x + r * Math.cos(a0), y + r * Math.sin(a0));
    this.lineDev(X0, Y0);
    if (sweep === 0 || r === 0) return;
    const uni = this.uniform();
    const n = Math.ceil(Math.abs(sweep) / (uni ? Math.PI : Math.PI / 2) - 1e-9);
    const step = sweep / n;
    for (let i = 1; i <= n; i++) {
      const b0 = a0 + step * (i - 1);
      const b1 = a0 + step * i;
      const [X, Y] = this.tx(x + r * Math.cos(b1), y + r * Math.sin(b1));
      if (uni) {
        const R = r * this.s.m[0];
        this.d.push(`A${num(R)} ${num(R)} 0 0 ${step > 0 ? 1 : 0} ${num(X)} ${num(Y)}`);
        this.last = 'A';
      } else {
        // Cubic approximation of one quarter (or less).
        const k = (4 / 3) * Math.tan((b1 - b0) / 4);
        const p1 = this.tx(
          x + r * (Math.cos(b0) - k * Math.sin(b0)),
          y + r * (Math.sin(b0) + k * Math.cos(b0)),
        );
        const p2 = this.tx(
          x + r * (Math.cos(b1) + k * Math.sin(b1)),
          y + r * (Math.sin(b1) - k * Math.cos(b1)),
        );
        this.cmd('C', p1[0], p1[1], p2[0], p2[1], X, Y);
      }
    }
  }

  // --- painting ---------------------------------------------------------------------------

  /** Coordinates are in the user space of the stroke or fill that uses it, as on a canvas. */
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): SvgGradient {
    return new SvgGradient(x0, y0, x1, y1);
  }

  /** As on a canvas; written as an SVG `radialGradient` (focal circle `fr` when r0 > 0). */
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): SvgGradient {
    return new SvgGradient(x0, y0, x1, y1, { r0, r1 });
  }

  /** `fill`/`stroke` attribute for a paint (a gradient becomes a def), with its own alpha. */
  private paint(p: Paint): { ref: string; alpha: number; opaque: boolean } | null {
    if (typeof p === 'string') {
      if (invisible(p)) return null;
      const c = svgColor(p);
      const opaque =
        c.alpha === 1 && !/^(rgba|hsla)\(|\/|^#[0-9a-f]{4}$|^#[0-9a-f]{8}$/i.test(c.color);
      return { ref: escapeXml(c.color), alpha: c.alpha, opaque };
    }
    const [x1, y1] = this.tx(p.x0, p.y0);
    const [x2, y2] = this.tx(p.x1, p.y1);
    let opaque = true;
    const stops = [...p.stops]
      .sort((a, b) => a.at - b.at)
      .map((s) => {
        const c = svgColor(s.color);
        if (c.alpha !== 1) opaque = false;
        const op = c.alpha !== 1 ? ` stop-opacity="${num(c.alpha)}"` : '';
        return `<stop offset="${num(s.at)}" stop-color="${escapeXml(c.color)}"${op}/>`;
      })
      .join('');
    let tag = 'linearGradient';
    let body = `gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}">${stops}`;
    if (p.radial) {
      const k = this.scaleOf();
      tag = 'radialGradient';
      const fr = p.radial.r0 > 0 ? ` fr="${num(p.radial.r0 * k)}"` : '';
      body = `gradientUnits="userSpaceOnUse" cx="${num(x2)}" cy="${num(y2)}" r="${num(p.radial.r1 * k)}" fx="${num(x1)}" fy="${num(y1)}"${fr}>${stops}`;
    }
    let id = this.gradIds.get(tag + body);
    if (!id) {
      id = `g${++this.ids}`;
      this.gradIds.set(tag + body, id);
      this.defs.push(`<${tag} id="${id}" ${body}</${tag}>`);
    }
    return { ref: `url(#${id})`, alpha: 1, opaque };
  }

  private common(alpha: number): string {
    let a = '';
    if (alpha < 1) a += ` opacity="${num3(alpha)}"`;
    if (this.s.clip) a += ` clip-path="url(#${this.s.clip})"`;
    const f = this.filterRef();
    if (f) a += ` filter="url(#${f})"`;
    return a;
  }

  /** The id of the current blur's `<filter>` def (over the whole canvas), or ''. */
  private filterRef(): string {
    const m = /^blur\((\d+(?:\.\d+)?)px\)$/.exec(this.s.filter);
    const sd = m ? Number(m[1]) * this.scaleOf() : 0;
    if (!(sd > 0)) return '';
    const { width: W, height: H } = this.canvas;
    const body = `filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feGaussianBlur stdDeviation="${num(sd)}"/>`;
    let id = this.gradIds.get('filter' + body);
    if (!id) {
      id = `f${++this.ids}`;
      this.gradIds.set('filter' + body, id);
      this.defs.push(`<filter id="${id}" ${body}</filter>`);
    }
    return id;
  }

  private push(el: string): void {
    this.flush();
    this.els.push(el);
  }
  private flush(): void {
    if (this.pendingD.length === 0) return;
    this.els.push(`<path d="${this.pendingD.join('')}"${this.pendingAttrs}/>`);
    this.pendingD = [];
    this.pendingAttrs = '';
  }

  stroke(): void {
    if (this.d.length === 0) return;
    const p = this.paint(this.s.strokeStyle);
    if (!p) return;
    const k = this.scaleOf();
    const s = this.s;
    let a = ` fill="none" stroke="${p.ref}" stroke-width="${num(s.lineWidth * k)}"`;
    if (s.lineCap !== 'butt') a += ` stroke-linecap="${s.lineCap}"`;
    if (s.lineJoin !== 'miter') a += ` stroke-linejoin="${s.lineJoin}"`;
    else a += ` stroke-miterlimit="${num(s.miterLimit)}"`;
    const dashed = s.dash.length > 0 && s.dash.some((x) => x > 0);
    if (dashed) {
      a += ` stroke-dasharray="${s.dash.map((x) => num(x * k)).join(' ')}"`;
      if (s.lineDashOffset) a += ` stroke-dashoffset="${num(s.lineDashOffset * k)}"`;
    }
    const alpha = s.globalAlpha * p.alpha;
    a += this.common(alpha);
    // Merging is safe only where overlaps can't show: opaque and undashed.
    const mergeable = alpha === 1 && p.opaque && !dashed;
    if (mergeable && this.pendingD.length > 0 && this.pendingAttrs === a) {
      this.pendingD.push(...this.d);
      return;
    }
    this.flush();
    if (mergeable) {
      this.pendingAttrs = a;
      this.pendingD = [...this.d];
      return;
    }
    this.els.push(`<path d="${this.d.join('')}"${a}/>`);
  }

  fill(rule?: CanvasFillRule): void {
    if (this.d.length === 0) return;
    const p = this.paint(this.s.fillStyle);
    if (!p) return;
    let a = ` fill="${p.ref}"`;
    if (rule === 'evenodd') a += ' fill-rule="evenodd"';
    this.push(`<path d="${this.d.join('')}"${a}${this.common(this.s.globalAlpha * p.alpha)}/>`);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const p = this.paint(this.s.fillStyle);
    if (!p || w === 0 || h === 0) return;
    const extra = this.common(this.s.globalAlpha * p.alpha);
    const m = this.s.m;
    if (m[1] === 0 && m[2] === 0) {
      const [X0, Y0] = this.tx(x, y);
      const [X1, Y1] = this.tx(x + w, y + h);
      const rx = Math.min(X0, X1);
      const ry = Math.min(Y0, Y1);
      this.push(
        `<rect x="${num(rx)}" y="${num(ry)}" width="${num(Math.abs(X1 - X0))}" height="${num(Math.abs(Y1 - Y0))}" fill="${p.ref}"${extra}/>`,
      );
      return;
    }
    const pts = [this.tx(x, y), this.tx(x + w, y), this.tx(x + w, y + h), this.tx(x, y + h)];
    const d = pts.map(([X, Y], i) => `${i ? 'L' : 'M'}${num(X)} ${num(Y)}`).join('') + 'Z';
    this.push(`<path d="${d}" fill="${p.ref}"${extra}/>`);
  }

  /** Clears everything drawn so far when the rectangle covers the canvas; otherwise a no-op. */
  clearRect(x: number, y: number, w: number, h: number): void {
    const c = [this.tx(x, y), this.tx(x + w, y + h)];
    const X0 = Math.min(c[0][0], c[1][0]);
    const X1 = Math.max(c[0][0], c[1][0]);
    const Y0 = Math.min(c[0][1], c[1][1]);
    const Y1 = Math.max(c[0][1], c[1][1]);
    const m = this.s.m;
    const covers =
      m[1] === 0 &&
      m[2] === 0 &&
      X0 <= 0 &&
      Y0 <= 0 &&
      X1 >= this.canvas.width &&
      Y1 >= this.canvas.height &&
      !this.s.clip;
    if (!covers) return;
    this.pendingD = [];
    this.pendingAttrs = '';
    this.els = [];
  }

  /** Intersects the clip with the current path (a `<clipPath>` def). */
  clip(rule?: CanvasFillRule): void {
    this.flush();
    const id = `c${++this.ids}`;
    const prev = this.s.clip ? ` clip-path="url(#${this.s.clip})"` : '';
    const r = rule === 'evenodd' ? ' clip-rule="evenodd"' : '';
    this.defs.push(
      `<clipPath id="${id}"${prev}><path d="${this.d.join('') || 'M0 0'}"${r}/></clipPath>`,
    );
    this.s.clip = id;
  }

  // --- text -------------------------------------------------------------------------------

  /** Advance width estimate: MONO_ADVANCE em per character plus the letter spacing. */
  measureText(text: string): TextMetrics {
    const f = parseFont(this.s.font);
    const n = [...text].length;
    const width = n * (f.size * MONO_ADVANCE + px(this.s.letterSpacing));
    const left = this.s.textAlign === 'right' || this.s.textAlign === 'end' ? width : 0;
    return {
      width,
      actualBoundingBoxLeft: this.s.textAlign === 'center' ? width / 2 : left,
      actualBoundingBoxRight: this.s.textAlign === 'center' ? width / 2 : width - left,
      actualBoundingBoxAscent: f.size * 0.75,
      actualBoundingBoxDescent: f.size * 0.2,
      fontBoundingBoxAscent: f.size * 0.9,
      fontBoundingBoxDescent: f.size * 0.25,
      emHeightAscent: f.size * 0.8,
      emHeightDescent: f.size * 0.2,
      alphabeticBaseline: 0,
      hangingBaseline: f.size * 0.7,
      ideographicBaseline: -f.size * 0.2,
    } as TextMetrics;
  }

  fillText(text: string, x: number, y: number): void {
    const p = this.paint(this.s.fillStyle);
    if (!p || text === '' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const s = this.s;
    const f = parseFont(s.font);
    const uni = this.uniform();
    const k = uni ? s.m[0] : 1;
    let a = '';
    if (uni) {
      const [X, Y] = this.tx(x, y);
      a += ` x="${num(X)}" y="${num(Y)}"`;
    } else {
      a += ` x="${num(x)}" y="${num(y)}" transform="matrix(${s.m.map(num3).join(' ')})"`;
    }
    a += ` font-family="${escapeXml(f.family)}" font-size="${num(f.size * k)}"`;
    if (f.weight && f.weight !== 'normal' && f.weight !== '400') a += ` font-weight="${f.weight}"`;
    if (f.style) a += ` font-style="${f.style}"`;
    const ls = px(s.letterSpacing);
    if (ls) a += ` letter-spacing="${num(ls * k)}"`;
    const anchor =
      s.textAlign === 'center'
        ? 'middle'
        : s.textAlign === 'right' || s.textAlign === 'end'
          ? 'end'
          : '';
    if (anchor) a += ` text-anchor="${anchor}"`;
    const base: Partial<Record<CanvasTextBaseline, string>> = {
      top: 'text-before-edge',
      hanging: 'hanging',
      middle: 'central',
      ideographic: 'ideographic',
      bottom: 'text-after-edge',
    };
    const db = base[s.textBaseline];
    if (db) a += ` dominant-baseline="${db}"`;
    a += ` fill="${p.ref}"${this.common(s.globalAlpha * p.alpha)}`;
    // Canvas draws every whitespace character as a space and keeps runs of them.
    this.push(`<text${a}>${escapeXml(text.replace(/[\t\n\f\r]/g, ' '))}</text>`);
  }

  // --- output -----------------------------------------------------------------------------

  /** The SVG document drawn so far. */
  toSvg(o: SvgOutput = {}): string {
    this.flush();
    const { width: W, height: H } = this.canvas;
    const head = o.xmlDeclaration === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>\n';
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>\n` : '';
    return (
      `${head}<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
      `viewBox="0 0 ${W} ${H}" xml:space="preserve">\n${defs}${this.els.join('\n')}\n</svg>\n`
    );
  }
}

/** Three decimals (alphas, matrices). */
function num3(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return r === 0 ? '0' : String(r);
}

/**
 * The one place an `SvgContext` is passed as a canvas context: it implements the part of
 * `CanvasRenderingContext2D` that `drawScore` calls (the poster's path never reaches the ghost
 * layer's drawImage).
 */
export function asCtx2D(ctx: SvgContext): CanvasRenderingContext2D {
  return ctx as unknown as CanvasRenderingContext2D;
}
