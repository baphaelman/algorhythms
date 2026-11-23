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
 *
 * Rows (owner, 2026-11-23): the piece cut in time into rows stacked like systems in sheet music
 * (`posterRows`). Each row is a `drawScore` call on its own sub-rectangle (offset by `origin`, no
 * clip), one pitch range and one time scale for all; a row shorter than the longest is drawn
 * narrower, so it ends at its break. The HUD and title block are drawn once, in the bottom band
 * a one-row poster has.
 */

import { keyAt } from '../core/query';
import type { CompiledScore, Key, LineColors } from '../core/types';
import { HUD_ROW, cameraAt, cameraScore, hudLines } from './camera';
import { DEFAULT_MONO, drawScore, hudPlacement, keyName, type Ctx2D } from './draw';
import { drawHud, hudItems, hudRows, hudTop, type HudPlacement } from './hud';
import { PLAYER_LOOK, lookStyle, type Look } from './look';
import type { CameraState, MomentLabels, MomentTimes, ScoreStyle, View } from './types';
import { DEFAULT_METER } from './bars';
import { videoCamera } from './video';

export type PosterSize = '16:9' | '1:1' | 'a4';

/** A poster's pixel size. */
export interface PosterDims {
  width: number;
  height: number;
}

/**
 * Output pixels of a preset: 16:9 3840×2160, 1:1 2160×2160, A4 portrait at 300 dpi 2480×3508.
 * Explicit dimensions pass through.
 */
export function posterSize(kind: PosterSize | PosterDims): PosterDims {
  if (typeof kind === 'object') return { width: kind.width, height: kind.height };
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
export function posterLayout(kind: PosterSize | PosterDims): {
  width: number;
  height: number;
  dpr: number;
} {
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
  /**
   * The export Look (§12 "Export look"); replaces theme, thickness, transparent and colors
   * below. Its future, playhead and heads are ignored (the finished piece); its HUD is drawn as
   * at the piece's end, above the title block.
   */
  look?: Look;
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
  /** With a Look: the piece's tempo and meter (beats) and name (the `title` readout). */
  bpm?: number;
  meter?: number;
  pieceName?: string;
}

/** Room below the HUD rows for the title block when both are on, layout px. */
export const TITLE_EXTRA = 48;

/**
 * The poster's ScoreStyle: finished (no ghost, heads or playhead), section labels on. Without a
 * Look: the player's drawing with no HUD.
 */
export function posterStyle(o: PosterStyleOptions): ScoreStyle {
  const look: Look = o.look ?? {
    ...PLAYER_LOOK,
    theme: o.theme,
    transparent: o.transparent ?? false,
    thickness: o.thickness ?? true,
    colors: o.colors ?? 'pitch',
    hud: [],
  };
  const style = lookStyle(look, {
    oklch: o.oklch ?? true,
    ...(o.customColors ? { customColors: o.customColors } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    ...(o.markerTimes ? { markerTimes: o.markerTimes } : {}),
    ...(o.fontMono ? { fontMono: o.fontMono } : {}),
    ...(o.bpm !== undefined ? { bpm: o.bpm } : {}),
    ...(o.meter !== undefined ? { meter: o.meter } : {}),
    ...(o.pieceName !== undefined ? { pieceName: o.pieceName } : {}),
  });
  style.futureOpacity = 1;
  style.heads = false;
  style.playhead = false;
  delete style.aheadHidden;
  return withTitle(style, o.title === true);
}

/** `style` with the bottom band for the title block (or without it), copied only if it changes. */
function withTitle(style: ScoreStyle, title: boolean): ScoreStyle {
  const extra = title && hudRows(hudItems(style)) > 0 ? TITLE_EXTRA : undefined;
  if ((style.reserveHud === true) === title && style.hudExtra === extra) return style;
  const out: ScoreStyle = { ...style };
  if (title) out.reserveHud = true;
  else delete out.reserveHud;
  if (extra !== undefined) out.hudExtra = extra;
  else delete out.hudExtra;
  return out;
}

/** What the title block shows besides the score. */
export interface PosterInfo {
  /** The piece's name; empty shows "Untitled". */
  name: string;
  /** Default: the score's key at 0. */
  key?: Key;
}

export interface PosterDrawOptions {
  size: PosterSize | PosterDims;
  /** From `posterStyle` (its `title` must match `title` here). */
  style: ScoreStyle;
  /** Draw the title block. */
  title: boolean;
  pitchRange?: [number, number];
  /** Rows the piece is cut into, 1..POSTER_MAX_ROWS. @default 1 */
  rows?: number;
  /** The piece's bar grid (`view.gridBpm`, `view.meter`): row breaks snap to its bar lines. */
  grid?: { bpm: number; meter?: number };
}

/** Most rows a poster takes. */
export const POSTER_MAX_ROWS = 8;
/** Gap between rows, layout px. */
export const ROW_GAP = 8;

/** One row of a poster: the time it shows. */
export interface PosterRow {
  start: number;
  end: number;
}

/**
 * The piece cut into `rows` rows of equal length; with a bar grid, each break moves to the
 * nearest bar line (unless that would leave a row empty or reorder breaks: then no break snaps).
 * The rows cover [0, duration] with no gaps or overlaps.
 */
export function posterRows(
  duration: number,
  rows: number,
  grid?: { bpm: number; meter?: number },
): PosterRow[] {
  const D = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const n = Number.isFinite(rows) ? Math.min(POSTER_MAX_ROWS, Math.max(1, Math.round(rows))) : 1;
  if (n === 1 || !(D > 0)) return [{ start: 0, end: D }];
  const even: number[] = [];
  for (let k = 1; k < n; k++) even.push((k * D) / n);
  let breaks = even;
  const meter =
    grid?.meter !== undefined && Number.isInteger(grid.meter) && grid.meter >= 1
      ? grid.meter
      : DEFAULT_METER;
  const bar = grid && Number.isFinite(grid.bpm) && grid.bpm > 0 ? (60 / grid.bpm) * meter : 0;
  if (bar > 0) {
    const snapped = even.map((b) => Math.round(b / bar) * bar);
    const eps = 1e-9;
    let ok = true;
    for (let k = 0; k < snapped.length; k++) {
      const prev = k === 0 ? 0 : snapped[k - 1];
      if (!(snapped[k] > prev + eps) || !(snapped[k] < D - eps)) ok = false;
    }
    if (ok) breaks = snapped;
  }
  const out: PosterRow[] = [];
  let a = 0;
  for (const b of breaks) {
    out.push({ start: a, end: b });
    a = b;
  }
  out.push({ start: a, end: D });
  return out;
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
 * an OffscreenCanvas or an `SvgContext` through `asCtx2D`), or `scale` times that (the Export
 * dialog's preview: the same picture, smaller). Returns the score's view.
 */
export function drawPoster(
  ctx: Ctx2D,
  compiled: CompiledScore,
  info: PosterInfo,
  opts: PosterDrawOptions,
  scale = 1,
): View {
  const lay = posterLayout(opts.size);
  const { width, height } = lay;
  const dpr = lay.dpr * scale;
  const px = posterSize(opts.size);
  resetContext(ctx);
  ctx.clearRect(0, 0, Math.ceil(px.width * scale), Math.ceil(px.height * scale));
  const style = withTitle(opts.style, opts.title);
  const cam = posterCamera(compiled, opts.pitchRange);
  const rows = posterRows(compiled.duration, opts.rows ?? 1, opts.grid);
  if (rows.length > 1) {
    const view = drawRows(ctx, compiled, cam, style, rows, { width, height }, dpr);
    if (opts.title) drawTitleBlock(ctx, compiled, info, style, view);
    return view;
  }
  const view = drawScore(ctx, compiled, cam, style, compiled.duration, { width, height }, dpr);
  if (opts.title) drawTitleBlock(ctx, compiled, info, style, view);
  return view;
}

/**
 * Where `drawPoster` put each HUD readout (`view` is what it returned): the Export dialog's
 * overlay.
 */
export function posterHudPlacement(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: PosterDrawOptions,
  view: View,
): HudPlacement {
  return hudPlacement(ctx, compiled, withTitle(opts.style, opts.title), view);
}

/** Type of the rows' time labels: the HUD's. */
const ROW_LABEL_PX = 10.5;

/**
 * The rows of a poster (see the file comment). Returns the one-row poster's view, which places
 * the HUD and the title block.
 */
function drawRows(
  ctx: Ctx2D,
  compiled: CompiledScore,
  cam: CameraState,
  style: ScoreStyle,
  rows: readonly PosterRow[],
  size: { width: number; height: number },
  dpr: number,
): View {
  const g = ctx as CanvasRenderingContext2D;
  const { width: W, height: H } = size;
  const items = hudItems(style);
  const hud = hudRows(items);
  const full = cameraAt(
    cameraScore(compiled),
    cam,
    compiled.duration,
    size,
    hud > 0 ? hud : style.reserveHud === true,
    style.hudExtra ?? 0,
  );
  const pitchRange: [number, number] = [full.pLo, full.pHi];
  const band = hud > 0 || style.reserveHud === true ? full.padB : 0;
  const n = rows.length;
  const rowH = Math.max(1, (H - band - ROW_GAP * (n - 1)) / n);
  let span = 0;
  for (const r of rows) span = Math.max(span, r.end - r.start);
  const rowStyle: ScoreStyle = { ...style, hud: false };
  delete rowStyle.reserveHud;
  delete rowStyle.hudExtra;
  const MONO = style.fontMono ?? DEFAULT_MONO;

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = style.tokens.paper;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    // Rows start on whole device pixels.
    const y = Math.round(i * (rowH + ROW_GAP) * dpr) / dpr;
    const len = r.end - r.start;
    const s: ScoreStyle = { ...rowStyle, markerTimes: rowMarkers(compiled, style, r, i === n - 1) };
    const view = drawScore(
      ctx,
      compiled,
      { start: r.start, window: len, pitchRange },
      s,
      compiled.duration,
      { width: (W * len) / span, height: rowH },
      dpr,
      { x: 0, y },
    );
    if (i > 0) {
      g.globalAlpha = 1;
      g.font = `${ROW_LABEL_PX}px ${MONO}`;
      g.fillStyle = style.tokens.ink2;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillText(posterLength(r.start), full.padL, view.padT - 4);
    }
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (hud > 0) drawHud(g, compiled, style, full, MONO, items);
  return full;
}

/**
 * Marker times for one row: the markers in [start, end) (the last row also takes its end) at
 * their times, the rest out of every view (−∞), so a marker on a break shows only in the row it
 * starts.
 */
function rowMarkers(
  compiled: CompiledScore,
  style: ScoreStyle,
  row: PosterRow,
  last: boolean,
): MomentTimes {
  const out: Record<string, number> = {};
  for (const s of compiled.momentSpans) {
    const t = style.markerTimes?.[s.id] ?? s.start;
    out[s.id] = t >= row.start && (t < row.end || (last && t <= row.end)) ? t : -Infinity;
  }
  return out;
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
  // The band starts below the section markers (they end 6 px under the plot), or below the HUD.
  let top = H - padB + 6;
  const rows = hudRows(hudItems(style));
  if (rows > 0) {
    const extra = style.hudExtra ?? 0;
    const lines = hudLines(padB - extra, rows);
    if (lines > 0) top = hudTop(view, lines, extra) + HUD_ROW * (lines - 1) + 8;
  }
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
