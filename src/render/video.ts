/**
 * Video frames (PLAN.md §12 "Video export", revision 11): sizes, a camera that is a pure function
 * of time, the video's `ScoreStyle`, and `drawVideoFrame` for frame k at t = k / fps. No encoding
 * here; DOM-free apart from the context it is handed.
 *
 * Layout scale: a frame is drawn by `drawScore` at a fixed CSS-like layout size (`videoLayout`)
 * with the pixel ratio making up the rest, so the HUD, labels, dots and lines keep the player's
 * proportions and 720p is the same picture as 1080p, only smaller.
 */

import { backgroundColour } from './background';
import type {
  CameraFrame,
  CameraKey,
  CompiledScore,
  LineColors,
  MomentId,
  Piece,
  PosterCameraKey,
  RowBreak,
  Seconds,
} from '../core/types';
import {
  DEFAULT_FUTURE_OPACITY,
  MIN_WINDOW,
  followStart,
  pitchExtent,
  pitchExtentIn,
} from './camera';
import { cameraPathAt } from './camera-path';
import { drawScore, type Ctx2D } from './draw';
import { layerFor } from './layer';
import { DEFAULT_HUD } from './hud';
import { PLAYER_LOOK, lookStyle, type Look } from './look';
import type { PosterLayout } from './poster-layout';
import type { TimeSpan } from './section';
import type { CameraState, MomentLabels, MomentTimes, ScoreStyle, View } from './types';

export type VideoAspect = '16:9' | '9:16' | '1:1';
/** The frame's short side, px (§12: 1440 and 2160 = 4K added in M11). */
export type VideoSize = '720' | '1080' | '1440' | '2160';
/**
 * `keys`: the piece's camera path (`VideoCameraOptions.keys`, M11.5); `auto`: the same, with keys
 * made from the piece (auto-camera.ts; the app's `frameOptions` passes them).
 */
export type VideoCameraMode = 'follow' | 'whole' | 'keys' | 'auto';

/**
 * Output pixel size: the short side is the size class (1080-class 1920×1080, 1080×1920, 1080×1080;
 * 720, 1440 and 2160 likewise).
 */
export function videoSize(aspect: VideoAspect, size: VideoSize): { width: number; height: number } {
  const s = Number(size);
  const long = (s * 16) / 9;
  if (aspect === '16:9') return { width: long, height: s };
  if (aspect === '9:16') return { width: s, height: long };
  return { width: s, height: s };
}

/**
 * Layout width (CSS px) per aspect: 16:9 is drawn as an 853×480 player (2.25× at 1080p), 9:16 as
 * 400×711 (2.7×) and 1:1 as 440×440 (2.45×), so text stays legible on a phone in the narrow ones.
 */
const LAYOUT_W: Record<VideoAspect, number> = { '16:9': 2560 / 3, '9:16': 400, '1:1': 440 };

/** Width / height of each aspect (a camera key's window is measured at 16:9; camera-path.ts). */
export const VIDEO_RATIO: Record<VideoAspect, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
};

/** The layout size and pixel ratio a frame of this aspect and size is drawn at. */
export function videoLayout(
  aspect: VideoAspect,
  size: VideoSize,
): { width: number; height: number; dpr: number } {
  const px = videoSize(aspect, size);
  const dpr = px.width / LAYOUT_W[aspect];
  return { width: px.width / dpr, height: px.height / dpr, dpr };
}

/**
 * Follow window for `aspect`, from the window the user sees at 16:9: the same layout px per
 * second, so a narrower frame shows less time (9:16 ≈ 0.47×, 1:1 ≈ 0.52×), at least MIN_WINDOW.
 */
export function videoWindow(window: Seconds, aspect: VideoAspect): Seconds {
  return Math.max(MIN_WINDOW, (window * LAYOUT_W[aspect]) / LAYOUT_W['16:9']);
}

/**
 * The 16:9-equivalent window (what `videoWindow` and `VideoCameraOptions.window` take) for a
 * frame of `aspect` that shows `shown` seconds; inverse of `videoWindow` above MIN_WINDOW.
 */
export function videoWindowAt16x9(shown: Seconds, aspect: VideoAspect): Seconds {
  return (shown * LAYOUT_W['16:9']) / LAYOUT_W[aspect];
}

export interface VideoCameraOptions {
  aspect: VideoAspect;
  /** Follow: the editor's zoom window (s), as seen at 16:9; scaled by `videoWindow`. */
  window?: Seconds;
  /** Pitch range for the whole video; default the piece's used range, padded (`pitchExtent`). */
  pitchRange?: [number, number];
  /** Follow: the playhead's place across the frame, 0..1. @default SMOOTH_X (0.35) */
  followAt?: number;
  /**
   * The section the video shows (§12 rev 15); absent = the whole piece. Whole fits it; Follow
   * stays inside it, as it stays inside the piece.
   */
  section?: TimeSpan;
  /** `keys`/`auto`: the camera keys (`cameraPathAt`, windows at 16:9); none = Follow. */
  keys?: readonly CameraKey[];
}

/** The span a video shows: its section clipped to the piece, else [0, duration]. */
export function videoSpan(duration: Seconds, section?: TimeSpan): TimeSpan {
  const D = Math.max(0, duration);
  if (!section) return { start: 0, end: D };
  const start = Math.min(Math.max(0, section.start), D);
  return { start, end: Math.min(Math.max(start, section.end), D) };
}

/**
 * The camera at time t, from t alone (no state between frames). Follow: Smooth follow, the
 * playhead at `followAt` (35 %) with `start` in [0, duration − window]. Whole: the piece fitted. The vertical
 * framing is the same for every frame. Keys (and Auto): the camera path at t (`cameraPathAt`
 * at the frame's aspect; the start may be < 0; window and pitch from the keys, a `pitchRange`
 * option ignored); without keys, Follow.
 */
export function videoCamera(
  mode: VideoCameraMode,
  compiled: CompiledScore,
  t: Seconds,
  opts: VideoCameraOptions,
): CameraState {
  if ((mode === 'keys' || mode === 'auto') && opts.keys) {
    const cam = cameraPathAt(opts.keys, t, VIDEO_RATIO[opts.aspect]);
    if (cam) return cam;
  }
  const span = videoSpan(compiled.duration, opts.section);
  const a = span.start;
  const D = Math.max(span.end - a, 1e-6);
  const pitchRange = opts.pitchRange ?? pitchExtent(compiled);
  const whole = Math.max(MIN_WINDOW, D);
  if (mode === 'whole' || opts.window === undefined) return { start: a, window: whole, pitchRange };
  const window = Math.min(whole, videoWindow(opts.window, opts.aspect));
  const tc = Math.min(Math.max(t - a, 0), D);
  const f = opts.followAt;
  if (f === undefined || !Number.isFinite(f)) {
    return { start: a + followStart('smooth', 0, tc, window, D), window, pitchRange };
  }
  const x = Math.min(1, Math.max(0, f));
  const start = Math.min(Math.max(0, D - window), Math.max(0, tc - x * window));
  return { start: a + start, window, pitchRange };
}

export interface VideoStyleOptions {
  /**
   * The export Look (§12 "Export look"); replaces theme, hud, thickness, colors and
   * futureOpacity below. `transparent` is ignored (video has no alpha).
   */
  look?: Look;
  theme: 'light' | 'dark';
  /** @default true */
  hud?: boolean;
  /** Weight drawn as thickness, with strands and ropes; false: equal-width lines. @default true */
  thickness?: boolean;
  /** @default 'pitch' */
  colors?: LineColors;
  /** OKLCH colours (see `supportsOklch`). @default true */
  oklch?: boolean;
  customColors?: readonly (string | undefined)[];
  /** @default DEFAULT_FUTURE_OPACITY (0.35) */
  futureOpacity?: number;
  /** Section labels and marker times, as the player shows them (`videoMarkers`). */
  labels?: MomentLabels;
  markerTimes?: MomentTimes;
  fontMono?: string;
  /** With a Look: the piece's tempo and meter (beats) and name (the `title` readout). */
  bpm?: number;
  meter?: number;
  pieceName?: string;
}

/** The player's section labels (labelled moments) and marker times (`moment.at`) of a piece. */
export function videoMarkers(piece: Pick<Piece, 'moments'>): {
  labels: MomentLabels;
  markerTimes: MomentTimes;
} {
  const labels: Record<MomentId, string> = {};
  const markerTimes: Record<MomentId, Seconds> = {};
  for (const m of piece.moments) {
    if (m.label) labels[m.id] = m.label;
    markerTimes[m.id] = m.at;
  }
  return { labels, markerTimes };
}

/**
 * The video's ScoreStyle: a Look (default: the player's, from the options' theme, hud,
 * thickness, colors and futureOpacity), heads and the canvas playhead on, no editor overlays.
 */
export function videoStyle(o: VideoStyleOptions): ScoreStyle {
  const look: Look = o.look
    ? { ...o.look, transparent: false }
    : {
        ...PLAYER_LOOK,
        theme: o.theme,
        hud: o.hud === false ? [] : DEFAULT_HUD,
        thickness: o.thickness ?? true,
        colors: o.colors ?? 'pitch',
        futureOpacity: o.futureOpacity ?? DEFAULT_FUTURE_OPACITY,
      };
  return lookStyle(look, {
    oklch: o.oklch ?? true,
    ...(o.customColors ? { customColors: o.customColors } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    ...(o.markerTimes ? { markerTimes: o.markerTimes } : {}),
    ...(o.fontMono ? { fontMono: o.fontMono } : {}),
    ...(o.bpm !== undefined ? { bpm: o.bpm } : {}),
    ...(o.meter !== undefined ? { meter: o.meter } : {}),
    ...(o.pieceName !== undefined ? { pieceName: o.pieceName } : {}),
  });
}

/**
 * Frames in a video `durationSeconds` long (the WAV export's length, frames / sample rate):
 * enough to cover it, so the video ends within one frame after the audio. At least 1.
 */
export function videoFrameCount(durationSeconds: Seconds, fps: number): number {
  if (!(durationSeconds > 0) || !(fps > 0)) return 1;
  return Math.max(1, Math.ceil(durationSeconds * fps - 1e-6));
}

/**
 * Score time of frame k: `start` + k / fps, held at `end` (the piece's end, or the section's)
 * through the audio's ring-out (the tail shows the last frame).
 */
export function videoFrameTime(k: number, fps: number, end: Seconds, start: Seconds = 0): Seconds {
  return Math.min(start + k / fps, Math.max(start, end));
}

export interface VideoFrameOptions {
  aspect: VideoAspect;
  size: VideoSize;
  camera: VideoCameraMode;
  /** Follow window as seen at 16:9 (see `videoCamera`). */
  window?: Seconds;
  pitchRange?: [number, number];
  /** Follow: the playhead's place across the frame, 0..1 (see `videoCamera`). */
  followAt?: number;
  /** The section the video shows (see `videoCamera`); frame 0 is its start. */
  section?: TimeSpan;
  /** `keys`/`auto`: the camera keys (see `videoCamera`). */
  keys?: readonly CameraKey[];
  /** From `videoStyle`. */
  style: ScoreStyle;
  /** Opening and ending (§12 "Ready for YouTube"); absent or all off = the video as before. */
  bookends?: VideoBookends;
  /**
   * The whole video's length, s (`videoLength`: lead-in, music and its ring-out, end card), for
   * the fade to black. @default lead-in + the section + the end card
   */
  length?: Seconds;
  /**
   * M15: `poster` = Over the poster (needs `poster`), `row` = One row. Resolve a piece's with
   * `pieceVideoFrame`. @default 'row' (also without `poster`)
   */
  frame?: CameraFrame;
  /** M15, Over the poster: how the frame moves to the next row. @default 'pan' */
  rowBreak?: RowBreak;
  /**
   * M15: the playhead line (Over the poster: the slice through the row). Absent = the style's
   * (the Look's `playhead`).
   */
  playhead?: boolean;
  /**
   * M15: the poster the video plays (`layoutPoster`, built once per export). Over the poster
   * frames it; One row draws with its styles (layer colours and visibility, travelling text).
   */
  poster?: PosterLayout;
  /** M15, Over the poster with camera `keys`: the frames in poster space (none = Follow). */
  posterKeys?: readonly PosterCameraKey[];
}

/**
 * Clears and draws frame k (t = `videoFrameTime(k, fps)`, from the section's start) on a context
 * whose canvas is `videoSize(aspect, size)` pixels. Returns the frame's view.
 */
export function drawVideoFrame(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  k: number,
  fps: number,
): View {
  if (bookendsOn(opts.bookends)) return drawVideoMoment(ctx, compiled, opts, k / fps);
  const span = videoSpan(compiled.duration, opts.section);
  return drawVideoFrameAt(ctx, compiled, opts, videoFrameTime(k, fps, span.end, span.start));
}

/**
 * Clears and draws the frame at score time t (clamped to the section) on a canvas `scale` times
 * `videoSize(aspect, size)` pixels: the same picture, smaller (the Export dialog's preview).
 */
export function drawVideoFrameAt(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  time: Seconds,
  scale = 1,
): View {
  const span = videoSpan(compiled.duration, opts.section);
  const t = Math.min(Math.max(span.start, time), span.end);
  const { width, height, dpr } = videoLayout(opts.aspect, opts.size);
  const cam = videoCamera(opts.camera, compiled, t, opts);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // drawScore leaves some state for the next frame (markers are stroked with the lines' round
  // caps); fixed here so frame k never depends on what was drawn before.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.textAlign = 'left';
  const px = videoSize(opts.aspect, opts.size);
  ctx.clearRect(0, 0, Math.ceil(px.width * scale), Math.ceil(px.height * scale));
  return drawScore(ctx, compiled, cam, opts.style, t, { width, height }, dpr * scale);
}

// ---------------------------------------------------------------------------------------------
// Opening and ending (PLAN.md §12 "Ready for YouTube")
// ---------------------------------------------------------------------------------------------

/**
 * A video's opening and ending. Every field absent or 0 draws the video as before. Times in
 * seconds of the video (τ, from its first frame).
 */
export interface VideoBookends {
  /** Fade in from black over the first `fadeIn` s, 0..3. */
  fadeIn?: Seconds;
  /** The opening frame held, silent, before the music, 0..3 (the audio starts this late). */
  leadIn?: Seconds;
  /** Title card: the title (empty = none) and an optional subtitle, over the picture. */
  title?: { text: string; subtitle?: string };
  /** Fade to black over the last `fadeOut` s, 0..3. */
  fadeOut?: Seconds;
  /** End card, s (0 = off; the dialog offers 5, 10, 20): the whole-piece view after the music. */
  endCard?: Seconds;
  /** The end card's credit line; absent or empty = none. */
  credit?: string;
}

/** The end card's default credit line. */
export const END_CREDIT = 'Made with AlgoRhythms';
/** The end card's crossfade from the last frame, s. */
export const END_FADE = 2;
/** The title card: in at TITLE_AT, fading in TITLE_IN, holding TITLE_HOLD, fading out TITLE_OUT. */
export const TITLE_AT = 0.5;
export const TITLE_IN = 1;
export const TITLE_HOLD = 4;
export const TITLE_OUT = 1;
/** The title card's type (no serif ships with the app: a system serif stack). */
export const DEFAULT_SERIF =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif';
/** Title card type size, layout px (shrunk to fit the frame's width). */
export const TITLE_PX = 34;

const num0 = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);

/** Whether any opening or ending option is on. */
export function bookendsOn(b: VideoBookends | undefined): b is VideoBookends {
  if (!b) return false;
  return (
    num0(b.fadeIn) > 0 ||
    num0(b.leadIn) > 0 ||
    num0(b.fadeOut) > 0 ||
    num0(b.endCard) > 0 ||
    (b.title !== undefined && b.title.text.trim() !== '')
  );
}

/**
 * The video's length, s: the lead-in, then the audio (the section's render, ring-out included),
 * or the end card's end if later (the card starts when the section's music ends).
 */
export function videoLength(
  b: VideoBookends | undefined,
  spanLength: Seconds,
  audioLength: Seconds,
): Seconds {
  const lead = num0(b?.leadIn);
  const card = num0(b?.endCard);
  return Math.max(lead + audioLength, card > 0 ? lead + spanLength + card : 0);
}

/** 0..1 eased (smoothstep) as x goes 0 → 1, clamped. */
function ease(x: number): number {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
}

/** The title card's opacity at video time τ (0 without a title). */
export function titleAlpha(b: VideoBookends | undefined, tau: Seconds): number {
  if (!b?.title || b.title.text.trim() === '') return 0;
  const x = tau - TITLE_AT;
  if (x <= 0) return 0;
  if (x < TITLE_IN) return ease(x / TITLE_IN);
  if (x <= TITLE_IN + TITLE_HOLD) return 1;
  return 1 - ease((x - TITLE_IN - TITLE_HOLD) / TITLE_OUT);
}

/** What a frame at video time τ shows. */
export interface BookendState {
  /** Score time of the picture (the section's start through the lead-in, held at its end). */
  t: Seconds;
  /** Title card opacity. */
  title: number;
  /** The end card's share of the picture (0 none, 1 the card alone). */
  end: number;
  /** Black over everything (the fades). */
  black: number;
}

/**
 * The frame at video time τ: the score time (τ − lead-in from the section's start, clamped to
 * it), the title's opacity, the end card's crossfade (over END_FADE from the section's end), and
 * the fades' black (the stronger of the two).
 */
export function bookendsAt(
  b: VideoBookends | undefined,
  span: TimeSpan,
  tau: Seconds,
  length?: Seconds,
): BookendState {
  const lead = num0(b?.leadIn);
  const music = Math.max(0, span.end - span.start);
  const card = num0(b?.endCard);
  const L = length ?? lead + music + card;
  const t = Math.min(span.end, Math.max(span.start, span.start + tau - lead));
  const end = card > 0 ? ease((tau - lead - music) / END_FADE) : 0;
  const fi = num0(b?.fadeIn);
  const fo = num0(b?.fadeOut);
  const black = Math.max(fi > 0 ? 1 - ease(tau / fi) : 0, fo > 0 ? ease((tau - (L - fo)) / fo) : 0);
  return { t, title: titleAlpha(b, tau), end, black };
}

/**
 * The end card's ScoreStyle: the video's look drawn finished (no ghost, heads, playhead or HUD;
 * the HUD's band kept for the credit line), a section showing only its own markers.
 */
export function endCardStyle(
  style: ScoreStyle,
  compiled: CompiledScore,
  section?: TimeSpan,
): ScoreStyle {
  const s: ScoreStyle = {
    ...style,
    futureOpacity: 1,
    heads: false,
    playhead: false,
    hud: false,
    reserveHud: true,
  };
  delete s.aheadHidden;
  delete s.hudLayout;
  delete s.hudExtra;
  if (section) {
    const out: Record<string, number> = {};
    for (const m of compiled.momentSpans) {
      const t = style.markerTimes?.[m.id] ?? m.start;
      out[m.id] = t >= section.start && t <= section.end ? t : -Infinity;
    }
    s.markerTimes = out;
  }
  return s;
}

/**
 * The whole-piece camera of the end card (the poster's): the section fitted, its pitch range fit
 * to its lines unless the video sets one.
 */
export function endCardCamera(compiled: CompiledScore, opts: VideoFrameOptions): CameraState {
  const span = videoSpan(compiled.duration, opts.section);
  const whole = span.start <= 0 && span.end >= compiled.duration - 1e-9;
  const o: VideoCameraOptions = { aspect: opts.aspect };
  if (!whole) o.section = span;
  if (opts.pitchRange) o.pitchRange = opts.pitchRange;
  else if (!whole) o.pitchRange = pitchExtentIn(compiled, span.start, span.end);
  return videoCamera('whole', compiled, compiled.duration, o);
}

/** A fresh context state for a frame (drawScore inherits some state; see drawVideoFrameAt). */
function freshState(ctx: Ctx2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.textAlign = 'left';
}

/**
 * Clears and draws the end card (the whole-piece view drawn finished, and the credit line) on a
 * canvas `scale` times the video's pixels. `credit` false leaves the credit out (thumbnails).
 */
export function drawEndCard(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  scale = 1,
  credit = true,
): View {
  const { width, height, dpr } = videoLayout(opts.aspect, opts.size);
  const px = videoSize(opts.aspect, opts.size);
  freshState(ctx);
  ctx.clearRect(0, 0, Math.ceil(px.width * scale), Math.ceil(px.height * scale));
  const span = videoSpan(compiled.duration, opts.section);
  const whole = span.start <= 0 && span.end >= compiled.duration - 1e-9;
  const style = endCardStyle(opts.style, compiled, whole ? undefined : span);
  const view = drawScore(
    ctx,
    compiled,
    endCardCamera(compiled, opts),
    style,
    compiled.duration,
    { width, height },
    dpr * scale,
  );
  const text = credit ? (opts.bookends?.credit ?? '').trim() : '';
  if (text) {
    const g = ctx as CanvasRenderingContext2D;
    g.globalAlpha = 1;
    g.font = `italic 12px ${DEFAULT_SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = style.paint?.end ?? style.tokens.ink2;
    g.fillText(text, width / 2, height - Math.max(10, view.padB / 2 - 6));
    g.textAlign = 'left';
  }
  return view;
}

/**
 * The title (and subtitle) centred over the picture at `alpha`, in the serif, on a soft scrim of
 * the background colour so it reads over lines. `size` is the title's type in layout px.
 */
export function drawTitleText(
  ctx: Ctx2D,
  style: ScoreStyle,
  layout: { width: number; height: number },
  dpr: number,
  title: { text: string; subtitle?: string },
  alpha: number,
  size = TITLE_PX,
  at = 0.44,
): void {
  const g = ctx as CanvasRenderingContext2D;
  const { width: W, height: H } = layout;
  const text = title.text.trim();
  if (!text || !(alpha > 0)) return;
  const sub = title.subtitle?.trim() ?? '';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = `500 ${size}px ${DEFAULT_SERIF}`;
  const w = g.measureText(text).width;
  const px = w > W * 0.86 ? (size * W * 0.86) / w : size;
  const subPx = Math.max(9, px * 0.42);
  const y = H * at + px * 0.35;
  // The scrim: the background's colour, strongest behind the text, gone at its edges.
  const paper = backgroundColour(style.paint?.background, style.tokens.paper);
  const cy = H * at + (sub ? subPx * 0.6 : 0);
  const rx = Math.min(W * 0.48, Math.max(w, px * 4) * 0.62);
  g.save();
  g.translate(W / 2, cy);
  g.scale(rx, px * (sub ? 2.4 : 1.9));
  const scrim = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  scrim.addColorStop(0, paper);
  scrim.addColorStop(0.55, paper);
  scrim.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.globalAlpha = alpha * 0.7;
  g.fillStyle = scrim;
  g.beginPath();
  g.arc(0, 0, 1, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.globalAlpha = alpha;
  g.fillStyle = style.paint?.title ?? style.tokens.ink;
  g.font = `500 ${px}px ${DEFAULT_SERIF}`;
  g.fillText(text, W / 2, y);
  if (sub) {
    g.font = `italic ${subPx}px ${DEFAULT_SERIF}`;
    g.fillStyle = style.paint?.title ?? style.tokens.ink2;
    g.fillText(sub, W / 2, y + subPx * 1.9);
  }
  g.globalAlpha = 1;
  g.textAlign = 'left';
}

/**
 * Clears and draws the frame at video time τ with its opening and ending: the picture at the
 * score time `bookendsAt` gives, crossfaded into the end card, the title card over it, then the
 * fades' black. Canvas `scale` times the video's pixels (the dialog's preview).
 */
export function drawVideoMoment(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  tau: Seconds,
  scale = 1,
): View {
  const b = opts.bookends;
  const span = videoSpan(compiled.duration, opts.section);
  const st = bookendsAt(b, span, tau, opts.length);
  const px = videoSize(opts.aspect, opts.size);
  const cw = Math.ceil(px.width * scale);
  const ch = Math.ceil(px.height * scale);
  let view: View;
  if (st.end >= 1) view = drawEndCard(ctx, compiled, opts, scale);
  else {
    view = drawVideoFrameAt(ctx, compiled, opts, st.t, scale);
    if (st.end > 0) {
      const layer = layerFor(ctx, 'end-card', cw, ch);
      if (layer) {
        drawEndCard(layer.g, compiled, opts, scale);
        const g = ctx as CanvasRenderingContext2D;
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = st.end;
        g.drawImage(layer.canvas, 0, 0, cw, ch, 0, 0, cw, ch);
        g.restore();
      } else if (st.end >= 0.5) view = drawEndCard(ctx, compiled, opts, scale);
    }
  }
  const lay = videoLayout(opts.aspect, opts.size);
  if (st.title > 0 && b?.title) {
    drawTitleText(ctx, opts.style, lay, lay.dpr * scale, b.title, st.title);
  }
  if (st.black > 0) {
    const g = ctx as CanvasRenderingContext2D;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = Math.min(1, st.black);
    g.fillStyle = '#000000';
    g.fillRect(0, 0, cw, ch);
    g.globalAlpha = 1;
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// Thumbnail (PLAN.md §12 "Ready for YouTube")
// ---------------------------------------------------------------------------------------------

/** A thumbnail's pixels: YouTube's 1280×720 at 16:9, 720×1280 at 9:16, 1080×1080 at 1:1. */
export function thumbnailSize(aspect: VideoAspect): { width: number; height: number } {
  if (aspect === '16:9') return { width: 1280, height: 720 };
  if (aspect === '9:16') return { width: 720, height: 1280 };
  return { width: 1080, height: 1080 };
}

/** The thumbnail title's type, layout px (shrunk to fit). */
export const THUMB_TITLE_PX = 60;

export interface ThumbnailOptions {
  /** The picture: the frame at this score time (clamped to the section), or the whole piece. */
  at: Seconds | 'whole';
  /** Drawn large over the picture; empty = none. */
  title: { text: string; subtitle?: string };
}

/**
 * Clears and draws a thumbnail on a canvas `thumbnailSize(opts.aspect)` pixels: the video's
 * frame at a time, or the end card's whole-piece view (no credit), with the title large.
 */
export function drawThumbnail(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  thumb: ThumbnailOptions,
): void {
  const px = videoSize(opts.aspect, opts.size);
  const scale = thumbnailSize(opts.aspect).width / px.width;
  if (thumb.at === 'whole') drawEndCard(ctx, compiled, opts, scale, false);
  else drawVideoFrameAt(ctx, compiled, opts, thumb.at, scale);
  const lay = videoLayout(opts.aspect, opts.size);
  drawTitleText(ctx, opts.style, lay, lay.dpr * scale, thumb.title, 1, THUMB_TITLE_PX, 0.42);
}
