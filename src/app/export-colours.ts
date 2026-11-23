/**
 * The Export dialog's Colours group (PLAN.md §12 "Exports you can shape" → Colours), as pure
 * functions: the form's colours, built-in and saved schemes, how they resolve to the renderer's
 * `LookColours`, the swatches' shown values and the contrast warning. No DOM.
 */

import type { LineColors } from '../core/types';
import {
  PAINT_KEYS,
  toHex,
  worstContrast,
  themeSwatch,
  type BackgroundPaint,
  type GradientDir,
  type LookColours,
  type PaintKey,
} from '../render/colours';
import { lchColor, pitchStops } from '../render/palettes';
import type { ThemeTokens } from '../render/types';

/** Lines: as in the app, by pitch, a colour per part, or one colour. */
export type LineMode = 'app' | 'pitch' | 'part' | 'one';
/** Background: the theme's, a solid colour, a gradient, or none (posters). */
export type BackgroundMode = 'theme' | 'solid' | 'gradient' | 'transparent';

/** `#rrggbb`, or null for the theme's colour. */
type Swatch = string | null;

/** What the Colours group holds. Null swatches draw the theme's colour (as before). */
export type ColoursForm = {
  lines: LineMode;
  /** 'transparent' is the poster's `look.transparent`, not stored here. */
  background: Exclude<BackgroundMode, 'transparent'>;
  bg: Swatch;
  bgFrom: Swatch;
  bgTo: Swatch;
  bgDir: GradientDir;
  /** By pitch: low and high (both null: the theme's hues) and an optional middle. */
  low: Swatch;
  mid: Swatch;
  high: Swatch;
  /** One colour. */
  one: Swatch;
  /** Per part: colour by part name ('' = lines without a part); missing = `partColour`. */
  parts: Readonly<Record<string, string>>;
} & { [K in PaintKey]: Swatch };

export const DEFAULT_COLOURS: ColoursForm = {
  lines: 'app',
  background: 'theme',
  bg: null,
  bgFrom: null,
  bgTo: null,
  bgDir: 'vertical',
  low: null,
  mid: null,
  high: null,
  one: null,
  parts: {},
  heads: null,
  playhead: null,
  hud: null,
  markers: null,
  labels: null,
  guides: null,
  beats: null,
  title: null,
  end: null,
  glow: null,
};

export const LINE_MODES: readonly { id: LineMode; label: string }[] = [
  { id: 'app', label: 'App' },
  { id: 'pitch', label: 'By pitch' },
  { id: 'part', label: 'Parts' },
  { id: 'one', label: 'One' },
];

export const BACKGROUND_MODES: readonly { id: BackgroundMode; label: string }[] = [
  { id: 'theme', label: 'Theme' },
  { id: 'solid', label: 'Solid' },
  { id: 'gradient', label: 'Gradient' },
  { id: 'transparent', label: 'Transparent' },
];

export const GRADIENT_DIRS: readonly { id: GradientDir; label: string }[] = [
  { id: 'vertical', label: 'Vertical' },
  { id: 'horizontal', label: 'Horizontal' },
  { id: 'radial', label: 'Radial' },
];

/** The element swatches in dialog order, with their labels. */
export const ELEMENT_SWATCHES: readonly { key: PaintKey; label: string; hint?: string }[] = [
  { key: 'heads', label: 'Heads and rings', hint: 'follows the lines' },
  { key: 'playhead', label: 'Playhead' },
  { key: 'hud', label: 'HUD text' },
  { key: 'markers', label: 'Moment markers' },
  { key: 'labels', label: 'Section labels' },
  { key: 'guides', label: 'Guide lines' },
  { key: 'beats', label: 'Beat and bar lines' },
  { key: 'title', label: 'Title text' },
  { key: 'end', label: 'End-card text' },
  { key: 'glow', label: 'Glow', hint: 'follows the lines' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** A typed hex colour ("#3a6", "3A66CC", "#3a66cc") as `#rrggbb`, or null. */
export function parseHex(text: string): string | null {
  let t = text.trim().toLowerCase();
  if (!t.startsWith('#')) t = `#${t}`;
  if (/^#[0-9a-f]{3}$/.test(t)) t = `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  return HEX.test(t) ? t : null;
}

// ---------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------

/** Hues of the per-part palette, far apart in order. */
const PART_HUES = [250, 30, 150, 330, 95, 200, 60, 290];

/** The k-th part's default colour (hex) for a theme. */
export function partColour(k: number, dark: boolean): string {
  const h = PART_HUES[((k % PART_HUES.length) + PART_HUES.length) % PART_HUES.length];
  const [L, c] = dark ? [0.78, 0.13] : [0.58, 0.16];
  return toHex(lchColor(L, c, h, true)) ?? '#808080';
}

/** The parts of a pool in first-seen order ('' = lines without a part). */
export function partsOf(parts: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const k = p ?? '';
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** The colour a part draws with: its own, else the palette's for its place. */
export function partSwatch(c: ColoursForm, names: readonly string[], part: string, dark: boolean) {
  return c.parts[part] ?? partColour(Math.max(0, names.indexOf(part)), dark);
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/** What the colours resolve against: the theme's tokens and the pool's parts. */
export interface ColourContext {
  tokens: ThemeTokens;
  dark: boolean;
  /** Each voice's part by pool index. */
  parts?: readonly (string | undefined)[];
}

/** The theme's pitch hues at the low and high ends, as hex. */
export function pitchEnds(dark: boolean): [string, string] {
  const s = pitchStops(dark, true);
  return [toHex(s[0].color) ?? '#000000', toHex(s[s.length - 1].color) ?? '#000000'];
}

/** The background a form draws (undefined = the theme's paper). */
export function backgroundOf(c: ColoursForm, t: ThemeTokens): BackgroundPaint | undefined {
  if (c.background === 'solid') return { kind: 'solid', color: c.bg ?? t.paper };
  if (c.background === 'gradient') {
    return { kind: 'gradient', from: c.bgFrom ?? t.paper, to: c.bgTo ?? t.panel, dir: c.bgDir };
  }
  return undefined;
}

/** The colour a swatch shows: its own, or the theme's (heads and glow: the ink). */
export function swatchValue(c: ColoursForm, key: PaintKey, t: ThemeTokens): string {
  return c[key] ?? toHex(themeSwatch(key, t)) ?? '#000000';
}

/**
 * The renderer's colours for a form, or undefined when every colour is the theme's (the export
 * then draws exactly as before). Lines 'app' set no `lines`.
 */
export function coloursLook(c: ColoursForm, ctx: ColourContext): LookColours | undefined {
  const out: LookColours = {};
  const bg = backgroundOf(c, ctx.tokens);
  if (bg) out.background = bg;
  if (c.lines === 'pitch') {
    if (c.low === null && c.high === null && c.mid === null) out.lines = { kind: 'pitch' };
    else {
      const [lo, hi] = pitchEnds(ctx.dark);
      const stops = [c.low ?? lo, ...(c.mid ? [c.mid] : []), c.high ?? hi];
      out.lines = { kind: 'pitch', stops };
    }
  } else if (c.lines === 'one') out.lines = { kind: 'one', color: c.one ?? ctx.tokens.ink };
  else if (c.lines === 'part') {
    const parts = ctx.parts ?? [];
    const names = partsOf(parts);
    out.lines = {
      kind: 'part',
      colors: parts.map((p) => partSwatch(c, names, p ?? '', ctx.dark)),
    };
  }
  for (const k of PAINT_KEYS) {
    const v = c[k];
    if (v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The Look's `colors` for a line mode (the app's own for 'app'). */
export function lineColorsOf(mode: LineMode, app: LineColors): LineColors {
  if (mode === 'app') return app;
  return mode === 'pitch' ? 'pitch' : mode === 'one' ? 'ink' : 'custom';
}

/** Least contrast HUD text and labels may have with the background (§12). */
export const MIN_CONTRAST = 3;

/**
 * The one-line contrast warning, or null: HUD text or section labels under 3:1 against the
 * background (a gradient's worst point). None for a transparent poster.
 */
export function contrastWarning(
  c: ColoursForm,
  t: ThemeTokens,
  transparent: boolean,
): string | null {
  if (transparent) return null;
  const bg = backgroundOf(c, t);
  const hud = Math.min(
    ...(c.hud ? [c.hud] : [t.ink, t.ink2]).map((x) => worstContrast(x, bg, t.paper)),
  );
  const labels = worstContrast(c.labels ?? t.ink2, bg, t.paper);
  const low: string[] = [];
  if (hud < MIN_CONTRAST) low.push(`HUD text ${hud.toFixed(1)}:1`);
  if (labels < MIN_CONTRAST) low.push(`labels ${labels.toFixed(1)}:1`);
  return low.length > 0
    ? `Low contrast with the background (${low.join(', ')}; aim for 3:1).`
    : null;
}

// ---------------------------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------------------------

export interface ColourScheme {
  /** 'paper', 'night', … for built-ins; the name for a saved one. */
  id: string;
  name: string;
  colours: ColoursForm;
}

const scheme = (id: string, name: string, c: Partial<ColoursForm>): ColourScheme => ({
  id,
  name,
  colours: { ...DEFAULT_COLOURS, ...c },
});

/**
 * Built-in schemes (§12): each sets every colour. HUD text and labels keep ≥ 4.5:1 with the
 * background's worst point (unit-tested).
 */
export const BUILTIN_SCHEMES: readonly ColourScheme[] = [
  scheme('paper', 'Paper', {
    lines: 'pitch',
    background: 'solid',
    bg: '#f4efe4',
    low: '#24426e',
    mid: '#8e3b52',
    high: '#c2782a',
    heads: '#2a2722',
    playhead: '#a39a8a',
    hud: '#2a2722',
    markers: '#cbbfa9',
    labels: '#6b6152',
    guides: '#ddd3c1',
    beats: '#ddd3c1',
    title: '#1f1c18',
    end: '#1f1c18',
  }),
  scheme('night', 'Night', {
    lines: 'pitch',
    background: 'gradient',
    bgFrom: '#070b17',
    bgTo: '#161a33',
    bgDir: 'vertical',
    low: '#4f86ff',
    mid: '#b07cff',
    high: '#ffcf70',
    heads: '#f3f0e6',
    playhead: '#3c4668',
    hud: '#c8d2e8',
    markers: '#2b3456',
    labels: '#8e9cc0',
    guides: '#1d2542',
    beats: '#1d2542',
    title: '#eef2fa',
    end: '#eef2fa',
    glow: '#6f7dff',
  }),
  scheme('neon', 'Neon', {
    lines: 'pitch',
    background: 'gradient',
    bgFrom: '#120a24',
    bgTo: '#040308',
    bgDir: 'radial',
    low: '#00e5ff',
    mid: '#ff2bd6',
    high: '#ffe600',
    heads: '#ffffff',
    playhead: '#4a3a6e',
    hud: '#ece8ff',
    markers: '#3a2c5c',
    labels: '#b8a6ff',
    guides: '#1d1633',
    beats: '#1d1633',
    title: '#ffffff',
    end: '#ffffff',
    glow: '#ff2bd6',
  }),
  scheme('pastel', 'Pastel', {
    lines: 'pitch',
    background: 'gradient',
    bgFrom: '#fdf6ef',
    bgTo: '#efe6f6',
    bgDir: 'radial',
    low: '#5b8bc9',
    mid: '#a77bc6',
    high: '#e0787f',
    heads: '#4a4458',
    playhead: '#b9afcb',
    hud: '#4a4458',
    markers: '#d9cde2',
    labels: '#5f5874',
    guides: '#ebe1ee',
    beats: '#ebe1ee',
    title: '#3c3749',
    end: '#3c3749',
  }),
  scheme('mono', 'Mono', {
    lines: 'one',
    background: 'solid',
    bg: '#0e0e0e',
    one: '#ededed',
    heads: '#ffffff',
    playhead: '#5a5a5a',
    hud: '#d6d6d6',
    markers: '#3a3a3a',
    labels: '#9a9a9a',
    guides: '#252525',
    beats: '#252525',
    title: '#ffffff',
    end: '#ffffff',
  }),
];

/** A colours record as text with sorted keys, for comparing. */
function canon(c: ColoursForm): string {
  const parts = Object.keys(c.parts)
    .sort()
    .map((k) => [k, c.parts[k]]);
  const rest = Object.keys(c)
    .filter((k) => k !== 'parts')
    .sort()
    .map((k) => [k, c[k as keyof ColoursForm]]);
  return JSON.stringify([rest, parts]);
}

export function sameColours(a: ColoursForm, b: ColoursForm): boolean {
  return canon(a) === canon(b);
}

/**
 * Which scheme the colours are: 'theme' (all the theme's), a built-in's id, 'saved:<name>', or
 * 'custom' (anything else, e.g. a swatch changed after picking a scheme).
 */
export function schemeOf(c: ColoursForm, saved: readonly ColourScheme[] = []): string {
  if (sameColours(c, DEFAULT_COLOURS)) return 'theme';
  for (const s of BUILTIN_SCHEMES) if (sameColours(c, s.colours)) return s.id;
  for (const s of saved) if (sameColours(c, s.colours)) return `saved:${s.name}`;
  return 'custom';
}

/** Longest scheme name kept. */
export const SCHEME_NAME_MAX = 40;
/** Most saved schemes kept. */
export const SCHEMES_MAX = 24;

/** The saved schemes with `colours` saved as `name` (replacing one of that name). */
export function saveScheme(
  saved: readonly ColourScheme[],
  name: string,
  colours: ColoursForm,
): ColourScheme[] {
  const n = name.trim().slice(0, SCHEME_NAME_MAX);
  if (!n) return [...saved];
  const rest = saved.filter((s) => s.name !== n);
  return [...rest, { id: n, name: n, colours }].slice(-SCHEMES_MAX);
}

export function deleteScheme(saved: readonly ColourScheme[], name: string): ColourScheme[] {
  return saved.filter((s) => s.name !== name);
}

// ---------------------------------------------------------------------------------------------
// Stored values
// ---------------------------------------------------------------------------------------------

const hexOrNull = (v: unknown): Swatch | undefined =>
  v === null ? null : typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined;
const oneOf = <T>(list: readonly { id: T }[], v: unknown): v is T => list.some((o) => o.id === v);

/** Stored colours over the defaults: each valid field kept. */
export function parseColours(raw: unknown): ColoursForm {
  const c: ColoursForm = { ...DEFAULT_COLOURS };
  if (!raw || typeof raw !== 'object') return c;
  const r = raw as Record<string, unknown>;
  if (oneOf(LINE_MODES, r.lines)) c.lines = r.lines;
  if (r.background === 'theme' || r.background === 'solid' || r.background === 'gradient')
    c.background = r.background;
  if (oneOf(GRADIENT_DIRS, r.bgDir)) c.bgDir = r.bgDir;
  for (const k of ['bg', 'bgFrom', 'bgTo', 'low', 'mid', 'high', 'one', ...PAINT_KEYS] as const) {
    const v = hexOrNull(r[k]);
    if (v !== undefined) c[k] = v;
  }
  if (r.parts && typeof r.parts === 'object') {
    const parts: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.parts as Record<string, unknown>)) {
      const h = hexOrNull(v);
      if (h) parts[k] = h;
    }
    c.parts = parts;
  }
  return c;
}

/** Stored saved schemes: valid names, each colours parsed. */
export function parseSchemes(raw: unknown): ColourScheme[] {
  if (!Array.isArray(raw)) return [];
  let out: ColourScheme[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const name = (s as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) continue;
    out = saveScheme(out, name, parseColours((s as { colours?: unknown }).colours));
  }
  return out;
}

/**
 * Colours from a record before v4: the old Line colours ('app' / 'pitch' / 'ink' / 'custom')
 * and their ink. Ink and Custom become One colour (voice colours still apply).
 */
export function coloursFromOld(colors: unknown, lineInk: unknown): ColoursForm {
  const c: ColoursForm = { ...DEFAULT_COLOURS };
  if (colors === 'pitch') c.lines = 'pitch';
  else if (colors === 'ink' || colors === 'custom') {
    c.lines = 'one';
    c.one = hexOrNull(lineInk) ?? null;
  }
  return c;
}
