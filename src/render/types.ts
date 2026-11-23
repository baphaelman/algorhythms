/**
 * Renderer types (PLAN.md §10, §11.5). The renderer imports only core; everything here is plain
 * data so the player, the editor and (later) export can share one `drawScore`.
 */

import type { CompiledScore, LineColors, MomentId, Seconds } from '../core/types';
import type { StylePaint } from './colours';
import type { HudLayout } from './hud-layout';

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

/**
 * A HUD readout (PLAN.md §12 "Export look"): formula, notes sounding / pool, time / length, chord,
 * key + follow mode, Hz range, spread (lowest → highest sounding line as an interval), lowest and
 * highest note names, the sounding notes by name, the gaps between neighbouring lines, the piece's
 * name.
 */
export type HudItem =
  | 'formula'
  | 'notes'
  | 'time'
  | 'chord'
  | 'key'
  | 'hz'
  | 'spread'
  | 'range'
  | 'names'
  | 'gaps'
  | 'title';

/** Guide lines at pitches (MIDI numbers, fractions allowed), labelled or not. */
export interface PitchGuides {
  pitches: readonly number[];
  labels: boolean;
}

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
  /**
   * The heads-up display: true = today's readouts (`DEFAULT_HUD`), false = none, or the readouts
   * in order (left column first, then right; as many rows as needed, the bottom band grows).
   */
  hud: boolean | readonly HudItem[];
  /**
   * Where each readout sits on the frame (§12 "Exports you can shape"). Absent = today's two
   * columns as the player draws them; present (even {}), each readout is a placed box, those
   * without a position in their default slot.
   */
  hudLayout?: HudLayout;
  /** The piece's name, for the `title` readout. */
  pieceName?: string;
  /** Extra px in the bottom band below the HUD rows (the poster's title block). @default 0 */
  hudExtra?: number;
  /**
   * Keep the HUD's bottom padding with `hud` false: the poster's title block goes there (§12
   * "Poster export"). @default false
   */
  reserveHud?: boolean;
  /** Draw heads (dots, rings, Hz labels) and the playhead emphasis. @default true */
  heads?: boolean;
  /** With heads: the dot per sounding line. @default true */
  dots?: boolean;
  /** With heads: the ring round a moving line. @default true */
  rings?: boolean;
  /** With heads: the Hz labels beside them. @default true */
  hzLabels?: boolean;
  /** The octave guides (A lines). @default true */
  guides?: boolean;
  /** The guides' Hz labels (with `guides`). @default true */
  guideLabels?: boolean;
  /** Short ticks of unlabelled moments. @default true */
  markers?: boolean;
  /** Labelled moments' full-height lines and labels (sections). @default true */
  sections?: boolean;
  /**
   * Nothing ahead of the playhead: markers, section labels and bar lines past `t` are not drawn
   * (lines and pulse marks follow `futureOpacity`, which should then be 0). @default false
   */
  aheadHidden?: boolean;
  /** Line opacity by audible level ("louder voices brighter", §10 revision 9). @default true */
  levelOpacity?: boolean;
  /** Pulse hit marks (§10 revision 10). @default true */
  pulseMarks?: boolean;
  /** Line width factor (thin / normal / bold). @default 1 */
  lineScale?: number;
  /** Colour of 'ink' lines and the fallback of 'custom' ones. @default tokens.ink */
  lineInk?: string;
  /**
   * Export colours (§12 "Exports you can shape" → Colours): the background, own pitch stops and
   * each element's colour. Absent (or any field absent): the tokens as before.
   */
  paint?: StylePaint;
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
   * meter, defaults in ./bars). Absent: none. `every`: every beat and bar, never thinned by zoom.
   */
  bars?: { bpm?: number; meter?: number; every?: boolean };
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
  /**
   * Glow (§12 "Ready for YouTube"), 0..1: soft light round the lines, from the lines only, in
   * `paint.glow` or the lines' own colours. Absent or 0: none.
   */
  glow?: number;
  /** Vignette, 0..1: the frame's edges darkened. Absent or 0: none. */
  vignette?: number;
  /**
   * Minimum line opacity (§12 "Ready for YouTube", revision 17), 0..1: sounding lines are drawn
   * at least this bright (level × pulse floored; life fades still apply). With level opacity
   * only. Absent or 0: none.
   */
  minLineOpacity?: number;
  /**
   * Guide lines at pitches (§12 "Ready for YouTube"): faint horizontal lines in the guides'
   * colour, each labelled with its note name when `labels`. Absent: none.
   */
  pitchGuides?: PitchGuides;
  /**
   * Line thickness by weight, with merges and splits as strands and ropes (§11.3). False draws
   * every line at the base width (video export's thickness off, §12). @default true
   */
  thickness?: boolean;
}
