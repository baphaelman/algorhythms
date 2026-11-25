/**
 * The poster's settings in the piece (PLAN.md §15 M14 "Stored in the piece"): the workspace's
 * panel options (size, rows, section, pitch range, Look, HUD) live in `Piece.poster` beside the
 * objects (layers, texts, groups, margins). Pure helpers between the Export form and the doc.
 *
 * A piece with a doc draws from the doc over the export defaults, never over the viewer's
 * remembered options, so a share link restores it exactly. A piece without one draws from the
 * viewer's options (today). `doc.look` holds the form's Look as differences from the defaults:
 * the Look keys the renderer reads (theme always, resolved), the HUD list and layout, and the
 * Colours group's form under `coloursForm` (the renderer ignores it; the app resolves it).
 */

import type { Piece, PosterDoc, PosterGroup } from '../core/types';
import {
  DEFAULT_EXPORT_FORM,
  DEFAULT_LOOK_FORM,
  parsePrefs,
  sectionOf,
  type ExportForm,
  type SectionContext,
} from './export-options';
import { DEFAULT_COLOURS } from './export-colours';

/** The form fields a poster doc holds. */
export const DOC_FIELDS = [
  'posterWidth',
  'posterHeight',
  'posterRows',
  'posterPieceRange',
  'section',
  'sectionSpan',
  'posterHud',
  'hudLayout',
  'look',
] as const satisfies readonly (keyof ExportForm)[];

export type PosterFields = Pick<ExportForm, (typeof DOC_FIELDS)[number]>;

/**
 * The Look keys only the video uses (Ahead of the playhead, the playhead line, the heads): the
 * viewer's remembered video options (PLAN.md §15 M15 "Storage"), never in the poster's doc.
 */
export const VIDEO_LOOK_KEYS = [
  'future',
  'futureOpacity',
  'playhead',
  'dots',
  'rings',
  'hzLabels',
] as const satisfies readonly (keyof ExportForm['look'])[];

/** `look` without the video's own keys. */
export function posterLook(look: ExportForm['look']): Partial<ExportForm['look']> {
  const out: Record<string, unknown> = { ...look };
  for (const k of VIDEO_LOOK_KEYS) delete out[k];
  return out as Partial<ExportForm['look']>;
}

/** The video's own Look keys of `look`. */
export function videoLook(look: ExportForm['look']): Partial<ExportForm['look']> {
  const out: Record<string, unknown> = {};
  for (const k of VIDEO_LOOK_KEYS) if (k in look) out[k] = look[k];
  return out as Partial<ExportForm['look']>;
}

export function posterFields(form: ExportForm): PosterFields {
  const out = {} as Record<string, unknown>;
  for (const k of DOC_FIELDS) out[k] = form[k];
  return out as PosterFields;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The fields whose values differ. */
export function changedFields(a: PosterFields, b: PosterFields): string[] {
  return DOC_FIELDS.filter((k) =>
    k === 'look' ? !same(posterLook(a.look), posterLook(b.look)) : !same(a[k], b[k]),
  );
}

/** What the doc's settings need from the app: its theme, and the piece's length and loop. */
export interface DocContext extends SectionContext {
  dark: boolean;
}

/** The Look keys a group's visibility follows by default: changing one clears the override. */
const GROUP_KEYS: Readonly<Partial<Record<PosterGroup, readonly string[]>>> = {
  sectionLabels: ['sections'],
  sectionLines: ['sections', 'sectionLines'],
  momentLabels: ['momentLabels'],
  momentLines: ['markers'],
  guideLabels: ['guides', 'guideLabels'],
  guideLines: ['guides'],
  pitchLabels: ['pitchGuides'],
  pitchLines: ['pitchGuides'],
  beatLines: ['beats'],
  pulseMarks: ['pulseMarks'],
};

/**
 * `doc` with its settings from the form's poster fields (differences from the defaults only);
 * its objects (layers, texts, groups, members, margins) kept. `prev`: the fields before the
 * change; a Look key a group's visibility follows by default (Moments, Guides) clears that
 * group's visible override, so the Look's control takes effect again.
 */
export function docWithForm(
  doc: PosterDoc | undefined,
  form: PosterFields,
  ctx: DocContext,
  prev?: PosterFields,
): PosterDoc | undefined {
  const out: PosterDoc = {};
  const d = DEFAULT_EXPORT_FORM;
  if (form.posterWidth !== d.posterWidth || form.posterHeight !== d.posterHeight) {
    out.size = { w: form.posterWidth, h: form.posterHeight };
  }
  if (form.posterRows !== 1) out.rows = form.posterRows;
  const section = sectionOf(form, ctx);
  if (section) {
    out.section = { start: section.start, end: section.end };
    if (form.posterPieceRange) out.pieceRange = true;
  }
  if (doc?.margins) out.margins = doc.margins;
  out.look = lookDiff(form, ctx.dark);
  if (doc?.layers) out.layers = doc.layers;
  if (doc?.texts) out.texts = doc.texts;
  let groups = doc?.groups;
  if (groups && prev) {
    const now = form.look as unknown as Record<string, unknown>;
    const was = prev.look as unknown as Record<string, unknown>;
    const changed = Object.keys(now).filter((k) => !same(now[k], was[k]));
    for (const [g, keys] of Object.entries(GROUP_KEYS)) {
      const s = groups[g as PosterGroup];
      if (s?.visible !== undefined && keys.some((k) => changed.includes(k))) {
        const { visible: _v, ...rest } = s;
        groups = { ...groups };
        if (Object.keys(rest).length > 0) groups[g as PosterGroup] = rest;
        else delete groups[g as PosterGroup];
      }
    }
    if (Object.keys(groups).length === 0) groups = undefined;
  }
  if (groups) out.groups = groups;
  if (doc?.members) out.members = doc.members;
  if (doc?.rowsBy) out.rowsBy = doc.rowsBy;
  if (doc?.rowSections) out.rowSections = doc.rowSections;
  if (doc?.picture) out.picture = doc.picture;
  return out;
}

/**
 * The default poster as a doc (Revert, PLAN.md §15 M14): the export defaults' poster fields, no
 * objects. Only the resolved theme is stored, as for every doc.
 */
export function defaultPosterDoc(ctx: DocContext): PosterDoc | undefined {
  return docWithForm(undefined, posterFields(DEFAULT_EXPORT_FORM), ctx);
}

/** The form's Look as the doc stores it: what differs from the defaults, the theme resolved. */
function lookDiff(form: PosterFields, dark: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const look = form.look as unknown as Record<string, unknown>;
  const def = DEFAULT_LOOK_FORM as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(def), ...Object.keys(look)])) {
    if (k === 'theme' || k === 'colours' || (VIDEO_LOOK_KEYS as readonly string[]).includes(k))
      continue;
    if (look[k] !== undefined && !same(look[k], def[k])) out[k] = look[k];
  }
  out.theme = form.look.theme === 'current' ? (dark ? 'dark' : 'light') : form.look.theme;
  const c = form.look.colours as unknown as Record<string, unknown>;
  const dc = DEFAULT_COLOURS as unknown as Record<string, unknown>;
  const colours: Record<string, unknown> = {};
  for (const k of Object.keys(c)) if (!same(c[k], dc[k])) colours[k] = c[k];
  if (Object.keys(colours).length > 0) out.coloursForm = colours;
  if (form.posterHud.length > 0) out.hud = [...form.posterHud];
  if (Object.keys(form.hudLayout).length > 0) out.hudLayout = form.hudLayout;
  return out;
}

/**
 * The form showing a doc's settings: the defaults with the doc's values over them (validated as
 * stored prefs are). The section shows as Custom (Whole when the doc has none); a remembered
 * Custom span is kept for Whole.
 */
export function formWithDoc(form: ExportForm, doc: PosterDoc): ExportForm {
  const d = DEFAULT_EXPORT_FORM;
  const l = doc.look ?? {};
  const { hud, hudLayout, coloursForm, ...look } = l as Record<string, unknown>;
  const p = parsePrefs({
    v: 4,
    posterWidth: doc.size?.w ?? d.posterWidth,
    posterHeight: doc.size?.h ?? d.posterHeight,
    posterRows: doc.rows ?? 1,
    posterPieceRange: doc.pieceRange === true,
    posterHud: Array.isArray(hud) ? hud : [],
    hudLayout: hudLayout && typeof hudLayout === 'object' ? hudLayout : {},
    look: {
      ...look,
      colours: {
        ...DEFAULT_COLOURS,
        ...(coloursForm && typeof coloursForm === 'object' ? coloursForm : {}),
      },
    },
  });
  const out: ExportForm = {
    ...form,
    posterWidth: p.posterWidth ?? d.posterWidth,
    posterHeight: p.posterHeight ?? d.posterHeight,
    posterRows: p.posterRows ?? 1,
    posterPieceRange: p.posterPieceRange ?? false,
    posterHud: p.posterHud ?? [],
    hudLayout: p.hudLayout ?? {},
    // The video's own keys stay the viewer's.
    look: { ...(p.look ?? DEFAULT_LOOK_FORM), ...videoLook(form.look) },
  };
  // Look keys parseLook doesn't know (the label/line split) pass through as booleans.
  for (const k of ['sectionLines', 'momentLabels'] as const) {
    if (typeof look[k] === 'boolean') out.look = { ...out.look, [k]: look[k] };
  }
  if (doc.section) {
    out.section = 'custom';
    out.sectionSpan = { start: doc.section.start, end: doc.section.end };
  } else out.section = 'whole';
  return out;
}

/** True when `a` and `b` differ in `poster` only (every other field the same object). */
export function onlyPosterDiffers(a: Piece, b: Piece): boolean {
  if (a.poster === b.poster) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k !== 'poster' && a[k as keyof Piece] !== b[k as keyof Piece]) return false;
  }
  return true;
}
