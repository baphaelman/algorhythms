/**
 * The background (PLAN.md §15 M14 "Backgrounds"): one function, `fillBackground`, draws every
 * background a Look or poster can set, for the poster's PNG and SVG and the video's frames.
 *
 * - **Solid** colours and the theme's paper, as before.
 * - **Gradients you place:** two or more stops (colour + position 0..1), linear at any angle
 *   (CSS degrees: 0 = to the top, 90 = to the right, 180 = to the bottom; the line through the
 *   centre, long enough that the corners reach the ends) or radial with a centre (fractions of
 *   the frame) and a radius (a fraction of the half-diagonal). The two-colour gradients of M11
 *   (`kind: 'gradient'`) draw as their placed form (`placedGradient`), with exactly the canvas
 *   calls they made before: vertical = 180°, horizontal = 90°, radial = centre ½ ½, radius 1.
 * - **Pictures:** a picture over a background (`under`, else the paper), fitted (cover, contain,
 *   tile) and placed (x, y: 0 = left / top, 1 = right / bottom), then the background washed over
 *   it at `dim`. A canvas draws the decoded image registered for its `src` (`setPictureImage`;
 *   until then only the background shows); an `SvgContext` writes an `<image>` of the data URL.
 *
 * No DOM beyond the 2D context it is given.
 */

import type { PictureFit, PosterPicture } from '../core/types';
import { contrastRatio, mixHex } from './colours';

export type GradientDir = 'vertical' | 'horizontal' | 'radial';

/** A gradient's colour at a position along it (0..1). */
export interface GradientStop {
  color: string;
  at: number;
}

/** A gradient you place: linear at an angle, or radial with a centre and radius. */
export type PlacedGradient =
  | { kind: 'linear'; stops: readonly GradientStop[]; angle: number }
  | { kind: 'radial'; stops: readonly GradientStop[]; cx: number; cy: number; r: number };

/** A background picture: a data URL, its pixel size, its fit, place and dimming. */
export interface BackgroundPicture {
  src: string;
  w: number;
  h: number;
  fit: PictureFit;
  x: number;
  y: number;
  dim: number;
}

/** A background other than a picture. */
export type FillPaint =
  | { kind: 'solid'; color: string }
  /** M11's two colours: `from` at the top (vertical), the left (horizontal) or the centre (radial). */
  | { kind: 'gradient'; from: string; to: string; dir: GradientDir }
  | PlacedGradient;

/** A background other than the theme's paper. Transparent stays `Look.transparent`. */
export type BackgroundPaint =
  FillPaint | { kind: 'picture'; picture: BackgroundPicture; under?: FillPaint };

/** Most tiles across the shorter side (smaller pictures tile larger). */
const MAX_TILES = 48;

// ---------------------------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------------------------

/** The placed form of M11's two-colour gradient (draws the same pixels). */
export function placedGradient(bg: { from: string; to: string; dir: GradientDir }): PlacedGradient {
  const stops = [
    { color: bg.from, at: 0 },
    { color: bg.to, at: 1 },
  ];
  if (bg.dir === 'radial') return { kind: 'radial', stops, cx: 0.5, cy: 0.5, r: 1 };
  return { kind: 'linear', stops, angle: bg.dir === 'horizontal' ? 90 : 180 };
}

/** A gradient's placed form (M11's two colours mapped), or null for a solid or picture. */
export function asPlaced(bg: BackgroundPaint | undefined): PlacedGradient | null {
  if (!bg) return null;
  if (bg.kind === 'gradient') return placedGradient(bg);
  return bg.kind === 'linear' || bg.kind === 'radial' ? bg : null;
}

const snap = (v: number): number => (Math.abs(v) < 1e-12 ? 0 : v);

/**
 * The ends of a linear gradient at `angle` (CSS degrees) over a W × H frame: through the centre,
 * long enough that the far corners sit at its ends. An axis-aligned line starts at the frame's
 * edge (x or y 0), as M11's vertical and horizontal gradients did.
 */
export function gradientLine(
  angle: number,
  W: number,
  H: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const a = ((Number.isFinite(angle) ? angle : 180) * Math.PI) / 180;
  const dx = snap(Math.sin(a));
  const dy = snap(-Math.cos(a));
  const half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
  const cx = W / 2;
  const cy = H / 2;
  return {
    x0: dx === 0 ? 0 : cx - dx * half,
    y0: dy === 0 ? 0 : cy - dy * half,
    x1: dx === 0 ? 0 : cx + dx * half,
    y1: dy === 0 ? 0 : cy + dy * half,
  };
}

/** The stops in position order (stable), each clamped to 0..1. */
export function sortedStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops
    .map((s, i) => ({ s, i }))
    .sort((p, q) => p.s.at - q.s.at || p.i - q.i)
    .map(({ s }) => ({ color: s.color, at: Math.min(1, Math.max(0, s.at)) }));
}

type Grad2D = Pick<CanvasRenderingContext2D, 'createLinearGradient' | 'createRadialGradient'>;

/** The canvas gradient of a placed gradient over a W × H frame. */
export function placedCanvasGradient(
  g: Grad2D,
  pg: PlacedGradient,
  W: number,
  H: number,
): CanvasGradient {
  let grad: CanvasGradient;
  if (pg.kind === 'radial') {
    const x = pg.cx * W;
    const y = pg.cy * H;
    grad = g.createRadialGradient(x, y, 0, x, y, Math.max(1e-6, pg.r) * (Math.hypot(W, H) / 2));
  } else {
    const l = gradientLine(pg.angle, W, H);
    grad = g.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
  }
  for (const s of sortedStops(pg.stops)) grad.addColorStop(s.at, s.color);
  return grad;
}

/** The colour at f (0..1) along positioned stops, mixed between neighbours as a canvas does. */
export function stopColorAt(stops: readonly GradientStop[], f: number): string {
  const s = sortedStops(stops);
  if (s.length === 0) return '#000000';
  if (f <= s[0].at) return s[0].color;
  for (let i = 1; i < s.length; i++) {
    if (f <= s[i].at) {
      const span = s[i].at - s[i - 1].at;
      return span > 0 ? mixHex(s[i - 1].color, s[i].color, (f - s[i - 1].at) / span) : s[i].color;
    }
  }
  return s[s.length - 1].color;
}

/** The background's colours to test text against: the solid colour, or 9 points of a gradient. */
export function backgroundSamples(bg: BackgroundPaint | undefined, paper: string): string[] {
  if (!bg) return [paper];
  if (bg.kind === 'picture') return backgroundSamples(bg.under, paper);
  if (bg.kind === 'solid') return [bg.color];
  const pg = asPlaced(bg)!;
  const out: string[] = [];
  for (let i = 0; i <= 8; i++) out.push(stopColorAt(pg.stops, i / 8));
  return out;
}

/** The worst contrast of `text` against a background (every sampled point of a gradient). */
export function worstContrast(
  text: string,
  bg: BackgroundPaint | undefined,
  paper: string,
): number {
  let worst = Infinity;
  for (const c of backgroundSamples(bg, paper)) worst = Math.min(worst, contrastRatio(text, c));
  return worst;
}

/** The background's first colour (a gradient's first stop; a picture's background's). */
export function backgroundColour(bg: BackgroundPaint | undefined, paper: string): string {
  if (!bg) return paper;
  if (bg.kind === 'picture') return backgroundColour(bg.under, paper);
  if (bg.kind === 'solid') return bg.color;
  if (bg.kind === 'gradient') return bg.from;
  return sortedStops(bg.stops)[0]?.color ?? paper;
}

// ---------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------

/** A rectangle in frame px. */
export interface PictureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a picture lands over a W × H frame: one rect for cover and contain (scaled to fill or to
 * fit, placed by x and y), the tiles for tile (at the picture's own pixel size, no smaller than
 * 1/48 of the shorter side; the grid shifted by x and y). Rects may reach past the frame (clip).
 */
export function pictureRects(p: BackgroundPicture, W: number, H: number): PictureRect[] {
  if (!(p.w > 0 && p.h > 0 && W > 0 && H > 0)) return [];
  const fx = clamp01(p.x);
  const fy = clamp01(p.y);
  if (p.fit === 'tile') {
    const k = Math.max(1, Math.min(W, H) / MAX_TILES / Math.min(p.w, p.h));
    const tw = p.w * k;
    const th = p.h * k;
    const ox = mod((W - tw) * fx, tw) - tw;
    const oy = mod((H - th) * fy, th) - th;
    const out: PictureRect[] = [];
    for (let y = oy; y < H; y += th)
      for (let x = ox; x < W; x += tw) out.push({ x, y, w: tw, h: th });
    return out.filter((r) => r.x + r.w > 0 && r.y + r.h > 0);
  }
  const s = p.fit === 'contain' ? Math.min(W / p.w, H / p.h) : Math.max(W / p.w, H / p.h);
  const w = p.w * s;
  const h = p.h * s;
  return [{ x: (W - w) * fx + 0, y: (H - h) * fy + 0, w, h }];
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Decoded pictures by data URL, for canvas drawing (the app registers them once loaded). */
const IMAGES = new Map<string, CanvasImageSource>();

/** Registers (or with null forgets) the decoded image of a picture's `src`. */
export function setPictureImage(src: string, image: CanvasImageSource | null): void {
  if (image) IMAGES.set(src, image);
  else IMAGES.delete(src);
}

/** The decoded image of a picture's `src`, if registered. */
export function pictureImage(src: string): CanvasImageSource | undefined {
  return IMAGES.get(src);
}

/** A context that writes image URLs itself (`SvgContext`). */
interface UrlImages {
  drawImageUrl(href: string, x: number, y: number, w: number, h: number): void;
}

function drawPicture(g: CanvasRenderingContext2D, p: BackgroundPicture, W: number, H: number) {
  const rects = pictureRects(p, W, H);
  if (rects.length === 0) return;
  const svg = 'drawImageUrl' in g ? (g as unknown as UrlImages) : null;
  const img = svg ? undefined : pictureImage(p.src);
  if (!svg && !img) return;
  g.save();
  g.beginPath();
  g.rect(0, 0, W, H);
  g.clip();
  g.globalAlpha = 1;
  for (const r of rects) {
    if (svg) svg.drawImageUrl(p.src, r.x, r.y, r.w, r.h);
    else g.drawImage(img!, r.x, r.y, r.w, r.h);
  }
  g.restore();
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

/** The fill style of a non-picture background (a colour or a canvas gradient). */
function fillStyleOf(g: CanvasRenderingContext2D, bg: FillPaint, W: number, H: number) {
  return bg.kind === 'solid' ? bg.color : placedCanvasGradient(g, asPlaced(bg)!, W, H);
}

/**
 * Fills a W × H frame with a background: its paint, else the paper as before. A transparent
 * paper (a transparent poster) ignores the paint, except a picture, which still draws (with
 * nothing under it and no wash).
 */
export function fillBackground(
  g: CanvasRenderingContext2D,
  paper: string,
  paint: { background?: BackgroundPaint } | undefined,
  W: number,
  H: number,
): void {
  const bg = paint?.background;
  if (bg?.kind === 'picture') {
    const under = bg.under;
    const clear = paper === 'transparent';
    const fill = (): void => {
      g.fillStyle = under && !clear ? fillStyleOf(g, under, W, H) : paper;
      g.fillRect(0, 0, W, H);
    };
    fill();
    drawPicture(g, bg.picture, W, H);
    const dim = clamp01(bg.picture.dim);
    if (dim > 0 && !clear) {
      const a = g.globalAlpha;
      g.globalAlpha = a * dim;
      fill();
      g.globalAlpha = a;
    }
    return;
  }
  if (!bg || paper === 'transparent') g.fillStyle = paper;
  else g.fillStyle = fillStyleOf(g, bg, W, H);
  g.fillRect(0, 0, W, H);
}

/** A stored picture (`PosterDoc.picture`) with its defaults: cover, centred, no dimming. */
export function resolvePicture(p: PosterPicture): BackgroundPicture {
  return {
    src: p.src,
    w: p.w,
    h: p.h,
    fit: p.fit === 'contain' || p.fit === 'tile' ? p.fit : 'cover',
    x: p.x ?? 0.5,
    y: p.y ?? 0.5,
    dim: p.dim ?? 0,
  };
}

/** A background with a picture over it (none: the background as it was). */
export function withPicture(
  bg: BackgroundPaint | undefined,
  picture: PosterPicture | undefined,
): BackgroundPaint | undefined {
  if (!picture || typeof picture.src !== 'string' || !(picture.w > 0 && picture.h > 0)) return bg;
  const under = bg?.kind === 'picture' ? bg.under : bg;
  return { kind: 'picture', picture: resolvePicture(picture), ...(under ? { under } : {}) };
}
