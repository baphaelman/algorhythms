/**
 * Poster doc edits from the panel (M14 P5: rows by sections, the background picture), each on
 * the piece's undo stack. Edits with the same `key` within `COALESCE_MS` (a slider's drag,
 * typing) join one entry.
 */

import type { Piece, PosterDoc } from '../core/types';
import { amend, edit, lastEntry } from './editor/history';

/** Edits this close together (ms) with the same key are one undo entry. */
export const COALESCE_MS = 1000;

/** The piece with `doc` (none: no `poster` field). */
export function withPosterDoc(piece: Piece, doc: PosterDoc | undefined): Piece {
  if (piece.poster === doc) return piece;
  if (doc) return { ...piece, poster: doc };
  const { poster: _p, ...rest } = piece;
  return rest;
}

let run: { key: string; at: number; entry: object | null } | null = null;

/** Applies `fn` to the piece's poster doc: one undo entry (a run of the same `key` joins it). */
export function editPosterDoc(
  fn: (doc: PosterDoc | undefined) => PosterDoc | undefined,
  label: string,
  key?: string,
): boolean {
  const recipe = (p: Piece): Piece => withPosterDoc(p, fn(p.poster));
  const now = performance.now();
  if (key && run && run.key === key && now - run.at < COALESCE_MS && lastEntry() === run.entry) {
    run.at = now;
    return amend(run.entry, recipe, label);
  }
  const ok = edit(recipe, label);
  run = ok && key ? { key, at: now, entry: lastEntry() } : null;
  return ok;
}
