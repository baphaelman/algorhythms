/**
 * `progression` (§6.2, revision 10): a chord sequence typed once. The compiler expands it into
 * one `chord` moment per chord (`progressionChords`), in the progression's place in the moment
 * array, so each chord behaves exactly as a hand-written chord moment with the same settings:
 * voice leading, register, count, numerals read at its own time, root in the bass, parts
 * entering from silence, and the moment's glide (stagger, land) on every change.
 *
 * The expanded chords keep the progression's id (diagnostics, spans, segments and harmony name
 * it) and get an explicit seed per chord (`progressionChordSeed`), which Freeze writes into the
 * chord moments it makes, so they sound the same.
 */

import { hash32, momentSeed } from '../rng';
import type { ChordMoment, Piece, ProgressionMoment, Seconds } from '../types';

/** Why a progression can't run (`progression-invalid`), or null. An empty one does nothing. */
export function progressionProblem(m: ProgressionMoment): string | null {
  if (!Array.isArray(m.chords)) return 'A progression needs a list of chords.';
  for (let k = 0; k < m.chords.length; k++) {
    const c = m.chords[k];
    if (!c || typeof c !== 'object' || typeof c.notes !== 'string')
      return `Chord ${k + 1} of the progression needs a chord symbol.`;
    if (!(typeof c.len === 'number' && Number.isFinite(c.len) && c.len > 0))
      return `Chord ${k + 1} of the progression needs a length > 0.`;
  }
  return null;
}

/** Chord starts: at, then at + the lengths before each chord; the last entry is the end. */
export function progressionStarts(m: Pick<ProgressionMoment, 'at' | 'chords'>): Seconds[] {
  const out: Seconds[] = [m.at];
  let t = m.at;
  for (const c of m.chords) out.push((t += c.len));
  return out;
}

/** The progression's end: `at` + every chord's length. */
export function progressionEnd(m: Pick<ProgressionMoment, 'at' | 'chords'>): Seconds {
  let t = m.at;
  for (const c of m.chords) t += c.len;
  return t;
}

/** The seed of chord k, from the progression's own seed (§7.7). */
export function progressionChordSeed(progressionSeed: number, k: number): number {
  return hash32(progressionSeed, `chord${k}`);
}

/**
 * The chord moments progression `m` stands for, chord k at its start with the progression's
 * target, glide and chord settings and seed `progressionChordSeed`. Ids stay `m.id`; the caller
 * renames them when they become moments of their own (Freeze). Muted or invalid: none.
 */
export function progressionChords(m: ProgressionMoment, pieceSeed: Piece['seed']): ChordMoment[] {
  if (m.muted || progressionProblem(m) !== null) return [];
  const seed = momentSeed(pieceSeed, m.id, m.seed);
  const starts = progressionStarts(m);
  return m.chords.map((c, k) => {
    const out: ChordMoment = {
      id: m.id,
      type: 'chord',
      at: starts[k],
      notes: { kind: 'chord', symbol: c.notes },
      voicing: m.voicing,
      assign: m.assign,
      seed: progressionChordSeed(seed, k),
    };
    if (m.target !== undefined) out.target = m.target;
    if (m.glide !== undefined) out.glide = m.glide;
    if (m.register !== undefined) out.register = m.register;
    if (m.count !== undefined) out.count = m.count;
    return out;
  });
}

/** Where an expanded moment came from: chord `k` of the progression at `index`. */
export interface ProgressionOrigin {
  index: number;
  k: number;
  symbol: string;
}

/**
 * `moments` with every valid progression replaced by its chords (`progressionChords`), and per
 * output moment its origin (null for moments that are not from a progression). Other moments
 * keep their identity; without a progression the input array is returned as is.
 */
export function expandProgressions(
  moments: readonly unknown[],
  pieceSeed: number,
): { moments: unknown[]; origins: (ProgressionOrigin | null)[] | null } {
  let any = false;
  for (const m of moments) if (isExpandable(m)) any = true;
  if (!any) return { moments: moments as unknown[], origins: null };
  const out: unknown[] = [];
  const origins: (ProgressionOrigin | null)[] = [];
  moments.forEach((m, index) => {
    if (!isExpandable(m)) {
      out.push(m);
      origins.push(null);
      return;
    }
    const chords = progressionChords(m, pieceSeed);
    chords.forEach((c, k) => {
      out.push(c);
      origins.push({ index, k, symbol: m.chords[k].notes });
    });
  });
  return { moments: out, origins };
}

/** A valid, unmuted progression with at least one chord at a valid time. */
function isExpandable(m: unknown): m is ProgressionMoment {
  if (!m || typeof m !== 'object') return false;
  const p = m as ProgressionMoment;
  return (
    p.type === 'progression' &&
    !p.muted &&
    typeof p.at === 'number' &&
    Number.isFinite(p.at) &&
    p.at >= 0 &&
    progressionProblem(p) === null &&
    p.chords.length > 0
  );
}
