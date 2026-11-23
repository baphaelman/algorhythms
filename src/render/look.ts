/**
 * The export Look (PLAN.md §12 "Export look", revision 13): every visual decision `drawScore`
 * makes, as one plain record the Export dialog edits, shared by video and poster. `lookStyle`
 * maps it to a ScoreStyle. `PLAYER_LOOK` is the player's drawing (what video drew before
 * revision 13); `EXPORT_LOOK` the owner's export defaults.
 */

import type { LineColors, Piece } from '../core/types';
import { DEFAULT_FUTURE_OPACITY } from './camera';
import { stylePaint, type LookColours } from './colours';
import { DEFAULT_HUD } from './hud';
import type { HudLayout } from './hud-layout';
import { tokensOf } from './palettes';
import type {
  HudItem,
  MomentLabels,
  MomentTimes,
  PitchGuides,
  ScoreStyle,
  ThemeName,
} from './types';

export type LookFuture = 'hidden' | 'dimmed' | 'full';
export type LookLineWidth = 'thin' | 'normal' | 'bold';
/** Beat lines: none, bars and beats thinned with zoom (as the editor), or every beat. */
export type LookBeats = 'off' | 'auto' | 'every';

/** A stored `beats` value: the three names, or the old boolean (true → 'auto'). */
export function lookBeats(v: unknown): LookBeats | undefined {
  if (v === true) return 'auto';
  if (v === false) return 'off';
  return v === 'off' || v === 'auto' || v === 'every' ? v : undefined;
}

export interface Look {
  theme: ThemeName;
  /** No background fill (posters; video ignores it: H.264 has no alpha). */
  transparent: boolean;
  /** Octave guides: the A lines. */
  guides: boolean;
  /** The guides' Hz labels (with `guides`). */
  guideLabels: boolean;
  /**
   * Beat and bar lines (the piece's tempo and meter, or 60 bpm 4/4): 'auto' thins them with
   * zoom as the editor does, 'every' draws every beat however dense (bars stronger).
   */
  beats: LookBeats;
  /** Ticks of unlabelled moments. */
  markers: boolean;
  /** Section lines and labels (labelled moments). */
  sections: boolean;
  /**
   * What is drawn ahead of the playhead: nothing (no lines, pulse marks, markers, labels or bar
   * lines), the lines at `futureOpacity`, or everything at full opacity. Posters ignore it.
   */
  future: LookFuture;
  /** Opacity of a dimmed future, 0..1. */
  futureOpacity: number;
  /** Louder voices brighter: line opacity by audible level (§10 revision 9). */
  levelOpacity: boolean;
  /** Merged and weighted lines thicker (strands and ropes). */
  thickness: boolean;
  /** Pulse hit marks. */
  pulseMarks: boolean;
  /** Heads: a dot per sounding line, a ring while it moves, Hz labels. Posters draw none. */
  dots: boolean;
  rings: boolean;
  hzLabels: boolean;
  /** The playhead line. Posters ignore it. */
  playhead: boolean;
  /** Line colours: by pitch, ink, or custom (each voice's colour, falling back to `lineInk`). */
  colors: LineColors;
  /** A colour for 'ink' lines and the 'custom' fallback; absent = the theme's ink. */
  lineInk?: string;
  /** Line width: a factor (LINE_SCALE_MIN..MAX; the dialog's slider) or a named width. */
  lineWidth: LookLineWidth | number;
  /** The HUD readouts in order (left column first); [] = no HUD. */
  hud: readonly HudItem[];
  /** Where each readout sits (§12 "Exports you can shape"); absent = today's two columns. */
  hudLayout?: HudLayout;
  /**
   * The export colours (§12 "Exports you can shape" → Colours): background, lines, each
   * element's colour. Absent (or a field absent) = the theme's as before; `lines` replaces
   * `colors` and `lineInk`.
   */
  colours?: LookColours;
  /** Glow round the lines, 0..1 (§12 "Ready for YouTube"); absent = 0. */
  glow?: number;
  /** Vignette, 0..1; absent = 0. */
  vignette?: number;
  /** Guide lines at pitches, labelled or not; absent or no pitches = none. */
  pitchGuides?: PitchGuides;
}

/** Line width factor per option. */
export const LINE_SCALE: Readonly<Record<LookLineWidth, number>> = {
  thin: 0.6,
  normal: 1,
  bold: 1.75,
};

/** The line width factor's range. */
export const LINE_SCALE_MIN = 0.5;
export const LINE_SCALE_MAX = 2;

/** The factor of a line width (a name, or a number clamped to the range; NaN → 1). */
export function lineScaleOf(w: LookLineWidth | number): number {
  if (typeof w !== 'number') return LINE_SCALE[w] ?? 1;
  return Number.isFinite(w) ? Math.min(LINE_SCALE_MAX, Math.max(LINE_SCALE_MIN, w)) : 1;
}

/** The player's drawing, as video drew it before revision 13 (light theme). */
export const PLAYER_LOOK: Look = {
  theme: 'light',
  transparent: false,
  guides: true,
  guideLabels: true,
  beats: 'off',
  markers: true,
  sections: true,
  future: 'dimmed',
  futureOpacity: DEFAULT_FUTURE_OPACITY,
  levelOpacity: true,
  thickness: true,
  pulseMarks: true,
  dots: true,
  rings: true,
  hzLabels: true,
  playhead: true,
  colors: 'pitch',
  lineWidth: 'normal',
  hud: DEFAULT_HUD,
};

/**
 * The owner's export defaults (2026-11-22): no octave guides or beats, nothing ahead of the
 * playhead, section labels without the unlabelled-moment ticks; the rest as the player draws.
 */
export const EXPORT_LOOK: Look = {
  ...PLAYER_LOOK,
  guides: false,
  guideLabels: false,
  beats: 'off',
  markers: false,
  sections: true,
  future: 'hidden',
};

/** What a Look needs from the piece and the browser. */
export interface LookContext {
  /** OKLCH colours (see `supportsOklch`). @default true */
  oklch?: boolean;
  /** `VoiceDef.color` by pool index, for `colors: 'custom'`. */
  customColors?: readonly (string | undefined)[];
  /** Section labels and marker times as the player shows them (`videoMarkers`). */
  labels?: MomentLabels;
  markerTimes?: MomentTimes;
  /** The piece's tempo and meter, for `beats`. */
  bpm?: number;
  meter?: number;
  /** The piece's name, for the `title` readout. */
  pieceName?: string;
  fontMono?: string;
}

/** Future opacity a Look draws with. */
export function lookFutureOpacity(look: Pick<Look, 'future' | 'futureOpacity'>): number {
  if (look.future === 'hidden') return 0;
  if (look.future === 'full') return 1;
  const o = look.futureOpacity;
  return Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : DEFAULT_FUTURE_OPACITY;
}

/**
 * The ScoreStyle of a Look (default: the player's). Only switches that differ from drawScore's
 * defaults are set, so PLAYER_LOOK draws exactly what a style without them draws.
 */
export function lookStyle(look: Look = PLAYER_LOOK, ctx: LookContext = {}): ScoreStyle {
  const base = tokensOf(look.theme);
  const style: ScoreStyle = {
    tokens: look.transparent ? { ...base, paper: 'transparent' } : base,
    dark: look.theme === 'dark',
    colors: look.colors,
    oklch: ctx.oklch ?? true,
    futureOpacity: lookFutureOpacity(look),
    hud: hudOf(look.hud),
    heads: true,
    playhead: look.playhead,
    thickness: look.thickness,
  };
  if (look.hudLayout) style.hudLayout = look.hudLayout;
  if (look.future === 'hidden') style.aheadHidden = true;
  if (!look.guides) style.guides = false;
  if (!look.guideLabels) style.guideLabels = false;
  if (!look.markers) style.markers = false;
  if (!look.sections) style.sections = false;
  const beats = lookBeats(look.beats) ?? 'off';
  if (beats !== 'off')
    style.bars = { ...barsOf(ctx), ...(beats === 'every' ? { every: true } : {}) };
  if (!look.levelOpacity) style.levelOpacity = false;
  if (!look.pulseMarks) style.pulseMarks = false;
  if (!look.dots) style.dots = false;
  if (!look.rings) style.rings = false;
  if (!look.hzLabels) style.hzLabels = false;
  const scale = lineScaleOf(look.lineWidth);
  if (scale !== 1) style.lineScale = scale;
  if (look.lineInk) style.lineInk = look.lineInk;
  if (ctx.customColors) style.customColors = ctx.customColors;
  const c = look.colours;
  const paint = stylePaint(c, look.transparent);
  if (paint) style.paint = paint;
  const lines = c?.lines;
  if (lines) {
    style.colors = lines.kind === 'pitch' ? 'pitch' : 'custom';
    delete style.lineInk;
    if (lines.kind === 'one') style.lineInk = lines.color;
    if (lines.kind === 'part') {
      const own = ctx.customColors;
      style.customColors = lines.colors.map((col, i) => own?.[i] || col);
    }
  }
  const glow = unit(look.glow);
  if (glow > 0) style.glow = glow;
  const vignette = unit(look.vignette);
  if (vignette > 0) style.vignette = vignette;
  const pg = look.pitchGuides;
  if (pg && pg.pitches.length > 0) style.pitchGuides = pg;
  if (ctx.labels) style.labels = ctx.labels;
  if (ctx.markerTimes) style.markerTimes = ctx.markerTimes;
  if (ctx.pieceName !== undefined) style.pieceName = ctx.pieceName;
  if (ctx.fontMono) style.fontMono = ctx.fontMono;
  return style;
}

/** A 0..1 amount (NaN and absent → 0). */
function unit(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** A readout list as ScoreStyle.hud: today's list is `true`, none is `false`. */
function hudOf(items: readonly HudItem[]): ScoreStyle['hud'] {
  if (items.length === 0) return false;
  const same = items.length === DEFAULT_HUD.length && items.every((it, i) => it === DEFAULT_HUD[i]);
  return same ? true : items;
}

function barsOf(ctx: LookContext): { bpm?: number; meter?: number } {
  const b: { bpm?: number; meter?: number } = {};
  if (ctx.bpm !== undefined) b.bpm = ctx.bpm;
  if (ctx.meter !== undefined) b.meter = ctx.meter;
  return b;
}

/** The piece's part of a LookContext: tempo and meter (beats) and name (the `title` readout). */
export function pieceLook(piece: Pick<Piece, 'view' | 'meta'>): {
  bpm?: number;
  meter?: number;
  pieceName: string;
} {
  const o: { bpm?: number; meter?: number; pieceName: string } = { pieceName: piece.meta.title };
  if (piece.view.gridBpm !== undefined) o.bpm = piece.view.gridBpm;
  if (piece.view.meter !== undefined) o.meter = piece.view.meter;
  return o;
}
