/**
 * The Generate panel's form, as pure functions (PLAN.md §11.3 "Generate", §15 M12): parsing the
 * seed and composing. Generate is Compose for me with every answer on Surprise me: the brief holds
 * only the seed. No DOM and no store, so they are unit-tested in Node.
 */

import type { ComposeBrief } from '../core/compose-brief';
import { composeDirected } from '../core/compose-directed';
import { composedPiece } from '../core/generate';
import type { Piece } from '../core/types';

/** FNV-1a over the UTF-16 code units: a stable unsigned 32-bit hash for text seeds. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The numeric seed for a seed field. A whole number (digits, optional sign) is taken modulo 2³²,
 * so "7" and "4294967303" are the same seed. Other text is hashed. Blank text gives null (an
 * error in the form).
 */
export function parseSeed(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  // BigInt keeps long digit strings exact.
  if (/^[+-]?\d+$/.test(t)) return Number(BigInt.asUintN(32, BigInt(t)));
  return hashSeed(t);
}

/** A fresh random seed (an integer 0..2³²−1). The app may use Math.random; core may not. */
export function newSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0x1_0000_0000) >>> 0;
}

export type SeedCheck = { ok: true; brief: ComposeBrief } | { ok: false; error: string };

/** The all-Surprise brief for a seed field, or the field's error. */
export function checkSeed(text: string): SeedCheck {
  const seed = parseSeed(text);
  if (seed === null) return { ok: false, error: 'Enter a seed: a number or any text.' };
  return { ok: true, brief: { seed } };
}

/** The finished piece for `brief`; `now` becomes `meta.created` and `modified`. */
export function generateFromBrief(brief: ComposeBrief, now?: string): Piece {
  const piece = composedPiece(composeDirected(brief));
  if (now === undefined) return piece;
  return { ...piece, meta: { ...piece.meta, created: now, modified: now } };
}
