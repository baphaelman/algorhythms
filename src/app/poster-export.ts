/**
 * Poster export (PLAN.md §12 "Poster export", §15 M14): the poster as a PNG (OffscreenCanvas +
 * convertToBlob) or an SVG (`SvgContext`), drawn from its layout (`layoutPoster`), as the
 * workspace's artboard draws it.
 */

import { compile } from '../core/compiler/compile';
import type { CompiledScore, LineColors, Piece, PosterDoc } from '../core/types';
import type { Ctx2D } from '../render/draw';
import type { HudPlacement } from '../render/hud';
import type { HudItem } from '../render/types';
import { posOfBox } from '../render/hud-layout';
import { PLAYER_LOOK, type Look } from '../render/look';
import { supportsOklch } from '../render/palettes';
import { drawPosterLayout, posterSize, type PosterDims, type PosterSize } from '../render/poster';
import {
  estimateText,
  layoutPoster,
  measureWith,
  type Measure,
  type PosterLayout,
} from '../render/poster-layout';
import type { TimeSpan } from '../render/section';
import { SvgContext, asCtx2D } from '../render/svg';
import { fileBase } from './export-options';
import { picturesReady } from './poster-picture';

export interface PosterOptions {
  /** A preset or explicit pixels. */
  size: PosterSize | PosterDims;
  /** Rows the piece is cut into (1..8), breaks on the piece's bar lines. @default 1 */
  rows?: number;
  theme: 'light' | 'dark';
  /** No background (PNG alpha, no SVG background rect). */
  transparent: boolean;
  /** The default text boxes when the doc has none (false: none, as the old Title block switch). */
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

/** `<title>.png` / `<title>.svg`. */
export function posterFileName(piece: Piece, format: 'png' | 'svg'): string {
  return `${fileBase(piece)}.${format}`;
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
  await picturesReady(piece);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  // Alpha on, as on the artboard, even when the paper is opaque: an opaque canvas gets subpixel
  // (LCD) text on Linux Chromium and Firefox, so the PNG would differ from the artboard.
  const g = canvas.getContext('2d');
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
 * The artboard: the poster drawn from its layout on a canvas `scale` times its pixel size (or
 * the part of it from `offset`, canvas px, when zoomed in). Returns the layout (for hit-testing
 * and the overlays).
 */
export function previewPosterLayout(
  ctx: Ctx2D,
  piece: Piece,
  compiled: CompiledScore,
  opts: PosterOptions,
  scale: number,
  doc: PosterDoc | undefined = piece.poster,
  offset?: { x: number; y: number },
): PosterLayout {
  const layout = posterLayoutOf(piece, opts, compiled, doc);
  drawPosterLayout(ctx, compiled, layout, scale, offset);
  return layout;
}

/** The HUD readouts' boxes of a layout, as the readout overlay places them. */
export function posterHudOf(layout: PosterLayout): HudPlacement {
  const frame = { width: layout.width, height: layout.height };
  const boxes: HudPlacement['boxes'] = [];
  for (const o of layout.objects) {
    if (o.type !== 'label' || o.group !== 'hud') continue;
    const { x, y, w, h } = o.box;
    boxes.push({
      item: o.member as HudItem,
      text: o.runs.map((r) => r.text).join(' '),
      x,
      y,
      w,
      h,
      anchor: posOfBox(x, y, w, h, frame).anchor,
    });
  }
  return { ...frame, margin: layout.margins.left, boxes };
}

/**
 * Tests: the poster at `scale` drawn from its layout on a fresh canvas `width` x `height` pixels
 * (from `offset`, canvas px), to compare with the artboard.
 */
export function referencePosterAt(
  piece: Piece,
  opts: PosterOptions,
  scale: number,
  width: number,
  height: number,
  doc: PosterDoc | undefined = piece.poster,
  offset?: { x: number; y: number },
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const compiled = compile(piece);
  drawPosterLayout(g, compiled, posterLayoutOf(piece, opts, compiled, doc), scale, offset);
  return g.getImageData(0, 0, width, height);
}
