/**
 * The poster's layout (PLAN.md §15 M14): `layoutPoster` turns a piece and its `PosterDoc` into
 * every object the poster draws, each with its box in artboard px, its group and its member id.
 * The PNG and SVG exports draw exactly this (`drawPosterLayout`, poster.ts); the workspace
 * hit-tests it (`hitTest`, poster-edit.ts) and the automated check reads it (`posterIssues`).
 *
 * - **Type scale.** One unit is the artboard's shorter side / 480 px (`posterUnit`): every type
 *   size, gap and line width is in units, so 16:9, square and A4 portrait look alike. A 3840×2160
 *   or 2160×2160 poster has 4.5 px units, today's poster ratio.
 * - **Margins** (fractions of the shorter side, default 6 %) bound the content: text and music
 *   stay inside them.
 * - **Default fit.** Text boxes without a box of their own stack at the top of the content (the
 *   text band); the music area is the rest, less a HUD band at the bottom when readouts show.
 *   Rows split the music area; each row is a label zone (section and moment labels, the row's
 *   time), gutters for guide labels, and the plot.
 * - **Layers.** Each part is a layer; a layer's box is where the music area's rows land (default:
 *   the music area). A line with a box of its own is a layer inside its part's box. Lines keep
 *   their thickness at any stretch: each row of a layer is a `drawScore` frame of its own size.
 * - **Per row** (owner, 2026-11-25): a row moved as a block carries everything in it (its plot,
 *   lines, labels and layers); a layer in one row can be moved on its own, inside its frame there.
 * - **Labels** are placed in priority order (row times, sections, HUD, guides, pitch guides,
 *   moments), each avoiding the text placed before it: one that collides shifts, and one that
 *   still can't fit inside the margins is hidden (listed in `hidden`).
 *
 * Pure: text is measured by the `measure` function given (a canvas context through
 * `measureWith`, or an estimate).
 */

import { partOf } from '../core/parts';
import { chordAt, keyAt } from '../core/query';
import { evalSegment } from '../core/segment';
import { hzOf } from '../core/tuning';
import type {
  CompiledScore,
  Key,
  MomentId,
  Piece,
  PosterBox,
  PosterDoc,
  PosterGroup,
  PosterGroupStyle,
  PosterLabelGroup,
  PosterLabelSide,
  PosterLineGroup,
  PosterMarkGroup,
  PosterMargins,
  PosterMemberStyle,
  PosterText,
  PosterTextStyle,
  Seconds,
} from '../core/types';
import { withPicture } from './background';
import { barGrid } from './bars';
import { pitchExtent } from './camera';
import { DEFAULT_MONO, PITCH_GUIDE_ALPHA, pitchGuideLabel } from './draw';
import { hudItems, hudText, keyName } from './hud';
import { EXPORT_LOOK, LINE_SCALE_MAX, LINE_SCALE_MIN, lookBeats, type Look } from './look';
import {
  POSTER_CREDIT,
  POSTER_MAX_ROWS,
  posterCamera,
  posterLength,
  posterMeta,
  posterRows,
  posterSpan,
  posterStyle,
} from './poster';
import { sectionRows, type SectionRowItem } from './poster-rows';
import { MIN_SECTION, sectionText, type TimeSpan } from './section';
import type { HudItem, ScoreStyle, View } from './types';
import { DEFAULT_SERIF, videoMarkers } from './video';

/** A rectangle in artboard px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The artboard's shorter side is this many type units. */
export const POSTER_UNIT_SIDE = 480;
/** The default artboard: 16:9 4K. */
export const DEFAULT_POSTER_SIZE = { w: 3840, h: 2160 } as const;
/** Default margin on every side, as a fraction of the shorter side. */
export const DEFAULT_MARGIN = 0.06;
/** Gap between rows, units. */
export const POSTER_ROW_GAP = 10;
/** Gap between the text band and the music, as a fraction of the shorter side. */
export const TEXT_BAND_GAP = 0.04;
/** Line height of text, × its size. */
export const LINE_HEIGHT = 1.2;
/** A text's ascent and descent above and below its baseline, × its size. */
const ASCENT = 0.8;
const DESCENT = 0.24;
/** The space a line box leaves above and below its ink, px, for text of `size` px. */
export const textPad = (size: number): number => ((LINE_HEIGHT - ASCENT - DESCENT) / 2) * size;
/** Space kept clear round placed text, units. */
const TEXT_PAD = 1.5;

/** Artboard px per type unit. */
export function posterUnit(width: number, height: number): number {
  return Math.min(width, height) / POSTER_UNIT_SIDE;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Text width in px of `text` set in the CSS `font`, with `spacing` px between letters. */
export type Measure = (text: string, font: string, spacing: number) => number;

/** An estimate for any font: 0.6 em a character (a monospace advance; wide for most serifs). */
export const estimateText: Measure = (text, font, spacing) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  const size = m ? Number(m[1]) : 10;
  return [...text].length * (size * 0.6 + spacing);
};

/** A Measure from a 2D context (canvas, OffscreenCanvas or SvgContext through asCtx2D). */
export function measureWith(g: {
  font: string;
  measureText(text: string): { width: number };
}): Measure {
  const cache = new Map<string, number>();
  return (text, font, spacing) => {
    const key = `${font}|${spacing}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      g.font = font;
      w = g.measureText(text).width + [...text].length * spacing;
      cache.set(key, w);
    }
    return w;
  };
}

/** What the layout needs from the piece. */
export type PosterPiece = Pick<Piece, 'meta' | 'key' | 'voices' | 'moments' | 'view'> &
  Partial<Pick<Piece, 'poster'>>;

/** Poster options remembered per viewer, under the piece's own (`PosterDoc` wins). */
export interface PosterBase {
  size?: { w: number; h: number };
  rows?: number;
  section?: TimeSpan;
  pieceRange?: boolean;
}

export interface PosterInput {
  compiled: CompiledScore;
  piece: PosterPiece;
  /** The poster document; default `piece.poster`. */
  doc?: PosterDoc;
  /** The viewer's remembered Look, under `doc.look`. Default: the export defaults, no HUD. */
  look?: Look;
  base?: PosterBase;
  /** OKLCH colours (see `supportsOklch`). @default true */
  oklch?: boolean;
  measure?: Measure;
  fontMono?: string;
  fontSerif?: string;
  fontSans?: string;
}

// ---------------------------------------------------------------------------------------------
// Resolved settings
// ---------------------------------------------------------------------------------------------

/** Margins in px. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The poster's settings with every default filled. */
export interface PosterSettings {
  width: number;
  height: number;
  rows: number;
  /** The section drawn; absent = the whole piece. */
  section?: TimeSpan;
  pieceRange: boolean;
  /** Fractions of the shorter side. */
  margins: PosterMargins;
}

export const DEFAULT_MARGINS: PosterMargins = {
  top: DEFAULT_MARGIN,
  right: DEFAULT_MARGIN,
  bottom: DEFAULT_MARGIN,
  left: DEFAULT_MARGIN,
};

const finiteIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** The settings of a doc over the viewer's base. */
export function posterSettings(doc?: PosterDoc, base: PosterBase = {}): PosterSettings {
  const size = doc?.size ?? base.size ?? DEFAULT_POSTER_SIZE;
  const rows = doc?.rows ?? base.rows ?? 1;
  const section = doc?.section ?? base.section;
  const m = doc?.margins;
  const margin = (k: keyof Margins): number =>
    m && finiteIn(m[k], 0, 0.45) ? m[k] : DEFAULT_MARGIN;
  const out: PosterSettings = {
    width: Math.max(1, Math.round(size.w)),
    height: Math.max(1, Math.round(size.h)),
    rows: Number.isFinite(rows) ? Math.min(POSTER_MAX_ROWS, Math.max(1, Math.round(rows))) : 1,
    pieceRange: doc?.pieceRange ?? base.pieceRange ?? false,
    margins: {
      top: margin('top'),
      right: margin('right'),
      bottom: margin('bottom'),
      left: margin('left'),
      ...(m?.linked === false ? { linked: false } : {}),
    },
  };
  if (section) out.section = { start: section.start, end: section.end };
  return out;
}

type LookKey = keyof Look;
const BOOL_KEYS: readonly LookKey[] = [
  'transparent',
  'guides',
  'guideLabels',
  'markers',
  'sections',
  'sectionLines',
  'momentLabels',
  'levelOpacity',
  'thickness',
  'pulseMarks',
];
const UNIT_KEYS: readonly LookKey[] = ['glow', 'vignette', 'minLineOpacity'];
const OBJECT_KEYS: readonly LookKey[] = ['colours', 'hudLayout', 'pitchGuides'];

/**
 * The Look a doc draws with: `base` with the doc's overrides that are valid Look values (others
 * are ignored, so a damaged or newer doc still draws).
 */
export function posterLook(base: Look, doc?: PosterDoc): Look {
  const o = doc?.look;
  if (!o) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(o)) {
    const key = k as LookKey;
    if (BOOL_KEYS.includes(key)) {
      if (typeof v === 'boolean') out[k] = v;
    } else if (UNIT_KEYS.includes(key)) {
      if (finiteIn(v, 0, 1)) out[k] = v;
    } else if (OBJECT_KEYS.includes(key)) {
      if (v !== null && typeof v === 'object') out[k] = v;
    } else if (key === 'theme') {
      if (v === 'light' || v === 'dark') out[k] = v;
    } else if (key === 'colors') {
      if (v === 'pitch' || v === 'ink' || v === 'custom') out[k] = v;
    } else if (key === 'lineInk') {
      if (typeof v === 'string') out[k] = v;
    } else if (key === 'lineWidth') {
      if (
        v === 'thin' ||
        v === 'normal' ||
        v === 'bold' ||
        finiteIn(v, LINE_SCALE_MIN, LINE_SCALE_MAX)
      )
        out[k] = v;
    } else if (key === 'beats') {
      const b = lookBeats(v);
      if (b) out[k] = b;
    } else if (key === 'hud') {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
    }
  }
  return out as unknown as Look;
}

/** The poster's default Look: the export defaults with no HUD (it would show end-of-piece values). */
export const POSTER_LOOK: Look = { ...EXPORT_LOOK, hud: [] };

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

export const LABEL_GROUPS: readonly PosterLabelGroup[] = [
  'sectionLabels',
  'momentLabels',
  'rowLabels',
  'rowNames',
  'guideLabels',
  'pitchLabels',
  'hud',
];
export const LINE_GROUPS: readonly PosterLineGroup[] = [
  'sectionLines',
  'momentLines',
  'guideLines',
  'pitchLines',
  'beatLines',
];
/** Mark groups: marks on the lines (pulse hits), drawn by each layer. */
export const MARK_GROUPS: readonly PosterMarkGroup[] = ['pulseMarks'];
export const POSTER_GROUPS: readonly PosterGroup[] = [
  ...LABEL_GROUPS,
  ...LINE_GROUPS,
  ...MARK_GROUPS,
];

export function isLabelGroup(g: string): g is PosterLabelGroup {
  return (LABEL_GROUPS as readonly string[]).includes(g);
}

export function isMarkGroup(g: string): g is PosterMarkGroup {
  return (MARK_GROUPS as readonly string[]).includes(g);
}

/** A group style's fields. */
export type GroupField = keyof PosterGroupStyle;

const LABEL_FIELDS: readonly GroupField[] = ['visible', 'size', 'weight', 'colour', 'opacity'];
const PLACED_FIELDS: readonly GroupField[] = [...LABEL_FIELDS, 'side', 'along', 'offset'];
const LINE_FIELDS: readonly GroupField[] = [
  'visible',
  'colour',
  'width',
  'opacity',
  'dashed',
  'extent',
];

/**
 * The style fields each group takes, for panels that show a group's controls (a field missing
 * here has no effect on that group).
 */
export const GROUP_FIELDS: Readonly<Record<PosterGroup, readonly GroupField[]>> = {
  sectionLabels: PLACED_FIELDS,
  momentLabels: PLACED_FIELDS,
  rowLabels: LABEL_FIELDS,
  rowNames: LABEL_FIELDS,
  guideLabels: PLACED_FIELDS,
  pitchLabels: PLACED_FIELDS,
  hud: LABEL_FIELDS,
  sectionLines: LINE_FIELDS,
  momentLines: LINE_FIELDS,
  guideLines: LINE_FIELDS,
  pitchLines: LINE_FIELDS,
  beatLines: LINE_FIELDS,
  pulseMarks: ['visible', 'size', 'width', 'opacity', 'colour'],
};

/** A label group's style with every field resolved (sizes, gaps and nudges in px). */
export interface LabelStyle {
  visible: boolean;
  /** Type size, px. */
  size: number;
  weight: number;
  colour: string;
  opacity: number;
  side: PosterLabelSide;
  along: 'start' | 'end';
  /** Gap to the line, px. */
  offset: number;
  /** Letter spacing, px. */
  spacing: number;
  uppercase: boolean;
}

/**
 * A mark group's style, resolved: `size` and `width` are factors of the marks' default length
 * and stroke (drawScore scales them with the type unit), `opacity` multiplies theirs, `colour`
 * absent = each line's colour.
 */
export interface MarkStyle {
  visible: boolean;
  size: number;
  width: number;
  opacity: number;
  colour?: string;
}

/** A line group's style, resolved (width in px). */
export interface LineStyle {
  visible: boolean;
  colour: string;
  width: number;
  opacity: number;
  dashed: boolean;
  extent: 'full' | 'tick';
}

/** Default label type sizes and gaps, units. */
const LABEL_DEFAULTS: Readonly<
  Record<
    PosterLabelGroup,
    {
      size: number;
      weight: number;
      side: PosterLabelSide;
      along: 'start' | 'end';
      offset: number;
      opacity: number;
    }
  >
> = {
  sectionLabels: { size: 9.5, weight: 500, side: 'right', along: 'start', offset: 4, opacity: 1 },
  momentLabels: { size: 8, weight: 400, side: 'right', along: 'start', offset: 3, opacity: 0.85 },
  rowLabels: { size: 10.5, weight: 400, side: 'right', along: 'start', offset: 0, opacity: 1 },
  rowNames: { size: 14, weight: 500, side: 'left', along: 'start', offset: 8, opacity: 1 },
  guideLabels: { size: 9, weight: 400, side: 'out', along: 'start', offset: 6, opacity: 0.75 },
  pitchLabels: {
    size: 9,
    weight: 400,
    side: 'out',
    along: 'end',
    offset: 6,
    opacity: PITCH_GUIDE_ALPHA,
  },
  hud: { size: 10.5, weight: 400, side: 'right', along: 'start', offset: 0, opacity: 1 },
};

/** Lengths of a short tick, units: above and below the plot's top edge. */
const TICK_ABOVE = 8;
const TICK_BELOW = 4;
/** A short tick of a horizontal guide, units. */
const TICK_LEN = 10;
/** Dash of dashed lines, units. */
const DASH: readonly number[] = [6, 4];

function sideFor(
  group: PosterLabelGroup,
  side: unknown,
  fallback: PosterLabelSide,
): PosterLabelSide {
  const vertical = group === 'sectionLabels' || group === 'momentLabels';
  if (vertical) return side === 'left' || side === 'right' ? side : fallback;
  if (group === 'guideLabels' || group === 'pitchLabels')
    return side === 'out' || side === 'above' || side === 'below' ? side : fallback;
  return fallback;
}

/** `over` on `base`, ignoring invalid values. */
function mergeStyle(base: PosterGroupStyle, over: PosterGroupStyle | undefined): PosterGroupStyle {
  if (!over) return base;
  const out: PosterGroupStyle = { ...base };
  for (const [k, v] of Object.entries(over))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

const pos = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
const unit = (v: unknown, d: number): number => (finiteIn(v, 0, 1) ? v : d);

function labelStyleOf(
  group: PosterLabelGroup,
  s: PosterGroupStyle,
  visible: boolean,
  colour: string,
  u: number,
): LabelStyle {
  const d = LABEL_DEFAULTS[group];
  return {
    visible: s.visible ?? visible,
    size: d.size * pos(s.size, 1) * u,
    weight: typeof s.weight === 'number' ? s.weight : d.weight,
    colour: typeof s.colour === 'string' && s.colour ? s.colour : colour,
    opacity: unit(s.opacity, d.opacity),
    side: sideFor(group, s.side, d.side),
    along: s.along === 'end' ? 'end' : s.along === 'start' ? 'start' : d.along,
    offset: d.offset * (typeof s.offset === 'number' && s.offset >= 0 ? s.offset : 1) * u,
    spacing: group === 'sectionLabels' ? u : 0,
    uppercase: group === 'sectionLabels',
  };
}

function lineStyleOf(
  s: PosterGroupStyle,
  d: {
    visible: boolean;
    colour: string;
    opacity: number;
    dashed: boolean;
    extent: 'full' | 'tick';
  },
  u: number,
): LineStyle {
  return {
    visible: s.visible ?? d.visible,
    colour: typeof s.colour === 'string' && s.colour ? s.colour : d.colour,
    width: pos(s.width, 1) * u,
    opacity: unit(s.opacity, d.opacity),
    dashed: s.dashed ?? d.dashed,
    extent: s.extent === 'full' || s.extent === 'tick' ? s.extent : d.extent,
  };
}

/** Every group's style, resolved: the Look's defaults, the doc's group styles over them. */
export function groupStyles(
  look: Look,
  style: ScoreStyle,
  doc: PosterDoc | undefined,
  u: number,
): {
  labels: Record<PosterLabelGroup, LabelStyle>;
  lines: Record<PosterLineGroup, LineStyle>;
  marks: Record<PosterMarkGroup, MarkStyle>;
} {
  const C = style.tokens;
  const P = style.paint;
  const g = (k: PosterGroup): PosterGroupStyle => doc?.groups?.[k] ?? {};
  const guides = look.guides;
  const pg = look.pitchGuides;
  const hasPg = !!pg && pg.pitches.length > 0;
  const labels = {
    sectionLabels: labelStyleOf(
      'sectionLabels',
      g('sectionLabels'),
      look.sections,
      P?.labels ?? C.ink2,
      u,
    ),
    momentLabels: labelStyleOf(
      'momentLabels',
      g('momentLabels'),
      look.momentLabels === true,
      P?.labels ?? C.ink2,
      u,
    ),
    rowLabels: labelStyleOf('rowLabels', g('rowLabels'), true, P?.labels ?? C.ink2, u),
    rowNames: labelStyleOf(
      'rowNames',
      g('rowNames'),
      doc?.rowsBy === 'sections',
      P?.labels ?? C.ink2,
      u,
    ),
    guideLabels: labelStyleOf(
      'guideLabels',
      g('guideLabels'),
      guides && look.guideLabels,
      P?.guides ?? C.ink2,
      u,
    ),
    pitchLabels: labelStyleOf(
      'pitchLabels',
      g('pitchLabels'),
      hasPg && pg.labels,
      P?.guides ?? C.ink2,
      u,
    ),
    hud: labelStyleOf('hud', g('hud'), look.hud.length > 0, P?.hud ?? C.ink2, u),
  };
  const markers = P?.markers ?? C.rule;
  const lines = {
    sectionLines: lineStyleOf(
      g('sectionLines'),
      {
        visible: look.sectionLines ?? look.sections,
        colour: markers,
        opacity: 1,
        dashed: false,
        extent: 'full',
      },
      u,
    ),
    momentLines: lineStyleOf(
      g('momentLines'),
      { visible: look.markers, colour: markers, opacity: 1, dashed: false, extent: 'tick' },
      u,
    ),
    guideLines: lineStyleOf(
      g('guideLines'),
      { visible: guides, colour: P?.guides ?? C.rule, opacity: 1, dashed: false, extent: 'full' },
      u,
    ),
    pitchLines: lineStyleOf(
      g('pitchLines'),
      {
        visible: hasPg,
        colour: P?.guides ?? C.rule,
        opacity: PITCH_GUIDE_ALPHA,
        dashed: true,
        extent: 'full',
      },
      u,
    ),
    beatLines: lineStyleOf(
      g('beatLines'),
      {
        visible: (lookBeats(look.beats) ?? 'off') !== 'off',
        colour: P?.beats ?? C.rule,
        opacity: 0.6,
        dashed: false,
        extent: 'full',
      },
      u,
    ),
  };
  const pm = g('pulseMarks');
  const marks = {
    pulseMarks: {
      visible: pm.visible ?? look.pulseMarks,
      size: pos(pm.size, 1),
      width: pos(pm.width, 1),
      opacity: unit(pm.opacity, 1),
      ...(typeof pm.colour === 'string' && pm.colour ? { colour: pm.colour } : {}),
    },
  };
  return { labels, lines, marks };
}

// ---------------------------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------------------------

/** One run of text: drawn with `fillText(text, x, y)` (y the baseline) in `font`, aligned. */
export interface TextRun {
  text: string;
  x: number;
  y: number;
}

interface ObjectBase {
  /** Ink box in artboard px. */
  box: Rect;
  /** `layers`, `texts`, or a label or line group. */
  group: PosterGroup | 'layers' | 'texts';
  /** The member: layer id, text id, moment id, guide pitch, row index, HUD readout, beat time. */
  member: string;
  /** The row it belongs to, if any. */
  row?: number;
  /** Text boxes and HUD readouts (M15): the video draws it with the frame, not on the poster. */
  travels?: boolean;
}

/** A label (a member of a label group). */
export interface LabelObject extends ObjectBase {
  type: 'label';
  group: PosterLabelGroup;
  runs: TextRun[];
  font: string;
  size: number;
  spacing: number;
  align: 'left' | 'center' | 'right';
  colour: string;
  opacity: number;
}

/** A text box. `frame` is its box (handles); `box` the ink. */
export interface TextObject extends ObjectBase {
  type: 'text';
  group: 'texts';
  kind: PosterText['kind'];
  /** The box as placed (auto boxes: the ink box). */
  frame: Rect;
  /** Placed in the text band (no box of its own). */
  auto: boolean;
  runs: TextRun[];
  font: string;
  size: number;
  spacing: number;
  align: 'left' | 'center' | 'right';
  colour: string;
  opacity: number;
}

/** A guide, beat or marker line (a member of a line group). */
export interface LineObject extends ObjectBase {
  type: 'line';
  group: PosterLineGroup;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colour: string;
  width: number;
  opacity: number;
  /** Dash pattern in px, or null for solid. */
  dash: readonly number[] | null;
}

/** One row of a music layer, where its lines are: `box` is the tight box of its lines. */
export interface LayerObject extends ObjectBase {
  type: 'layer';
  group: 'layers';
  /** Index into `PosterLayout.layers`. */
  layer: number;
  row: number;
}

export type PosterObject = LabelObject | TextObject | LineObject | LayerObject;

/** A row: the time it shows, its whole rect (label zone and gutters included) and its plot. */
export interface RowLayout {
  index: number;
  start: Seconds;
  end: Seconds;
  /** Rows by sections: the item that starts it (a labelled moment's id or `start`) and its label. */
  section?: string;
  name?: string;
  /** What its own placements are stored under (`PosterDoc.rowBoxes`, `PosterLayer.rows`). */
  key: string;
  rect: Rect;
  plot: Rect;
  /** Moved as a block: where `rect` would be. */
  home?: Rect;
}

/** One frame `drawScore` draws a layer's row in (artboard px): the row's plot, transformed. */
export interface LayerFrame {
  row: number;
  rect: Rect;
  /** Moved in this row on its own (`PosterLayer.rows`): where `rect` would be. */
  base?: Rect;
}

/** A music layer: a part, or a line with a box of its own. */
export interface LayerLayout {
  /** `part:<name>` or `line:<voice id>`. */
  id: string;
  kind: 'part' | 'line';
  /** The part's name ('' = voices with no part). */
  part: string;
  /** Pool indices drawn in this layer (a part's lines with their own layer are not). */
  voices: number[];
  hidden: boolean;
  /** Its colour, if set (the line's own beats its part's). */
  colour?: string;
  /** Where the music area lands (artboard px): the layer's box. */
  box: Rect;
  frames: LayerFrame[];
  /** Tight box of its lines in each row (null where it has none). */
  rowBounds: (Rect | null)[];
  /** Union of `rowBounds`; null when the layer draws nothing. */
  bounds: Rect | null;
}

export interface PosterLayout {
  width: number;
  height: number;
  /** Px per type unit. */
  unit: number;
  settings: PosterSettings;
  margins: Margins;
  /** Inside the margins. */
  content: Rect;
  /** The text band (auto text boxes), or null when no auto text shows. */
  band: Rect | null;
  /** The default music area (every row). */
  music: Rect;
  /** The HUD band, or null. */
  hudBand: Rect | null;
  /** The section drawn, or null for the whole piece. */
  span: TimeSpan | null;
  rows: RowLayout[];
  pitchRange: [number, number];
  layers: LayerLayout[];
  /** Every drawn object, back to front (lines, layers, labels, texts). */
  objects: PosterObject[];
  /** Labels left out because they could not fit. */
  hidden: LabelObject[];
  look: Look;
  /** The music's ScoreStyle (finished piece): each layer draws with `layerStyle`. */
  style: ScoreStyle;
  labels: Record<PosterLabelGroup, LabelStyle>;
  lines: Record<PosterLineGroup, LineStyle>;
  marks: Record<PosterMarkGroup, MarkStyle>;
  /** Rows by sections: the Organize list (null for equal rows). */
  sectionRows: SectionRowItem[] | null;
  fonts: { mono: string; serif: string; sans: string };
  /** How the layout measured text (the editor sizes new text boxes with it). */
  measure: Measure;
  /** Line colours by pool index from the layers (`posterVoiceColors`), if any. */
  voiceColors?: (string | undefined)[];
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

export function intersects(a: Rect, b: Rect, pad = 0): boolean {
  return (
    a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
  );
}

/** a inside b (within eps px). */
export function inside(a: Rect, b: Rect, eps = 0.5): boolean {
  return (
    a.x >= b.x - eps &&
    a.y >= b.y - eps &&
    a.x + a.w <= b.x + b.w + eps &&
    a.y + a.h <= b.y + b.h + eps
  );
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** `r` mapped from frame `from` onto frame `to`, each axis separately. */
export function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const kx = from.w > 0 ? to.w / from.w : 1;
  const ky = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (r.x - from.x) * kx, y: to.y + (r.y - from.y) * ky, w: r.w * kx, h: r.h * ky };
}

/** A box of fractions of `frame` in px. */
export function fromFractions(b: PosterBox, frame: Rect): Rect {
  return {
    x: frame.x + b.x * frame.w,
    y: frame.y + b.y * frame.h,
    w: b.w * frame.w,
    h: b.h * frame.h,
  };
}

/** A px rect as fractions of `frame`. */
export function toFractions(r: Rect, frame: Rect): PosterBox {
  return {
    x: (r.x - frame.x) / frame.w,
    y: (r.y - frame.y) / frame.h,
    w: r.w / frame.w,
    h: r.h / frame.h,
  };
}

const validBox = (b: PosterBox | undefined): b is PosterBox =>
  !!b &&
  [b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
  b.w > 0 &&
  b.h > 0;

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** The default text boxes: today's title block (the name; length, section and key; the credit). */
export const DEFAULT_POSTER_TEXTS: readonly PosterText[] = [
  { id: 'title', kind: 'title', text: '{name}' },
  { id: 'credit', kind: 'credit', text: `{meta} · ${POSTER_CREDIT}` },
];

/** Default style by kind; `size` as a fraction of the shorter side. */
const TEXT_DEFAULTS: Readonly<
  Record<PosterText['kind'], Required<Pick<PosterTextStyle, 'font' | 'size' | 'weight'>>>
> = {
  title: { font: 'serif', size: 0.075, weight: 400 },
  subtitle: { font: 'serif', size: 0.036, weight: 400 },
  credit: { font: 'mono', size: 0.024, weight: 400 },
  free: { font: 'sans', size: 0.03, weight: 400 },
};

/** The values of a poster's text tokens. */
export interface TextTokens {
  name: string;
  key: string;
  length: string;
  section: string;
  meta: string;
  tempo: string;
}

/** The tokens' values for this piece and section. */
export function textTokens(
  compiled: CompiledScore,
  piece: PosterPiece,
  span: TimeSpan | null,
): TextTokens {
  const key: Key = span ? keyAt(compiled, span.start) : keyAt(compiled, 0);
  const k = keyName(key);
  const D = compiled.duration;
  const bpm = piece.view.gridBpm;
  return {
    name: piece.meta.title.trim() || 'Untitled',
    key: k,
    length: posterLength(span ? span.end - span.start : D),
    section: span ? sectionText(span, D) : '',
    meta: posterMeta(D, k, span ?? undefined),
    tempo: bpm !== undefined ? `${Math.round(bpm * 10) / 10} bpm` : '',
  };
}

/** `text` with its `{token}`s replaced (unknown tokens stay as written). */
export function fillTokens(text: string, tokens: TextTokens): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.hasOwn(tokens, k) ? tokens[k as keyof TextTokens] : m,
  );
}

/** `line` broken at spaces so each piece is at most `width` wide (a longer word stays whole). */
export function wrapLine(line: string, width: number, w: (text: string) => number): string[] {
  const words = line.split(' ');
  const out: string[] = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = `${cur} ${words[i]}`;
    if (w(next) <= width) cur = next;
    else {
      out.push(cur);
      cur = words[i];
    }
  }
  out.push(cur);
  return out;
}

/** The type size (fraction of the shorter side), font and weight a new box of `kind` gets. */
export function textDefaults(kind: PosterText['kind']): {
  size: number;
  font: 'serif' | 'sans' | 'mono';
  weight: number;
} {
  return TEXT_DEFAULTS[kind] ?? TEXT_DEFAULTS.free;
}

/** The CSS font of a text of `size` px with `style` (and `kind`'s defaults) in `layout`'s fonts. */
export function textFont(
  layout: Pick<PosterLayout, 'fonts'>,
  kind: PosterText['kind'],
  size: number,
  style: PosterTextStyle = {},
): string {
  const def = textDefaults(kind);
  return cssFont(
    style.weight ?? def.weight,
    size,
    layout.fonts[style.font ?? def.font] ?? layout.fonts.sans,
    style.italic === true,
  );
}

function cssFont(weight: number, size: number, family: string, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight === 400 ? '' : `${weight} `}${round3(size)}px ${family}`;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Lines' extents
// ---------------------------------------------------------------------------------------------

const EXTENT_SAMPLES = 6;

/**
 * Where voice `v` sounds within [a, b]: its first and last time and its pitch range, or null.
 */
function voiceExtent(
  compiled: CompiledScore,
  v: number,
  a: Seconds,
  b: Seconds,
): { t0: number; t1: number; lo: number; hi: number } | null {
  let t0 = Infinity;
  let t1 = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of compiled.voices[v].segments) {
    if (s.t1 < a || s.t0 > b) continue;
    const x0 = Math.max(s.t0, a);
    const x1 = Math.min(s.t1, b);
    if (x0 < t0) t0 = x0;
    if (x1 > t1) t1 = x1;
    const n = s.p0 === s.p1 && !s.m0 && !s.curve ? 1 : EXTENT_SAMPLES;
    for (let i = 0; i <= n; i++) {
      const p = evalSegment(s, x0 + ((x1 - x0) * i) / n);
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
  }
  return t1 >= t0 ? { t0, t1, lo, hi } : null;
}

// ---------------------------------------------------------------------------------------------
// layoutPoster
// ---------------------------------------------------------------------------------------------

/** The section labels' and moments' times and texts (as the player shows them). */
interface Marker {
  id: MomentId;
  t: Seconds;
  label?: string;
  text: string;
}

function markersOf(compiled: CompiledScore, piece: PosterPiece): Marker[] {
  const { labels, markerTimes } = videoMarkers(piece);
  const types = new Map(piece.moments.map((m) => [m.id, m.type]));
  const out: Marker[] = [];
  for (const s of compiled.momentSpans) {
    const t = markerTimes[s.id] ?? s.start;
    const label = labels[s.id];
    const type = types.get(s.id) ?? '';
    const chord =
      type === 'chord' || type === 'progression' ? chordAt(compiled, s.end)?.label : undefined;
    out.push({ id: s.id, t, ...(label ? { label } : {}), text: label ?? chord ?? type });
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Octave guides: the A of each octave. */
const A_PITCHES = [21, 33, 45, 57, 69, 81, 93, 105];

function memberOf(
  doc: PosterDoc | undefined,
  group: PosterGroup,
  member: string,
): PosterMemberStyle | undefined {
  return doc?.members?.[group]?.[member];
}

/**
 * Lays out the poster (see the file comment). Cheap enough to run on every edit: about one
 * `evalSegment` pass over the score per row.
 */
export function layoutPoster(input: PosterInput): PosterLayout {
  const { compiled, piece } = input;
  const doc = input.doc ?? piece.poster;
  const measure = input.measure ?? estimateText;
  const settings = posterSettings(doc, input.base);
  const W = settings.width;
  const H = settings.height;
  const u = posterUnit(W, H);
  const S = Math.min(W, H);
  const fonts = {
    mono: input.fontMono ?? DEFAULT_MONO,
    serif: input.fontSerif ?? DEFAULT_SERIF,
    sans: input.fontSans ?? 'system-ui, -apple-system, "Segoe UI", sans-serif',
  };
  const look = posterLook(input.look ?? POSTER_LOOK, doc);
  const style = posterStyle({
    look,
    theme: look.theme,
    oklch: input.oklch ?? true,
    customColors: piece.voices.map((v) => v.color),
    ...videoMarkers(piece),
    fontMono: fonts.mono,
    ...(piece.view.gridBpm !== undefined ? { bpm: piece.view.gridBpm } : {}),
    ...(piece.view.meter !== undefined ? { meter: piece.view.meter } : {}),
    pieceName: piece.meta.title,
  });
  const { labels: LS, lines: LN, marks: MK } = groupStyles(look, style, doc, u);
  const bg = withPicture(style.paint?.background, doc?.picture);
  if (bg && bg !== style.paint?.background) style.paint = { ...style.paint, background: bg };
  const pm = MK.pulseMarks;
  if (pm.visible) delete style.pulseMarks;
  else style.pulseMarks = false;
  if (pm.size !== 1 || pm.width !== 1 || pm.opacity !== 1 || pm.colour) {
    style.pulseStyle = {
      size: pm.size,
      width: pm.width,
      opacity: pm.opacity,
      ...(pm.colour ? { colour: pm.colour } : {}),
    };
  }

  const mg = settings.margins;
  const margins: Margins = {
    top: mg.top * S,
    right: mg.right * S,
    bottom: mg.bottom * S,
    left: mg.left * S,
  };
  const content: Rect = {
    x: margins.left,
    y: margins.top,
    w: Math.max(1, W - margins.left - margins.right),
    h: Math.max(1, H - margins.top - margins.bottom),
  };
  const span = posterSpan(compiled, settings.section) ?? null;
  const tokens = textTokens(compiled, piece, span);

  // --- text boxes -------------------------------------------------------------------------------
  const texts: TextObject[] = [];
  let bandBottom = content.y;
  let anyAuto = false;
  for (const tx of doc?.texts ?? DEFAULT_POSTER_TEXTS) {
    if (tx.hidden) continue;
    const def = TEXT_DEFAULTS[tx.kind] ?? TEXT_DEFAULTS.free;
    const st = tx.style ?? {};
    const family = fonts[st.font ?? def.font] ?? fonts.sans;
    const weight = st.weight ?? def.weight;
    const italic = st.italic === true;
    const align = st.align ?? 'left';
    let lines = fillTokens(tx.text, tokens).split('\n');
    const widthAt = (size: number): number =>
      Math.max(0, ...lines.map((l) => measure(l, cssFont(weight, size, family, italic), 0)));
    const box = validBox(tx.box) ? fromFractions(tx.box, { x: 0, y: 0, w: W, h: H }) : null;
    let size: number;
    let frame: Rect;
    if (box && tx.sizing) {
      size = pos(st.size, def.size) * S;
      if (tx.sizing === 'wrap') {
        const f = cssFont(weight, size, family, italic);
        lines = lines.flatMap((l) => wrapLine(l, box.w, (t) => measure(t, f, 0)));
        frame = { ...box, h: lines.length * LINE_HEIGHT * size };
      } else {
        const w = widthAt(size);
        const x =
          align === 'left'
            ? box.x
            : align === 'right'
              ? box.x + box.w - w
              : box.x + (box.w - w) / 2;
        frame = { x, y: box.y, w, h: lines.length * LINE_HEIGHT * size };
      }
    } else if (box) {
      size = box.h / (lines.length * LINE_HEIGHT);
      const w = widthAt(size);
      if (w > box.w && w > 0) size *= box.w / w;
      frame = box;
    } else {
      anyAuto = true;
      size = pos(st.size, def.size) * S;
      const w = widthAt(size);
      if (w > content.w && w > 0) size *= content.w / w;
      frame = { x: content.x, y: bandBottom, w: content.w, h: lines.length * LINE_HEIGHT * size };
    }
    const lh = LINE_HEIGHT * size;
    const font = cssFont(weight, size, family, italic);
    const runs: TextRun[] = [];
    let ink: Rect | null = null;
    lines.forEach((text, i) => {
      const w = measure(text, font, 0);
      const x =
        align === 'left' ? frame.x : align === 'right' ? frame.x + frame.w : frame.x + frame.w / 2;
      const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
      // The first baseline sits so the line box (1.2 × size) holds ascent and descent centred.
      const y = frame.y + i * lh + (lh - (ASCENT + DESCENT) * size) / 2 + ASCENT * size;
      runs.push({ text, x, y });
      ink = union(ink, { x: left, y: y - ASCENT * size, w, h: (ASCENT + DESCENT) * size });
    });
    const inkBox: Rect = ink ?? { x: frame.x, y: frame.y, w: 0, h: 0 };
    if (!box) {
      frame = { ...frame, x: inkBox.x, w: inkBox.w };
      bandBottom += lines.length * lh;
    }
    texts.push({
      type: 'text',
      group: 'texts',
      member: tx.id,
      kind: tx.kind,
      box: inkBox,
      frame,
      auto: !box,
      runs,
      font,
      size,
      spacing: 0,
      align,
      colour:
        st.colour ??
        (tx.kind === 'title'
          ? (style.paint?.title ?? style.tokens.ink)
          : (style.paint?.title ?? style.tokens.ink2)),
      opacity: unit(st.opacity, 1),
      ...(tx.travels === true ? { travels: true } : {}),
    });
  }
  const band: Rect | null = anyAuto
    ? { x: content.x, y: content.y, w: content.w, h: bandBottom - content.y }
    : null;

  // --- HUD band -----------------------------------------------------------------------------------
  const hudStyle = LS.hud;
  const items = hudStyle.visible ? hudItems(style) : [];
  const hudLines = Math.ceil(items.length / 2);
  const hudRowH = hudStyle.size * (14 / 10.5);
  const hudBand: Rect | null =
    hudLines > 0
      ? {
          x: content.x,
          y: content.y + content.h - hudLines * hudRowH,
          w: content.w,
          h: hudLines * hudRowH,
        }
      : null;

  const musicTop = band ? band.y + band.h + TEXT_BAND_GAP * S : content.y;
  const musicBottom = hudBand ? hudBand.y - 6 * u : content.y + content.h;
  const music: Rect = {
    x: content.x,
    y: Math.min(musicTop, musicBottom - u),
    w: content.w,
    h: Math.max(u, musicBottom - Math.min(musicTop, musicBottom - u)),
  };

  // --- rows -----------------------------------------------------------------------------------------
  const A = span ? span.start : 0;
  const B = span ? span.end : compiled.duration;
  const maxRows = Math.max(1, Math.floor((B - A) / MIN_SECTION));
  const grid =
    piece.view.gridBpm !== undefined
      ? {
          bpm: piece.view.gridBpm,
          ...(piece.view.meter !== undefined ? { meter: piece.view.meter } : {}),
        }
      : undefined;
  const markers = markersOf(compiled, piece);
  const sections = markers.filter((m) => m.label !== undefined);
  const moments = markers.filter((m) => m.label === undefined);
  const plan =
    doc?.rowsBy === 'sections'
      ? sectionRows(
          sections.map((m) => ({ id: m.id, t: m.t, label: m.label ?? '' })),
          doc.rowSections,
          A,
          B,
        )
      : null;
  const times: { start: Seconds; end: Seconds; id?: string; label?: string }[] = plan
    ? plan.rows
    : posterRows(B, Math.min(settings.rows, maxRows), grid, A);
  const n = times.length;
  let longest = 0;
  for (const r of times) longest = Math.max(longest, r.end - r.start);
  const cam = posterCamera(compiled, undefined, span ?? undefined, settings.pieceRange);
  const pitchRange: [number, number] = cam.pitchRange ?? pitchExtent(compiled);
  const [pLo, pHi] = pitchRange;

  // Label zones: above the plot (labels along the start) and below (along the end).
  const vLabels = [LS.sectionLabels, LS.momentLabels].filter((s) => s.visible);
  const zoneOf = (along: 'start' | 'end'): number => {
    let z = 0;
    for (const s of vLabels)
      if (s.along === along) z = Math.max(z, s.size * (ASCENT + DESCENT) + s.offset + 2 * u);
    return z;
  };
  const rowLabelZone =
    n > 1 && LS.rowLabels.visible ? LS.rowLabels.size * (ASCENT + DESCENT) + 3 * u : 0;
  const zoneTop = Math.max(zoneOf('start'), rowLabelZone, (TICK_ABOVE + 1) * u);
  const zoneBottom = Math.max(zoneOf('end'), 2 * u);
  // Gutters for guide labels set out past the lines' ends.
  const guidePitches = A_PITCHES.filter((p) => p >= pLo && p <= pHi);
  const pg = look.pitchGuides;
  const pgPitches = pg ? pg.pitches.filter((p) => Number.isFinite(p) && p >= pLo && p <= pHi) : [];
  const guideText = (p: number): string =>
    `A${Math.floor(p / 12) - 1} ${hzOf(p, compiled.referenceHz).toFixed(0)} Hz`;
  const gutter = { start: 0, end: 0 };
  const gutterFor = (s: LabelStyle, texts: string[]): void => {
    if (!s.visible || s.side !== 'out' || texts.length === 0) return;
    const font = cssFont(s.weight, s.size, fonts.mono);
    const w = Math.max(...texts.map((t) => measure(t, font, s.spacing))) + s.offset + TEXT_PAD * u;
    gutter[s.along] = Math.max(gutter[s.along], w);
  };
  gutterFor(LS.guideLabels, guidePitches.map(guideText));
  gutterFor(LS.pitchLabels, pgPitches.map(pitchGuideLabel));
  // Row labels (rows by sections): a column at the left, before the guide labels' gutter.
  const RN = LS.rowNames;
  const nameFont = cssFont(RN.weight, RN.size, fonts.mono);
  let nameW = 0;
  if (plan && RN.visible) {
    for (const r of times) {
      const t = r.label?.trim();
      if (t) nameW = Math.max(nameW, measure(t, nameFont, RN.spacing));
    }
    if (nameW > 0) nameW = Math.min(music.w * 0.3, nameW + RN.offset + TEXT_PAD * u);
  }
  const names = { x: music.x, w: nameW };
  gutter.start += nameW;

  const rowH = Math.max(u, (music.h - POSTER_ROW_GAP * u * (n - 1)) / n);
  const plotW = Math.max(u, music.w - gutter.start - gutter.end);
  const rows: RowLayout[] = times.map((r, i) => {
    const y = music.y + i * (rowH + POSTER_ROW_GAP * u);
    const pw = longest > 0 ? (plotW * (r.end - r.start)) / longest : plotW;
    const rect: Rect = { x: music.x, y, w: gutter.start + pw + gutter.end, h: rowH };
    const plot: Rect = {
      x: music.x + gutter.start,
      y: y + zoneTop,
      w: pw,
      h: Math.max(u, rowH - zoneTop - zoneBottom),
    };
    return {
      index: i,
      start: r.start,
      end: r.end,
      ...(r.id !== undefined ? { section: r.id, name: r.label ?? '' } : {}),
      key: r.id ?? String(i),
      rect,
      plot,
    };
  });
  const xOf = (row: RowLayout, t: Seconds): number =>
    row.plot.x + ((t - row.start) / Math.max(1e-9, row.end - row.start)) * row.plot.w;
  const yOf = (row: RowLayout, p: number): number =>
    row.plot.y + ((pHi - p) / (pHi - pLo)) * row.plot.h;
  // The music area as the rows' plots cover it: what a layer's box maps.
  let plots: Rect | null = null;
  for (const r of rows) plots = union(plots, r.plot);
  const plotArea = plots ?? music;
  // Rows moved as blocks: the plot keeps its insets in the row (label zone, gutters).
  const artboard: Rect = { x: 0, y: 0, w: W, h: H };
  for (const r of rows) {
    const b = doc?.rowBoxes?.[r.key];
    if (!validBox(b)) continue;
    const to = fromFractions(b, artboard);
    const home = r.rect;
    const p = r.plot;
    r.plot = {
      x: to.x + (p.x - home.x),
      y: to.y + (p.y - home.y),
      w: Math.max(u, to.w - (home.w - p.w)),
      h: Math.max(u, to.h - (home.h - p.h)),
    };
    r.rect = to;
    r.home = home;
  }

  // --- layers -----------------------------------------------------------------------------------------
  const layerDocs = new Map((doc?.layers ?? []).map((l) => [l.id, l]));
  const parts: string[] = [];
  const partVoices = new Map<string, number[]>();
  piece.voices.forEach((def, i) => {
    const p = partOf(def);
    if (!partVoices.has(p)) {
      partVoices.set(p, []);
      parts.push(p);
    }
    partVoices.get(p)!.push(i);
  });
  const ordered: string[] = [];
  for (const l of doc?.layers ?? []) {
    const p = l.id.startsWith('part:') ? l.id.slice(5) : null;
    if (p !== null && partVoices.has(p) && !ordered.includes(p)) ordered.push(p);
  }
  for (const p of parts) if (!ordered.includes(p)) ordered.push(p);

  const extents: ({ t0: number; t1: number; lo: number; hi: number } | null)[][] = [];
  const extentOf = (v: number, row: number) => {
    const ev = (extents[v] ??= []);
    if (ev[row] === undefined) {
      const r = rows[row];
      ev[row] = compiled.voices[v] ? voiceExtent(compiled, v, r.start, r.end) : null;
    }
    return ev[row];
  };
  const layers: LayerLayout[] = [];
  const addLayer = (
    id: string,
    kind: 'part' | 'line',
    part: string,
    voices: number[],
    box: Rect,
    hidden: boolean,
    colour: string | undefined,
    own: Record<string, PosterBox> | undefined,
  ): void => {
    const frames: LayerFrame[] = rows.map((r) => {
      const base = mapRect(r.plot, plotArea, box);
      const f = own?.[r.key];
      return validBox(f)
        ? { row: r.index, rect: fromFractions(f, base), base }
        : { row: r.index, rect: base };
    });
    const rowBounds = rows.map((r, ri) => {
      let b: Rect | null = null;
      for (const v of voices) {
        const e = extentOf(v, ri);
        if (!e) continue;
        const x0 = xOf(r, e.t0);
        const x1 = xOf(r, e.t1);
        const y0 = yOf(r, e.hi);
        const y1 = yOf(r, e.lo);
        b = union(b, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      return b ? mapRect(b, r.plot, frames[ri].rect) : null;
    });
    let bounds: Rect | null = null;
    for (const b of rowBounds) bounds = union(bounds, b);
    layers.push({
      id,
      kind,
      part,
      voices,
      hidden,
      ...(colour ? { colour } : {}),
      box,
      frames,
      rowBounds,
      bounds,
    });
  };
  for (const p of ordered) {
    const ld = layerDocs.get(`part:${p}`);
    const pbox = validBox(ld?.box) ? fromFractions(ld.box, artboard) : plotArea;
    const all = partVoices.get(p) ?? [];
    const own: number[] = [];
    const split: {
      id: string;
      v: number;
      box: Rect;
      hidden: boolean;
      colour?: string;
      rows?: Record<string, PosterBox>;
    }[] = [];
    for (const v of all) {
      const vid = piece.voices[v].id;
      const lineDoc = layerDocs.get(`line:${vid}`);
      if (lineDoc?.hidden) continue;
      if (validBox(lineDoc?.box)) {
        const c = lineDoc.colour ?? ld?.colour;
        split.push({
          id: `line:${vid}`,
          v,
          box: fromFractions(lineDoc.box, pbox),
          hidden: ld?.hidden === true,
          ...(c ? { colour: c } : {}),
          ...(lineDoc.rows ? { rows: lineDoc.rows } : {}),
        });
      } else own.push(v);
    }
    addLayer(`part:${p}`, 'part', p, own, pbox, ld?.hidden === true, ld?.colour, ld?.rows);
    for (const s of split) addLayer(s.id, 'line', p, [s.v], s.box, s.hidden, s.colour, s.rows);
  }

  // --- lines (guides, beats, markers) ---------------------------------------------------------------
  const lineObjs: LineObject[] = [];
  const pushLine = (
    group: PosterLineGroup,
    member: string,
    row: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    s: LineStyle,
    opacity = s.opacity,
    colour = s.colour,
  ): void => {
    const m = memberOf(doc, group, member);
    if (m?.visible === false) return;
    const ms = m ? lineStyleOf(m, s, u) : s;
    const ws = m?.width !== undefined ? ms.width : s.width;
    const dx = (m?.dx ?? 0) * S;
    const dy = (m?.dy ?? 0) * S;
    const half = ws / 2;
    lineObjs.push({
      type: 'line',
      group,
      member,
      row,
      x0: x0 + dx,
      y0: y0 + dy,
      x1: x1 + dx,
      y1: y1 + dy,
      colour: m?.colour ? ms.colour : colour,
      width: ws,
      opacity: m?.opacity !== undefined ? ms.opacity : opacity,
      dash: (m?.dashed ?? s.dashed) ? DASH.map((d) => d * u) : null,
      box: {
        x: Math.min(x0, x1) + dx - half,
        y: Math.min(y0, y1) + dy - half,
        w: Math.abs(x1 - x0) + ws,
        h: Math.abs(y1 - y0) + ws,
      },
    });
  };
  const inRow = (r: RowLayout, t: Seconds): boolean =>
    t >= r.start && (t < r.end || (r.index === n - 1 && t <= r.end));
  for (const r of rows) {
    const { plot } = r;
    const right = plot.x + plot.w;
    if (LN.beatLines.visible) {
      const bars = { bpm: piece.view.gridBpm, meter: piece.view.meter };
      const every = look.beats === 'every';
      const pps = plot.w / u / Math.max(1e-9, r.end - r.start);
      const { beat, bar } = barGrid(bars.bpm, bars.meter, pps, every);
      for (let pass = 0; pass < 2; pass++) {
        const step = pass === 0 ? beat : bar;
        if (!(step > 0)) continue;
        for (let k = Math.max(0, Math.ceil(r.start / step - 1e-9)); k * step <= r.end + 1e-9; k++) {
          const t = k * step;
          if (pass === 0 && Math.abs(t / bar - Math.round(t / bar)) < 1e-6) continue;
          const x = xOf(r, t);
          const full = LN.beatLines.extent === 'full';
          pushLine(
            'beatLines',
            `${pass === 0 ? 'beat' : 'bar'}:${round3(t)}`,
            r.index,
            x,
            full ? plot.y - 6 * u : plot.y - TICK_ABOVE * u,
            x,
            full ? plot.y + plot.h + 6 * u : plot.y + TICK_BELOW * u,
            LN.beatLines,
            pass === 0 ? LN.beatLines.opacity : LN.beatLines.opacity / 2,
            pass === 0 ? LN.beatLines.colour : (style.paint?.beats ?? style.tokens.ink2),
          );
        }
      }
    }
    const hLine = (group: 'guideLines' | 'pitchLines', p: number): void => {
      const s = LN[group];
      if (!s.visible) return;
      const y = yOf(r, p);
      const tick = s.extent === 'tick';
      pushLine(group, String(p), r.index, plot.x, y, tick ? plot.x + TICK_LEN * u : right, y, s);
    };
    for (const p of guidePitches) hLine('guideLines', p);
    for (const p of pgPitches) hLine('pitchLines', p);
    const vLine = (group: 'sectionLines' | 'momentLines', m: Marker): void => {
      const s = LN[group];
      if (!s.visible || !inRow(r, m.t)) return;
      const x = xOf(r, m.t);
      if (s.extent === 'tick')
        pushLine(group, m.id, r.index, x, plot.y - TICK_ABOVE * u, x, plot.y + TICK_BELOW * u, s);
      else pushLine(group, m.id, r.index, x, r.rect.y + 2 * u, x, plot.y + plot.h + 2 * u, s);
    };
    for (const m of moments) vLine('momentLines', m);
    for (const m of sections) vLine('sectionLines', m);
  }

  // --- labels -----------------------------------------------------------------------------------------
  const placed: Rect[] = texts.map((t) => t.box);
  const labelObjs: LabelObject[] = [];
  const hidden: LabelObject[] = [];
  const P = TEXT_PAD * u;
  /** A start for a label: its left x and baseline, and which way it may slide past what it meets. */
  interface Start {
    x: number;
    y: number;
    slide?: 'right' | 'left';
  }
  /**
   * Places a label at the first of `starts` (the preferred first; each moved by the member's
   * nudge) that fits inside `bounds` clear of placed text, sliding a start past each box it meets
   * (by at most twice its width); else hides it. Labels keep a gap of about one character
   * across from each other.
   */
  const place = (
    group: PosterLabelGroup,
    member: string,
    row: number | undefined,
    text: string,
    s: LabelStyle,
    starts: (w: number) => Start[],
    bounds: Rect = content,
  ): void => {
    const m = memberOf(doc, group, member);
    if (m?.visible === false) return;
    const ms = m
      ? labelStyleOf(group, mergeStyle(doc?.groups?.[group] ?? {}, m), s.visible, s.colour, u)
      : s;
    const shown = ms.uppercase ? text.toUpperCase() : text;
    const font = cssFont(ms.weight, ms.size, fonts.mono);
    const w = measure(shown, font, ms.spacing);
    const dx = (m?.dx ?? 0) * S;
    const dy = (m?.dy ?? 0) * S;
    const gapX = Math.max(P, 0.9 * ms.size);
    const make = (x: number, y: number): LabelObject => ({
      type: 'label',
      group,
      member,
      ...(row !== undefined ? { row } : {}),
      runs: [{ text: shown, x: x + dx, y: y + dy }],
      font,
      size: ms.size,
      spacing: ms.spacing,
      align: 'left',
      colour: ms.colour,
      opacity: ms.opacity,
      box: { x: x + dx, y: y + dy - ASCENT * ms.size, w, h: (ASCENT + DESCENT) * ms.size },
    });
    const meets = (b: Rect): Rect | undefined =>
      placed.find(
        (p) =>
          b.x < p.x + p.w + gapX &&
          p.x < b.x + b.w + gapX &&
          b.y < p.y + p.h + P &&
          p.y < b.y + b.h + P,
      );
    const all = starts(w);
    for (const st of all) {
      let x = st.x;
      for (let k = 0; k < 16; k++) {
        const o = make(x, st.y);
        if (!inside(o.box, bounds)) break;
        const hit = meets(o.box);
        if (!hit) {
          placed.push(o.box);
          labelObjs.push(o);
          return;
        }
        if (!st.slide) break;
        x = st.slide === 'right' ? hit.x + hit.w + gapX - dx : hit.x - gapX - w - dx;
        if (Math.abs(x - st.x) > 2 * w + gapX) break;
      }
    }
    if (all.length > 0) hidden.push(make(all[0].x, all[0].y));
  };

  // Row times: each row after the first, at its top left.
  if (n > 1 && LS.rowLabels.visible) {
    for (const r of rows.slice(1)) {
      const s = LS.rowLabels;
      place('rowLabels', String(r.index), r.index, posterLength(r.start), s, () => [
        { x: r.plot.x, y: r.rect.y + s.size * ASCENT + u },
      ]);
    }
  }
  // Row labels: left of each row, centred on its plot (else at its top), in their column.
  if (nameW > 0) {
    for (const r of rows) {
      const text = r.name?.trim();
      if (!text || r.section === undefined) continue;
      const mid = r.plot.y + r.plot.h / 2 + (RN.size * (ASCENT - DESCENT)) / 2;
      place(
        'rowNames',
        r.section,
        r.index,
        text,
        RN,
        () => [
          { x: names.x, y: mid },
          { x: names.x, y: r.plot.y + RN.size * ASCENT },
        ],
        { x: names.x, y: r.rect.y, w: names.w, h: r.rect.h },
      );
    }
  }
  /** A vertical line's label: beside the line in the zone above or below the plot, shifting right past what it meets. */
  const vLabel = (group: 'sectionLabels' | 'momentLabels', list: Marker[]): void => {
    const s = LS[group];
    if (!s.visible) return;
    for (const r of rows) {
      for (const mk of list) {
        if (!inRow(r, mk.t)) continue;
        const x = xOf(r, mk.t);
        const y =
          s.along === 'start'
            ? r.plot.y - s.offset - s.size * DESCENT - 2 * u
            : r.plot.y + r.plot.h + s.offset + s.size * ASCENT;
        place(
          group,
          mk.id,
          r.index,
          mk.text,
          s,
          (w): Start[] =>
            s.side === 'left'
              ? [
                  { x: x - s.offset - w, y, slide: 'left' },
                  { x: x + s.offset, y, slide: 'right' },
                ]
              : [
                  { x: x + s.offset, y, slide: 'right' },
                  { x: x - s.offset - w, y, slide: 'left' },
                ],
          // Not into the guide labels' gutter.
          { x: r.plot.x, y: content.y, w: content.x + content.w - r.plot.x, h: content.h },
        );
      }
    }
  };
  vLabel('sectionLabels', sections);

  // HUD readouts: two columns in the HUD band (left first), or where the Look's layout puts them.
  if (hudBand && items.length > 0) {
    const view = { t: compiled.duration, window: B - A, duration: compiled.duration } as View;
    items.forEach((item: HudItem, k) => {
      const text = hudText(item, compiled, view, style);
      if (!text) return;
      const right = k >= hudLines;
      const r = right ? k - hudLines : k;
      const em = item === 'chord' || item === 'title';
      const s: LabelStyle = em
        ? {
            ...hudStyle,
            size: hudStyle.size * (12 / 10.5),
            weight: 500,
            colour: style.paint?.hud ?? style.tokens.ink,
          }
        : hudStyle;
      const y =
        hudBand.y + r * hudRowH + s.size * ASCENT + (hudRowH - s.size * (ASCENT + DESCENT)) / 2;
      const pos = look.hudLayout?.[item];
      place('hud', item, undefined, text, s, (w) => {
        if (pos) {
          // A placed readout: its anchor point on the artboard plus its offset (as the video).
          const fx = pos.anchor.includes('r')
            ? 1
            : pos.anchor === 't' || pos.anchor === 'c' || pos.anchor === 'b'
              ? 0.5
              : 0;
          const fy = pos.anchor.startsWith('b')
            ? 1
            : pos.anchor === 'l' || pos.anchor === 'c' || pos.anchor === 'r'
              ? 0.5
              : 0;
          const bh = s.size * (ASCENT + DESCENT);
          const bx = fx * W + pos.x * W - fx * w;
          const by = fy * H + pos.y * H - fy * bh;
          const cx = Math.min(content.x + content.w - w, Math.max(content.x, bx));
          const cy = Math.min(content.y + content.h - bh, Math.max(content.y, by));
          return [{ x: cx, y: cy + s.size * ASCENT }];
        }
        return [{ x: right ? content.x + content.w - w : content.x, y }];
      });
    });
  }

  /** A horizontal guide's label: in the gutter past the row's end, or above or below the line. */
  const hLabel = (
    group: 'guideLabels' | 'pitchLabels',
    pitches: number[],
    text: (p: number) => string,
  ): void => {
    const s = LS[group];
    if (!s.visible) return;
    for (const r of rows) {
      for (const p of pitches) {
        const y = yOf(r, p);
        place(group, String(p), r.index, text(p), s, (w): Start[] => {
          const atEnd = s.along === 'end';
          const mid = y + (s.size * (ASCENT - DESCENT)) / 2;
          if (s.side === 'out') {
            const x = atEnd ? r.plot.x + r.plot.w + s.offset : r.plot.x - s.offset - w;
            const step = s.size * 0.5;
            return [0, -1, 1, -2, 2].map((k) => ({ x, y: mid + k * step }));
          }
          const x = atEnd ? r.plot.x + r.plot.w - s.offset - w : r.plot.x + s.offset;
          const yy =
            s.side === 'below' ? y + s.offset + s.size * ASCENT : y - s.offset - s.size * DESCENT;
          return [{ x, y: yy, slide: atEnd ? 'left' : 'right' }];
        });
      }
    }
  };
  hLabel('guideLabels', guidePitches, guideText);
  hLabel('pitchLabels', pgPitches, pitchGuideLabel);
  vLabel('momentLabels', moments);

  // HUD readouts travel with a video's frame unless set to stay (M15).
  for (const o of labelObjs) if (o.group === 'hud' && hudTravels(doc, o.member)) o.travels = true;

  // --- objects, back to front ----------------------------------------------------------------------
  const LINE_ORDER: readonly PosterLineGroup[] = [
    'beatLines',
    'guideLines',
    'pitchLines',
    'momentLines',
    'sectionLines',
  ];
  const objects: PosterObject[] = [];
  for (const g of LINE_ORDER) for (const l of lineObjs) if (l.group === g) objects.push(l);
  layers.forEach((L, li) => {
    if (L.hidden) return;
    L.rowBounds.forEach((b, ri) => {
      if (b)
        objects.push({ type: 'layer', group: 'layers', member: L.id, layer: li, row: ri, box: b });
    });
  });
  objects.push(...labelObjs, ...texts);

  const voiceColors = posterVoiceColors(doc, piece.voices);
  return {
    ...(voiceColors ? { voiceColors } : {}),
    width: W,
    height: H,
    unit: u,
    settings,
    margins,
    content,
    band,
    music,
    hudBand,
    span,
    rows,
    pitchRange,
    layers,
    objects,
    hidden,
    look,
    style,
    labels: LS,
    lines: LN,
    marks: MK,
    sectionRows: plan ? plan.items : null,
    fonts,
    measure,
  };
}

/** Whether HUD readout `item` travels with a video's frame (M15): its own switch, the group's, else yes. */
export function hudTravels(doc: PosterDoc | undefined, item: string): boolean {
  return doc?.members?.hud?.[item]?.travels ?? doc?.groups?.hud?.travels ?? true;
}

/**
 * The Organize list of rows by sections for a doc (whether or not its rows are by sections):
 * the labelled moments in the poster's span, in order, with their row labels and switches.
 */
export function posterSectionItems(
  compiled: CompiledScore,
  piece: PosterPiece,
  doc?: PosterDoc,
  base?: PosterBase,
): SectionRowItem[] {
  const settings = posterSettings(doc, base);
  const span = posterSpan(compiled, settings.section) ?? null;
  const sections = markersOf(compiled, piece)
    .filter((m) => m.label !== undefined)
    .map((m) => ({ id: m.id, t: m.t, label: m.label ?? '' }));
  const A = span ? span.start : 0;
  const B = span ? span.end : compiled.duration;
  return sectionRows(sections, doc?.rowSections, A, B).items;
}

/**
 * Line colours by pool index from a doc's layers (a line's own beats its part's): the poster
 * draws with them, and so does the video (§15 M14 "Colours are shared"). Undefined when none.
 */
export function posterVoiceColors(
  doc: PosterDoc | undefined,
  voices: PosterPiece['voices'],
): (string | undefined)[] | undefined {
  const ls = doc?.layers;
  if (!ls || !ls.some((l) => l.colour)) return undefined;
  const by = new Map(ls.map((l) => [l.id, l.colour]));
  const out = voices.map((v) => by.get(`line:${v.id}`) || by.get(`part:${partOf(v)}`) || undefined);
  return out.some((c) => c) ? out : undefined;
}
