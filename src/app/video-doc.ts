/**
 * The video in the piece (PLAN.md §15 M17): the Video workspace's options that say what the video
 * shows live in `Piece.video`; the file settings (size, frame rate, quality, loudness, thumbnail,
 * description) stay the viewer's. Pure helpers between the Export form and the record.
 *
 * A piece with a record shows the record over the fixed defaults, never over the viewer's
 * remembered options, so a link plays the maker's video frame for frame. That covers every input
 * of a frame: the Look (theme resolved, colours), the HUD and its layout, the editor's zoom (a
 * Follow window left to it uses the record's `zoom`, else the piece's `view.window`, never the
 * viewer's) and the app's line colours ('app' lines: the piece's `view.colors`, or the maker's under `appColors`).
 * With a poster, the poster's settings (section, HUD layout, the Look's poster keys) draw over the
 * record's, as they did before (poster-doc.ts `formWithDoc`). A piece without a record plays with
 * the viewer's options.
 */

import { roundTime } from '../core/canonical';
import type { LineColors, Piece, PieceVideo } from '../core/types';
import { DEFAULT_HUD } from '../render/hud';
import { pieceVideoFrame } from '../render/poster-video';
import { END_CREDIT } from '../render/video';
import { DEFAULT_COLOURS } from './export-colours';
import {
  DEFAULT_EXPORT_FORM,
  DEFAULT_LOOK_FORM,
  cameraChoice,
  followWindowOf,
  parsePrefs,
  sectionOf,
  type ExportForm,
  type VideoContext,
} from './export-options';
import { formWithDoc } from './poster-doc';

/** The form fields the record holds. */
export const VIDEO_FIELDS = [
  'videoAspect',
  'videoCamera',
  'videoFollowAt',
  'videoWindow',
  'videoHud',
  'hudLayout',
  'videoAheadPoster',
  'section',
  'sectionSpan',
  'videoFadeIn',
  'videoLeadIn',
  'videoTitleCard',
  'videoTitle',
  'videoSubtitle',
  'videoFadeOut',
  'videoEndCard',
  'videoCredit',
  'look',
] as const satisfies readonly (keyof ExportForm)[];

export type VideoFields = Pick<ExportForm, (typeof VIDEO_FIELDS)[number]>;

export function videoFields(form: ExportForm): VideoFields {
  const out = {} as Record<string, unknown>;
  for (const k of VIDEO_FIELDS) out[k] = form[k];
  return out as VideoFields;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The record's fields whose values differ. */
export function changedVideoFields(a: VideoFields, b: VideoFields): string[] {
  return VIDEO_FIELDS.filter((k) => !same(a[k], b[k]));
}

type WindowPiece = Pick<Piece, 'camera' | 'poster' | 'view'>;

/**
 * The record of what the form shows for `piece` (differences from the defaults only). `ctx` is
 * the app now: a null window is the editor's zoom, 'current' the app's theme, 'app' lines the
 * app's colours; each is stored resolved, so the record shows the same anywhere.
 */
export function recordFromForm(
  form: VideoFields,
  piece: WindowPiece,
  ctx: VideoContext,
): PieceVideo {
  const d = DEFAULT_EXPORT_FORM;
  const r: PieceVideo = {};
  if (form.videoAspect !== d.videoAspect) r.aspect = form.videoAspect;
  if (form.videoCamera === 'whole') r.whole = true;
  if (form.videoFollowAt !== null) r.followAt = form.videoFollowAt;
  if (form.videoWindow !== null) r.window = roundTime(followWindowOf(form, ctx));
  else if (pieceVideoFrame(piece) === 'row') {
    // Left to the editor's zoom: the maker's zoom now, unless it is the piece's.
    const zoom = roundTime(ctx.window);
    if (zoom !== roundTime(piece.view.window)) r.zoom = zoom;
  }
  if (!same(form.videoHud, d.videoHud)) r.hud = [...form.videoHud];
  if (Object.keys(form.hudLayout).length > 0) {
    r.hudLayout = structuredClone(form.hudLayout) as Record<string, unknown>;
  }
  if (form.videoAheadPoster !== d.videoAheadPoster) r.ahead = form.videoAheadPoster;
  const section = sectionOf(form, ctx);
  if (section) r.section = { start: roundTime(section.start), end: roundTime(section.end) };
  if (form.videoFadeIn > 0) r.fadeIn = form.videoFadeIn;
  if (form.videoLeadIn > 0) r.leadIn = form.videoLeadIn;
  if (form.videoTitleCard) r.titleCard = true;
  if (form.videoTitle !== null) r.title = form.videoTitle;
  if (form.videoSubtitle !== '') r.subtitle = form.videoSubtitle;
  if (form.videoFadeOut > 0) r.fadeOut = form.videoFadeOut;
  if (form.videoEndCard > 0) r.endCard = form.videoEndCard;
  if (form.videoCredit !== END_CREDIT) r.credit = form.videoCredit;
  r.look = lookRecord(form.look, piece, ctx);
  return r;
}

/** The form's Look as the record stores it: differences from the defaults, theme resolved. */
function lookRecord(
  look: ExportForm['look'],
  piece: WindowPiece,
  ctx: VideoContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const l = look as unknown as Record<string, unknown>;
  const def = DEFAULT_LOOK_FORM as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(def), ...Object.keys(l)])) {
    if (k === 'theme' || k === 'colours') continue;
    if (l[k] !== undefined && !same(l[k], def[k])) out[k] = structuredClone(l[k]);
  }
  out.theme = look.theme === 'current' ? (ctx.dark ? 'dark' : 'light') : look.theme;
  const c = look.colours as unknown as Record<string, unknown>;
  const dc = DEFAULT_COLOURS as unknown as Record<string, unknown>;
  const colours: Record<string, unknown> = {};
  for (const k of Object.keys(c)) if (!same(c[k], dc[k])) colours[k] = structuredClone(c[k]);
  if (Object.keys(colours).length > 0) out.coloursForm = colours;
  // 'app' lines follow the app's colour mode: the piece's, unless the maker switched it.
  if (look.colours.lines === 'app' && ctx.colors !== piece.view.colors) out.appColors = ctx.colors;
  return out;
}

const LINE_COLORS: readonly LineColors[] = ['pitch', 'ink', 'custom'];

/**
 * The app context a frame of `piece` draws with: a piece with a record takes its line colours and
 * zoom from the piece (and the record's `appColors`), never from the viewer's app.
 */
export function videoContextFor<C extends VideoContext>(piece: Piece, live: C): C {
  const rec = piece.video;
  if (!rec) return live;
  const app = rec.look?.appColors;
  const colors = LINE_COLORS.includes(app as LineColors) ? (app as LineColors) : piece.view.colors;
  const theme = rec.look?.theme;
  return {
    ...live,
    colors,
    window: num(rec.zoom) && rec.zoom > 0 ? rec.zoom : piece.view.window,
    dark: theme === 'dark' || (theme !== 'light' && live.dark),
  };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The form showing `piece`'s record: the defaults with the record's values over them (validated
 * as stored prefs are), the file settings and the poster's own fields kept. With a poster, its
 * settings then draw over them (`formWithDoc`), as before.
 */
export function formWithRecord(form: ExportForm, piece: Piece): ExportForm {
  const rec = piece.video;
  if (!rec) return form;
  const d = DEFAULT_EXPORT_FORM;
  const { coloursForm, appColors: _a, ...look } = (rec.look ?? {}) as Record<string, unknown>;
  const p = parsePrefs({
    v: 4,
    videoAspect: rec.aspect ?? d.videoAspect,
    videoFollowAt: rec.followAt ?? null,
    videoHud: rec.hud ?? d.videoHud,
    hudLayout: rec.hudLayout ?? {},
    videoAheadPoster: rec.ahead ?? d.videoAheadPoster,
    videoFadeIn: rec.fadeIn ?? 0,
    videoLeadIn: rec.leadIn ?? 0,
    videoTitleCard: rec.titleCard === true,
    videoFadeOut: rec.fadeOut ?? 0,
    videoEndCard: rec.endCard ?? 0,
    videoCredit: rec.credit ?? END_CREDIT,
    look: {
      ...look,
      colours: {
        ...DEFAULT_COLOURS,
        ...(coloursForm && typeof coloursForm === 'object' ? coloursForm : {}),
      },
    },
  });
  const aspect = p.videoAspect ?? d.videoAspect;
  let out: ExportForm = {
    ...form,
    videoAspect: aspect,
    videoCamera: cameraChoice({ videoCamera: rec.whole ? 'whole' : 'follow' }, piece),
    videoFollowAt: p.videoFollowAt ?? null,
    videoWindow: num(rec.window) ? rec.window : null,
    videoHud: p.videoHud ?? DEFAULT_HUD,
    hudLayout: p.hudLayout ?? {},
    videoAheadPoster: p.videoAheadPoster ?? d.videoAheadPoster,
    // A remembered Custom span is kept for Whole (as formWithDoc does).
    section: rec.section ? 'custom' : 'whole',
    sectionSpan: rec.section
      ? { start: rec.section.start, end: rec.section.end }
      : form.sectionSpan,
    videoFadeIn: p.videoFadeIn ?? 0,
    videoLeadIn: p.videoLeadIn ?? 0,
    videoTitleCard: p.videoTitleCard ?? false,
    videoTitle: typeof rec.title === 'string' ? rec.title : null,
    videoSubtitle: typeof rec.subtitle === 'string' ? rec.subtitle : '',
    videoFadeOut: p.videoFadeOut ?? 0,
    videoEndCard: p.videoEndCard ?? 0,
    videoCredit: p.videoCredit ?? END_CREDIT,
    look: p.look ?? DEFAULT_LOOK_FORM,
  };
  // Look keys parseLook doesn't know (the label/line split) pass through as booleans.
  for (const k of ['sectionLines', 'momentLabels'] as const) {
    if (typeof look[k] === 'boolean') out.look = { ...out.look, [k]: look[k] };
  }
  if (piece.poster) out = formWithDoc(out, piece.poster);
  return out;
}

/**
 * The form a video of `piece` draws with, from the viewer's form `base`: the record's (and the
 * poster's) settings when the piece has a record, else `base` (with the poster's, if any).
 */
export function formForPiece(base: ExportForm, piece: Piece): ExportForm {
  if (piece.video) return formWithRecord(base, piece);
  return piece.poster ? formWithDoc(base, piece.poster) : base;
}

/**
 * `formWithRecord` for the form that wrote the record (the Video workspace after an edit): the
 * same, except that a Current theme and a Loop region section stay when they show the record's.
 */
export function formSettled(form: ExportForm, piece: Piece, ctx: VideoContext): ExportForm {
  let next = formWithRecord(form, piece);
  if (form.look.theme === 'current') {
    const name = ctx.dark ? 'dark' : 'light';
    if (next.look.theme === name) next = { ...next, look: { ...next.look, theme: 'current' } };
  }
  if (form.section === 'loop' && same(sectionOf(form, ctx), sectionOf(next, ctx))) {
    next = { ...next, section: form.section, sectionSpan: form.sectionSpan };
  }
  return next;
}
