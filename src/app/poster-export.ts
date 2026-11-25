/**
 * Poster export (PLAN.md §12 "Poster export", revision 12): the whole piece as a PNG
 * (OffscreenCanvas + convertToBlob) or an SVG (`SvgContext`), drawn by `drawPoster`.
 */

import { compile } from '../core/compiler/compile';
import type { CompiledScore, LineColors, Piece, PosterDoc } from '../core/types';
import { drawScore, type Ctx2D } from '../render/draw';
import type { HudPlacement } from '../render/hud';
import { PLAYER_LOOK, pieceLook, type Look } from '../render/look';
import { supportsOklch } from '../render/palettes';
import {
  drawPoster,
  drawPosterLayout,
  posterCamera,
  posterLayout,
  posterSize,
  posterStyle,
  type PosterDims,
  type PosterDrawOptions,
  type PosterInfo,
  type PosterSize,
  posterHudPlacement,
} from '../render/poster';
import {
  estimateText,
  layoutPoster,
  measureWith,
  type Measure,
  type PosterLayout,
} from '../render/poster-layout';
import type { TimeSpan } from '../render/section';
import { SvgContext, asCtx2D } from '../render/svg';
import { videoMarkers } from '../render/video';
import { fileBase } from './export-options';

export interface PosterOptions {
  /** A preset or explicit pixels. */
  size: PosterSize | PosterDims;
  /** Rows the piece is cut into (1..8), breaks on the piece's bar lines. @default 1 */
  rows?: number;
  theme: 'light' | 'dark';
  /** No background (PNG alpha, no SVG background rect). */
  transparent: boolean;
  /** The title block (name, length, key, credit). */
  title: boolean;
  /** Weight drawn as thickness. */
  thickness: boolean;
  /** @default 'pitch' */
  colors?: LineColors;
  /** Voice colours by pool index, for `colors: 'custom'`. */
  customColors?: readonly (string | undefined)[];
  /** The export Look (§12); replaces theme, transparent, thickness and colors when given. */
  look?: Look;
  /** The section drawn (§12 rev 15); absent = the whole piece. */
  section?: TimeSpan;
  /** With a section: the whole piece's pitch range, not the section's. @default false */
  pieceRange?: boolean;
}

/**
 * `drawPoster`'s options for a piece. `oklch`: the PNG uses what the browser parses; the SVG
 * always asks for OKLCH (SvgContext writes it as hex).
 */
export function posterDrawOptions(
  piece: Piece,
  opts: PosterOptions,
  oklch: boolean,
): PosterDrawOptions {
  const style = posterStyle({
    theme: opts.theme,
    thickness: opts.thickness,
    transparent: opts.transparent,
    title: opts.title,
    colors: opts.colors ?? 'pitch',
    oklch,
    ...(opts.customColors ? { customColors: opts.customColors } : {}),
    ...videoMarkers(piece),
    ...(opts.look ? { look: opts.look, ...pieceLook(piece) } : {}),
  });
  const o: PosterDrawOptions = { size: opts.size, style, title: opts.title };
  if (opts.rows !== undefined && opts.rows !== 1) o.rows = opts.rows;
  if (opts.section) o.section = opts.section;
  if (opts.pieceRange) o.pieceRange = true;
  const bpm = piece.view.gridBpm;
  if (bpm !== undefined) {
    o.grid = piece.view.meter !== undefined ? { bpm, meter: piece.view.meter } : { bpm };
  }
  return o;
}

function posterInfo(piece: Piece): PosterInfo {
  return { name: piece.meta.title, key: piece.key };
}

/** The poster as a PNG. */
export async function renderPosterPng(
  piece: Piece,
  opts: PosterOptions,
  compiled: CompiledScore = compile(piece),
): Promise<Blob> {
  const { width, height } = posterSize(opts.size);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: opts.transparent });
  if (!g) throw new Error('Poster export: this browser cannot draw on an OffscreenCanvas.');
  drawPoster(g, compiled, posterInfo(piece), posterDrawOptions(piece, opts, supportsOklch()));
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * The Export dialog's preview: the poster as the PNG export draws it, title block included, on a
 * canvas `scale` times the poster's pixel size.
 */
export function previewPoster(
  ctx: Ctx2D,
  piece: Piece,
  compiled: CompiledScore,
  opts: PosterOptions,
  scale: number,
): HudPlacement {
  const o = posterDrawOptions(piece, opts, supportsOklch());
  const view = drawPoster(ctx, compiled, posterInfo(piece), o, scale);
  return posterHudPlacement(ctx, compiled, o, view);
}

/** The poster as an SVG document. */
export function renderPosterSvg(
  piece: Piece,
  opts: PosterOptions,
  compiled: CompiledScore = compile(piece),
): string {
  const { width, height } = posterSize(opts.size);
  const svg = new SvgContext(width, height);
  drawPoster(asCtx2D(svg), compiled, posterInfo(piece), posterDrawOptions(piece, opts, true));
  return svg.toSvg();
}

/** `<title>.png` / `<title>.svg`. */
export function posterFileName(piece: Piece, format: 'png' | 'svg'): string {
  return `${fileBase(piece)}.${format}`;
}

/**
 * Tests: the poster at `scale` drawn on a fresh canvas `width` x `height` pixels (title block
 * included), to compare with the dialog's preview.
 */
export function referencePosterAt(
  piece: Piece,
  opts: PosterOptions,
  scale: number,
  width: number,
  height: number,
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const o = posterDrawOptions(piece, opts, supportsOklch());
  drawPoster(g, compile(piece), posterInfo(piece), o, scale);
  return g.getImageData(0, 0, width, height);
}

/**
 * Tests: the poster drawn by `drawScore` directly (same camera, style and layout, no title) on a
 * fresh OffscreenCanvas, to compare with `renderPosterPng`.
 */
export function referencePoster(piece: Piece, opts: PosterOptions): ImageData {
  const { width, height } = posterSize(opts.size);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: opts.transparent })!;
  const compiled = compile(piece);
  const { style } = posterDrawOptions(piece, { ...opts, title: false }, supportsOklch());
  const lay = posterLayout(opts.size);
  drawScore(g, compiled, posterCamera(compiled), style, compiled.duration, lay, lay.dpr);
  return g.getImageData(0, 0, width, height);
}

// ---------------------------------------------------------------------------------------------
// The poster workspace (§15 M14): drawn from `layoutPoster`
// ---------------------------------------------------------------------------------------------

/**
 * The poster's layout for a piece: `opts` are the viewer's remembered poster options (size, rows,
 * section, Look) under the piece's `PosterDoc` (`doc`, default `piece.poster`), which wins. With
 * `title: false` and a doc without text boxes, none are drawn (today's switch). Text is measured
 * with `measure` (default: an OffscreenCanvas where there is one, else an estimate), so the PNG,
 * the SVG and the artboard share one layout.
 */
export function posterLayoutOf(
  piece: Piece,
  opts: PosterOptions,
  compiled: CompiledScore = compile(piece),
  doc: PosterDoc | undefined = piece.poster,
  measure: Measure = posterMeasure(),
): PosterLayout {
  const size = posterSize(opts.size);
  const look: Look = opts.look ?? {
    ...PLAYER_LOOK,
    theme: opts.theme,
    transparent: opts.transparent,
    thickness: opts.thickness,
    colors: opts.colors ?? 'pitch',
    hud: [],
  };
  const d: PosterDoc | undefined = !opts.title && !doc?.texts ? { ...doc, texts: [] } : doc;
  return layoutPoster({
    compiled,
    piece: opts.customColors
      ? { ...piece, voices: piece.voices.map((v, i) => ({ ...v, color: opts.customColors?.[i] })) }
      : piece,
    ...(d ? { doc: d } : {}),
    look,
    base: {
      size: { w: size.width, h: size.height },
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      ...(opts.section ? { section: opts.section } : {}),
      ...(opts.pieceRange ? { pieceRange: true } : {}),
    },
    oklch: supportsOklch(),
    measure,
  });
}

let measurer: Measure | null = null;

/** Text measured on an OffscreenCanvas (one per page), or the estimate where there is none. */
export function posterMeasure(): Measure {
  if (measurer) return measurer;
  const g =
    typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
  measurer = g ? measureWith(g) : estimateText;
  return measurer;
}

/** The poster as a PNG, drawn from its layout (default: `posterLayoutOf`). */
export async function renderPosterLayoutPng(
  piece: Piece,
  opts: PosterOptions,
  compiled: CompiledScore = compile(piece),
  layout: PosterLayout = posterLayoutOf(piece, opts, compiled),
): Promise<Blob> {
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const transparent = layout.style.tokens.paper === 'transparent';
  const g = canvas.getContext('2d', { alpha: transparent });
  if (!g) throw new Error('Poster export: this browser cannot draw on an OffscreenCanvas.');
  drawPosterLayout(g, compiled, layout);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** The poster as an SVG document, drawn from its layout (OKLCH colours, written as hex). */
export function renderPosterLayoutSvg(
  piece: Piece,
  opts: PosterOptions,
  compiled: CompiledScore = compile(piece),
  layout: PosterLayout = posterLayoutOf(piece, opts, compiled),
): string {
  const svg = new SvgContext(layout.width, layout.height);
  const l = layout.style.oklch ? layout : { ...layout, style: { ...layout.style, oklch: true } };
  drawPosterLayout(asCtx2D(svg), compiled, l);
  return svg.toSvg();
}

/**
 * The artboard: the poster drawn from its layout on a canvas `scale` times its pixel size.
 * Returns the layout (for hit-testing and the overlays).
 */
export function previewPosterLayout(
  ctx: Ctx2D,
  piece: Piece,
  compiled: CompiledScore,
  opts: PosterOptions,
  scale: number,
  doc: PosterDoc | undefined = piece.poster,
): PosterLayout {
  const layout = posterLayoutOf(piece, opts, compiled, doc);
  drawPosterLayout(ctx, compiled, layout, scale);
  return layout;
}
