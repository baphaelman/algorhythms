/**
 * Posters (PLAN.md §12 "Poster export", §15 M14): the piece drawn as if it had finished (t =
 * duration: every line at full opacity, no ghost, no heads or playhead, no editor overlays). Sizes,
 * the poster style, rows and the title block's text; `drawPosterLayout` draws what
 * `layoutPoster` (poster-layout.ts) laid out, as a PNG on an OffscreenCanvas or an SVG on
 * `SvgContext`. DOM-free apart from the context it is handed.
 */

import type { CompiledScore, LineColors } from '../core/types';
import { MIN_WINDOW, pitchExtentIn } from './camera';
import { fillBackground } from './background';
import { drawScore, drawVignette, type Ctx2D } from './draw';
import { PLAYER_LOOK, lookStyle, type Look } from './look';
import type { CameraState, MomentLabels, MomentTimes, ScoreStyle } from './types';
import type { LayerLayout, PosterLayout, PosterObject } from './poster-layout';
import { barSeconds, isWholeSpan, sectionText, type TimeSpan } from './section';
import { videoCamera, videoSpan } from './video';

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
 * The whole-piece camera (the video's Whole) with the score's fitted pitch range; with a
 * section, the section fitted, its pitch range fitted to the lines sounding in it unless
 * `pieceRange`.
 */
export function posterCamera(
  compiled: CompiledScore,
  pitchRange?: [number, number],
  section?: TimeSpan,
  pieceRange = false,
): CameraState {
  const o: { aspect: '16:9'; pitchRange?: [number, number]; section?: TimeSpan } = {
    aspect: '16:9',
  };
  const span = posterSpan(compiled, section);
  if (span) o.section = span;
  if (pitchRange) o.pitchRange = pitchRange;
  else if (span && !pieceRange) o.pitchRange = pitchExtentIn(compiled, span.start, span.end);
  return videoCamera('whole', compiled, compiled.duration, o);
}

/** A poster's section clipped to the piece; undefined for none or the whole piece. */
export function posterSpan(compiled: CompiledScore, section?: TimeSpan): TimeSpan | undefined {
  if (!section) return undefined;
  const span = videoSpan(compiled.duration, section);
  return isWholeSpan(span, compiled.duration) || !(span.end > span.start) ? undefined : span;
}

export interface PosterStyleOptions {
  /**
   * The export Look (§12 "Export look"); replaces theme, thickness, transparent and colors
   * below. Its future, playhead and heads are ignored (the finished piece); its HUD is drawn as
   * at the piece's end.
   */
  look?: Look;
  theme: 'light' | 'dark';
  /** Weight as thickness, strands and ropes. @default true */
  thickness?: boolean;
  /** No background fill. @default false */
  transparent?: boolean;
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
  return style;
}

/** Most rows a poster takes. */
export const POSTER_MAX_ROWS = 8;

/** One row of a poster: the time it shows. */
export interface PosterRow {
  start: number;
  end: number;
}

/**
 * [start, end] (the piece, or a section of it) cut into `rows` rows of equal length; with a bar
 * grid, each break moves to the nearest bar line of the piece (unless that would leave a row
 * empty or reorder breaks: then no break snaps). The rows cover [start, end] with no gaps or
 * overlaps.
 */
export function posterRows(
  end: number,
  rows: number,
  grid?: { bpm: number; meter?: number },
  start = 0,
): PosterRow[] {
  const D = Math.max(0, Number.isFinite(end) ? end : 0);
  const A = Math.min(D, Math.max(0, Number.isFinite(start) ? start : 0));
  const n = Number.isFinite(rows) ? Math.min(POSTER_MAX_ROWS, Math.max(1, Math.round(rows))) : 1;
  if (n === 1 || !(D > A)) return [{ start: A, end: D }];
  const even: number[] = [];
  for (let k = 1; k < n; k++) even.push(A + (k * (D - A)) / n);
  let breaks = even;
  const bar = barSeconds(grid);
  if (bar > 0) {
    const snapped = even.map((b) => Math.round(b / bar) * bar);
    const eps = 1e-9;
    let ok = true;
    for (let k = 0; k < snapped.length; k++) {
      const prev = k === 0 ? A : snapped[k - 1];
      if (!(snapped[k] > prev + eps) || !(snapped[k] < D - eps)) ok = false;
    }
    if (ok) breaks = snapped;
  }
  const out: PosterRow[] = [];
  let a = A;
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

/**
 * The title block's second line: "2:28 · A minor", or with a section its length and times,
 * "0:45 · 0:45–1:30 of 2:28 · A minor".
 */
export function posterMeta(duration: number, key: string, section?: TimeSpan): string {
  if (!section) return `${posterLength(duration)} · ${key}`;
  const len = posterLength(section.end - section.start);
  return `${len} · ${sectionText(section, duration)} · ${key}`;
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

// ---------------------------------------------------------------------------------------------
// The poster workspace's drawing (§15 M14): exactly what `layoutPoster` laid out
// ---------------------------------------------------------------------------------------------

/**
 * Draws a laid-out poster (poster-layout.ts) on a context whose canvas is `layout.width ×
 * layout.height` px, or `scale` times that (the artboard on screen). Back to front: the
 * background, the guide, beat and marker lines, each layer's rows (one `drawScore` frame per row,
 * so a stretched layer keeps its line widths), the vignette, the labels and the text boxes. PNG
 * (OffscreenCanvas) and SVG (`SvgContext` through `asCtx2D`) alike.
 */
export function drawPosterLayout(
  ctx: Ctx2D,
  compiled: CompiledScore,
  layout: PosterLayout,
  scale = 1,
): void {
  const g = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  const { width: W, height: H, unit: u, style } = layout;
  resetContext(ctx);
  ctx.clearRect(0, 0, Math.ceil(W * scale), Math.ceil(H * scale));
  g.setTransform(scale, 0, 0, scale, 0, 0);
  fillBackground(g, style.tokens.paper, style.paint, W, H);
  let k = 0;
  const objs = layout.objects;
  for (; k < objs.length && objs[k].type === 'line'; k++) drawObject(g, objs[k]);
  const dpr = u * scale;
  // Every part's glow under every part's lines, as the video draws it.
  const passes: ('glow' | 'lines')[] = style.glow ? ['glow', 'lines'] : ['lines'];
  for (const pass of passes)
    for (const L of layout.layers) {
      if (L.hidden || L.voices.length === 0) continue;
      const ls = { ...layerStyle(layout, L), pass };
      for (const f of L.frames) {
        const row = layout.rows[f.row];
        if (!(f.rect.w > 0 && f.rect.h > 0)) continue;
        // A row shorter than the shortest camera window is drawn wider and clipped to its frame.
        const len = Math.max(1e-9, row.end - row.start);
        const wide = Math.max(1, MIN_WINDOW / len);
        if (wide > 1) {
          g.save();
          g.setTransform(scale, 0, 0, scale, 0, 0);
          g.beginPath();
          g.rect(f.rect.x, f.rect.y, f.rect.w, f.rect.h);
          g.clip();
        }
        drawScore(
          ctx,
          compiled,
          { start: row.start, window: len * wide, pitchRange: layout.pitchRange, free: true },
          ls,
          compiled.duration,
          { width: (f.rect.w * wide) / u, height: f.rect.h / u },
          dpr,
          { x: f.rect.x / u, y: f.rect.y / u },
        );
        if (wide > 1) g.restore();
      }
    }
  resetContext(ctx);
  g.setTransform(scale, 0, 0, scale, 0, 0);
  if (style.vignette) drawVignette(g, W, H, Math.min(1, style.vignette));
  for (; k < objs.length; k++) if (objs[k].type !== 'layer') drawObject(g, objs[k]);
  g.globalAlpha = 1;
  g.textAlign = 'left';
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}

/**
 * The ScoreStyle layer `L` draws its lines with: the music's style, its voices only, the layers'
 * colours, nothing but the lines (the poster draws guides, markers and labels itself), the plot
 * filling the frame.
 */
export function layerStyle(layout: PosterLayout, L: LayerLayout): ScoreStyle {
  const s: ScoreStyle = {
    ...layout.style,
    tokens: { ...layout.style.tokens, paper: 'transparent' },
    hud: false,
    guides: false,
    markers: false,
    sections: false,
    sectionLines: false,
    voices: new Set(L.voices),
    pads: { top: 0, bottom: 0 },
  };
  delete s.bars;
  delete s.pitchGuides;
  delete s.vignette;
  delete s.reserveHud;
  delete s.hudExtra;
  delete s.hudLayout;
  const own = L.colour;
  const vc = layout.voiceColors;
  if (own || vc)
    s.voiceColors = L.voices.reduce<(string | undefined)[]>((a, v) => {
      a[v] = (L.kind === 'line' ? own : undefined) ?? vc?.[v] ?? own;
      return a;
    }, []);
  if (s.paint?.background) {
    const paint = { ...s.paint };
    delete paint.background;
    s.paint = paint;
  }
  return s;
}

/** Draws one line, label or text object of a layout (layers draw through `drawScore`). */
export function drawObject(
  g: CanvasRenderingContext2D & { letterSpacing?: string },
  o: PosterObject,
): void {
  if (o.type === 'layer') return;
  if (o.type === 'line') {
    g.globalAlpha = o.opacity;
    g.strokeStyle = o.colour;
    g.lineWidth = o.width;
    g.lineCap = 'butt';
    g.setLineDash(o.dash ? [...o.dash] : []);
    g.beginPath();
    g.moveTo(o.x0, o.y0);
    g.lineTo(o.x1, o.y1);
    g.stroke();
    g.setLineDash([]);
    return;
  }
  g.globalAlpha = o.opacity;
  g.fillStyle = o.colour;
  g.font = o.font;
  g.textAlign = o.align;
  g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) g.letterSpacing = `${o.spacing}px`;
  for (const r of o.runs) g.fillText(r.text, r.x, r.y);
}
