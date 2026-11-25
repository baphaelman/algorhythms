/**
 * Export colours (PLAN.md §12 "Exports you can shape" → Colours): the background, the lines and a
 * colour per drawn element, as the Look carries them (`LookColours`) and as drawScore reads them
 * (`StylePaint` on the ScoreStyle). Every field is optional: absent draws exactly as before.
 * Colour maths (hex parsing, mixing, WCAG contrast) lives here too. Pure; no DOM.
 */

import type { BackgroundPaint } from './background';
import type { ThemeTokens } from './types';
import { svgColor } from './svg';

export type { BackgroundPaint, GradientDir } from './background';

/**
 * Line colours other than the app's: by pitch (2 or 3 stops, low → high; none = the theme's hues),
 * a colour per line resolved from its part (by pool index), or one colour. Voice colours from
 * the Voices drawer win in each.
 */
export type LinePaint =
  | { kind: 'pitch'; stops?: readonly string[] }
  | { kind: 'part'; colors: readonly string[] }
  | { kind: 'one'; color: string };

/** The element colours a Look can set (each absent = the theme's as before). */
export const PAINT_KEYS = [
  'heads',
  'playhead',
  'hud',
  'markers',
  'labels',
  'guides',
  'beats',
  'title',
  'end',
  'glow',
] as const;
export type PaintKey = (typeof PAINT_KEYS)[number];

/** A Look's colours (§12 Colours). */
export type LookColours = {
  background?: BackgroundPaint;
  lines?: LinePaint;
} & { [K in PaintKey]?: string };

/**
 * What drawScore reads: the background, the pitch colouring's stops, whether voice colours beat
 * the pitch gradient, and the element colours:
 * - heads: dots, rings and Hz labels (else the line colour, the accent and the secondary ink);
 * - playhead; hud: every readout; markers: moment ticks and section lines; labels: section
 *   labels and a poster's row times; guides: octave (and pitch) guide lines and their labels;
 *   beats: beat and bar lines; title: a poster's title block (and the video's title card);
 *   end: the end card's text; glow: the glow (absent = the lines').
 */
export type StylePaint = {
  background?: BackgroundPaint;
  pitchStops?: readonly string[];
  voiceFirst?: boolean;
} & { [K in PaintKey]?: string };

// ---------------------------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------------------------

/** `#rrggbb` (lower case) of any colour this module reads (hex, oklch), or null. */
export function toHex(color: string): string | null {
  const c = svgColor(color.trim()).color.toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

/** sRGB channels 0..255 of a colour, or null. */
export function rgbOf(color: string): [number, number, number] | null {
  const h = toHex(color);
  if (!h) return null;
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0');

/** `a` mixed toward `b` by f (0..1) in sRGB, as a canvas gradient interpolates. */
export function mixHex(a: string, b: string, f: number): string {
  const p = rgbOf(a);
  const q = rgbOf(b);
  if (!p || !q) return a;
  const k = Math.min(1, Math.max(0, f));
  return `#${hex2(p[0] + (q[0] - p[0]) * k)}${hex2(p[1] + (q[1] - p[1]) * k)}${hex2(p[2] + (q[2] - p[2]) * k)}`;
}

/** The colour at f (0..1) of evenly spaced stops, mixed between neighbours. */
export function stopsAt(stops: readonly string[], f: number): string {
  if (stops.length === 0) return '#000000';
  if (stops.length === 1) return stops[0];
  const x = Math.min(1, Math.max(0, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixHex(stops[i], stops[i + 1], x - i);
}

/** WCAG 2 relative luminance of a colour (0 black .. 1 white); null when unreadable. */
export function luminance(color: string): number | null {
  const c = rgbOf(color);
  if (!c) return null;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio of two colours, 1..21 (1 when either is unreadable). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return 1;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The StylePaint of a Look's colours, or undefined when they set nothing. */
export function stylePaint(
  c: LookColours | undefined,
  transparent: boolean,
): StylePaint | undefined {
  if (!c) return undefined;
  const p: StylePaint = {};
  if (c.background && !transparent) p.background = c.background;
  if (c.lines) {
    p.voiceFirst = true;
    if (c.lines.kind === 'pitch' && c.lines.stops && c.lines.stops.length >= 2)
      p.pitchStops = c.lines.stops;
  }
  for (const k of PAINT_KEYS) {
    const v = c[k];
    if (v) p[k] = v;
  }
  return Object.keys(p).length > 0 ? p : undefined;
}

/** A theme's colour for each element swatch, as drawn with nothing set (hex). */
export function themeSwatch(key: PaintKey, t: ThemeTokens): string {
  switch (key) {
    case 'hud':
    case 'title':
    case 'end':
    case 'heads':
    case 'glow':
      return t.ink;
    case 'labels':
      return t.ink2;
    default:
      return t.rule;
  }
}
