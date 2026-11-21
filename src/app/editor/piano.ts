/**
 * The piano ruler (PLAN.md §11.3 "Piano ruler"): pure helpers. The score's pitch axis shows
 * piano keys; with a chord selected a key toggles that note in it, with a pin selected it sets
 * the pin's pitch. Keys in the key in effect are marked (the tonic more strongly).
 */

import { isScaleTone, pitchClassOf } from '../../core/scales';
import type { Key, Pitch } from '../../core/types';

/** The ruler's width (px), at the score's left edge in the editor layout. */
export const PIANO_WIDTH = 20;

const BLACK = new Set([1, 3, 6, 8, 10]);

const pcOf = (p: Pitch): number => ((Math.round(p) % 12) + 12) % 12;

/** True for C♯, D♯, F♯, G♯ and A♯. */
export function isBlackKey(p: Pitch): boolean {
  return BLACK.has(pcOf(p));
}

/** The whole-semitone keys whose centres lie in [lo, hi], low to high, within MIDI 0..127. */
export function pianoKeys(lo: number, hi: number): Pitch[] {
  const a = Math.max(0, Math.ceil(lo));
  const b = Math.min(127, Math.floor(hi));
  const out: Pitch[] = [];
  for (let p = a; p <= b; p++) out.push(p);
  return out;
}

/** How a key relates to `key`: its tonic, another scale tone, or outside the scale. */
export function keyRole(p: Pitch, key: Key): 'tonic' | 'scale' | 'out' {
  if (pitchClassOf(key.tonic) === pcOf(p)) return 'tonic';
  return isScaleTone(Math.round(p), key) ? 'scale' : 'out';
}

/** Why a toggle was refused. */
export type ToggleRefusal = 'last-note' | 'pool-full';

/**
 * `notes` with `pitch` removed (if a note is within ½ semitone of it) or added, low to high. A
 * chord keeps at least one note and at most `max` (the pool size).
 */
export function toggledNotes(
  notes: readonly Pitch[],
  pitch: Pitch,
  max: number,
): { notes: Pitch[]; added: boolean } | { refused: ToggleRefusal } {
  const i = notes.findIndex((n) => Math.abs(n - pitch) < 0.5);
  if (i >= 0) {
    if (notes.length <= 1) return { refused: 'last-note' };
    return { notes: notes.filter((_, j) => j !== i).sort((a, b) => a - b), added: false };
  }
  if (notes.length >= max) return { refused: 'pool-full' };
  return { notes: [...notes, pitch].sort((a, b) => a - b), added: true };
}
