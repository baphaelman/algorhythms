/**
 * Folding never merges lines (composing.md §3 #6, 2026-11-22). A target outside a voice's range
 * folds by octave into it (§7.8, range.ts); when the fold lands on a pitch another line of its
 * part holds or heads to, and its own target was a different pitch (so the merge is the fold's
 * doing, not the moment's), it takes a free pitch instead: the next octave if it is in the range
 * and free, else the nearest free scale step (cents offset kept), else the nearest free semitone
 * (ties: towards the target). Targets that share their pitch before folding (a unison)
 * stay together, and follow the first of them that moved.
 */

import { pitchesWithPcs, scalePcs } from '../scales';
import type { Key, Pitch } from '../types';
import { foldIntoRange } from './range';

const EPS = 1e-6;
const same = (a: Pitch, b: Pitch): boolean => Math.abs(a - b) <= EPS;

/** A target to fold: its line's part and range. `to` is rewritten when it moves. */
export interface FoldNote {
  part: string;
  to: Pitch;
  lo: Pitch;
  hi: Pitch;
}

interface Claim {
  part: string;
  /** The pitch it sounds after folding. */
  at: Pitch;
  /** Its target before folding. */
  was: Pitch;
  folded: boolean;
}

/**
 * Moves the folded targets of `notes` off the pitches of other lines of their part: `held`
 * (lines the moment leaves alone) and the other targets. Returns how many moved.
 */
export function foldApart(
  notes: readonly FoldNote[],
  held: readonly { part: string; p: Pitch }[],
  key: Key,
): number {
  const claims: Claim[] = held.map((h) => ({ part: h.part, at: h.p, was: h.p, folded: false }));
  const folded: { n: FoldNote; at: Pitch }[] = [];
  for (const n of notes) {
    if (!Number.isFinite(n.to)) continue;
    const f = foldIntoRange(n.to, n.lo, n.hi);
    // A range narrower than an octave clamps (`range-too-narrow`): left as it is.
    if (f.folded && !f.clampedToRange) folded.push({ n, at: f.p });
    else claims.push({ part: n.part, at: f.p, was: n.to, folded: false });
  }
  let moved = 0;
  for (const { n, at } of folded) {
    const was = n.to;
    const mate = claims.find((c) => c.folded && c.part === n.part && same(c.was, was));
    let to = mate ? mate.at : at;
    const clash = (p: Pitch): boolean =>
      claims.some((c) => c.part === n.part && same(c.at, p) && !same(c.was, was));
    if (!mate && clash(at)) {
      const taken = (p: Pitch): boolean => claims.some((c) => c.part === n.part && same(c.at, p));
      const p = freeNear(was, at, n.lo, n.hi, taken, key);
      if (p === p) {
        to = p;
        n.to = p;
        moved++;
      }
    } else if (to !== at) n.to = to;
    claims.push({ part: n.part, at: to, was, folded: true });
  }
  return moved;
}

/**
 * The free pitch for the fold target `f` of `x` in [lo, hi]: the next octave, else the nearest
 * scale step, else the nearest semitone (both keeping f's offset from the semitone grid). NaN if
 * the range is full.
 */
function freeNear(
  x: Pitch,
  f: Pitch,
  lo: Pitch,
  hi: Pitch,
  taken: (p: Pitch) => boolean,
  key: Key,
): Pitch {
  const pick = (cands: readonly Pitch[]): Pitch => {
    let best = NaN;
    for (const c of cands) {
      if (c < lo - EPS || c > hi + EPS || same(c, f) || taken(c)) continue;
      const d = Math.abs(c - f);
      const bd = Math.abs(best - f);
      // Nearest f; ties towards the target (the way the fold did not go).
      if (best !== best || d < bd - EPS || (d <= bd + EPS && Math.abs(c - x) < Math.abs(best - x)))
        best = c;
    }
    return best;
  };
  // The next octave the way the fold went (f is the octave of x nearest it in the range).
  const oct = pick([x > f ? f - 12 : f + 12]);
  if (oct === oct) return oct;
  const off = f - Math.round(f);
  const steps = pitchesWithPcs(scalePcs(key), lo - off, hi - off).map((p) => p + off);
  const step = pick(steps);
  if (step === step) return step;
  const semis: Pitch[] = [];
  for (let p = Math.ceil(lo - off) + off; p <= hi + EPS; p++) semis.push(p);
  return pick(semis);
}
