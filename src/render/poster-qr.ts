/**
 * A poster's QR code (PLAN.md §15 M17 "QR code"): the piece's watch link as dark modules on a
 * light card that holds the 4-module quiet zone. The app encodes the link (a library loaded on
 * demand) and hands the modules to the layout (`QrInput`); this file places the card and draws
 * it. Pure: no encoder here.
 */

import type { PosterQr } from '../core/types';

/** A QR code's modules: `n` × `n`, row by row, '1' = dark. */
export interface QrMatrix {
  n: number;
  bits: string;
}

/** What the app knows of a poster's QR code. */
export interface QrInput {
  /** The watch link it holds. */
  link: string;
  /** Its modules; absent while encoding, or when the link is too long. */
  matrix?: QrMatrix;
  /** The link is longer than a code that scans easily holds (`QR_MAX_CHARS`). */
  tooLong?: boolean;
}

/** Longest watch link a poster's code holds (about what scans easily at poster sizes). */
export const QR_MAX_CHARS = 1500;
/** The quiet zone, modules on each side. */
export const QR_QUIET = 4;
/** The default card's side while its modules are unknown, a fraction of the shorter side. */
export const QR_SIDE = 0.24;
/** The default card's side is between these fractions of the shorter side. */
export const QR_DEFAULT_MIN = 0.12;
export const QR_DEFAULT_MAX = 0.4;
/** A module that scans printed: this fraction of the shorter side (≈ 0.5 mm on A4). */
export const QR_MODULE_FRACTION = 1 / 400;
/** Smallest card side, a fraction of the shorter side. */
export const QR_MIN_SIDE = 0.04;
/** A module smaller than this (export px) may not scan. */
export const QR_MIN_MODULE_PX = 3;
/** Module and card colours below this contrast ratio may not scan. */
export const QR_MIN_CONTRAST = 4;

export const QR_DEFAULT_COLOUR = '#000000';
export const QR_DEFAULT_CARD = '#ffffff';

/**
 * Where the code stands: `ok` (drawn), `long` (the link is over the limit: the artboard shows a
 * notice, exports leave it out) or `pending` (still encoding: nothing exported).
 */
export type QrState = 'ok' | 'long' | 'pending';

/** The card's modules across, quiet zone included (0 while unknown). */
export const qrSpan = (m: QrMatrix | undefined): number => (m ? m.n + 2 * QR_QUIET : 0);

/**
 * The card's square from a stored box (fractions of a `W` × `H` artboard): as wide as the
 * smaller of its sides in px. With the modules known and at least `QR_MIN_MODULE_PX` px each,
 * it snaps to whole px per module and a whole-px corner, so a PNG at 1:1 is crisp.
 */
export function qrSquare(
  x: number,
  y: number,
  side: number,
  matrix: QrMatrix | undefined,
): { x: number; y: number; w: number; h: number } {
  const span = qrSpan(matrix);
  if (!(span > 0 && side / span >= QR_MIN_MODULE_PX)) return { x, y, w: side, h: side };
  const s = Math.floor(side / span) * span;
  return { x: Math.round(x), y: Math.round(y), w: s, h: s };
}

/** The smallest module that scans (px, on a poster whose shorter side is `S` px). */
export const qrMinModule = (S: number): number =>
  Math.max(QR_MIN_MODULE_PX, S * QR_MODULE_FRACTION);

/**
 * The default card's side (px) on a poster whose shorter side is `S` px: whole px per module of
 * at least `qrMinModule`, so denser codes are larger; between `QR_DEFAULT_MIN` and
 * `QR_DEFAULT_MAX` of `S` (`QR_SIDE` while the modules are unknown).
 */
export function qrDefaultSide(S: number, m: QrMatrix | undefined): number {
  if (!m) return QR_SIDE * S;
  const span = qrSpan(m);
  // Whole px per module: the clamps round inward to the module grid.
  const lo = Math.ceil((QR_DEFAULT_MIN * S) / span) * span;
  const hi = Math.floor((QR_DEFAULT_MAX * S) / span) * span;
  return Math.min(hi, Math.max(lo, Math.ceil(qrMinModule(S)) * span));
}

/** The doc's code side in px from its box (none: undefined). */
export function qrBoxSide(qr: PosterQr, W: number, H: number): number | undefined {
  const b = qr.box;
  if (!b || !(b.w > 0 && b.h > 0)) return undefined;
  return Math.min(b.w * W, b.h * H);
}

/** A module's size in px when the card is `side` px. */
export const qrModulePx = (side: number, m: QrMatrix | undefined): number =>
  m ? side / qrSpan(m) : 0;

/** The dark modules as runs per row: [row, col, length]. */
export function qrRuns(m: QrMatrix): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let r = 0; r < m.n; r++) {
    let c = 0;
    while (c < m.n) {
      if (m.bits.charCodeAt(r * m.n + c) !== 49) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < m.n && m.bits.charCodeAt(r * m.n + c) === 49) c++;
      out.push([r, c0, c - c0]);
    }
  }
  return out;
}

/** The dark modules as compact SVG path data in module units (the code's top-left at 0, 0). */
export function qrPathData(m: QrMatrix): string {
  return qrRuns(m)
    .map(([r, c, n]) => `M${c} ${r}h${n}v1h-${n}z`)
    .join('');
}

// ---------------------------------------------------------------------------------------------
// Contrast (WCAG relative luminance)
// ---------------------------------------------------------------------------------------------

function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * The contrast ratio of modules on card (1..21), negative when the modules are lighter than the
 * card (many phone readers miss inverted codes); null for colours it can't read.
 */
export function qrContrast(colour: string, card: string): number | null {
  const a = luminance(colour);
  const b = luminance(card);
  if (a === null || b === null) return null;
  const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return a > b ? -r : r;
}

/** Whether modules on card scan easily: dark on light, contrast ≥ `QR_MIN_CONTRAST`. */
export function qrReadable(colour: string, card: string): boolean {
  const c = qrContrast(colour, card);
  return c === null || c >= QR_MIN_CONTRAST;
}
