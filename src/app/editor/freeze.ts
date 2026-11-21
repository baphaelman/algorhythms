/**
 * Freeze (PLAN.md §11.3 inspector): replaces a moment's result with absolute targets plus an
 * explicit seed, so later edits to earlier moments no longer change what it does. Pure helpers.
 * - chord: `freezeChord` (a `pitches` NoteSet, `assign: 'ordered'`, `count` kept), with the old
 *   notes in `frozenFrom` for Unfreeze;
 * - split: the pitches its voices (survivors and newborns) get, as a `pitches` NoteSet;
 * - walk: its steps as `fixed` notes (`freezeWalk`; Unfreeze drops them).
 * Other moments have no NoteSet or random draw to bake, so they are not freezable.
 */

import { compileWithTrace } from '../../core/compiler/compile';
import { pieceDecisionTime } from '../../core/compiler/glide';
import { freezeChord } from '../../core/freeze-chord';
import { freezeWalk } from '../../core/moments/walk';
import { momentSeed } from '../../core/rng';
import type { CompiledScore, Moment, MomentId, Piece, Pitch } from '../../core/types';
import { frozenPatch } from './chord-notes';
import { patchMoment, type MomentPatch } from './ops';

/** True for the moment types Freeze applies to. */
export function canFreeze(m: Moment): boolean {
  return m.type === 'chord' || m.type === 'split' || m.type === 'walk';
}

/** True if `m` is already frozen (or fixed by hand: a split listing its pitches). */
export function isFrozen(m: Moment): boolean {
  if (m.type === 'chord') return m.frozenFrom !== undefined;
  if (m.type === 'split') return m.notes?.kind === 'pitches';
  if (m.type === 'walk') return m.fixed !== undefined;
  return false;
}

/**
 * The pitches moment `id`'s voices land on (deaths left out), low to high, from a compile of the
 * moments decided before it (as `freezeChord`). Null if it was not applied.
 */
function landedPitches(piece: Piece, score: CompiledScore, id: MomentId): Pitch[] | null {
  const index = piece.moments.findIndex((m) => m.id === id);
  if (index < 0) return null;
  const m = piece.moments[index];
  if (m.muted || !score.momentSpans.some((s) => s.id === id)) return null;
  const t = pieceDecisionTime(piece, m);
  const before = piece.moments.filter((x, j) => {
    const d = pieceDecisionTime(piece, x);
    if (d < t || (d === t && j <= index)) return true;
    return x.type === 'key' && (x.at < m.at || (x.at === m.at && j < index));
  });
  const { trace } = compileWithTrace({ ...piece, moments: before });
  const tr = trace.moments.find((x) => x.id === id);
  const intents = tr?.logical ?? tr?.intents;
  if (!intents) return null;
  const out: Pitch[] = [];
  for (const it of intents) if (it.kind !== 'death') out.push(it.to);
  return out.length > 0 ? out.sort((a, b) => a - b) : null;
}

/**
 * The patch that freezes `m` in `piece` (compiled as `score`), or null when it can't be frozen
 * (another type, already frozen, or not applied). The seed becomes explicit (§7.7).
 */
export function freezePatch(piece: Piece, score: CompiledScore, m: Moment): MomentPatch | null {
  if (!canFreeze(m) || isFrozen(m)) return null;
  const seed = momentSeed(piece.seed, m.id, m.seed);
  if (m.type === 'chord') {
    const f = freezeChord(piece, score, m.id);
    if (!f || f.notes.kind !== 'pitches') return null;
    return { ...frozenPatch(m, f.notes.pitches, true), seed };
  }
  if (m.type === 'split') {
    const pitches = landedPitches(piece, score, m.id);
    return pitches ? { notes: { kind: 'pitches', pitches }, seed } : null;
  }
  if (m.type === 'walk') {
    if (!score.momentSpans.some((s) => s.id === m.id)) return null;
    return { fixed: freezeWalk(score, m.id), seed };
  }
  return null;
}

/**
 * `piece` with every freezable moment of `ids` frozen, in piece order; `compile` gives the score
 * of each intermediate piece (a frozen moment sounds the same, so later ones see the same state).
 */
export function freezeAll(
  piece: Piece,
  ids: readonly MomentId[],
  compile: (p: Piece) => CompiledScore,
): Piece {
  const want = new Set(ids);
  let p = piece;
  for (const id of piece.moments.filter((m) => want.has(m.id)).map((m) => m.id)) {
    const m = p.moments.find((x) => x.id === id);
    const patch = m && freezePatch(p, compile(p), m);
    if (patch) p = patchMoment(p, id, patch);
  }
  return p;
}
