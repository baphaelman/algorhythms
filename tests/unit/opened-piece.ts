/**
 * The empty template has no moments (owner 2026-11-21). Tests written against the old template
 * (one chord at 0 on A3, id `start0`) add it back with this.
 */

import { DEFAULT_START_PITCH, openingNote } from '../../src/core/defaults';
import type { Piece } from '../../src/core/types';

/** `p` with a one-note chord at 0 on A3 (id `start0`) first in its moments. */
export function withOpening(p: Piece): Piece {
  p.moments = [openingNote(DEFAULT_START_PITCH), ...p.moments];
  return p;
}
