/**
 * Poster frames (PLAN.md §12 "Poster export", revision 12): the whole piece drawn by `drawScore`
 * as if it had finished (t = duration: every line at full opacity, no ghost, no heads or
 * playhead, no editor overlays), with an optional title block. The same call draws a PNG on an
 * OffscreenCanvas and an SVG on `SvgContext`. DOM-free apart from the context it is handed.
 *
 * Title block: in the bottom band the HUD would use (`ScoreStyle.reserveHud`), below the plot and
 * the section markers' ends, so it never covers a line. The piece's name (HUD mono, 500 14 px,
 * ink) over "m:ss · key" (10.5 px, secondary ink) at the left inset, and "AlgoRhythms" (9.5 px,
 * secondary ink) right-aligned on the second line's baseline; the block is centred vertically in
 * the band.
 */

import { keyAt } from '../core/query';
import type { CompiledScore, Key, LineColors } from '../core/types';
import { DEFAULT_MONO, drawScore, keyName, type Ctx2D } from './draw';
import { tokensOf } from './palettes';
import type { CameraState, MomentLabels, MomentTimes, ScoreStyle, View } from './types';
import { videoCamera } from './video';

export type PosterSize = '16:9' | '1:1' | 'a4';

/** Output pixels: 16:9 3840×2160, 1:1 2160×2160, A4 portrait at 300 dpi 2480×3508. */
export function posterSize(kind: PosterSize): { width: number; height: number } {
  if (kind === '16:9') return { width: 3840, height: 2160 };
  if (kind === '1:1') return { width: 2160, height: 2160 };
  return { width: 2480, height: 3508 };
}

/**
 * Pixel ratio of every poster size: the 16:9 poster is the video's 853×480 layout at 4.5× (twice
 * its 1080p ratio), so type, dots and lines keep the player's proportions. One ratio for all
 * sizes keeps 10 px type at 45 px (about 11 pt on A4 at 300 dpi).
 */
export const POSTER_DPR = 4.5;

/** The layout size (CSS-like px) and pixel ratio `drawScore` is called with. */
export function posterLayout(kind: PosterSize): { width: number; height: number; dpr: number } {
  const p = posterSize(kind);
  return { width: p.width / POSTER_DPR, height: p.height / POSTER_DPR, dpr: POSTER_DPR };
}

/** The whole-piece camera (the video's Whole) with the score's fitted pitch range. */
export function posterCamera(compiled: CompiledScore, pitchRange?: [number, number]): CameraState {
  const o: { aspect: '16:9'; pitchRange?: [number, number] } = { aspect: '16:9' };
  if (pitchRange) o.pitchRange = pitchRange;
  return videoCamera('whole', compiled, compiled.duration, o);
}

export interface PosterStyleOptions {
  theme: 'light' | 'dark';
  /** Weight as thickness, strands and ropes. @default true */
  thickness?: boolean;
  /** No background fill. @default false */
  transparent?: boolean;
  /** Leave the bottom band for the title block. @default false */
  title?: boolean;
  /** @default 'pitch' */
  colors?: LineColors;
  /** @default true */
  oklch?: boolean;
  customColors?: readonly (string | undefined)[];
  /** Section labels and marker times as the player shows them (`videoMarkers`). */
  labels?: MomentLabels;
  markerTimes?: MomentTimes;
  fontMono?: string;
}

/** The poster's ScoreStyle: finished (no ghost, heads, playhead or HUD), section labels on. */
export function posterStyle(o: PosterStyleOptions): ScoreStyle {
  const base = tokensOf(o.theme);
  const style: ScoreStyle = {
    tokens: o.transparent ? { ...base, paper: 'transparent' } : base,
    dark: o.theme === 'dark',
    colors: o.colors ?? 'pitch',
    oklch: o.oklch ?? true,
    futureOpacity: 1,
    hud: false,
    heads: false,
    playhead: false,
    thickness: o.thickness ?? true,
  };
  if (o.title) style.reserveHud = true;
  if (o.customColors) style.customColors = o.customColors;
  if (o.labels) style.labels = o.labels;
  if (o.markerTimes) style.markerTimes = o.markerTimes;
  if (o.fontMono) style.fontMono = o.fontMono;
  return style;
}

/** What the title block shows besides the score. */
export interface PosterInfo {
  /** The piece's name; empty shows "Untitled". */
  name: string;
  /** Default: the score's key at 0. */
  key?: Key;
}

export interface PosterDrawOptions {
  size: PosterSize;
  /** From `posterStyle` (its `title` must match `title` here). */
  style: ScoreStyle;
  /** Draw the title block. */
  title: boolean;
  pitchRange?: [number, number];
}

/** `m:ss` of a duration, rounded to the second. */
export function posterLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The credit in the title block. */
export const POSTER_CREDIT = 'AlgoRhythms';

/**
 * Resets the context to a fresh canvas's state. drawScore inherits line cap, dash, text align
 * and more from whatever was drawn before (build log M8-b), so a poster on a used context would
 * differ from one on a new canvas.
 */
export function resetContext(ctx: Ctx2D): void {
  const g = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000000';
  g.strokeStyle = '#000000';
  g.lineWidth = 1;
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  g.miterLimit = 10;
  g.setLineDash([]);
  g.lineDashOffset = 0;
  g.font = '10px sans-serif';
  g.textAlign = 'start';
  g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}

/**
 * Clears and draws the poster on a context whose canvas is `posterSize(size)` pixels (a canvas,
 * an OffscreenCanvas or an `SvgContext` through `asCtx2D`). Returns the score's view.
 */
export function drawPoster(
  ctx: Ctx2D,
  compiled: CompiledScore,
  info: PosterInfo,
  opts: PosterDrawOptions,
): View {
  const { width, height, dpr } = posterLayout(opts.size);
  const px = posterSize(opts.size);
  resetContext(ctx);
  ctx.clearRect(0, 0, px.width, px.height);
  const style =
    (opts.style.reserveHud === true) === opts.title
      ? opts.style
      : { ...opts.style, reserveHud: opts.title };
  const cam = posterCamera(compiled, opts.pitchRange);
  const view = drawScore(ctx, compiled, cam, style, compiled.duration, { width, height }, dpr);
  if (opts.title) drawTitleBlock(ctx, compiled, info, style, view);
  return view;
}

/** Line heights of the title block, layout px. */
const NAME_PX = 14;
const META_PX = 10.5;
const CREDIT_PX = 9.5;
const META_GAP = 17;

/** The title block in the band below the plot (see the file comment). */
export function drawTitleBlock(
  ctx: Ctx2D,
  compiled: CompiledScore,
  info: PosterInfo,
  style: ScoreStyle,
  view: View,
): void {
  const g = ctx as CanvasRenderingContext2D;
  const MONO = style.fontMono ?? DEFAULT_MONO;
  const C = style.tokens;
  const { width: W, height: H, padB, padL, padR } = view;
  // The band starts below the section markers (they end 6 px under the plot).
  const top = H - padB + 6;
  const block = NAME_PX + META_GAP;
  const y1 = top + Math.max(4, (H - top - block) / 2) + NAME_PX * 0.75;
  const y2 = y1 + META_GAP;
  g.globalAlpha = 1;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';

  g.font = `500 ${NAME_PX}px ${MONO}`;
  g.fillStyle = C.ink;
  g.fillText(fitText(g, info.name.trim() || 'Untitled', W - padL - padR), padL, y1);

  g.font = `${META_PX}px ${MONO}`;
  g.fillStyle = C.ink2;
  const key = info.key ?? keyAt(compiled, 0);
  g.fillText(`${posterLength(compiled.duration)} · ${keyName(key)}`, padL, y2);

  g.font = `${CREDIT_PX}px ${MONO}`;
  g.textAlign = 'right';
  g.fillText(POSTER_CREDIT, W - padR, y2);
  g.textAlign = 'left';
}

/** `text`, cut with an ellipsis to fit `max` px in the current font. */
function fitText(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(chars.slice(0, mid).join('').trimEnd() + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + '…';
}
