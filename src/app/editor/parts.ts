/**
 * Pure piece recipes for parts in the Notes drawer and inspector (PLAN.md §11.3 revision 9).
 * A part exists while some voice names it (`VoiceDef.part`); `partOf` gives '' for none. Each
 * recipe returns the same piece when nothing changes (so `edit` records no entry).
 */

import { inPartScope, partOf, partScope, renamePartIn, type PartScope } from '../../core/parts';
import type { Moment, Piece, Pitch, VoiceDef, VoiceId } from '../../core/types';
import { normalizeRange, patchVoice, type VoicePatch } from './voices';

/** Part names in order of first appearance in the pool ('' excluded). */
export function partNames(piece: Piece): string[] {
  const out: string[] = [];
  for (const v of piece.voices) {
    const p = partOf(v);
    if (p !== '' && !out.includes(p)) out.push(p);
  }
  return out;
}

export const hasParts = (piece: Piece): boolean => piece.voices.some((v) => partOf(v) !== '');

/** Voices of `part` ('' = unassigned), in pool order. */
export function partVoices(piece: Piece, part: string): VoiceDef[] {
  return piece.voices.filter((v) => partOf(v) === part);
}

/** "Part n" with the smallest n ≥ 1 not in use. */
export function freePartName(piece: Piece): string {
  const used = new Set(partNames(piece));
  let n = 1;
  while (used.has(`Part ${n}`)) n++;
  return `Part ${n}`;
}

/** A short label for a part scope: "Melody", "Melody, Bass", "all but Melody". */
export function scopeLabel(scope: PartScope): string {
  const names = scope.names.map((n) => (n === '' ? 'Unassigned' : n)).join(', ');
  return scope.except ? `all but ${names}` : names;
}

/** Moments whose target names `part` (`{ part }`, or in `{ parts }` / `{ exceptParts }`). */
export function momentsTargeting(piece: Piece, part: string): Moment[] {
  return piece.moments.filter((m) => partScope(m.target)?.names.includes(part) === true);
}

/** Moves a voice into `part` ('' or undefined: unassigned). */
export function assignPart(piece: Piece, id: VoiceId, part: string | undefined): Piece {
  const name = part?.trim() ?? '';
  const v = piece.voices.find((x) => x.id === id);
  if (!v || partOf(v) === name) return piece;
  const voices = piece.voices.map((x) => {
    if (x.id !== id) return x;
    const next: VoiceDef = { ...x };
    if (name === '') delete next.part;
    else next.part = name;
    return next;
  });
  return { ...piece, voices };
}

/** Why `to` can't rename `from`, or null when it can. */
export function renameError(piece: Piece, from: string, to: string): string | null {
  const name = to.trim();
  if (name === '') return 'A part needs a name';
  if (name !== from && partNames(piece).includes(name)) return `A part named ${name} exists`;
  return null;
}

/** Renames a part: its voices and every target naming it (`part`, `parts`, `exceptParts`). */
export function renamePart(piece: Piece, from: string, to: string): Piece {
  const name = to.trim();
  if (from === '' || name === from || renameError(piece, from, name)) return piece;
  const voices = piece.voices.map((v) => (partOf(v) === from ? { ...v, part: name } : v));
  const moments = piece.moments.map((m) => {
    const target = renamePartIn(m.target, from, name);
    return target === m.target ? m : { ...m, target };
  });
  return { ...piece, voices, moments };
}

/**
 * Deletes a part: its voices become unassigned, and a moment whose target names it targets the
 * voices that target picked by pick instead (the same notes; none left means the default target).
 */
export function deletePart(piece: Piece, part: string): Piece {
  if (part === '') return piece;
  if (partVoices(piece, part).length === 0 && momentsTargeting(piece, part).length === 0)
    return piece;
  const voices = piece.voices.map((v) => {
    if (partOf(v) !== part) return v;
    const next = { ...v };
    delete next.part;
    return next;
  });
  const moments = piece.moments.map((m): Moment => {
    const scope = partScope(m.target);
    if (!scope?.names.includes(part)) return m;
    const ids = piece.voices.filter((v) => inPartScope(scope, partOf(v))).map((v) => v.id);
    const next = { ...m };
    if (ids.length > 0) next.target = { voices: ids };
    else delete next.target;
    return next;
  });
  return { ...piece, voices, moments };
}

/** Applies `patch` (or a per-voice patch) to every voice of `part`, as one recipe. */
export function patchPart(
  piece: Piece,
  part: string,
  patch: VoicePatch | ((v: VoiceDef) => VoicePatch),
): Piece {
  let out = piece;
  for (const v of partVoices(piece, part)) {
    out = patchVoice(out, v.id, typeof patch === 'function' ? patch(v) : patch);
  }
  return out;
}

/** Sets one range bound on every voice of `part`, keeping each voice's other bound. */
export function setPartRangeBound(piece: Piece, part: string, which: 0 | 1, n: Pitch): Piece {
  return patchPart(piece, part, (v) => ({
    range: which === 0 ? normalizeRange(n, v.range[1]) : normalizeRange(v.range[0], n),
  }));
}

/** The value every voice shares, or undefined when they differ (or there are none). */
export function common<T>(voices: readonly VoiceDef[], get: (v: VoiceDef) => T): T | undefined {
  if (voices.length === 0) return undefined;
  const first = get(voices[0]);
  return voices.every((v) => get(v) === first) ? first : undefined;
}
