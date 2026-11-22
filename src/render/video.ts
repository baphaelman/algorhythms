/**
 * Video frames (PLAN.md §12 "Video export", revision 11): sizes, a camera that is a pure function
 * of time, the video's `ScoreStyle`, and `drawVideoFrame` for frame k at t = k / fps. No encoding
 * here; DOM-free apart from the context it is handed.
 *
 * Layout scale: a frame is drawn by `drawScore` at a fixed CSS-like layout size (`videoLayout`)
 * with the pixel ratio making up the rest, so the HUD, labels, dots and lines keep the player's
 * proportions and 720p is the same picture as 1080p, only smaller.
 */

import type { CompiledScore, LineColors, MomentId, Piece, Seconds } from '../core/types';
import { DEFAULT_FUTURE_OPACITY, MIN_WINDOW, followStart, pitchExtent } from './camera';
import { drawScore, type Ctx2D } from './draw';
import { DEFAULT_HUD } from './hud';
import { PLAYER_LOOK, lookStyle, type Look } from './look';
import type { CameraState, MomentLabels, MomentTimes, ScoreStyle, View } from './types';

export type VideoAspect = '16:9' | '9:16' | '1:1';
export type VideoSize = '1080' | '720';
export type VideoCameraMode = 'follow' | 'whole';

/** Output pixel size: 1080-class 1920×1080, 1080×1920, 1080×1080; 720-class two thirds of it. */
export function videoSize(aspect: VideoAspect, size: VideoSize): { width: number; height: number } {
  const s = size === '720' ? 720 : 1080;
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

export interface VideoCameraOptions {
  aspect: VideoAspect;
  /** Follow: the editor's zoom window (s), as seen at 16:9; scaled by `videoWindow`. */
  window?: Seconds;
  /** Pitch range for the whole video; default the piece's used range, padded (`pitchExtent`). */
  pitchRange?: [number, number];
  /** Follow: the playhead's place across the frame, 0..1. @default SMOOTH_X (0.35) */
  followAt?: number;
}

/**
 * The camera at time t, from t alone (no state between frames). Follow: Smooth follow, the
 * playhead at `followAt` (35 %) with `start` in [0, duration − window]. Whole: the piece fitted. The vertical
 * framing is the same for every frame.
 */
export function videoCamera(
  mode: VideoCameraMode,
  compiled: CompiledScore,
  t: Seconds,
  opts: VideoCameraOptions,
): CameraState {
  const D = Math.max(compiled.duration, 1e-6);
  const pitchRange = opts.pitchRange ?? pitchExtent(compiled);
  const whole = Math.max(MIN_WINDOW, D);
  if (mode === 'whole' || opts.window === undefined) return { start: 0, window: whole, pitchRange };
  const window = Math.min(whole, videoWindow(opts.window, opts.aspect));
  const tc = Math.min(Math.max(t, 0), D);
  const f = opts.followAt;
  if (f === undefined || !Number.isFinite(f)) {
    return { start: followStart('smooth', 0, tc, window, D), window, pitchRange };
  }
  const x = Math.min(1, Math.max(0, f));
  const start = Math.min(Math.max(0, D - window), Math.max(0, tc - x * window));
  return { start, window, pitchRange };
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
 * Score time of frame k: k / fps, held at the piece's end through the audio's ring-out (the
 * tail shows the last frame).
 */
export function videoFrameTime(k: number, fps: number, duration: Seconds): Seconds {
  return Math.min(k / fps, Math.max(0, duration));
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
  /** From `videoStyle`. */
  style: ScoreStyle;
}

/**
 * Clears and draws frame k (t = `videoFrameTime(k, fps)`) on a context whose canvas is
 * `videoSize(aspect, size)` pixels. Returns the frame's view.
 */
export function drawVideoFrame(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  k: number,
  fps: number,
): View {
  return drawVideoFrameAt(ctx, compiled, opts, videoFrameTime(k, fps, compiled.duration));
}

/**
 * Clears and draws the frame at score time t (clamped to the piece) on a canvas `scale` times
 * `videoSize(aspect, size)` pixels: the same picture, smaller (the Export dialog's preview).
 */
export function drawVideoFrameAt(
  ctx: Ctx2D,
  compiled: CompiledScore,
  opts: VideoFrameOptions,
  time: Seconds,
  scale = 1,
): View {
  const t = Math.min(Math.max(0, time), Math.max(0, compiled.duration));
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
