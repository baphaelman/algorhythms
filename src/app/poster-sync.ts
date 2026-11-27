/**
 * The poster workspace's edits on the piece (PLAN.md §15 M14 "Stored in the piece", "Every edit
 * undoes"): while the workspace shows, the Export form's poster fields and `Piece.poster` are
 * kept in step, and every poster edit is one entry on the piece's undo stack.
 *
 * - Form → doc: a change of the panel's options writes the doc (`docWithForm`). Changes to the
 *   same fields within `COALESCE_MS` of each other (a slider's drag, typing) join one entry. In
 *   Video, they only update a doc the piece already has.
 * - Doc → form: when the doc changes from elsewhere (undo, redo, opening the workspace), the
 *   form shows it (`formWithDoc`); back to no doc, the form the workspace opened with.
 * - Object edits (layers, texts, groups, margins) go through `editPoster` (one entry) or
 *   `posterGesture` (a drag: one entry when it ends). A piece's first doc starts from the form's
 *   settings, so nothing it shows moves.
 */

import type { Piece, PosterDoc } from '../core/types';
import type { ExportForm } from './export-options';
import {
  amend,
  beginGesture,
  cancelGesture,
  edit,
  endGesture,
  lastEntry,
  updateGesture,
} from './editor/history';
import { appDark, useExportUi, videoContext } from './ui/export-state';
import {
  changedFields,
  defaultPosterDoc,
  docWithForm,
  formWithDoc,
  posterFields,
  videoLook,
  type DocContext,
  type PosterFields,
} from './poster-doc';
import { usePlayer } from './store';
import { useExportSurface } from './export-surface';

/** Panel changes this close together (ms) to the same fields are one undo entry. */
export const COALESCE_MS = 1000;

const docContext = (): DocContext => ({ ...videoContext(), dark: appDark() });

/** The piece with `doc` (none: no `poster` field). */
export function withPoster(piece: Piece, doc: PosterDoc | undefined): Piece {
  if (piece.poster === doc) return piece;
  if (doc) return { ...piece, poster: doc };
  const { poster: _p, ...rest } = piece;
  return rest;
}

let active = false;
/** True while this module changes the piece (its own changes are not shown back). */
let writing = false;
/** The poster as the workspace opened (a doc; none = the defaults): Revert's target with no save point. */
let opened: PosterDoc | undefined;
let lastFields: PosterFields | null = null;
let baseline: PosterFields | null = null;
let run: { key: string; at: number; entry: object | null } | null = null;
/** The form whose change this module last wrote to the piece, and that undo entry. */
let wrote: { form: ExportForm; entry: object | null } | null = null;
/** The fields when a form gesture began (`posterFormGesture`); null when none is open. */
let gestureBase: PosterFields | null = null;

function mine<T>(f: () => T): T {
  writing = true;
  try {
    return f();
  } finally {
    writing = false;
  }
}

/** Shows `doc`'s settings in the form (none: the form the workspace opened with). */
function showDoc(doc: PosterDoc | undefined): void {
  const { form } = useExportUi.getState();
  const next = doc
    ? formWithDoc(form, doc)
    : baseline
      ? { ...form, ...baseline, look: { ...baseline.look, ...videoLook(form.look) } }
      : form;
  lastFields = posterFields(next);
  run = null;
  if (next !== form) useExportUi.setState({ form: next });
}

function writeForm(f: PosterFields): void {
  const prev = lastFields;
  lastFields = f;
  if (!prev) return;
  const changed = changedFields(prev, f);
  if (changed.length === 0) return;
  // Video changes (its section) on a piece without a poster stay the form's: a first doc only
  // comes from Poster, so opening Video never turns One row into Over the poster (M15).
  if (!usePlayer.getState().piece.poster && useExportSurface.getState().surface !== 'poster') {
    return;
  }
  const ctx = docContext();
  if (gestureBase) {
    const base = gestureBase;
    mine(() => updateGesture((p) => withPoster(p, docWithForm(p.poster, f, ctx, base))));
    return;
  }
  const recipe = (p: Piece) => withPoster(p, docWithForm(p.poster, f, ctx, prev));
  const key = changed.join(',');
  const now = performance.now();
  mine(() => {
    if (run && run.key === key && now - run.at < COALESCE_MS && lastEntry() === run.entry) {
      amend(run.entry, recipe, 'Poster');
      run.at = now;
    } else {
      edit(recipe, 'Poster');
      run = { key, at: now, entry: lastEntry() };
    }
  });
}

/**
 * Starts keeping the form and the piece's poster in step (the workspace calls it on mount);
 * returns the stop function.
 */
export function startPosterSync(): () => void {
  active = true;
  baseline = posterFields(useExportUi.getState().form);
  lastFields = baseline;
  opened = usePlayer.getState().piece.poster;
  run = null;
  const doc = usePlayer.getState().piece.poster;
  if (doc) showDoc(doc);
  let shown = usePlayer.getState().piece.poster;
  const offPiece = usePlayer.subscribe((s) => {
    const d = s.piece.poster;
    if (d === shown) return;
    shown = d;
    if (!writing) showDoc(d);
  });
  const offForm = useExportUi.subscribe((s, p) => {
    if (s.form === p.form) return;
    const before = usePlayer.getState().piece;
    writeForm(posterFields(s.form));
    if (usePlayer.getState().piece !== before) wrote = { form: s.form, entry: lastEntry() };
  });
  return () => {
    offPiece();
    offForm();
    active = false;
    lastFields = null;
    baseline = null;
    run = null;
    gestureBase = null;
    wrote = null;
  };
}

/**
 * The undo entry this module wrote `form`'s change to (the video sync joins it: one change of a
 * shared field, one entry), or null.
 */
export function posterEntryFor(form: ExportForm): object | null {
  return wrote && wrote.form === form && lastEntry() === wrote.entry ? wrote.entry : null;
}

/** True while the workspace keeps the poster in step. */
export const posterSyncActive = (): boolean => active;

type DocFn = (doc: PosterDoc | undefined) => PosterDoc | undefined;

/** The piece's doc, or (none yet) one holding the form's settings. */
function docOf(p: Piece): PosterDoc | undefined {
  if (p.poster) return p.poster;
  return docWithForm(undefined, posterFields(useExportUi.getState().form), docContext());
}

const recipeOf =
  (fn: DocFn) =>
  (p: Piece): Piece => {
    const base = docOf(p);
    const next = fn(base);
    return next === base ? p : withPoster(p, next);
  };

/** One poster edit, one undo entry; false when nothing changed. */
export function editPoster(fn: DocFn, label = 'Poster'): boolean {
  run = null;
  return mine(() => edit(recipeOf(fn), label));
}

/**
 * A poster edit that coalesces with the previous one of the same `key` within `COALESCE_MS`
 * (arrow-key nudges, typed numbers): one undo entry for the run.
 */
export function editPosterRun(key: string, fn: DocFn, label = 'Poster'): boolean {
  const now = performance.now();
  const recipe = recipeOf(fn);
  return mine(() => {
    if (run && run.key === key && now - run.at < COALESCE_MS && lastEntry() === run.entry) {
      run.at = now;
      return amend(run.entry, recipe, label);
    }
    const ok = edit(recipe, label);
    run = ok ? { key, at: now, entry: lastEntry() } : null;
    return ok;
  });
}

/**
 * The undo entry the last edit made (for `editPosterJoin`), or null when it changed nothing.
 */
export function editPosterEntry(fn: DocFn, label = 'Poster'): object | null {
  run = null;
  return mine(() => (edit(recipeOf(fn), label) ? lastEntry() : null));
}

/**
 * A poster edit that joins `entry` while it is still the newest undo entry (a new text box and
 * its first text: one step); otherwise its own entry.
 */
export function editPosterJoin(entry: object | null, fn: DocFn, label = 'Poster'): boolean {
  run = null;
  return mine(() => amend(entry, recipeOf(fn), label));
}

/** A drag on the artboard: `update` replaces the change so far; one undo entry at `end`. */
export interface PosterGesture {
  update(fn: DocFn): void;
  end(): void;
  cancel(): void;
}

export function posterGesture(label = 'Poster'): PosterGesture {
  run = null;
  mine(() => beginGesture(label));
  return {
    update: (fn) => mine(() => updateGesture(recipeOf(fn))),
    end: () => mine(() => endGesture()),
    cancel: () => mine(() => cancelGesture()),
  };
}

/**
 * A drag that writes the form (gradient handles): form changes until `end` are one undo entry.
 * `cancel` puts the piece and the form back.
 */
export function posterFormGesture(label = 'Poster'): { end(): void; cancel(): void } {
  run = null;
  gestureBase = lastFields;
  mine(() => beginGesture(label));
  return {
    end: () => {
      gestureBase = null;
      mine(() => endGesture());
    },
    cancel: () => {
      gestureBase = null;
      mine(() => cancelGesture());
      if (active) showDoc(usePlayer.getState().piece.poster);
    },
  };
}

/** `doc` as a comparable string: no doc is the default poster. */
const keyOf = (doc: PosterDoc | undefined): string =>
  JSON.stringify(doc ?? defaultPosterDoc(docContext()));

function setPoster(doc: PosterDoc | undefined, label: string): boolean {
  run = null;
  const ok = mine(() =>
    edit((p) => (keyOf(p.poster) === keyOf(doc) ? p : withPoster(p, doc)), label),
  );
  if (ok && active) showDoc(doc);
  return ok;
}

/** Full revert: the poster back to its defaults, as one undo entry; false when already so. */
export function revertPoster(): boolean {
  return setPoster(defaultPosterDoc(docContext()), 'Revert poster');
}

/** Where Revert goes: the save point, else the poster as the workspace opened. */
const savePoint = (p: Piece): PosterDoc | undefined => p.posterSaved ?? opened;

/** True when Revert has nothing to do (the poster is its save point). */
export function posterAtSavePoint(piece: Piece): boolean {
  return keyOf(piece.poster) === keyOf(savePoint(piece));
}

/** True when the poster is the save point (Save has nothing to do). */
export function posterSaved(piece: Piece): boolean {
  return !!piece.posterSaved && keyOf(piece.poster) === keyOf(piece.posterSaved);
}

/** Save: a copy of the poster stored in the piece, as one undo entry. */
export function savePoster(): boolean {
  run = null;
  return mine(() =>
    edit((p) => {
      if (posterSaved(p)) return p;
      return {
        ...p,
        posterSaved: structuredClone(p.poster ?? defaultPosterDoc(docContext()) ?? {}),
      };
    }, 'Save poster'),
  );
}

/** Revert: the poster back to its save point (see `savePoint`), one undo entry. */
export function revertToSaved(): boolean {
  const doc = savePoint(usePlayer.getState().piece);
  return setPoster(doc && structuredClone(doc), 'Revert to saved');
}

/** True when the piece's poster is the default one (Revert has nothing to do). */
export function posterIsDefault(doc: PosterDoc | undefined): boolean {
  return JSON.stringify(doc) === JSON.stringify(defaultPosterDoc(docContext()));
}
