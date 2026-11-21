/**
 * The piece's key as a fixed key moment at 0:00 (PLAN.md "The piece's key is a fixed key moment
 * at 0:00", owner 2026-11-21). No schema change: `piece.key` stays the source. The lane shows it
 * as an item with id `PIECE_KEY_ID`, which the selection may hold; it is never in
 * `piece.moments`, so delete, move and copy (which act on `piece.moments`) leave it alone.
 *
 * Load rule (`foldOpeningKeys`): unmuted `key` moments at exactly 0 that the compiler runs before
 * any other unmuted moment at 0 are folded into `piece.key` (the last one wins, as in compile
 * order) and removed. This is exact: nothing compiled before them could hear the old key. Any
 * other key moment at 0 stays an ordinary moment and overrides the piece key from its turn on.
 */

import type { Key, KeyMoment, MomentId, Piece } from '../../core/types';

/** The selection id of the piece's key at 0:00. Not a valid moment id in `piece.moments`. */
export const PIECE_KEY_ID: MomentId = '__pieceKey';

export const isPieceKey = (id: MomentId): boolean => id === PIECE_KEY_ID;

/** The piece's key as a key moment at 0 (never stored). */
export function pieceKeyMoment(piece: Piece): KeyMoment {
  return { id: PIECE_KEY_ID, type: 'key', at: 0, key: piece.key };
}

/**
 * `piece` with its key as a key moment at 0, first in compile order (at 0, first in the array):
 * compiles the same, and lets the key-moment span helpers (core/transpose) treat the piece key
 * like any key moment.
 */
export function withPieceKeyMoment(piece: Piece): Piece {
  return { ...piece, moments: [pieceKeyMoment(piece), ...piece.moments] };
}

/** Undoes `withPieceKeyMoment` (its key moment written back to `piece.key`). */
export function withoutPieceKeyMoment(piece: Piece): Piece {
  const k = piece.moments.find((m) => m.id === PIECE_KEY_ID);
  const moments = piece.moments.filter((m) => m.id !== PIECE_KEY_ID);
  return { ...piece, key: k && k.type === 'key' ? k.key : piece.key, moments };
}

/** The key moment `id` in `piece` (the piece key for `PIECE_KEY_ID`), or null. */
export function keyMomentOf(piece: Piece, id: MomentId): KeyMoment | null {
  if (isPieceKey(id)) return pieceKeyMoment(piece);
  const m = piece.moments.find((x) => x.id === id);
  return m && m.type === 'key' ? m : null;
}

/** `piece` with key `key`; `piece` itself when unchanged (spelling counts: C# is not Db). */
export function setKeyOf(piece: Piece, key: Key): Piece {
  return JSON.stringify(piece.key) === JSON.stringify(key) ? piece : { ...piece, key };
}

/** The load rule (see the module comment); `piece` itself when nothing folds. */
export function foldOpeningKeys(piece: Piece): Piece {
  // Array order is compile order among moments at the same time.
  const fold = new Set<MomentId>();
  let key = piece.key;
  for (const m of piece.moments) {
    if (m.at !== 0 || m.muted) continue;
    if (m.type !== 'key') break;
    fold.add(m.id);
    key = m.key;
  }
  if (fold.size === 0) return piece;
  return { ...piece, key, moments: piece.moments.filter((m) => !fold.has(m.id)) };
}
