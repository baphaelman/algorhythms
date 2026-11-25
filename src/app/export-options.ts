/**
 * The Export dialog's form, as pure functions (PLAN.md §12): the choices, how they map to the
 * export APIs' options, the file names, and the size text. No DOM, no store and no DSP imports, so
 * the main bundle stays small and the mapping is unit-tested in Node. The heavy work lives in
 * `export-run.ts`, which the dialog loads on demand.
 */

import type { LineColors, Piece, Seconds } from '../core/types';
import { DEFAULT_HUD, HUD_ITEMS } from '../render/hud';
import { parseHudPos, type HudLayout } from '../render/hud-layout';
import {
  EXPORT_LOOK,
  LINE_SCALE_MAX,
  LINE_SCALE_MIN,
  lookBeats,
  type Look,
  type LookFuture,
  type LookLineWidth,
} from '../render/look';
import type { PosterSize } from '../render/poster';
import {
  clampSpan,
  isWholeSpan,
  snapToBar,
  stepBar,
  type BarGridSpec,
  type TimeSpan,
} from '../render/section';
import type { HudItem } from '../render/types';
import { MIN_WINDOW } from '../render/camera';
import { tokensOf } from '../render/palettes';
import {
  DEFAULT_COLOURS,
  coloursFromOld,
  coloursLook,
  lineColorsOf,
  parseColours,
  parseSchemes,
  type ColourScheme,
  type ColoursForm,
} from './export-colours';
import {
  END_CREDIT,
  bookendsOn,
  videoWindow as videoWindowOf,
  videoWindowAt16x9,
  type VideoAspect,
  type VideoBookends,
  type VideoCameraMode,
  type VideoSize,
} from '../render/video';
import type { PosterOptions } from './poster-export';
import { pieceRowBreak, pieceVideoFrame } from '../render/poster-video';
import type { VideoOptions, VideoQuality, VideoSupport } from './video-export';
import type { ExportLoudness } from '../audio/wav-export';

export type ExportFormat = 'wav' | 'stems' | 'midi' | 'video' | 'poster';

export const EXPORT_FORMATS: readonly { id: ExportFormat; label: string }[] = [
  { id: 'wav', label: 'WAV' },
  { id: 'stems', label: 'Stems' },
  { id: 'midi', label: 'MIDI' },
  { id: 'video', label: 'Video (MP4)' },
  { id: 'poster', label: 'Poster' },
];

/** 32 means 32-bit float. */
export type ExportBitDepth = 16 | 24 | 32;
export type ExportRate = 44100 | 48000;
export type ExportMidiMode = 'perVoice' | 'mpe' | 'notesOnly';
export type ExportBendRange = 2 | 12 | 24 | 48;

export const BIT_DEPTHS: readonly { id: ExportBitDepth; label: string }[] = [
  { id: 16, label: '16-bit' },
  { id: 24, label: '24-bit' },
  { id: 32, label: '32-bit float' },
];

export const RATES: readonly { id: ExportRate; label: string }[] = [
  { id: 44100, label: '44.1 kHz' },
  { id: 48000, label: '48 kHz' },
];

export const MIDI_MODES: readonly { id: ExportMidiMode; label: string; hint: string }[] = [
  {
    id: 'perVoice',
    label: 'Per-note tracks',
    hint: 'One track per note, each with its own pitch-bend range. Use one monophonic synth per track.',
  },
  {
    id: 'mpe',
    label: 'MPE',
    hint: 'For one MPE synth (bend range fixed at ±48). More than 15 notes make several files.',
  },
  {
    id: 'notesOnly',
    label: 'Notes only',
    hint: 'One note per arrival, no glides. For notation and plain synths.',
  },
];

export const BEND_RANGES: readonly { id: ExportBendRange; label: string }[] = [
  { id: 2, label: '±2' },
  { id: 12, label: '±12' },
  { id: 24, label: '±24' },
  { id: 48, label: '±48' },
];

export type ExportVideoTheme = 'current' | 'light' | 'dark';

/** The Section control's choice (§12 rev 15): what a video or poster shows. */
export type ExportSectionKind = 'whole' | 'loop' | 'custom';

export const SECTION_KINDS: readonly { id: ExportSectionKind; label: string }[] = [
  { id: 'whole', label: 'Whole piece' },
  { id: 'loop', label: 'Loop region' },
  { id: 'custom', label: 'Custom' },
];

export const VIDEO_ASPECTS: readonly { id: VideoAspect; label: string }[] = [
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
];

/** Every size class; the dialog shows those this browser can encode (`videoSizes`). */
export const VIDEO_SIZES: readonly { id: VideoSize; label: string }[] = [
  { id: '720', label: '720p' },
  { id: '1080', label: '1080p' },
  { id: '1440', label: '1440p' },
  { id: '2160', label: '4K' },
];

/** Loudness of the WAV mix and the video's audio (§12 "Ready for YouTube"). */
export const LOUDNESS_TARGETS: readonly { id: ExportLoudness; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: -14, label: '−14 LUFS' },
  { id: -16, label: '−16 LUFS' },
];

/** Where the thumbnail's picture comes from: the preview's frame or the whole-piece view. */
export type ThumbnailAt = 'frame' | 'whole';
export const THUMBNAIL_ATS: readonly { id: ThumbnailAt; label: string }[] = [
  { id: 'frame', label: 'This frame' },
  { id: 'whole', label: 'Whole piece' },
];

/** Quality (§12 "Ready for YouTube"): the target bitrate, High = YouTube's upload rates. */
export const VIDEO_QUALITIES: readonly { id: VideoQuality; label: string }[] = [
  { id: 'standard', label: 'Standard' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
];

/** End card lengths offered (§12 "Ready for YouTube"), s; 0 = off. */
export type VideoEndCard = 0 | 5 | 10 | 20;
export const VIDEO_END_CARDS: readonly { id: VideoEndCard; label: string }[] = [
  { id: 0, label: 'Off' },
  { id: 5, label: '5 s' },
  { id: 10, label: '10 s' },
  { id: 20, label: '20 s' },
];
/** Longest fade in, lead-in and fade to black, s. */
export const VIDEO_FADE_MAX = 3;

export const VIDEO_FPS: readonly { id: 30 | 60; label: string }[] = [
  { id: 30, label: '30 fps' },
  { id: 60, label: '60 fps' },
];

export const VIDEO_CAMERAS: readonly { id: VideoCameraMode; label: string; hint: string }[] = [
  { id: 'follow', label: 'Follow', hint: 'Follows the playhead; Window sets how much it shows.' },
  { id: 'auto', label: 'Auto', hint: 'Moves with the music.' },
  {
    id: 'keys',
    label: 'Keys',
    hint: 'Your keys. Select one, then drag or scroll the preview.',
  },
  {
    id: 'whole',
    label: 'Whole piece',
    hint: 'The whole piece in view; the playhead moves across.',
  },
];

/**
 * The Camera the dialog shows for a piece (M11.5): Whole piece is the dialog's own choice;
 * otherwise the piece's camera mode (Auto without one), which Follow, Auto and Keys write.
 */
export function cameraChoice(
  form: Pick<ExportForm, 'videoCamera'>,
  piece: Pick<Piece, 'camera'>,
): VideoCameraMode {
  return form.videoCamera === 'whole' ? 'whole' : (piece.camera?.mode ?? 'auto');
}

export const VIDEO_THEMES: readonly { id: ExportVideoTheme; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** What the dialog's controls hold. */
export interface ExportForm {
  format: ExportFormat;
  /** Video and poster: the section shown (per piece for the session, not remembered). */
  section: ExportSectionKind;
  /** The Custom section's span (s); null until one is set. */
  sectionSpan: TimeSpan | null;
  /** WAV and stems. */
  bitDepth: ExportBitDepth;
  /** WAV and stems. */
  sampleRate: ExportRate;
  /** Stems only: mono voice and FX stems (the mix stays stereo). */
  mono: boolean;
  /** WAV and video: normalise to this loudness (off = peaks ≤ −1 dBFS, as before). */
  loudness: ExportLoudness;
  midiMode: ExportMidiMode;
  /** Per-voice mode only (MPE is always ±48; notes-only writes no bends). */
  bendRange: ExportBendRange;
  /** Write pulse envelopes, fades and level gain as CC11. */
  cc11: boolean;
  /** End and re-strike the note on every arrival (plucked sounds). */
  restrike: boolean;
  videoAspect: VideoAspect;
  videoSize: VideoSize;
  videoFps: 30 | 60;
  videoQuality: VideoQuality;
  videoCamera: VideoCameraMode;
  /** Follow: playhead place across the frame, % (10..90); null = by the future (`followAtOf`). */
  videoFollowAt: number | null;
  /**
   * Follow: seconds the frame shows at the chosen aspect (≥ MIN_WINDOW, at most the piece when
   * used); null = the editor's zoom, scaled to the aspect (`videoWindow`).
   */
  videoWindow: number | null;
  /** HUD readouts of a video, in `HUD_ITEMS` order. */
  videoHud: readonly HudItem[];
  /**
   * Over the poster (M15): Ahead of the playhead, 0..100 % (0 = the poster draws itself). One
   * row keeps the Look's `future`.
   */
  videoAheadPoster: number;
  /** Opening (§12 "Ready for YouTube"): fade in from black and lead-in, s (0..3). */
  videoFadeIn: number;
  videoLeadIn: number;
  /** The title card on; its title (null = the piece's name) and subtitle (per piece). */
  videoTitleCard: boolean;
  videoTitle: string | null;
  videoSubtitle: string;
  /** Ending: fade to black, s (0..3), and the end card's length (0 = off). */
  videoFadeOut: number;
  videoEndCard: VideoEndCard;
  /** The end card's credit line ('' = none). */
  videoCredit: string;
  /** The thumbnail's picture. */
  thumbnailAt: ThumbnailAt;
  /** Copy description: add the piece's share link. */
  descriptionLink: boolean;
  posterFormat: PosterFormat;
  /** Poster pixels (POSTER_MIN_SIDE..POSTER_MAX_SIDE each, area ≤ POSTER_MAX_AREA). */
  posterWidth: number;
  posterHeight: number;
  /** Rows the piece is cut into, 1..POSTER_MAX_ROWS. */
  posterRows: number;
  posterTitle: boolean;
  /** With a section: keep the whole piece's pitch range (else fit the section's lines). */
  posterPieceRange: boolean;
  /** HUD readouts of a poster (default none: it would show end-of-piece values). */
  posterHud: readonly HudItem[];
  /**
   * Where each readout sits, shared by video and poster (§12 "Exports you can shape"); {} =
   * today's two columns, a readout without a position takes its slot there.
   */
  hudLayout: HudLayout;
  /** The Look shared by video and poster (§12 "Export look"). */
  look: LookForm;
  /** Colour schemes the viewer saved (§12 Colours), oldest first. */
  colourSchemes: readonly ColourScheme[];
}

export type PosterFormat = 'png' | 'svg';

/**
 * The dialog's Look: `Look` with a 'current' theme, no HUD (per format), and the Colours group's
 * form in place of the line colours (§12 Colours; lines 'app' = as the app draws now).
 */
export interface LookForm extends Omit<
  Look,
  'theme' | 'hud' | 'hudLayout' | 'lineInk' | 'colors' | 'colours'
> {
  theme: ExportVideoTheme;
  colours: ColoursForm;
}

/** EXPORT_LOOK as the dialog holds it (theme: current, every colour the theme's). */
export const DEFAULT_LOOK_FORM: LookForm = (() => {
  const { hud: _h, lineInk: _i, theme: _t, colors: _c, colours: _o, ...rest } = EXPORT_LOOK;
  return { ...rest, theme: 'current', colours: DEFAULT_COLOURS };
})();

export const POSTER_FORMATS: readonly { id: PosterFormat; label: string }[] = [
  { id: 'png', label: 'PNG' },
  { id: 'svg', label: 'SVG' },
];

/** Quick picks of the poster's size: each sets Width and Height (as `posterSize`). */
export const POSTER_SIZES: readonly {
  id: PosterSize;
  label: string;
  width: number;
  height: number;
}[] = [
  { id: '16:9', label: '16:9', width: 3840, height: 2160 },
  { id: '1:1', label: '1:1', width: 2160, height: 2160 },
  { id: 'a4', label: 'A4 portrait', width: 2480, height: 3508 },
];

/** Width and Height slider range, px. */
export const POSTER_MIN_SIDE = 1000;
export const POSTER_MAX_SIDE = 8000;
/** Largest canvas every browser draws (Safari: 4096², 16.7 M px). */
export const POSTER_MAX_AREA = 16_777_216;
/** Rows slider range (as the renderer's POSTER_MAX_ROWS). */
export const POSTER_MAX_ROWS = 8;

/** Largest side allowed next to a side `other` px long: where a dragged slider stops. */
export function posterSideMax(other: number): number {
  return Math.min(POSTER_MAX_SIDE, Math.floor(POSTER_MAX_AREA / Math.max(1, other)));
}

const side = (v: number, max = POSTER_MAX_SIDE) =>
  Math.min(max, Math.max(POSTER_MIN_SIDE, Math.round(v)));

/**
 * Width and height in range, whole px, within the area cap: `keep` stays (in range) and the
 * other side gives way.
 */
export function clampPosterDims(
  width: number,
  height: number,
  keep: 'width' | 'height' = 'width',
): { width: number; height: number } {
  let w = side(Number.isFinite(width) ? width : POSTER_SIZES[0].width);
  let h = side(Number.isFinite(height) ? height : POSTER_SIZES[0].height);
  if (keep === 'width') h = Math.min(h, posterSideMax(w));
  else w = Math.min(w, posterSideMax(h));
  return { width: w, height: h };
}

/** The area cap holds a side below POSTER_MAX_SIDE and that side is at its cap. */
export function posterCapped(width: number, height: number): boolean {
  const mw = posterSideMax(height);
  const mh = posterSideMax(width);
  return (mw < POSTER_MAX_SIDE && width >= mw) || (mh < POSTER_MAX_SIDE && height >= mh);
}

/** The quick pick matching the form's size, if any. */
export function posterPreset(
  form: Pick<ExportForm, 'posterWidth' | 'posterHeight'>,
): PosterSize | undefined {
  return POSTER_SIZES.find((p) => p.width === form.posterWidth && p.height === form.posterHeight)
    ?.id;
}

/** Rows clamped to 1..POSTER_MAX_ROWS, whole. */
export function clampRows(v: number): number {
  return Number.isFinite(v) ? Math.min(POSTER_MAX_ROWS, Math.max(1, Math.round(v))) : 1;
}

export const LOOK_FUTURES: readonly { id: LookFuture; label: string }[] = [
  { id: 'hidden', label: 'Hidden' },
  { id: 'dimmed', label: 'Dimmed' },
  { id: 'full', label: 'Full' },
];

export const LOOK_WIDTHS: readonly { id: LookLineWidth; label: string }[] = [
  { id: 'thin', label: 'Thin' },
  { id: 'normal', label: 'Normal' },
  { id: 'bold', label: 'Bold' },
];

/** Each HUD readout's name and a one-line sample, in `HUD_ITEMS` order. */
export const HUD_CHOICES: readonly { id: HudItem; label: string; sample: string }[] = (() => {
  const info: Record<HudItem, [string, string]> = {
    formula: ['Formula', 'f(n) = 440·2^((n−69)/12)'],
    notes: ['Notes sounding / pool', 'notes 5 / 8'],
    time: ['Time / length', 't 01:23.4 / 03:00.0'],
    chord: ['Chord', 'Dm7'],
    key: ['Key and follow mode', 'd dorian · following'],
    hz: ['Hz range', '146.8–587.3 Hz'],
    spread: ['Spread', 'spread 19 st · octave + 5th'],
    range: ['Lowest and highest note', 'range D3 – A4'],
    names: ['Sounding notes', 'names D3 F3 A3×2 C4'],
    gaps: ['Gaps between lines', 'gaps 3 4 5'],
    title: ['Piece name', 'the piece’s name'],
  };
  return HUD_ITEMS.map((id) => ({ id, label: info[id][0], sample: info[id][1] }));
})();

/** The Follow camera's default playhead place, %: far right when nothing is drawn ahead. */
export const FOLLOW_AT_HIDDEN = 80;
export const FOLLOW_AT_SHOWN = 35;
export const FOLLOW_AT_MIN = 10;
export const FOLLOW_AT_MAX = 90;

export const DEFAULT_EXPORT_FORM: ExportForm = {
  format: 'wav',
  section: 'whole',
  sectionSpan: null,
  bitDepth: 32,
  sampleRate: 48000,
  mono: false,
  loudness: 'off',
  midiMode: 'perVoice',
  bendRange: 24,
  cc11: false,
  restrike: false,
  videoAspect: '16:9',
  videoSize: '1080',
  videoFps: 30,
  videoQuality: 'high',
  videoCamera: 'follow',
  videoFollowAt: null,
  videoWindow: null,
  videoHud: DEFAULT_HUD,
  videoAheadPoster: 0,
  videoFadeIn: 0,
  videoLeadIn: 0,
  videoTitleCard: false,
  videoTitle: null,
  videoSubtitle: '',
  videoFadeOut: 0,
  videoEndCard: 0,
  videoCredit: END_CREDIT,
  thumbnailAt: 'frame',
  descriptionLink: false,
  posterFormat: 'png',
  posterWidth: 3840,
  posterHeight: 2160,
  posterRows: 1,
  posterTitle: true,
  posterPieceRange: false,
  posterHud: [],
  hudLayout: {},
  look: DEFAULT_LOOK_FORM,
  colourSchemes: [],
};

// ---------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------

/** Characters no common file system accepts in a name, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name stem from text such as a piece title: unsafe characters dropped, spaces turned into
 * hyphens, no leading dots, at most 80 characters, and `fallback` when nothing is left.
 */
export function sanitizeFileName(text: string, fallback = 'piece'): string {
  let s = text
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[. -]+$/, '')
    .slice(0, 80)
    .replace(/[. -]+$/, '');
  if (s === '') s = fallback;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** The file name stem for a piece (its title, sanitized). */
export function fileBase(piece: Piece): string {
  return sanitizeFileName(piece.meta.title);
}

/** The file name of an export (MIDI file names come from the MIDI exporter; a zip is `-midi.zip`). */
export function exportFileName(piece: Piece, form: ExportForm, files = 1): string {
  const base = fileBase(piece);
  switch (form.format) {
    case 'wav':
      return `${base}.wav`;
    case 'stems':
      return `${base}-stems.zip`;
    case 'midi':
      return files > 1 ? `${base}-midi.zip` : `${base}.mid`;
    case 'video':
      return `${base}.mp4`;
    case 'poster':
      return `${base}.${form.posterFormat}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------------------------

export function wavOptions(form: ExportForm): { sampleRate: ExportRate; bitDepth: ExportBitDepth } {
  return { sampleRate: form.sampleRate, bitDepth: form.bitDepth };
}

/** The WAV export's loudness option: present only when on. */
export function wavLoudness(form: Pick<ExportForm, 'loudness'>): { loudness?: -14 | -16 } {
  return form.loudness === 'off' ? {} : { loudness: form.loudness };
}

/** Display names by voice id, for the stem file names. */
export function voiceNames(piece: Piece): Record<string, string> {
  const names: Record<string, string> = {};
  for (const v of piece.voices) if (v.name) names[v.id] = v.name;
  return names;
}

export function stemsOptions(
  form: ExportForm,
  piece: Piece,
): {
  sampleRate: ExportRate;
  bitDepth: ExportBitDepth;
  mono: boolean;
  voiceNames: Record<string, string>;
} {
  return {
    sampleRate: form.sampleRate,
    bitDepth: form.bitDepth,
    mono: form.mono,
    voiceNames: voiceNames(piece),
  };
}

export interface MidiRequest {
  mode: ExportMidiMode;
  bendRange: ExportBendRange;
  cc11: boolean;
  restrikeOnArrival: boolean;
  name: string;
  title: string;
  /** Present only when the piece has a grid, so 1 beat follows it; else the exporter's 60. */
  bpm?: number;
}

export function midiOptions(form: ExportForm, piece: Piece): MidiRequest {
  const req: MidiRequest = {
    mode: form.midiMode,
    bendRange: form.midiMode === 'mpe' ? 48 : form.bendRange,
    cc11: form.cc11,
    restrikeOnArrival: form.restrike,
    name: fileBase(piece),
    title: piece.meta.title,
  };
  const bpm = piece.view.gridBpm;
  if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) req.bpm = bpm;
  return req;
}

/** What a section resolves against: the piece's length and its loop region. */
export interface SectionContext {
  /** The piece's length (s). */
  duration?: Seconds;
  /** The piece's loop region (clipped to the piece), if it has one. */
  loop?: TimeSpan | null;
}

/**
 * The span the form's Section shows, or undefined for the whole piece (Whole; Loop without a
 * loop region; a span covering the piece).
 */
export function sectionOf(
  form: Pick<ExportForm, 'section' | 'sectionSpan'>,
  ctx: SectionContext,
): TimeSpan | undefined {
  const D = ctx.duration;
  if (D === undefined || !(D > 0)) return undefined;
  let span: TimeSpan | undefined;
  if (form.section === 'loop' && ctx.loop) span = clampSpan(ctx.loop, D);
  else if (form.section === 'custom' && form.sectionSpan) span = clampSpan(form.sectionSpan, D);
  return span && !isWholeSpan(span, D) ? span : undefined;
}

/** The piece's bar grid, if it has a tempo (`view.gridBpm`, `view.meter`). */
export function gridOf(piece: Pick<Piece, 'view'>): BarGridSpec | undefined {
  const bpm = piece.view.gridBpm;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || !(bpm > 0)) return undefined;
  return piece.view.meter !== undefined ? { bpm, meter: piece.view.meter } : { bpm };
}

/**
 * The span Custom starts with: the loop region if there is one, else the editor's view (snapped
 * to bars), else the middle third when the view shows the whole piece.
 */
export function defaultCustomSpan(
  duration: Seconds,
  view: { start: Seconds; window: Seconds },
  loop?: TimeSpan | null,
  grid?: BarGridSpec,
): TimeSpan {
  if (loop) return clampSpan(loop, duration);
  let span: TimeSpan = {
    start: snapToBar(view.start, grid),
    end: snapToBar(view.start + view.window, grid),
  };
  span = clampSpan(span, duration);
  if (isWholeSpan(span, duration)) {
    span = clampSpan(
      { start: snapToBar(duration / 3, grid), end: snapToBar((2 * duration) / 3, grid) },
      duration,
    );
  }
  return span;
}

/** Which end of a section moves. */
export type SectionHandle = 'start' | 'end';

/**
 * The span with one handle moved to t: snapped to the nearest bar line unless `free` (Alt) or
 * the piece has no grid, kept inside the piece and at least MIN_SECTION from the other handle.
 */
export function moveHandle(
  span: TimeSpan,
  handle: SectionHandle,
  t: Seconds,
  duration: Seconds,
  grid?: BarGridSpec,
  free = false,
): TimeSpan {
  const v = free ? t : snapToBar(t, grid);
  return handle === 'start'
    ? clampSpan({ start: v, end: span.end }, duration, 'end')
    : clampSpan({ start: span.start, end: v }, duration, 'start');
}

/**
 * The span with one handle typed as t: exact, inside the piece; the other handle gives way to
 * keep MIN_SECTION between them.
 */
export function typeHandle(
  span: TimeSpan,
  handle: SectionHandle,
  t: Seconds,
  duration: Seconds,
): TimeSpan {
  return clampSpan({ ...span, [handle]: t }, duration, handle);
}

/**
 * A keyboard step of one handle: a bar (Shift: 4 bars) with a grid, else 1 s (Shift: 10 s); Alt
 * steps 0.1 s (Shift: 1 s), off the grid. Home and End go to the piece's ends.
 */
export function stepHandle(
  span: TimeSpan,
  handle: SectionHandle,
  key: string,
  mods: { shift?: boolean; alt?: boolean },
  duration: Seconds,
  grid?: BarGridSpec,
): TimeSpan | null {
  const t = span[handle];
  let dir: 1 | -1;
  if (key === 'Home' || key === 'End') {
    return moveHandle(span, handle, key === 'Home' ? 0 : duration, duration, undefined, true);
  }
  if (key === 'ArrowRight' || key === 'ArrowUp' || key === 'PageUp') dir = 1;
  else if (key === 'ArrowLeft' || key === 'ArrowDown' || key === 'PageDown') dir = -1;
  else return null;
  const big = mods.shift === true || key === 'PageUp' || key === 'PageDown';
  let v: Seconds;
  if (mods.alt) v = t + dir * (big ? 1 : 0.1);
  else if (grid) {
    v = t;
    for (let i = 0; i < (big ? 4 : 1); i++) v = stepBar(v, dir, grid);
  } else v = t + dir * (big ? 10 : 1);
  return moveHandle(span, handle, v, duration, undefined, true);
}

/** "0:45.0": a section handle's time, to the tenth of a second. */
export function sectionClock(t: Seconds): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** A typed time: "1:05.5", "65.5" or "1:05"; null when it isn't one. */
export function parseClock(text: string): Seconds | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)\s*$/.exec(text);
  if (!m) return null;
  const sec = Number(m[2]);
  if (m[1] !== undefined && sec >= 60) return null;
  const v = (m[1] !== undefined ? Number(m[1]) * 60 : 0) + sec;
  return Number.isFinite(v) ? v : null;
}

/** What the video and poster exports take from the app beyond the form. */
export interface VideoContext extends LookAppContext, SectionContext {
  /** The editor's zoom window now (s), as seen at 16:9; Follow uses it unless the form sets one. */
  window: Seconds;
}

/** The Follow window slider's range, seconds shown: 2 s to the whole piece. */
export function followWindowRange(duration: Seconds): [Seconds, Seconds] {
  const d = Number.isFinite(duration) ? duration : 0;
  return [MIN_WINDOW, Math.max(MIN_WINDOW, d)];
}

/** Seconds the Follow frame shows: the form's window, else the editor's zoom at this aspect. */
export function followWindowOf(
  form: Pick<ExportForm, 'videoWindow' | 'videoAspect'>,
  ctx: Pick<VideoContext, 'window' | 'duration'>,
): Seconds {
  const w = form.videoWindow;
  const shown = w !== null && Number.isFinite(w) ? w : videoWindowOf(ctx.window, form.videoAspect);
  if (ctx.duration === undefined) return Math.max(MIN_WINDOW, shown);
  const [lo, hi] = followWindowRange(ctx.duration);
  return Math.min(hi, Math.max(lo, shown));
}

/** Slider position 0..1 (log scale) for a Follow window; 0 = 2 s, 1 = the whole piece. */
export function followWindowToSlider(window: Seconds, duration: Seconds): number {
  const [lo, hi] = followWindowRange(duration);
  if (hi <= lo) return 1;
  const w = Math.min(hi, Math.max(lo, window));
  return (Math.log(w) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
}

/** Follow window for a slider position 0..1; inverse of `followWindowToSlider`. */
export function sliderToFollowWindow(x: number, duration: Seconds): Seconds {
  const [lo, hi] = followWindowRange(duration);
  const k = Math.min(1, Math.max(0, x));
  return Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * k);
}

/** How close (fraction of the track) the Window slider snaps to the editor's zoom tick. */
export const WINDOW_SNAP = 0.03;

/**
 * Whether the Window slider at `x` lands on the editor's zoom tick at `tick` (0..1 positions):
 * within WINDOW_SNAP. With `from` (a keyboard step from that position) it snaps only moving
 * toward the tick, so a step can leave it. A pointer drag passes no `from`: the browser keeps
 * its own drag position, so it snaps by distance alone.
 */
export function windowSnaps(x: number, tick: number, from?: number): boolean {
  const d = Math.abs(x - tick);
  if (d < 5e-4) return true; // the same slider step (1/1000)
  return d <= WINDOW_SNAP && (from === undefined || d < Math.abs(from - tick));
}

/** "12 s", "4.5 s" (under 10 s, one decimal). */
export function windowText(window: Seconds): string {
  return window < 10 ? `${window.toFixed(1)} s` : `${Math.round(window)} s`;
}

/** The Follow camera's playhead place, %: the user's, else by the future setting. */
export function followAtOf(form: Pick<ExportForm, 'videoFollowAt' | 'look'>): number {
  const v = form.videoFollowAt;
  if (v === null || !Number.isFinite(v)) {
    return form.look.future === 'hidden' ? FOLLOW_AT_HIDDEN : FOLLOW_AT_SHOWN;
  }
  return Math.min(FOLLOW_AT_MAX, Math.max(FOLLOW_AT_MIN, v));
}

/** A readout list in `HUD_ITEMS` order, unknown and repeated items dropped. */
export function hudInOrder(items: readonly unknown[]): HudItem[] {
  return HUD_ITEMS.filter((it) => items.includes(it));
}

/** What a Look takes from the app now: its theme and line-colour mode. */
export interface LookAppContext {
  dark: boolean;
  /** The app's line colours now (`view.colors`), for 'app'. */
  colors: LineColors;
  /** Each voice's part by pool index (per-part line colours). */
  parts?: readonly (string | undefined)[];
}

/**
 * The renderer's Look for a video or poster export of this form. 'app' line colours resolve to
 * the app's mode with the theme's ink, as the app draws them (voice colours come from the piece).
 * The Colours group's choices go in `colours` only when one differs from the theme's.
 */
export function lookOf(form: ExportForm, kind: 'video' | 'poster', app: LookAppContext): Look {
  const { theme, colours, ...rest } = form.look;
  const name = theme === 'current' ? (app.dark ? 'dark' : 'light') : theme;
  const transparent = kind === 'poster' && form.look.transparent;
  const look: Look = {
    ...rest,
    theme: name,
    transparent,
    colors: lineColorsOf(colours.lines, app.colors),
    hud: hudInOrder(kind === 'poster' ? form.posterHud : form.videoHud),
    hudLayout: form.hudLayout,
  };
  const c = coloursLook(colours, {
    tokens: tokensOf(name),
    dark: name === 'dark',
    ...(app.parts ? { parts: app.parts } : {}),
  });
  if (c) look.colours = c;
  if (c?.lines?.kind === 'one') look.lineInk = c.lines.color;
  return look;
}

/** Each voice's part, for per-part colours. */
const partsOf = (piece: Piece) => piece.voices.map((v) => v.part);

/**
 * Ahead of the playhead as the Look holds it, from 0..100 %: 0 = hidden, 100 = full, between =
 * dimmed at that opacity.
 */
export function aheadLook(n: number): Pick<LookForm, 'future'> & Partial<LookForm> {
  const r = Math.round(n);
  if (!(r > 0)) return { future: 'hidden' };
  if (r >= 100) return { future: 'full' };
  return { future: 'dimmed', futureOpacity: r / 100 };
}

/**
 * The form as the video reads it: Over the poster (M15) takes Ahead of the playhead from
 * `videoAheadPoster`; One row keeps the Look's.
 */
export function videoForm(form: ExportForm, piece: Pick<Piece, 'camera' | 'poster'>): ExportForm {
  if (pieceVideoFrame(piece) !== 'poster') return form;
  return { ...form, look: { ...form.look, ...aheadLook(form.videoAheadPoster) } };
}

export function videoOptions(formIn: ExportForm, piece: Piece, ctx: VideoContext): VideoOptions {
  const form = videoForm(formIn, piece);
  const frame = pieceVideoFrame(piece);
  const look = lookOf(form, 'video', { ...ctx, parts: partsOf(piece) });
  const o: VideoOptions = {
    aspect: form.videoAspect,
    size: form.videoSize,
    fps: form.videoFps,
    quality: form.videoQuality,
    camera: form.videoCamera,
    theme: look.theme,
    hud: look.hud.length > 0,
    thickness: look.thickness,
    colors: look.colors,
    customColors: piece.voices.map((v) => v.color),
    look,
  };
  // Keys without keys in the piece fall back to Follow, so they take Follow's window too.
  if (form.videoCamera !== 'whole') {
    // The renderer takes the window as seen at 16:9; the form's is what this aspect shows.
    o.window =
      form.videoWindow === null
        ? ctx.window
        : videoWindowAt16x9(followWindowOf(form, ctx), form.videoAspect);
    o.followAt = followAtOf(form) / 100;
  }
  const section = sectionOf(form, ctx);
  if (section) o.section = section;
  const bookends = bookendsOf(form, piece);
  if (bookends) o.bookends = bookends;
  if (form.loudness !== 'off') o.loudness = form.loudness;
  // M15: the frame, and Over the poster's row break and poster (the workspace's options).
  o.frame = frame;
  if (frame === 'poster') {
    o.rowBreak = pieceRowBreak(piece);
    o.poster = posterOptions(form, piece, ctx);
  }
  return o;
}

const fade = (v: number) =>
  Number.isFinite(v) ? Math.min(VIDEO_FADE_MAX, Math.max(0, Math.round(v * 10) / 10)) : 0;

/** The video's opening and ending from the form, or undefined when all are off. */
export function bookendsOf(
  form: ExportForm,
  piece: Pick<Piece, 'meta'>,
): VideoBookends | undefined {
  const b: VideoBookends = {};
  if (fade(form.videoFadeIn) > 0) b.fadeIn = fade(form.videoFadeIn);
  if (fade(form.videoLeadIn) > 0) b.leadIn = fade(form.videoLeadIn);
  if (form.videoTitleCard) {
    const text = (form.videoTitle ?? piece.meta.title).trim();
    const sub = form.videoSubtitle.trim();
    if (text) b.title = sub ? { text, subtitle: sub } : { text };
  }
  if (fade(form.videoFadeOut) > 0) b.fadeOut = fade(form.videoFadeOut);
  if (form.videoEndCard > 0) {
    b.endCard = form.videoEndCard;
    if (form.videoCredit.trim()) b.credit = form.videoCredit.trim();
  }
  return bookendsOn(b) ? b : undefined;
}

export function posterOptions(
  form: ExportForm,
  piece: Piece,
  ctx: LookAppContext & SectionContext,
): PosterOptions {
  const look = lookOf(form, 'poster', { ...ctx, parts: partsOf(piece) });
  const section = sectionOf(form, ctx);
  return {
    ...(section ? { section, pieceRange: form.posterPieceRange } : {}),
    size: { width: form.posterWidth, height: form.posterHeight },
    rows: form.posterRows,
    theme: look.theme,
    transparent: look.transparent,
    // Text boxes replaced the Title block switch (M14): the doc's, else the default title.
    title: true,
    thickness: look.thickness,
    colors: look.colors,
    customColors: piece.voices.map((v) => v.color),
    look,
  };
}

/** The poster's pixel size, "3840 × 2160 px". */
export function posterPixels(form: Pick<ExportForm, 'posterWidth' | 'posterHeight'>): string {
  return `${form.posterWidth} × ${form.posterHeight} px`;
}

// ---------------------------------------------------------------------------------------------
// Remembered choices (per viewer)
// ---------------------------------------------------------------------------------------------

/** localStorage key of the remembered Look and video/poster choices. */
export const EXPORT_PREFS_KEY = 'algorhythms.export';
/**
 * Version of the stored prefs. 2: line colours gained 'app' (the default). A record without it
 * predates that: its 'pitch' was the old default, not a choice, so it loads as 'app'.
 * 3: `hudLayout` (placed readouts). An older record's ordered lists load with an empty layout:
 * each readout in its default slot, the list's two columns as before.
 * 4: the Look's `colours` (§12 Colours) and the saved `colourSchemes`. An older record's line
 * colours and ink load as the Colours group's Lines (Ink and Custom as One colour).
 */
export const EXPORT_PREFS_VERSION = 4;

/** The form fields remembered per viewer. */
const REMEMBERED = [
  'loudness',
  'videoAspect',
  'videoSize',
  'videoFps',
  'videoQuality',
  'videoCamera',
  'videoFollowAt',
  'videoWindow',
  'videoHud',
  'videoAheadPoster',
  'videoFadeIn',
  'videoLeadIn',
  'videoTitleCard',
  'videoFadeOut',
  'videoEndCard',
  'videoCredit',
  'thumbnailAt',
  'descriptionLink',
  'posterFormat',
  'posterWidth',
  'posterHeight',
  'posterRows',
  'posterTitle',
  'posterPieceRange',
  'posterHud',
  'hudLayout',
  'look',
  'colourSchemes',
] as const satisfies readonly (keyof ExportForm)[];

export type ExportPrefs = Partial<Pick<ExportForm, (typeof REMEMBERED)[number]>>;

/** Storage as the prefs use it (localStorage, or a stub in tests). */
export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function storageOf(s?: PrefsStorage | null): PrefsStorage | null {
  if (s !== undefined) return s;
  return globalThis.localStorage ?? null;
}

/** Saves the remembered fields; false when storage is missing or throws. */
export function saveExportPrefs(form: ExportForm, storage?: PrefsStorage | null): boolean {
  try {
    const st = storageOf(storage);
    if (!st) return false;
    const o: Record<string, unknown> = { v: EXPORT_PREFS_VERSION };
    for (const k of REMEMBERED) o[k] = form[k];
    st.setItem(EXPORT_PREFS_KEY, JSON.stringify(o));
    return true;
  } catch {
    return false;
  }
}

/** The remembered fields that are valid; {} when nothing is stored or storage throws. */
export function loadExportPrefs(storage?: PrefsStorage | null): ExportPrefs {
  let raw: unknown;
  try {
    const text = storageOf(storage)?.getItem(EXPORT_PREFS_KEY);
    if (!text) return {};
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  return parsePrefs(raw);
}

const oneOf = <T>(list: readonly { id: T }[], v: unknown): v is T => list.some((o) => o.id === v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates stored prefs field by field (unknown or bad values are left out). */
export function parsePrefs(raw: unknown): ExportPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const p: ExportPrefs = {};
  if (oneOf(LOUDNESS_TARGETS, r.loudness)) p.loudness = r.loudness;
  if (oneOf(VIDEO_ASPECTS, r.videoAspect)) p.videoAspect = r.videoAspect;
  if (oneOf(VIDEO_SIZES, r.videoSize)) p.videoSize = r.videoSize;
  if (oneOf(VIDEO_FPS, r.videoFps)) p.videoFps = r.videoFps;
  if (oneOf(VIDEO_QUALITIES, r.videoQuality)) p.videoQuality = r.videoQuality;
  if (oneOf(VIDEO_CAMERAS, r.videoCamera)) p.videoCamera = r.videoCamera;
  if (r.videoFollowAt === null) p.videoFollowAt = null;
  else if (typeof r.videoFollowAt === 'number' && Number.isFinite(r.videoFollowAt)) {
    p.videoFollowAt = Math.min(FOLLOW_AT_MAX, Math.max(FOLLOW_AT_MIN, r.videoFollowAt));
  }
  if (r.videoWindow === null) p.videoWindow = null;
  else if (typeof r.videoWindow === 'number' && Number.isFinite(r.videoWindow)) {
    // The piece's cap applies where it is known (`followWindowOf`).
    p.videoWindow = Math.max(MIN_WINDOW, r.videoWindow);
  }
  if (Array.isArray(r.videoHud)) p.videoHud = hudInOrder(r.videoHud);
  if (num(r.videoAheadPoster)) {
    p.videoAheadPoster = Math.min(100, Math.max(0, Math.round(r.videoAheadPoster)));
  }
  if (num(r.videoFadeIn)) p.videoFadeIn = fade(r.videoFadeIn);
  if (num(r.videoLeadIn)) p.videoLeadIn = fade(r.videoLeadIn);
  if (isBool(r.videoTitleCard)) p.videoTitleCard = r.videoTitleCard;
  if (num(r.videoFadeOut)) p.videoFadeOut = fade(r.videoFadeOut);
  if (oneOf(VIDEO_END_CARDS, r.videoEndCard)) p.videoEndCard = r.videoEndCard;
  if (typeof r.videoCredit === 'string') p.videoCredit = r.videoCredit.slice(0, 120);
  if (oneOf(THUMBNAIL_ATS, r.thumbnailAt)) p.thumbnailAt = r.thumbnailAt;
  if (isBool(r.descriptionLink)) p.descriptionLink = r.descriptionLink;
  if (oneOf(POSTER_FORMATS, r.posterFormat)) p.posterFormat = r.posterFormat;
  // Size: explicit pixels, else an old record's preset (`posterSize`); both sides or neither.
  const preset = POSTER_SIZES.find((s) => s.id === r.posterSize);
  if (num(r.posterWidth) || num(r.posterHeight) || preset) {
    const base = preset ?? POSTER_SIZES[0];
    const dims = clampPosterDims(
      num(r.posterWidth) ? r.posterWidth : base.width,
      num(r.posterHeight) ? r.posterHeight : base.height,
    );
    p.posterWidth = dims.width;
    p.posterHeight = dims.height;
  }
  if (num(r.posterRows)) p.posterRows = clampRows(r.posterRows);
  if (isBool(r.posterTitle)) p.posterTitle = r.posterTitle;
  if (isBool(r.posterPieceRange)) p.posterPieceRange = r.posterPieceRange;
  if (Array.isArray(r.posterHud)) p.posterHud = hudInOrder(r.posterHud);
  if (typeof r.v === 'number' && r.v >= 3) {
    if (r.hudLayout && typeof r.hudLayout === 'object') p.hudLayout = parseHudLayout(r.hudLayout);
  } else if (Array.isArray(r.videoHud) || Array.isArray(r.posterHud)) {
    // Before v3 the lists' order was the layout: empty = their default slots.
    p.hudLayout = {};
  }
  const v = typeof r.v === 'number' ? r.v : 1;
  if (r.look && typeof r.look === 'object') {
    const look = r.look as Record<string, unknown>;
    p.look = parseLook(look);
    if (v < 4) {
      // Before v2 'pitch' was the unchosen default (ink and custom were real choices).
      const colors = v < 2 && look.colors === 'pitch' ? 'app' : look.colors;
      p.look.colours = coloursFromOld(colors, look.lineInk);
    }
  }
  if (Array.isArray(r.colourSchemes)) p.colourSchemes = parseSchemes(r.colourSchemes);
  return p;
}

/** A stored layout: each known readout with a valid position. */
export function parseHudLayout(raw: object): HudLayout {
  const r = raw as Record<string, unknown>;
  const out: HudLayout = {};
  for (const it of HUD_ITEMS) {
    const pos = parseHudPos(r[it]);
    if (pos) out[it] = pos;
  }
  return out;
}

const LOOK_FLAGS = [
  'transparent',
  'guides',
  'guideLabels',
  'markers',
  'sections',
  'levelOpacity',
  'thickness',
  'pulseMarks',
  'dots',
  'rings',
  'hzLabels',
  'playhead',
] as const satisfies readonly (keyof LookForm)[];

/** A stored Look over the defaults: each valid field kept, the rest default. */
function parseLook(r: Record<string, unknown>): LookForm {
  const l: LookForm = { ...DEFAULT_LOOK_FORM };
  if (oneOf(VIDEO_THEMES, r.theme)) l.theme = r.theme;
  for (const k of LOOK_FLAGS) {
    const v = r[k];
    if (isBool(v)) l[k] = v;
  }
  const beats = lookBeats(r.beats);
  if (beats) l.beats = beats;
  if (oneOf(LOOK_FUTURES, r.future)) l.future = r.future;
  if (typeof r.futureOpacity === 'number' && Number.isFinite(r.futureOpacity)) {
    l.futureOpacity = Math.min(1, Math.max(0, r.futureOpacity));
  }
  // The Ahead slider's ends are Hidden and Full: a dimmed 0 or 1 reads as those.
  if (l.future === 'dimmed' && l.futureOpacity <= 0) l.future = 'hidden';
  if (l.future === 'dimmed' && l.futureOpacity >= 1) l.future = 'full';
  if (r.colours && typeof r.colours === 'object') l.colours = parseColours(r.colours);
  for (const k of ['glow', 'vignette', 'minLineOpacity'] as const) {
    const v = r[k];
    if (num(v) && v > 0) l[k] = Math.min(1, v);
  }
  const pg = parsePitchGuides(r.pitchGuides);
  if (pg) l.pitchGuides = pg;
  if (oneOf(LOOK_WIDTHS, r.lineWidth)) l.lineWidth = r.lineWidth;
  else if (typeof r.lineWidth === 'number' && Number.isFinite(r.lineWidth)) {
    l.lineWidth = Math.min(LINE_SCALE_MAX, Math.max(LINE_SCALE_MIN, r.lineWidth));
  }
  return l;
}

/** Most guide lines at pitches a Look keeps. */
export const PITCH_GUIDES_MAX = 12;

/** Stored guide lines at pitches: MIDI 0..127, up to PITCH_GUIDES_MAX; null when none. */
export function parsePitchGuides(raw: unknown): { pitches: number[]; labels: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pitches)) return null;
  const pitches = r.pitches.filter((p): p is number => num(p) && p >= 0 && p <= 127);
  if (pitches.length === 0) return null;
  return { pitches: pitches.slice(0, PITCH_GUIDES_MAX), labels: r.labels !== false };
}

/**
 * Reset to defaults: the Look, the playhead place, the HUD layout and the open format's HUD
 * (video: today's; poster: none).
 */
export function resetLook(form: ExportForm): ExportForm {
  return {
    ...form,
    look: DEFAULT_LOOK_FORM,
    videoFollowAt: null,
    hudLayout: {},
    ...(form.format === 'poster' ? { posterHud: [] } : { videoHud: DEFAULT_HUD }),
  };
}

const CODEC_NAMES: [string, string][] = [
  ['avc1', 'H.264'],
  ['vp09', 'VP9'],
  ['mp4a', 'AAC'],
  ['opus', 'Opus'],
];

/** "H.264 + AAC" from WebCodecs codec strings. */
export function codecLabel(video: string, audio: string): string {
  const name = (c: string) => CODEC_NAMES.find(([p]) => c.startsWith(p))?.[1] ?? c;
  return `${name(video)} + ${name(audio)}`;
}

/**
 * The dialog's one line when this browser can't encode AAC (§12 "Ready for YouTube"), else null.
 */
export function aacNote(support: VideoSupport | null): string | null {
  if (!support?.ok || support.aac) return null;
  return 'This browser can’t encode AAC, so the audio is Opus; some players (QuickTime, iPhone Photos) may not play it.';
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** Decimal units, as the 1 GB warning is: 1 234 567 bytes gives "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1e3) return `${Math.round(bytes)} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 1e4 ? 1 : 0)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
