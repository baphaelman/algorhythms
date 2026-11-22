/**
 * The chord in effect over time, for `walk.over: 'chord'` (§6.2, revision 10): the pitch classes
 * of the latest chord at or before t, whatever its target. Built once from the piece (it reads no
 * simulation state), so the walk's dependency on chords is causal: an edited chord at time T
 * changes only ticks at or after T, which the incremental compile replays (it resumes before T).
 *
 * Sources today: `chord` moments with a `pitches`, symbol / numeral or `degrees` NoteSet (a
 * numeral or degrees read in the key at the chord's time). `current` names no chord and is
 * skipped, as are muted, invalid and unparsable chords. A `progression` moment adds its chords
 * with `add` (one entry per chord, at its own time).
 */

import { mod } from '../math';
import { parseChord } from '../chords';
import { degreesToPcs } from '../scales';
import type { Key, NoteSet, Seconds } from '../types';
import { roundTiesDown } from '../voicing';

interface Entry {
  t: Seconds;
  /** Ties at equal t: the larger order wins (moment index, then position inside the moment). */
  order: number;
  pcs: readonly number[];
}

/** Pitch classes a NoteSet names in `key`, deduplicated; null when it names no chord. */
export function noteSetPcs(notes: NoteSet, key: Key): number[] | null {
  let pcs: number[];
  switch (notes?.kind) {
    case 'pitches':
      if (!Array.isArray(notes.pitches)) return null;
      pcs = notes.pitches.filter(Number.isFinite).map((p) => mod(roundTiesDown(p), 12));
      break;
    case 'chord': {
      if (typeof notes.symbol !== 'string') return null;
      const r = parseChord(notes.symbol, key);
      if (!r.ok) return null;
      pcs = r.pcs;
      break;
    }
    case 'degrees':
      if (!Array.isArray(notes.degrees)) return null;
      pcs = degreesToPcs(notes.degrees.filter(Number.isFinite), key);
      break;
    default:
      return null;
  }
  const out = [...new Set(pcs)].sort((a, b) => a - b);
  return out.length > 0 ? out : null;
}

export class ChordTrack {
  private entries: Entry[] = [];
  private sorted = true;

  /** Adds a chord taking effect at t; `order` breaks ties at equal t (larger wins). */
  add(t: Seconds, order: number, pcs: readonly number[]): void {
    const last = this.entries[this.entries.length - 1];
    if (last && (last.t > t || (last.t === t && last.order > order))) this.sorted = false;
    this.entries.push({ t, order, pcs });
  }

  /** Pitch classes of the latest chord at or before t, or null before any chord. */
  pcsAt(t: Seconds): readonly number[] | null {
    if (!this.sorted) {
      this.entries.sort((a, b) => a.t - b.t || a.order - b.order);
      this.sorted = true;
    }
    const e = this.entries;
    let lo = 0;
    let hi = e.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (e[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? e[lo - 1].pcs : null;
  }
}
