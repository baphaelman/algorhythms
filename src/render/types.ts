/**
 * Renderer types (PLAN.md §10, §11.5). The renderer imports only core; everything here is plain
 * data so the player, the editor and (later) export can share one `drawScore`.
 */

import type { CompiledScore, LineColors, MomentId, Seconds } from '../core/types';

/** The colour tokens of one theme (the prototype's `--paper`, `--ink`, ...; §11.5). */
export interface ThemeTokens {
  /** Background. */
  paper: string;
  /** Primary text and ink-coloured lines. */
  ink: string;
  /** Secondary text. */
  ink2: string;
  /** Grid lines, markers and the playhead. */
  rule: string;
  /** Accent: motion rings in ink mode, paused/idle hints. */
  accent: string;
  /** Raised panels (used by the app, carried here so one token set serves both). */
  panel: string;
}

/** Light or dark. */
export type ThemeName = 'light' | 'dark';

/**
 * What a user controls about the view (PLAN.md §10, revision 5). Pure data: the app owns it,
 * `cameraAt` resolves it against the score and the canvas size to a `View`.
 */
export interface CameraState {
  /** Time at the left edge, seconds; clamped to [0, duration − window]. */
  start: Seconds;
  /** Visible time window in seconds, 2 s up to the whole piece (log scale); clamped. */
  window: Seconds;
  /** Overrides the vertical auto-fit: the pitch range [low, high] to show. */
  pitchRange?: [number, number];
}

/**
 * A camera resolved for one frame: everything needed to map time and pitch to pixels. It is an
 * `Axis` (start, window, width, pps), so `timeToX(view, t)` works on it.
 */
export interface View {
  /** Canvas width and height in CSS pixels. */
  width: number;
  height: number;
  /** Time the playhead shows (the `t` passed to `cameraAt`). */
  t: Seconds;
  /** Time at x = 0 (clamped). */
  start: Seconds;
  /** Visible time span (clamped). */
  window: Seconds;
  /** Pixels per second: `width / window`. */
  pps: number;
  /** x of the playhead, time `t` (may be off-canvas). */
  xHead: number;
  /** Time at the left and right edges (`start`, `start + window`). */
  tL: Seconds;
  tR: Seconds;
  /** Pitch shown at the top (`pHi`) and bottom (`pLo`) of the plot area. */
  pLo: number;
  pHi: number;
  /** Plot-area padding in px: the pitch axis spans [padT, height − padB]. padL/padR inset text. */
  padT: number;
  padB: number;
  padL: number;
  padR: number;
  /** Piece duration (seconds), for convenience. */
  duration: Seconds;
}

/** A moment label to draw on the markers layer. */
export type MomentLabels = Readonly<Record<MomentId, string>>;

/** A time per moment id. */
export type MomentTimes = Readonly<Record<MomentId, Seconds>>;

/** How to paint one frame. Pure data; the app builds it from the piece's view settings and theme. */
export interface ScoreStyle {
  /** Resolved colour tokens of the current theme. */
  tokens: ThemeTokens;
  /** True for the dark theme (picks lightness for pitch colours). */
  dark: boolean;
  /** Line colouring (PLAN.md §10). */
  colors: LineColors;
  /** Use OKLCH colours; false selects the HSL fallback (see `supportsOklch`). */
  oklch: boolean;
  /** `VoiceDef.color` by pool index, for `colors: 'custom'`. Missing entries fall back to the ink. */
  customColors?: readonly (string | undefined)[];
  /** Opacity 0..1 of the future lines (the ghost); the app's default is 0.35. */
  futureOpacity: number;
  /** Draw the heads-up display. */
  hud: boolean;
  /** Draw heads (dots, rings, Hz labels) and the playhead emphasis. @default true */
  heads?: boolean;
  /**
   * Moment labels by id. A labelled moment gets a full-height marker with its label (a "section");
   * an unlabelled one gets a short tick. Positions come from `CompiledScore.momentSpans`.
   */
  labels?: MomentLabels;
  /**
   * Marker times by moment id (the editor passes `moment.at`, so markers agree with the lane).
   * Moments missing here are drawn at their span start. Markers are still drawn only for moments
   * with a span.
   */
  markerTimes?: MomentTimes;
  /** Monospace font family. */
  fontMono?: string;
  /**
   * Selected moments (§11.3 selection feedback): segments with these `momentId`s are drawn
   * emphasised and the other lines dimmed. Empty or absent: no highlight, no extra cost.
   */
  highlight?: ReadonlySet<MomentId>;
  /**
   * Whole lines to highlight (pool indices) like `highlight`'s segments, e.g. the line a tune's
   * "Melody on" option points at (owner, 2026-11-21). Empty or absent: none.
   */
  highlightVoices?: ReadonlySet<number>;
  /**
   * Bar grid to draw behind the lines (§11.3 revision 7; the editor passes the piece's tempo and
   * meter, defaults in ./bars). Absent: none.
   */
  bars?: { bpm?: number; meter?: number };
  /**
   * Width (px) covered at the left by the editor's piano ruler (§11.3): the pitch axis labels
   * start after it. @default 0
   */
  axisInset?: number;
  /** Draw the playhead line. The editor layout draws its own DOM playhead (§10). @default true */
  playhead?: boolean;
  /**
   * A moment preview (§11.3, palette hover and drag): this score's lines from `from` on, drawn
   * dashed over the real ones. Absent: none.
   */
  preview?: { score: CompiledScore; from: Seconds };
  /**
   * Editor (revision 9, "Silent lines vanish"): draw a faint dotted trace where a selected
   * (`highlight`) or hovered (`traceVoice`) line is silent, so it can still be found.
   */
  traces?: boolean;
  /** Pool index of the line under the pointer, for its dotted trace (with `traces`). */
  traceVoice?: number;
  /**
   * Compose for me (M4.5-28): lines are drawn only up to this time (the composer's pen), so a
   * moment's lines draw in as it is placed. Absent: the whole score.
   */
  reveal?: Seconds;
}
