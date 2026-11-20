/**
 * Line colours and theme tokens (PLAN.md §10 "Colors", §11.5). Pure functions of their inputs:
 * the only browser touch is the optional `supportsOklch()` probe, which the app calls once and
 * passes in `ScoreStyle.oklch`.
 */

import type { LineColors } from '../core/types';
import type { ThemeName, ThemeTokens } from './types';

/** Light theme tokens, from the prototype. */
export const LIGHT_TOKENS: ThemeTokens = {
  paper: '#EEF1F4',
  ink: '#151A21',
  ink2: '#5E6876',
  rule: '#D2D8DF',
  accent: '#C2410C',
  panel: '#E3E8ED',
};

/** Dark theme tokens, from the prototype. */
export const DARK_TOKENS: ThemeTokens = {
  paper: '#0F1217',
  ink: '#E4E8EE',
  ink2: '#8D97A5',
  rule: '#262C36',
  accent: '#FF8F5A',
  panel: '#181D25',
};

/** The token set of a theme. */
export function tokensOf(theme: ThemeName): ThemeTokens {
  return theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
}

/** CSS custom property behind each token. */
const TOKEN_VARS: Record<keyof ThemeTokens, string> = {
  paper: '--paper',
  ink: '--ink',
  ink2: '--ink-2',
  rule: '--rule',
  accent: '--accent',
  panel: '--panel',
};

/**
 * Reads the tokens through `getValue` (e.g. `(k) => getComputedStyle(root).getPropertyValue(k)`),
 * falling back to the theme's built-in value when a property is empty.
 */
export function readTokens(
  getValue: (cssVar: string) => string,
  fallback: ThemeName = 'light',
): ThemeTokens {
  const base = tokensOf(fallback);
  const out = { ...base };
  for (const key of Object.keys(TOKEN_VARS) as (keyof ThemeTokens)[]) {
    const v = getValue(TOKEN_VARS[key]).trim();
    if (v) out[key] = v;
  }
  return out;
}

/** True when a #rrggbb colour is dark (luma < 128). Anything unparsable counts as light. */
export function isDarkColor(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 128;
}

/** True when the browser parses `oklch(...)`; false in Node. */
export function supportsOklch(): boolean {
  try {
    const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
    return !!css?.supports?.('color', 'oklch(0.5 0.1 100)');
  } catch {
    return false;
  }
}

/** Hues of the pitch gradient, from the lowest pitch (cool) to the highest (warm). */
export const PITCH_HUES: readonly number[] = [280, 240, 195, 150, 95, 50, 20];

/** Lightness and chroma by theme: lighter and calmer on dark paper. */
function lc(dark: boolean): [number, number] {
  return dark ? [0.8, 0.13] : [0.57, 0.16];
}

/** `oklch(L C h)`, or an HSL approximation when OKLCH is unavailable. */
export function lchColor(L: number, c: number, hue: number, oklch: boolean): string {
  const h = ((hue % 360) + 360) % 360;
  return oklch
    ? `oklch(${L} ${c} ${Math.round(h * 10) / 10})`
    : `hsl(${Math.round(h)} 65% ${Math.round(L * 88)}%)`;
}

/** Gradient stops for 'pitch' mode, from the low end (position 0) to the high end (position 1). */
export function pitchStops(dark: boolean, oklch: boolean): { at: number; color: string }[] {
  const [L, c] = lc(dark);
  return PITCH_HUES.map((h, i) => ({
    at: i / (PITCH_HUES.length - 1),
    color: lchColor(L, c, h, oklch),
  }));
}

/** Colour at pitch fraction `x` (0 = lowest, 1 = highest) of the pitch palette, by stepwise stops. */
export function pitchColor(x: number, dark: boolean, oklch: boolean): string {
  const stops = pitchStops(dark, oklch);
  const i = Math.round(Math.min(1, Math.max(0, x)) * (stops.length - 1));
  return stops[i].color;
}

/** What the colour functions need from a style. */
export interface PaletteInput {
  tokens: ThemeTokens;
  dark: boolean;
  oklch: boolean;
  colors: LineColors;
  customColors?: readonly (string | undefined)[];
}

/**
 * The solid colour of voice `index` in the given mode, or null in 'pitch' mode (which paints a
 * gradient, see `pitchStops`). 'ink' uses the theme ink; 'custom' uses `VoiceDef.color` and falls
 * back to the ink when a voice has none.
 */
export function lineColor(p: PaletteInput, index: number): string | null {
  if (p.colors === 'pitch') return null;
  if (p.colors === 'custom') return p.customColors?.[index] || p.tokens.ink;
  return p.tokens.ink;
}
