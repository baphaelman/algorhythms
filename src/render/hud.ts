/**
 * The heads-up display (PLAN.md §10 layer 6, §12 "Export look"): an ordered list of readouts laid
 * out in two columns, left first (the first ⌈n/2⌉), then right, one row each. The default list is
 * the player's HUD: formula, notes, time | chord, key · follow mode, Hz range.
 */

import { spreadText, semitoneText } from '../core/intervals';
import { activeAt, chordAt, keyAt, pitchAt } from '../core/query';
import { hzOf } from '../core/tuning';
import type { CompiledScore, Key, Pitch, Seconds } from '../core/types';
import { HUD_ROW, hudLines } from './camera';
import { noteLabel } from './hover';
import {
  HUD_BASELINE,
  HUD_BOX_H,
  HUD_MIN_W,
  anchorFactors,
  placeBox,
  type HudAnchor,
  type HudLayout,
  type HudRect,
} from './hud-layout';
import { OPACITY_EPS, opacityAt } from './level';
import type { HudItem, ScoreStyle, View } from './types';

/** Today's HUD (the player's): left formula, notes, time; right chord, key, Hz range. */
export const DEFAULT_HUD: readonly HudItem[] = ['formula', 'notes', 'time', 'chord', 'key', 'hz'];

/** Every readout, in the order an options list shows them. */
export const HUD_ITEMS: readonly HudItem[] = [
  ...DEFAULT_HUD,
  'spread',
  'range',
  'names',
  'gaps',
  'title',
];

const NONE: readonly HudItem[] = [];

/** The readouts a style draws (`hud: true` = DEFAULT_HUD). */
export function hudItems(style: Pick<ScoreStyle, 'hud'>): readonly HudItem[] {
  const h = style.hud;
  return h === true ? DEFAULT_HUD : h === false ? NONE : h;
}

/** Rows a list of readouts takes: the left column's length. */
export function hudRows(items: readonly HudItem[]): number {
  return Math.ceil(items.length / 2);
}

/** `mm:ss.s` */
export function formatTime(t: Seconds): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
}

/** Display name of a key, e.g. "D dorian". */
export function keyName(key: Key): string {
  const scale = typeof key.scale === 'string' ? key.scale : (key.scale.name ?? 'custom');
  return `${key.tonic} ${scale.replace(/-/g, ' ')}`;
}

/** Pitches of the lines sounding at t (alive and audible), low to high. */
export function soundingPitches(compiled: CompiledScore, t: Seconds): Pitch[] {
  const out: Pitch[] = [];
  for (const i of activeAt(compiled, t)) {
    const v = compiled.voices[i];
    const p = pitchAt(v, t);
    if (p === null || opacityAt(v, t) < OPACITY_EPS) continue;
    out.push(p);
  }
  return out.sort((a, b) => a - b);
}

/** Pitches closer than this (semitones) are one line (as the head labels group them). */
const SAME = 0.05;

/** Distinct lines of `pitches` (sorted), merged within SAME. */
function distinct(pitches: readonly Pitch[]): Pitch[] {
  const out: Pitch[] = [];
  for (const p of pitches) if (out.length === 0 || p - out[out.length - 1] >= SAME) out.push(p);
  return out;
}

/** Nearest note name of `p`, spelled in `key`: "C♯4". */
export function nearestNote(p: Pitch, key?: Key): string {
  return noteLabel(Math.round(p), key);
}

/** The sounding notes by name, low to high, repeats counted: "C3 E3 G3×2 B3". */
export function noteNamesText(pitches: readonly Pitch[], key?: Key): string {
  const parts: string[] = [];
  let last = '';
  let n = 0;
  const flush = (): void => {
    if (n > 0) parts.push(n > 1 ? `${last}×${n}` : last);
  };
  for (const p of pitches) {
    const name = nearestNote(p, key);
    if (name === last) {
      n++;
      continue;
    }
    flush();
    last = name;
    n = 1;
  }
  flush();
  return parts.join(' ');
}

/** Semitones between neighbouring distinct lines, low to high: "4 3 4.5". */
export function gapsText(pitches: readonly Pitch[]): string {
  const d = distinct(pitches);
  const out: string[] = [];
  for (let i = 1; i < d.length; i++) out.push(semitoneText(d[i] - d[i - 1]));
  return out.join(' ');
}

/** The readouts' left labels, padded to 8 columns like "notes" and "t". */
const label = (s: string): string => s.padEnd(8, ' ');

/** The chord and the title are set larger, in the ink. */
function emphasised(item: HudItem): boolean {
  return item === 'chord' || item === 'title';
}

/** The text of one readout at the view's time; '' when it has nothing to show. */
export function hudText(
  item: HudItem,
  compiled: CompiledScore,
  view: View,
  style: Pick<ScoreStyle, 'pieceName'>,
): string {
  const t = view.t;
  switch (item) {
    case 'formula':
      return `f(n) = ${Math.round(compiled.referenceHz * 100) / 100}·2^((n−69)/12)`;
    case 'notes':
      return `notes   ${String(activeAt(compiled, t).length).padStart(2, ' ')} / ${compiled.voices.length}`;
    case 'time':
      return `t       ${formatTime(t)} / ${formatTime(view.duration)}`;
    case 'chord':
      return chordAt(compiled, t)?.label ?? '';
    case 'key': {
      const mode = view.window >= view.duration ? 'whole piece' : 'following';
      return `${keyName(keyAt(compiled, t)).toLowerCase()} · ${mode}`;
    }
    case 'hz': {
      let lo = Infinity;
      let hi = -Infinity;
      for (const i of activeAt(compiled, t)) {
        const p = pitchAt(compiled.voices[i], t);
        if (p === null) continue;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      if (!(hi >= lo)) return '';
      const f = (p: number): string => hzOf(p, compiled.referenceHz).toFixed(1);
      return `${f(lo)}–${f(hi)} Hz`;
    }
    case 'spread': {
      const ps = soundingPitches(compiled, t);
      return ps.length < 2 ? '' : label('spread') + spreadText(ps[ps.length - 1] - ps[0]);
    }
    case 'range': {
      const ps = soundingPitches(compiled, t);
      if (ps.length === 0) return '';
      const key = keyAt(compiled, t);
      return `${label('range')}${nearestNote(ps[0], key)} – ${nearestNote(ps[ps.length - 1], key)}`;
    }
    case 'names': {
      const ps = soundingPitches(compiled, t);
      return ps.length === 0 ? '' : label('names') + noteNamesText(ps, keyAt(compiled, t));
    }
    case 'gaps': {
      const g = gapsText(soundingPitches(compiled, t));
      return g ? label('gaps') + g : '';
    }
    case 'title':
      return style.pieceName?.trim() ?? '';
  }
}

/** Estimated advance of the 10.5 px mono type, px per character (as the formula check). */
const CHAR_PX = 6.4;
/** Readouts whose text can run long (lists): cut with an ellipsis to their column. */
const LISTS: ReadonlySet<HudItem> = new Set(['names', 'gaps', 'title']);

/** Width of the last emphasised label drawn, re-measured only when the label or font changes. */
let measured = { label: '', font: '', width: 0 };
function emWidth(g: CanvasRenderingContext2D, text: string, font: string): number {
  if (text !== measured.label || font !== measured.font) {
    measured = { label: text, font, width: g.measureText(text).width };
  }
  return measured.width;
}

/** `text` cut to `chars` characters with an ellipsis. */
function cut(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return chars <= 1 ? '…' : text.slice(0, chars - 1).trimEnd() + '…';
}

/**
 * Baseline of the first HUD row with `lines` rows in the view's bottom band, `extra` px of it
 * kept free below them.
 */
export function hudTop(view: View, lines: number, extra = 0): number {
  const { height: H, padB } = view;
  return Math.min(H - padB + 22, H - 4 - HUD_ROW * (lines - 1) - extra);
}

/** A placed readout: its text, its box (layout px) and the anchor its text aligns to. */
export interface HudBox extends HudRect {
  item: HudItem;
  text: string;
  anchor: HudAnchor;
}

/** What the Export dialog overlays on its preview: the frame, its margin and each box. */
export interface HudPlacement {
  width: number;
  height: number;
  /** The margin readouts snap to, in from each side. */
  margin: number;
  boxes: HudBox[];
}

/** The frame's margin for readouts: the score's side padding. */
export function hudMargin(view: Pick<View, 'padL'>): number {
  return view.padL;
}

/**
 * Today's slots as positions (the default layout): the first ⌈n/2⌉ readouts down the left
 * (bottom-left anchor at padL), the rest down the right (bottom-right at padR), on the rows
 * `drawHud` uses.
 */
export function defaultHudLayout(items: readonly HudItem[], view: View, extra = 0): HudLayout {
  const { width: W, height: H, padL, padR } = view;
  const rows = hudRows(items);
  const lines = Math.max(1, hudLines(view.padB - extra, rows));
  const hy = hudTop(view, lines, extra);
  const out: HudLayout = {};
  items.forEach((item, k) => {
    const right = k >= rows;
    const r = right ? k - rows : k;
    const bottom = hy + HUD_ROW * r - HUD_BASELINE + HUD_BOX_H;
    out[item] = { anchor: right ? 'br' : 'bl', x: (right ? -padR : padL) / W, y: (bottom - H) / H };
  });
  return out;
}

/**
 * Each readout's text and box with the style's layout (default slots where it has none), the
 * text measured in its font; boxes are clamped inside the frame.
 */
export function hudBoxes(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  MONO: string,
  items: readonly HudItem[],
): HudBox[] {
  const layout = style.hudLayout ?? {};
  const defs = defaultHudLayout(items, view, style.hudExtra ?? 0);
  const colChars = Math.max(4, Math.floor((view.width - view.padL - view.padR - 16) / 2 / CHAR_PX));
  const out: HudBox[] = [];
  for (const item of items) {
    let text = hudText(item, compiled, view, style);
    const em = emphasised(item);
    if (LISTS.has(item)) text = cut(text, em ? Math.floor((colChars * 10.5) / 12) : colChars);
    g.font = em ? `500 12px ${MONO}` : `10.5px ${MONO}`;
    const w = Math.max(HUD_MIN_W, text ? g.measureText(text).width : 0);
    const pos = layout[item] ?? defs[item] ?? { anchor: 'bl', x: 0, y: 0 };
    const { x, y } = placeBox(pos, w, HUD_BOX_H, view);
    out.push({ item, text, anchor: pos.anchor, x, y, w, h: HUD_BOX_H });
  }
  return out;
}

/** The readouts at their placed boxes, each text aligned to its box's anchor side. */
function drawPlacedHud(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  MONO: string,
  items: readonly HudItem[],
): void {
  const C = style.tokens;
  g.globalAlpha = 1;
  for (const b of hudBoxes(g, compiled, style, view, MONO, items)) {
    if (!b.text) continue;
    const em = emphasised(b.item);
    const fx = anchorFactors(b.anchor)[0];
    g.font = em ? `500 12px ${MONO}` : `10.5px ${MONO}`;
    g.fillStyle = style.paint?.hud ?? (em ? C.ink : C.ink2);
    g.textAlign = fx === 0 ? 'left' : fx === 1 ? 'right' : 'center';
    g.fillText(b.text, b.x + fx * b.w, b.y + HUD_BASELINE);
  }
  g.textAlign = 'left';
}

/**
 * Draws the readouts: at their placed boxes when the style has a layout, else in two columns
 * from the top of the bottom band; a short canvas keeps the
 * first rows that fit (bottom-anchored). On a row whose right readout is emphasised (the chord),
 * a left readout that would run into it is left out, as the formula yields to a long chord.
 */
export function drawHud(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  MONO: string,
  items: readonly HudItem[],
): void {
  if (style.hudLayout) {
    drawPlacedHud(g, compiled, style, view, MONO, items);
    return;
  }
  const C = style.tokens;
  const { width: W, padL, padR } = view;
  const rows = hudRows(items);
  const extra = style.hudExtra ?? 0;
  const lines = hudLines(view.padB - extra, rows);
  if (lines === 0) return;
  const hy = hudTop(view, lines, extra);
  g.globalAlpha = 1;
  const texts = items.map((it) => hudText(it, compiled, view, style));
  const font = `10.5px ${MONO}`;
  const emFont = `500 12px ${MONO}`;
  // Right column widths of emphasised readouts, measured once per label.
  const rightEm: number[] = [];
  for (let r = 0; r < lines; r++) {
    const k = rows + r;
    if (k < items.length && emphasised(items[k]) && texts[k]) {
      g.font = emFont;
      rightEm[r] = emWidth(g, texts[k], MONO);
    }
  }
  const colChars = Math.max(4, Math.floor((W - padL - padR - 16) / 2 / CHAR_PX));
  for (let side = 0; side < 2; side++) {
    const right = side === 1;
    g.textAlign = right ? 'right' : 'left';
    let curFont = '';
    let curFill = '';
    for (let r = 0; r < lines; r++) {
      const k = right ? rows + r : r;
      if (k >= items.length) break;
      const item = items[k];
      let text = texts[k];
      if (!text) continue;
      const em = emphasised(item);
      if (LISTS.has(item)) text = cut(text, em ? Math.floor((colChars * 10.5) / 12) : colChars);
      if (!right) {
        const rw = rightEm[r];
        if (rw !== undefined && !(padL + text.length * CHAR_PX + 16 + rw < W - padR)) continue;
      }
      const f = em ? emFont : font;
      const fill = style.paint?.hud ?? (em ? C.ink : C.ink2);
      if (f !== curFont) g.font = curFont = f;
      if (fill !== curFill) g.fillStyle = curFill = fill;
      g.fillText(text, right ? W - padR : padL, hy + HUD_ROW * r);
    }
  }
  g.textAlign = 'left';
}
