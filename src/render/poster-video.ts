/**
 * Play the poster (PLAN.md §15 M15): the video as a window over the poster's layout.
 *
 * - **Frames.** `pieceVideoFrame`: Over the poster (`poster`) when the piece has a poster, else
 *   One row (`row`, today's video). A frame on the poster is a `Rect` in artboard px whose
 *   aspect is the video's.
 * - **Camera** (`posterCameraAt`, pure in t). Follow keeps the playhead's slice in frame row by
 *   row: the frame is one row's slot high (`window` absent) or `window` seconds wide (never
 *   shorter than the slice), the slice at `followAt` across it, held inside the row's ends and
 *   the artboard. The main group's rows lead; a moved layer lights up in its own place. Row
 *   breaks: a pan (smootherstep) or a scroll (constant speed) over `ROW_BREAK` s that lands as
 *   the next row starts, or a cut. Whole fits the poster; Keys ease between frames stored in
 *   poster space (centre linearly, height geometrically).
 * - **Drawing** (`drawPosterFrame`). The poster drawn through the frame: its background (the
 *   background's colour past the artboard's edges), guide, beat and marker lines, each layer's
 *   rows (`drawScore` cropped to what the frame shows, so line widths and the ghost layer stay
 *   as on the poster), the playhead's slice, the vignette (the frame's), then labels and text
 *   boxes. The video's Look sets what's ahead of the playhead: hidden (the poster draws itself,
 *   time-anchored lines and labels included), dimmed or full. Objects that travel (HUD readouts
 *   by default, text boxes switched on) are drawn in the frame at their place across the poster,
 *   at the video's type size; HUD readouts show the playing time's values. The end card is the
 *   finished poster, fitted.
 */

import { bezierOf, ease, easeCodeOf } from '../core/ease';
import type {
  CameraFrame,
  CompiledScore,
  EaseRef,
  Piece,
  PosterCameraKey,
  RowBreak,
  Seconds,
} from '../core/types';
import { backgroundColour, fillBackground } from './background';
import { MIN_WINDOW, SMOOTH_X, cameraAt, cameraScore } from './camera';
import { DEFAULT_KEY_EASE } from './camera-path';
import { DEFAULT_SERIF } from './video';
import { drawScore, drawVignette, type Ctx2D } from './draw';
import { hudText } from './hud';
import { drawObject, layerStyle, resetContext } from './poster';
import { posterTimeAt } from './poster-edit';
import {
  POSTER_ROW_GAP,
  intersects,
  type LabelObject,
  type PosterLayout,
  type PosterObject,
  type Rect,
  type RowLayout,
  type TextObject,
} from './poster-layout';
import type { HudItem, ScoreStyle, View } from './types';
import {
  VIDEO_RATIO,
  videoLayout,
  videoSize,
  videoWindow,
  type VideoAspect,
  type VideoCameraMode,
  type VideoFrameOptions,
} from './video';

/** The frame a piece's video shows (absent: Over the poster when it has a poster, else One row). */
export function pieceVideoFrame(piece: Pick<Piece, 'camera' | 'poster'>): CameraFrame {
  const f = piece.camera?.frame;
  if (f === 'poster' || f === 'row') return f;
  return piece.poster ? 'poster' : 'row';
}

/** A piece's row-break transition (absent: a pan). */
export function pieceRowBreak(piece: Pick<Piece, 'camera'>): RowBreak {
  const b = piece.camera?.rowBreak;
  return b === 'scroll' || b === 'cut' ? b : 'pan';
}

// ---------------------------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------------------------

export interface PosterCameraOptions {
  aspect: VideoAspect;
  /** `auto` plays as `follow`; `keys` without keys as `follow`. */
  mode: VideoCameraMode;
  /** Follow: seconds shown, as seen at 16:9 (`videoWindow`); absent = one row's height. */
  window?: Seconds;
  /** Follow: the playhead's place across the frame, 0..1. @default 0.35 */
  followAt?: number;
  /** @default 'pan' */
  rowBreak?: RowBreak;
  /** `keys`: the frames in poster space, sorted by `at`. */
  keys?: readonly PosterCameraKey[];
}

/** A row break's pan or scroll, s (at most `BREAK_SHARE` of the row it leaves). */
export const ROW_BREAK = 1.5;
const BREAK_SHARE = 0.4;

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const fin = (x: number | undefined, d: number): number =>
  x !== undefined && Number.isFinite(x) ? x : d;

/** The frame at `aspect` (width / height) that fits the whole artboard, centred. */
export function posterWholeFrame(layout: PosterLayout, aspect: VideoAspect): Rect {
  const r = VIDEO_RATIO[aspect];
  const { width: W, height: H } = layout;
  if (W / H > r) {
    const h = W / r;
    return { x: 0, y: (H - h) / 2, w: W, h };
  }
  const w = H * r;
  return { x: (W - w) / 2, y: 0, w, h: H };
}

/** The row showing t (clamped to the poster's span; a break belongs to the later row). */
export function posterRowAt(layout: PosterLayout, t: Seconds): number {
  const rows = layout.rows;
  for (let i = rows.length - 1; i > 0; i--) if (t >= rows[i].start) return i;
  return 0;
}

/** Follow's frame size on the poster (artboard px). */
function followSize(layout: PosterLayout, opts: PosterCameraOptions): { w: number; h: number } {
  const r = VIDEO_RATIO[opts.aspect];
  const gap = POSTER_ROW_GAP * layout.unit;
  let slot = 0;
  let plot = 0;
  let pps = 0;
  for (const row of layout.rows) {
    slot = Math.max(slot, row.rect.h + gap);
    plot = Math.max(plot, row.plot.h + 2 * layout.unit);
    const len = row.end - row.start;
    if (len > 0) pps = Math.max(pps, row.plot.w / len);
  }
  let h = slot;
  const win = opts.window;
  if (win !== undefined && Number.isFinite(win) && win > 0 && pps > 0)
    h = Math.max(plot, (videoWindow(win, opts.aspect) * pps) / r);
  h = Math.min(h, posterWholeFrame(layout, opts.aspect).h);
  return { w: h * r, h };
}

/** `v` held in [lo, hi] (centred between them when hi < lo). */
const hold = (v: number, lo: number, hi: number): number =>
  hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));

/** Follow's frame on row `row` at time t. */
function followFrame(
  layout: PosterLayout,
  row: RowLayout,
  t: Seconds,
  size: { w: number; h: number },
  place: number,
): Rect {
  const { w, h } = size;
  const f = clamp01((t - row.start) / Math.max(1e-9, row.end - row.start));
  const sx = row.plot.x + f * row.plot.w;
  const pad = layout.margins.left / 2;
  let x = hold(sx - place * w, row.rect.x - pad, row.rect.x + row.rect.w + pad - w);
  x = hold(x, 0, layout.width - w);
  const y = hold(row.rect.y + row.rect.h / 2 - h / 2, 0, layout.height - h);
  return { x, y, w, h };
}

function lerpRect(a: Rect, b: Rect, e: number): Rect {
  return {
    x: a.x + (b.x - a.x) * e,
    y: a.y + (b.y - a.y) * e,
    w: a.w + (b.w - a.w) * e,
    h: a.h + (b.h - a.h) * e,
  };
}

/** The frame on the poster (artboard px) the video shows at time t (see the module comment). */
export function posterCameraAt(layout: PosterLayout, t: Seconds, opts: PosterCameraOptions): Rect {
  if (opts.mode === 'whole') return posterWholeFrame(layout, opts.aspect);
  if (opts.mode === 'keys' && opts.keys && opts.keys.length > 0) {
    const pose = posterPoseAt(opts.keys, t);
    if (pose) return posterKeyFrame(layout, pose, opts.aspect);
  }
  const rows = layout.rows;
  if (rows.length === 0) return posterWholeFrame(layout, opts.aspect);
  const last = rows.length - 1;
  const tc = Math.min(rows[last].end, Math.max(rows[0].start, t));
  const i = posterRowAt(layout, tc);
  const size = followSize(layout, opts);
  const place = clamp01(fin(opts.followAt, SMOOTH_X));
  const a = followFrame(layout, rows[i], tc, size, place);
  const brk = opts.rowBreak ?? 'pan';
  if (i === last || brk === 'cut') return a;
  const T = rows[i + 1].start;
  const d = Math.min(ROW_BREAK, BREAK_SHARE * (rows[i].end - rows[i].start));
  if (!(d > 0) || tc <= T - d) return a;
  const b = followFrame(layout, rows[i + 1], T, size, place);
  const x = clamp01((tc - (T - d)) / d);
  return lerpRect(a, b, brk === 'scroll' ? x : ease(easeCodeOf('smootherstep'), x));
}

/** A key's frame: centre and height as fractions of the artboard. */
export type PosterPose = Pick<PosterCameraKey, 'x' | 'y' | 'h'>;

/** The pose at time t: eased between the keys around t, held outside them; null without keys. */
export function posterPoseAt(keys: readonly PosterCameraKey[], t: Seconds): PosterPose | null {
  if (keys.length === 0) return null;
  const pose = (k: PosterCameraKey): PosterPose => ({
    x: fin(k.x, 0.5),
    y: fin(k.y, 0.5),
    h: Math.max(1e-3, fin(k.h, 1)),
  });
  let i = -1;
  for (let j = 0; j < keys.length && keys[j].at <= t; j++) i = j;
  if (i < 0) return pose(keys[0]);
  if (i >= keys.length - 1) return pose(keys[keys.length - 1]);
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const a = pose(k0);
  const b = pose(k1);
  const span = k1.at - k0.at;
  if (!(span > 0)) return b;
  const ref = k0.ease ?? DEFAULT_KEY_EASE;
  const e = ease(easeCodeOf(ref), clamp01((t - k0.at) / span), bezierOf(ref));
  return {
    x: a.x + (b.x - a.x) * e,
    y: a.y + (b.y - a.y) * e,
    h: Math.exp(Math.log(a.h) + (Math.log(b.h) - Math.log(a.h)) * e),
  };
}

/** The frame a key holds at `aspect` (artboard px). */
export function posterKeyFrame(layout: PosterLayout, key: PosterPose, aspect: VideoAspect): Rect {
  const h = key.h * layout.height;
  const w = h * VIDEO_RATIO[aspect];
  return { x: key.x * layout.width - w / 2, y: key.y * layout.height - h / 2, w, h };
}

/** A key from a frame on the poster (artboard px) at time t: its centre and height. */
export function posterKeyOfFrame(
  layout: PosterLayout,
  frame: Rect,
  t: Seconds,
  easeRef?: EaseRef,
): PosterCameraKey {
  const k: PosterCameraKey = {
    at: t,
    x: (frame.x + frame.w / 2) / layout.width,
    y: (frame.y + frame.h / 2) / layout.height,
    h: frame.h / layout.height,
  };
  if (easeRef !== undefined) k.ease = easeRef;
  return k;
}

/** The camera options of a video's frame options. */
export function posterCameraOptions(opts: VideoFrameOptions): PosterCameraOptions {
  const o: PosterCameraOptions = { aspect: opts.aspect, mode: opts.camera };
  if (opts.window !== undefined) o.window = opts.window;
  if (opts.followAt !== undefined) o.followAt = opts.followAt;
  if (opts.rowBreak) o.rowBreak = opts.rowBreak;
  if (opts.posterKeys) o.keys = opts.posterKeys;
  return o;
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

type G = CanvasRenderingContext2D & { letterSpacing?: string };

/** What a frame draws: the playing time's state, or the finished poster (the end card). */
interface FrameState {
  t: Seconds;
  finished: boolean;
  futureOpacity: number;
  aheadHidden: boolean;
  heads: boolean;
  playhead: boolean;
}

/** The time a line or label stands for, when it stands for one (markers and beats). */
function timeOf(layout: PosterLayout, o: PosterObject): number | undefined {
  switch (o.group) {
    case 'sectionLines':
    case 'momentLines':
    case 'sectionLabels':
    case 'momentLabels':
      return layout.style.markerTimes?.[o.member];
    case 'beatLines': {
      const t = Number(o.member);
      return Number.isFinite(t) ? t : undefined;
    }
    default:
      return undefined;
  }
}

/** Ahead of the playhead with the future hidden: not drawn yet. */
function ahead(layout: PosterLayout, o: PosterObject, st: FrameState): boolean {
  if (!st.aheadHidden) return false;
  const at = timeOf(layout, o);
  return at !== undefined && at > st.t + 1e-9;
}

/** The paper a video draws the poster on (a transparent poster's is the video's). */
function paperOf(layout: PosterLayout, style: ScoreStyle): string {
  const p = layout.style.tokens.paper;
  return p === 'transparent' ? style.tokens.paper : p;
}

/**
 * Draws one layer's row through the frame: `drawScore` over just the times the frame shows (plus
 * a margin for caps and heads), placed at the poster's scale `k` (canvas px per artboard px), its
 * strokes, heads and labels at `d` canvas px per unit.
 */
function drawRowCrop(
  g: G,
  compiled: CompiledScore,
  layout: PosterLayout,
  row: RowLayout,
  rect: Rect,
  F: Rect,
  k: number,
  style: ScoreStyle,
  t: Seconds,
  ch: number,
  d: number,
): void {
  const len = Math.max(1e-9, row.end - row.start);
  const m = (16 * d) / k;
  // With a dimmed future, crop edges on whole device px so the ghost layer composites crisply.
  const ghost = style.futureOpacity > 0.01 && style.futureOpacity < 1;
  const snapX = (x: number): number => (ghost ? F.x + Math.round((x - F.x) * k) / k : x);
  const xa = snapX(Math.max(rect.x, F.x - m));
  const xb = Math.min(rect.x + rect.w, F.x + F.w + m);
  if (!(xb > xa)) return;
  const ta = row.start + ((xa - rect.x) / rect.w) * len;
  const tb = row.start + ((xb - rect.x) / rect.w) * len;
  const win = tb - ta;
  const wide = Math.max(1, MIN_WINDOW / win);
  const oy = ghost ? F.y + Math.round((rect.y - F.y) * k) / k : rect.y;
  if (wide > 1) {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    g.rect((xa - F.x) * k, 0, (xb - xa) * k, ch);
    g.clip();
  }
  const c = k / d;
  drawScore(
    g,
    compiled,
    { start: ta, window: win * wide, pitchRange: layout.pitchRange, free: true },
    style,
    t,
    { width: (xb - xa) * wide * c, height: rect.h * c },
    d,
    { x: (xa - F.x) * c, y: (oy - F.y) * c },
  );
  if (wide > 1) g.restore();
}

/**
 * Draws a line, label or text box where it is on the poster (`k` canvas px per artboard px), at
 * `kt` ≤ k for its size: a label or text box scaled about its anchor (its aligned edge, its
 * middle for labels), a line's width and dashes thinned.
 */
function drawStaying(g: G, o: PosterObject, F: Rect, k: number, kt: number): void {
  if (o.type === 'layer') return;
  if (kt >= k) {
    g.setTransform(k, 0, 0, k, -F.x * k, -F.y * k);
    drawObject(g, o);
    return;
  }
  const f = kt / k;
  if (o.type === 'line') {
    g.setTransform(k, 0, 0, k, -F.x * k, -F.y * k);
    drawObject(g, { ...o, width: o.width * f, dash: o.dash ? o.dash.map((v) => v * f) : null });
    return;
  }
  const b = o.box;
  const ax = o.align === 'left' ? b.x : o.align === 'right' ? b.x + b.w : b.x + b.w / 2;
  const ay = o.type === 'label' ? b.y + b.h / 2 : b.y;
  g.setTransform(kt, 0, 0, kt, (ax - F.x) * k - ax * kt, (ay - F.y) * k - ay * kt);
  drawObject(g, o);
}

/** A HUD readout with the playing time's value (null when it has none). */
function liveHud(
  g: G,
  compiled: CompiledScore,
  layout: PosterLayout,
  o: LabelObject,
  view: View,
): LabelObject | null {
  const raw = hudText(o.member as HudItem, compiled, view, layout.style);
  if (!raw) return null;
  const text = layout.labels.hud.uppercase ? raw.toUpperCase() : raw;
  g.font = o.font;
  if ('letterSpacing' in g) g.letterSpacing = `${o.spacing}px`;
  const w = g.measureText(text).width;
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  // Readouts right of the centre keep their right edge.
  const right = o.box.x + o.box.w / 2 > layout.width / 2;
  const x = right ? o.box.x + o.box.w - w : o.box.x;
  const run = o.runs[0];
  return {
    ...o,
    runs: [{ text, x: run ? run.x + (x - o.box.x) : x, y: run ? run.y : o.box.y }],
    box: { ...o.box, x, w },
  };
}

/**
 * Draws a travelling object in the frame (canvas px `cw` × `ch`): at the place across the poster
 * of `from` (the poster's own box: its share of the free space, so an object by an edge stays by
 * that edge), one poster unit drawn as `unitPx` canvas px.
 */
function drawTraveller(
  g: G,
  layout: PosterLayout,
  o: LabelObject | TextObject,
  from: Rect,
  cw: number,
  ch: number,
  unitPx: number,
): void {
  const q = unitPx / layout.unit;
  const fx = layout.width > from.w ? clamp01(from.x / (layout.width - from.w)) : 0.5;
  const fy = layout.height > from.h ? clamp01(from.y / (layout.height - from.h)) : 0.5;
  const X = fx * (cw - from.w * q);
  const Y = fy * (ch - from.h * q);
  g.setTransform(q, 0, 0, q, X - from.x * q, Y - from.y * q);
  drawObject(g, o);
}

/** Draws the frame `F` of the poster at state `st` on a canvas `cw` × `ch` px. Returns its view. */
function drawPosterThrough(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  layout: PosterLayout,
  F: Rect,
  st: FrameState,
  scale: number,
): View {
  const g = ctx as G;
  const px = videoSize(opts.aspect, opts.size);
  const lay = videoLayout(opts.aspect, opts.size);
  const cw = Math.ceil(px.width * scale);
  const ch = Math.ceil(px.height * scale);
  const k = (px.width * scale) / F.w;
  const toFrame = (): void => g.setTransform(k, 0, 0, k, -F.x * k, -F.y * k);
  resetContext(ctx);
  ctx.clearRect(0, 0, cw, ch);
  const paper = paperOf(layout, opts.style);
  const paint = layout.style.paint;
  g.fillStyle = backgroundColour(paint?.background, paper);
  g.fillRect(0, 0, cw, ch);
  toFrame();
  fillBackground(g, paper, paint, layout.width, layout.height);

  // Sizes never grow past the video's: zoomed in, strokes and type are drawn at its scale (a
  // poster unit as one layout px of the video), in their places on the poster.
  const unitPx = lay.dpr * scale;
  const d = Math.min(layout.unit * k, unitPx);
  const kt = d / layout.unit;

  // Guide, beat and marker lines.
  const objs = layout.objects;
  const pad = 4 * layout.unit;
  let i = 0;
  for (; i < objs.length && objs[i].type === 'line'; i++) {
    const o = objs[i];
    if (!intersects(o.box, F, pad) || ahead(layout, o, st)) continue;
    drawStaying(g, o, F, k, kt);
  }

  // The music: every layer's glow, then every layer's lines (as the poster).
  const passes: ('glow' | 'lines')[] = layout.style.glow ? ['glow', 'lines'] : ['lines'];
  const rowOf = st.finished ? -1 : posterRowAt(layout, st.t);
  const tDraw = st.finished ? compiled.duration : st.t;
  for (const pass of passes)
    for (const L of layout.layers) {
      if (L.hidden || L.voices.length === 0) continue;
      const base: ScoreStyle = {
        ...layerStyle(layout, L),
        pass,
        futureOpacity: st.futureOpacity,
        playhead: false,
      };
      if (st.aheadHidden) base.aheadHidden = true;
      for (const f of L.frames) {
        const row = layout.rows[f.row];
        if (!row || !(f.rect.w > 0 && f.rect.h > 0) || !intersects(f.rect, F, pad)) continue;
        const style = { ...base, heads: st.heads && f.row === rowOf };
        drawRowCrop(g, compiled, layout, row, f.rect, F, k, style, tDraw, ch, d);
      }
    }

  // The playhead's slice, and a fainter one on each moved layer's own.
  resetContext(ctx);
  if (st.playhead) {
    const at = posterTimeAt(layout, st.t);
    if (at) {
      toFrame();
      g.strokeStyle = layout.style.paint?.playhead ?? layout.style.tokens.rule;
      g.lineWidth = (lay.dpr * scale) / k;
      g.lineCap = 'butt';
      const ext = 2 * layout.unit;
      const line = (x: number, y0: number, y1: number, a: number): void => {
        g.globalAlpha = a;
        g.beginPath();
        g.moveTo(x, y0 - ext);
        g.lineTo(x, y1 + ext);
        g.stroke();
      };
      line(at.x, at.y0, at.y1, 1);
      for (const l of at.layers)
        if (Math.abs(l.x - at.x) > 0.5 || l.y0 < at.y0 - 0.5 || l.y1 > at.y1 + 0.5)
          line(l.x, l.y0, l.y1, 0.5);
      g.globalAlpha = 1;
    }
  }

  // The vignette is the frame's.
  if (layout.style.vignette) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    drawVignette(g, cw, ch, Math.min(1, layout.style.vignette));
  }

  // Labels and text boxes: on the poster, or travelling with the frame.
  const row = layout.rows[Math.max(0, rowOf)];
  const pps = row && row.end > row.start ? row.plot.w / (row.end - row.start) : 1;
  const view = cameraAt(
    cameraScore(compiled),
    {
      start: (row?.start ?? 0) + (F.x - (row?.plot.x ?? 0)) / pps,
      window: F.w / pps,
      pitchRange: layout.pitchRange,
      free: true,
    },
    tDraw,
    { width: lay.width, height: lay.height },
    false,
  );
  for (; i < objs.length; i++) {
    const o = objs[i];
    if (o.type === 'layer' || o.type === 'line') continue;
    if (ahead(layout, o, st)) continue;
    let obj: LabelObject | TextObject | null = o;
    if (o.type === 'label' && o.group === 'hud' && !st.finished) {
      obj = liveHud(g, compiled, layout, o, view);
      if (!obj) continue;
    }
    if (o.travels && !st.finished) {
      drawTraveller(g, layout, obj, o.box, cw, ch, unitPx);
      continue;
    }
    if (!intersects(obj.box, F, pad)) continue;
    drawStaying(g, obj, F, k, kt);
  }
  resetContext(ctx);
  return view;
}

/** The frame's state at time t from the video's style and options. */
function playingState(opts: VideoFrameOptions, t: Seconds): FrameState {
  const s = opts.style;
  return {
    t,
    finished: false,
    futureOpacity: s.futureOpacity,
    aheadHidden: s.aheadHidden === true,
    heads: s.heads !== false,
    playhead: opts.playhead ?? s.playhead !== false,
  };
}

/**
 * Clears and draws the Over-the-poster frame at score time t on a canvas `scale` times
 * `videoSize(aspect, size)` px. Returns a view of the playing row through the frame.
 */
export function drawPosterFrame(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  layout: PosterLayout,
  t: Seconds,
  scale = 1,
): View {
  const F = posterCameraAt(layout, t, posterCameraOptions(opts));
  return drawPosterThrough(ctx, compiled, opts, layout, F, playingState(opts, t), scale);
}

/**
 * Clears and draws the end card of a video over the poster: the finished poster fitted to the
 * frame (as its PNG draws it), and the credit line in the band below it when there is one, else
 * at the frame's foot.
 */
export function drawPosterEndCard(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  layout: PosterLayout,
  scale = 1,
  credit = true,
): View {
  const F = posterWholeFrame(layout, opts.aspect);
  const st: FrameState = {
    t: compiled.duration,
    finished: true,
    futureOpacity: 1,
    aheadHidden: false,
    heads: false,
    playhead: false,
  };
  const view = drawPosterThrough(ctx, compiled, opts, layout, F, st, scale);
  const text = credit ? (opts.bookends?.credit ?? '').trim() : '';
  if (text) {
    const lay = videoLayout(opts.aspect, opts.size);
    const g = ctx as G;
    // The band below the poster, in layout px.
    const band = ((F.y + F.h - layout.height) * lay.height) / F.h;
    g.setTransform(lay.dpr * scale, 0, 0, lay.dpr * scale, 0, 0);
    g.globalAlpha = 1;
    g.font = `italic 12px ${DEFAULT_SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = layout.style.paint?.end ?? layout.style.tokens.ink2;
    const y = band >= 24 ? lay.height - band / 2 + 4 : lay.height - 10;
    g.fillText(text, lay.width / 2, y);
    g.textAlign = 'left';
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// One row with the poster's styles
// ---------------------------------------------------------------------------------------------

const rowVoices = new WeakMap<PosterLayout, ReadonlySet<number> | null>();

/** The voices One row draws: all but those of hidden layers (null when none is hidden). */
function shownVoices(layout: PosterLayout): ReadonlySet<number> | null {
  let v = rowVoices.get(layout);
  if (v === undefined) {
    v = layout.layers.some((L) => L.hidden)
      ? new Set(layout.layers.filter((L) => !L.hidden).flatMap((L) => L.voices))
      : null;
    rowVoices.set(layout, v);
  }
  return v;
}

/** One row's style with the poster's: its hidden layers left out, the playhead switch. */
export function rowStyle(opts: VideoFrameOptions): ScoreStyle {
  const voices = opts.poster ? shownVoices(opts.poster) : null;
  if (!voices && opts.playhead === undefined) return opts.style;
  const s: ScoreStyle = { ...opts.style };
  if (voices) s.voices = voices as Set<number>;
  if (opts.playhead !== undefined) s.playhead = opts.playhead;
  return s;
}

/** One row: the poster's travelling text boxes, in the frame (as Over the poster draws them). */
export function drawRowTravellers(
  ctx: Ctx2D,
  opts: VideoFrameOptions,
  layout: PosterLayout,
  scale = 1,
): void {
  const texts = layout.objects.filter(
    (o): o is TextObject => o.type === 'text' && o.travels === true,
  );
  if (texts.length === 0) return;
  const g = ctx as G;
  const px = videoSize(opts.aspect, opts.size);
  const lay = videoLayout(opts.aspect, opts.size);
  resetContext(ctx);
  for (const o of texts)
    drawTraveller(
      g,
      layout,
      o,
      o.box,
      Math.ceil(px.width * scale),
      Math.ceil(px.height * scale),
      lay.dpr * scale,
    );
  resetContext(ctx);
}
