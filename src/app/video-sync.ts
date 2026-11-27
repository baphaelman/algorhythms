/**
 * The Video workspace's edits on the piece (PLAN.md §15 M17 "The video in the piece"): while
 * Video shows, the Export form's video fields and `Piece.video` are kept in step, and every video
 * edit is one entry on the piece's undo stack (as poster-sync.ts does for the poster).
 *
 * - Record → form: entering Video, and when the record changes from elsewhere (undo, redo,
 *   another piece), the form shows it (`formWithRecord`). A piece without one keeps the viewer's
 *   options.
 * - Form → record: a change of a video field writes the whole record from what the form shows
 *   (`recordFromForm`), so a piece's first edit captures everything it shows. Changes to the same
 *   fields within `COALESCE_MS` join one entry; a change poster-sync also wrote to the poster
 *   (the shared section, HUD layout and Look) joins its entry.
 * - A camera edit (CameraKeys) on a piece without a record adds one in the same entry.
 */

import type { Piece, PieceVideo } from '../core/types';
import { jsonEqual } from '../core/schema';
import { pieceVideoFrame } from '../render/poster-video';
import { amend, edit, inGesture, lastEntry, useEditor } from './editor/history';
import { useExportSurface } from './export-surface';
import { posterEntryFor } from './poster-sync';
import { loadInfo, usePlayer } from './store';
import { clampPreview, useExportUi, videoContext, viewerVideoForm } from './ui/export-state';
import {
  changedVideoFields,
  formSettled,
  formWithRecord,
  recordFromForm,
  videoFields,
  type VideoFields,
} from './video-doc';

/** Panel changes this close together (ms) to the same fields are one undo entry. */
export const COALESCE_MS = 1000;

/** The piece with `rec` (none: no `video` field). */
export function withVideo(piece: Piece, rec: PieceVideo | undefined): Piece {
  if (piece.video === rec || (rec && piece.video && jsonEqual(piece.video, rec))) return piece;
  if (rec) return { ...piece, video: rec };
  if (!piece.video) return piece;
  const { video: _v, ...rest } = piece;
  return rest;
}

let writing = false;
let lastFields: VideoFields | null = null;
let run: { key: string; at: number; entry: object | null } | null = null;

function mine<T>(f: () => T): T {
  writing = true;
  try {
    return f();
  } finally {
    writing = false;
  }
}

const inVideo = (): boolean => useExportSurface.getState().surface === 'video';

/**
 * Shows the piece's record in the form. Without one, the form keeps what it shows, except for a
 * newly opened piece (`loaded`), which shows the viewer's remembered options.
 */
function showRecord(loaded = false): void {
  const { piece, compiled } = usePlayer.getState();
  const { form } = useExportUi.getState();
  run = null;
  const next = piece.video
    ? formWithRecord(form, piece, compiled.duration)
    : loaded
      ? viewerVideoForm(form)
      : form;
  lastFields = videoFields(next);
  if (next === form || jsonEqual(next, form)) return;
  mine(() => useExportUi.setState({ form: next }));
  clampPreview(next);
}

/** Writes the record from the form's video fields (one undo entry, or joined; see above). */
function writeForm(f: VideoFields): void {
  const prev = lastFields;
  lastFields = f;
  if (!prev || !inVideo() || inGesture()) return;
  const changed = changedVideoFields(prev, f);
  if (changed.length === 0) return;
  const ctx = videoContext();
  const recipe = (p: Piece) => withVideo(p, recordFromForm(f, p, ctx));
  const now = performance.now();
  // Choosing a camera writes the piece's camera, then the form's: one entry.
  const cam =
    camEdit && camEdit.entry === lastEntry() && now - camEdit.at < JOIN_MS ? camEdit.entry : null;
  const joined =
    posterEntryFor(useExportUi.getState().form) ??
    (changed.every((k) => k === 'videoCamera') ? cam : null);
  const key = changed.join(',');
  mine(() => {
    if (joined) {
      amend(joined, recipe, 'Video');
      run = { key, at: now, entry: lastEntry() };
    } else if (run && run.key === key && now - run.at < COALESCE_MS && lastEntry() === run.entry) {
      amend(run.entry, recipe, 'Video');
      run.at = now;
    } else {
      edit(recipe, 'Video');
      run = { key, at: now, entry: lastEntry() };
    }
  });
  settle();
}

/**
 * After a write, the form shows the record as stored (canonical numbers; a null Follow window,
 * the editor's zoom, as the record's window), so the preview draws what a link draws. The
 * Section's Loop region and the theme's Current stay when they show the same.
 */
function settle(): void {
  const { piece, compiled } = usePlayer.getState();
  const { form } = useExportUi.getState();
  if (!piece.video) return;
  const next = formSettled(form, piece, compiled.duration, videoContext());
  if (changedVideoFields(videoFields(form), videoFields(next)).length === 0) return;
  lastFields = videoFields(next);
  mine(() => useExportUi.setState({ form: next }));
}

/** Undo entries seen, so a redone or undone entry is never taken for a new edit. */
const seen = new WeakSet<object>();
/** The last new camera edit's entry and when it was made. */
let camEdit: { entry: object; at: number } | null = null;
/** A camera edit and the form change that follows it within this long (ms) are one entry. */
const JOIN_MS = 100;

/**
 * A new camera edit (with `edit`); without a record, the record joins its entry (after the
 * listeners of this change have run, so none of them sees the pieces out of order).
 */
function cameraEdited(entry: object, hasRecord: boolean): void {
  camEdit = { entry, at: performance.now() };
  if (hasRecord) return;
  queueMicrotask(() => {
    if (lastEntry() !== entry || !inVideo() || usePlayer.getState().piece.video) return;
    const ctx = videoContext();
    const f = videoFields(useExportUi.getState().form);
    mine(() => amend(entry, (p) => withVideo(p, recordFromForm(f, p, ctx)), 'Video'));
    settle();
  });
}

/**
 * Starts keeping the form and the piece's video in step (the workspace calls it on mount, after
 * `startPosterSync`); returns the stop function.
 */
export function startVideoSync(): () => void {
  lastFields = videoFields(useExportUi.getState().form);
  run = null;
  const entry = lastEntry();
  if (entry) seen.add(entry);
  if (inVideo()) showRecord();
  const offSurface = useExportSurface.subscribe((s, p) => {
    if (s.surface === 'video' && p.surface !== 'video') showRecord();
  });
  let loads = loadInfo().count;
  const offPiece = usePlayer.subscribe((s, p) => {
    const e = lastEntry();
    const loaded = loadInfo().count !== loads;
    loads = loadInfo().count;
    if (s.piece !== p.piece && !writing && inVideo()) {
      if (loaded) showRecord(true);
      else if (s.piece.video !== p.piece.video) showRecord();
      else if (s.piece.video && pieceVideoFrame(s.piece) !== pieceVideoFrame(p.piece)) {
        // The frame decides what an absent window means (One row: the piece's; poster: a row).
        showRecord();
      } else if (
        s.piece.camera !== p.piece.camera &&
        e &&
        !seen.has(e) &&
        !useEditor.getState().canRedo
      ) {
        seen.add(e);
        cameraEdited(e, !!s.piece.video);
      }
    }
    if (e) seen.add(e);
  });
  const offForm = useExportUi.subscribe((s, p) => {
    if (s.form !== p.form && !writing) writeForm(videoFields(s.form));
  });
  return () => {
    offSurface();
    offPiece();
    offForm();
    lastFields = null;
    run = null;
    camEdit = null;
  };
}
