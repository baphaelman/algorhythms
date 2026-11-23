/**
 * Poster export (PLAN.md §12 "Poster export", revision 12): the whole piece as a PNG
 * (OffscreenCanvas + convertToBlob) or an SVG (`SvgContext`), drawn by `drawPoster`.
 */

import { compile } from '../core/compiler/compile';
import type { CompiledScore, LineColors, Piece } from '../core/types';
import { drawScore, type Ctx2D } from '../render/draw';
import { pieceLook, type Look } from '../render/look';
import { supportsOklch } from '../render/palettes';
import {
  drawPoster,
  posterCamera,
  posterLayout,
  posterSize,
  posterStyle,
  type PosterDims,
  type PosterDrawOptions,
  type PosterInfo,
  type PosterSize,
} from '../render/poster';
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
): void {
  const o = posterDrawOptions(piece, opts, supportsOklch());
  drawPoster(ctx, compiled, posterInfo(piece), o, scale);
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
