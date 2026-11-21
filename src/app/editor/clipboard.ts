/**
 * Copy and paste of moments (PLAN.md §11.3 "Edit on the lane"): pure helpers. A clip is JSON
 * text `{ format: 'algorhythms-moments', version: 1, moments }` with times relative to the
 * earliest copied moment and each seed made explicit (the effective seed, §7.7, as Alt-drag
 * duplicates do), so a paste sounds like the original even in another piece. Pasting places the
 * earliest at the anchor (the playhead, snapped to a beat when Snap to beats is on), keeps the
 * relative times and gives every moment a fresh id. The piece key at 0:00 is not a moment and is
 * never copied.
 */

import { momentSeed } from '../../core/rng';
import { parsePiece } from '../../core/schema';
import type { Moment, MomentId, Piece, Seconds } from '../../core/types';
import { insertMoments, newMomentIds, shifted } from './ops';
import { nearestBeat } from './snap';

export const CLIP_FORMAT = 'algorhythms-moments';
export const CLIP_VERSION = 1;

export interface Clip {
  format: typeof CLIP_FORMAT;
  version: number;
  /** Copied moments, in piece order; the earliest is at 0. */
  moments: Moment[];
}

const round6 = (t: number): number => Math.round(t * 1e6) / 1e6 + 0;

/** Rounds a moment's times to 1 µs. */
function roundTimes(m: Moment): Moment {
  const out = { ...m, at: round6(m.at) } as Moment;
  if (out.type === 'walk' || out.type === 'pulse') out.until = round6(out.until);
  return out;
}

/** The clip of `ids` in `piece`, or null when none of them is a moment. */
export function clipOf(piece: Piece, ids: readonly MomentId[]): Clip | null {
  const want = new Set(ids);
  const picked = piece.moments.filter((m) => want.has(m.id));
  if (picked.length === 0) return null;
  const t0 = Math.min(...picked.map((m) => m.at));
  const moments = picked.map((m) =>
    roundTimes({ ...shifted(m, -t0), seed: momentSeed(piece.seed, m.id, m.seed) } as Moment),
  );
  return { format: CLIP_FORMAT, version: CLIP_VERSION, moments };
}

/** A clip as clipboard text. */
export function clipText(clip: Clip): string {
  return JSON.stringify(clip);
}

/** The clip in clipboard `text`, or null when it is not one (any other text, bad JSON). */
export function parseClip(text: string | null | undefined): Clip | null {
  if (!text) return null;
  const s = text.trim();
  if (!s.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const c = v as Partial<Clip>;
  if (c.format !== CLIP_FORMAT || typeof c.version !== 'number' || c.version > CLIP_VERSION) {
    return null;
  }
  if (!Array.isArray(c.moments) || c.moments.length === 0) return null;
  for (const m of c.moments as unknown[]) {
    if (typeof m !== 'object' || m === null) return null;
    const x = m as { type?: unknown; at?: unknown };
    if (typeof x.type !== 'string' || typeof x.at !== 'number' || !Number.isFinite(x.at)) {
      return null;
    }
  }
  return c as Clip;
}

/** Where a paste puts the clip's earliest moment: `at` (≥ 0), on the nearest beat of `beat`. */
export function pasteAnchor(at: Seconds, beat: Seconds | null): Seconds {
  const t = Math.max(0, at);
  return beat ? nearestBeat(t, beat) : round6(t);
}

/** The result of `pasteClip`: the piece and the new moments' ids (in clip order). */
export interface Pasted {
  piece: Piece;
  ids: MomentId[];
}

/**
 * `piece` with `clip` pasted at `anchor` (see `pasteAnchor`), each moment with a new id. Null when
 * the result is not a valid piece (a moment the schema refuses).
 */
export function pasteClip(
  piece: Piece,
  clip: Clip,
  anchor: Seconds,
  rnd?: () => number,
): Pasted | null {
  const t0 = Math.min(...clip.moments.map((m) => m.at));
  const ids = newMomentIds(piece, clip.moments.length, rnd);
  const moments = clip.moments.map((m, i) =>
    roundTimes({ ...shifted(m, anchor - t0), id: ids[i] } as Moment),
  );
  const next = insertMoments(piece, moments);
  // The schema checks every field of the pasted moments (they may come from another tab).
  const r = parsePiece(next);
  if (!r.ok) return null;
  const parsed = new Map(r.piece.moments.map((m) => [m.id, m]));
  const clean = moments.map((m) => parsed.get(m.id) ?? m);
  return { piece: insertMoments(piece, clean), ids };
}
