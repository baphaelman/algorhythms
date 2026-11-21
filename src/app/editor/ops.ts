/**
 * Pure piece transforms for moment editing. Each returns a new piece (sharing everything it does
 * not change) or the same piece when nothing changes, so they work as `edit` / `updateGesture`
 * recipes. `piece.moments` is kept stably sorted by `at`: array order breaks ties between equal
 * times (§5), so a stable sort never changes what a piece sounds like.
 */

import { base62Id, momentSeed } from '../../core/rng';
import type { Moment, MomentId, MomentType, MomentOf, Piece } from '../../core/types';

/** Fields a patch may set on a moment of type T (`undefined` removes an optional field). */
export type MomentPatchOf<T extends MomentType> = {
  [K in Exclude<keyof MomentOf<T>, 'id' | 'type'>]?: MomentOf<T>[K] | undefined;
};
/** A patch for any moment type. */
export type MomentPatch = { [T in MomentType]: MomentPatchOf<T> }[MomentType];

/** A random uint32 (app code may use the platform RNG; core and dsp may not). */
export function randomU32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** `n` fresh 6-character moment ids, unique among `piece`'s moments and each other. */
export function newMomentIds(piece: Piece, n: number, rnd: () => number = randomU32): MomentId[] {
  const used = new Set(piece.moments.map((m) => m.id));
  const out: MomentId[] = [];
  while (out.length < n) {
    const id = base62Id(rnd());
    if (used.has(id)) continue;
    used.add(id);
    out.push(id);
  }
  return out;
}

/** Stable sort by `at`; returns the input array when already sorted. */
function sortByAt(moments: Moment[]): Moment[] {
  for (let i = 1; i < moments.length; i++) {
    if (moments[i].at < moments[i - 1].at) {
      return moments
        .map((m, j) => ({ m, j }))
        .sort((a, b) => a.m.at - b.m.at || a.j - b.j)
        .map((x) => x.m);
    }
  }
  return moments;
}

function withMoments(piece: Piece, moments: Moment[]): Piece {
  return { ...piece, moments: sortByAt(moments) };
}

/** A moment shifted by `dt` (a walk's or pulse's `until` moves with it). */
function shifted(m: Moment, dt: number): Moment {
  return m.type === 'walk' || m.type === 'pulse'
    ? { ...m, at: m.at + dt, until: m.until + dt }
    : { ...m, at: m.at + dt };
}

/**
 * The patch that moves moment `m` to `at` (the inspector's Time field): a region (walk, pulse)
 * keeps its length, so its `until` moves too.
 */
export function atPatch(m: Moment, at: number): MomentPatch {
  if (m.type === 'walk' || m.type === 'pulse') {
    return { at, until: Math.round((m.until + at - m.at) * 1e6) / 1e6 };
  }
  return { at };
}

/** `dt` limited so no moment in `ids` goes before 0 (keeps a group's spacing). */
function clampDt(piece: Piece, ids: ReadonlySet<MomentId>, dt: number): number {
  let min = Infinity;
  for (const m of piece.moments) if (ids.has(m.id)) min = Math.min(min, m.at);
  return min === Infinity ? 0 : Math.max(dt, -min);
}

/** Inserts `moments` (ids must be unique). */
export function insertMoments(piece: Piece, moments: readonly Moment[]): Piece {
  if (moments.length === 0) return piece;
  return withMoments(piece, [...piece.moments, ...moments]);
}

/** Merges `patch` into moment `id`; `undefined` values delete the field. */
export function patchMoment(piece: Piece, id: MomentId, patch: MomentPatch): Piece {
  const i = piece.moments.findIndex((m) => m.id === id);
  if (i < 0) return piece;
  const old = piece.moments[i];
  const next: Record<string, unknown> = { ...old };
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'type') continue;
    if (v === undefined) {
      if (k in next) {
        delete next[k];
        changed = true;
      }
    } else if (next[k] !== v) {
      next[k] = v;
      changed = true;
    }
  }
  if (!changed) return piece;
  const moments = piece.moments.slice();
  moments[i] = next as unknown as Moment;
  return withMoments(piece, moments);
}

/** Moves the moments in `ids` by `dt` seconds, clamped so none goes before 0. */
export function moveMomentsBy(piece: Piece, ids: readonly MomentId[], dt: number): Piece {
  const set = new Set(ids);
  const d = clampDt(piece, set, dt);
  if (d === 0) return piece;
  return withMoments(
    piece,
    piece.moments.map((m) => (set.has(m.id) ? shifted(m, d) : m)),
  );
}

/** Removes the moments in `ids`. */
export function removeMoments(piece: Piece, ids: readonly MomentId[]): Piece {
  const set = new Set(ids);
  const moments = piece.moments.filter((m) => !set.has(m.id));
  return moments.length === piece.moments.length ? piece : { ...piece, moments };
}

/**
 * Copies the moments in `ids`, `dt` seconds later (clamped at 0), with ids `newIds` (one per
 * copied moment, in piece order; generated when absent; pass the same ids on every frame of an
 * Alt-drag). Each copy gets the original's effective seed (§7.7). Returns the piece and the
 * copies' ids.
 */
export function copyMoments(
  piece: Piece,
  ids: readonly MomentId[],
  dt: number,
  newIds?: readonly MomentId[],
): { piece: Piece; ids: MomentId[] } {
  const set = new Set(ids);
  const originals = piece.moments.filter((m) => set.has(m.id));
  if (originals.length === 0) return { piece, ids: [] };
  const fresh = newIds ? [...newIds] : newMomentIds(piece, originals.length);
  if (fresh.length !== originals.length) throw new Error('copyMoments: wrong number of new ids');
  const d = clampDt(piece, set, dt);
  const copies = originals.map(
    (m, i) =>
      ({
        ...shifted(m, d),
        id: fresh[i],
        seed: momentSeed(piece.seed, m.id, m.seed),
      }) as Moment,
  );
  return { piece: insertMoments(piece, copies), ids: fresh };
}
