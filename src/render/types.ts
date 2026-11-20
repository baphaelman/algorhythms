/**
 * Renderer types (PLAN.md §10, §11.5). The renderer imports only core; everything here is plain
 * data so the player, the editor and (later) export can share one `drawScore`.
 */

import type { LineColors, MomentId, Seconds } from '../core/types';

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
 * What a user controls about the view. Pure data: the app owns it, `cameraAt` resolves it against
 * the score and the canvas size to a `View`.
 */
export interface CameraState {
  /**
   * Visible time window in seconds, 2 s up to the whole piece (log scale). Values outside the
   * range are clamped.
   */
  window: Seconds;
  /**
   * Overview factor 0..1: 0 = follow camera, 1 = the whole piece. The app animates it, for
   * example 0 → 1 over 2.4 s when the piece ends and 1 → 0 when playback starts (the prototype's
   * `z`; see `easeOverview`). The camera also blends into the overview by itself as `window`
   * approaches the whole piece.
   */
  overview: number;
  /** Playhead x as a fraction of the width in follow mode. @default 0.78 */
  playheadX?: number;
  /** Paused dragging: seconds the view centre is shifted from the playhead. @default 0 */
  pan?: Seconds;
  /** Overrides the vertical auto-fit: the pitch range [low, high] to show. */
  pitchRange?: [number, number];
}

/** A camera resolved for one frame: everything needed to map time and pitch to pixels. */
export interface View {
  /** Canvas width and height in CSS pixels. */
  width: number;
  height: number;
  /** Time the playhead shows (the `t` passed to `cameraAt`). */
  t: Seconds;
  /** Time anchored at `xAnchor`: `t` plus the (blend-faded) pan, clamped to the piece. */
  tc: Seconds;
  /** x of time `tc`. */
  xAnchor: number;
  /** x of the playhead, time `t`. */
  xHead: number;
  /** Pixels per second. */
  pps: number;
  /** Time at the left and right edges. */
  tL: Seconds;
  tR: Seconds;
  /** 0 = follow, 1 = overview: the max of `overview` and the window-driven blend. */
  blend: number;
  /** Pitch shown at the top (`pHi`) and bottom (`pLo`) of the plot area. */
  pLo: number;
  pHi: number;
  /** Plot-area padding in px: the pitch axis spans [padT, height − padB]. */
  padT: number;
  padB: number;
  padL: number;
  padR: number;
  /** Piece duration (seconds), for convenience. */
  duration: Seconds;
}

/** A moment label to draw on the markers layer. */
export type MomentLabels = Readonly<Record<MomentId, string>>;

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
  /** Opacity 0..1 of the future lines (the ghost). 0 during playback by default. */
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
  /** Monospace font family. */
  fontMono?: string;
}
