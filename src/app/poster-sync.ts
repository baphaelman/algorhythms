/**
 * The poster workspace's edits on the piece (PLAN.md §15 M14 "Stored in the piece", "Every edit
 * undoes"): while the workspace shows, the Export form's poster fields and `Piece.poster` are
 * kept in step, and every poster edit is one entry on the piece's undo stack.
 *
 * - Form → doc: a change of the panel's options writes the doc (`docWithForm`). Changes to the
 *   same fields within `COALESCE_MS` of each other (a slider's drag, typing) join one entry.
 * - Doc → form: when the doc changes from elsewhere (undo, redo, opening the workspace), the
 *   form shows it (`formWithDoc`); back to no doc, the form the workspace opened with.
 * - Object edits (layers, texts, groups, margins) go through `editPoster` (one entry) or
 *   `posterGesture` (a drag: one entry when it ends). A piece's first doc starts from the form's
 *   settings, so nothing it shows moves.
 */

import type { Piece, PosterDoc } from '../core/types';
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
  docWithForm,
  formWithDoc,
  posterFields,
  type DocContext,
  type PosterFields,
} from './poster-doc';
import { usePlayer } from './store';

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
let lastFields: PosterFields | null = null;
let baseline: PosterFields | null = null;
let run: { key: string; at: number; entry: object | null } | null = null;

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
  const next = doc ? formWithDoc(form, doc) : baseline ? { ...form, ...baseline } : form;
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
  const ctx = docContext();
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
    if (s.form !== p.form) writeForm(posterFields(s.form));
  });
  return () => {
    offPiece();
    offForm();
    active = false;
    lastFields = null;
    baseline = null;
    run = null;
  };
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
