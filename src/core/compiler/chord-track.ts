/**
 * The harmony over time, for `walk.over: 'chord'` (§6.2, revision 10; M13 fix): the pitch classes
 * of the chord blocks that sound on the Chords row (§6.4). A block lasts until a later chord with
 * its target (`chain`) or targeting all starts; a chord of two or more notes also ends earlier
 * chords (not lines) of any target. A line (one note, or `count: 1`) only adds its note, so a
 * part's one-line bass joins the pad's chord instead of replacing it, and a walking part's own
 * opening chord stops counting once another part changes chord. Built once from the piece (it reads no
 * simulation state), so the walk's dependency on chords is causal: an edited chord at time T
 * changes only ticks at or after T, which the incremental compile replays (it resumes before T).
 *
 * Sources today: `chord` moments with a `pitches`, symbol / numeral or `degrees` NoteSet (a
 * numeral or degrees read in the key at the chord's time). `current` names no chord and is
 * skipped, as are muted, invalid and unparsable chords. A `progression` moment's chords come in
 * as the chord moments the compiler expands it into (one entry per chord, at its own time).
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
  /** The chord's target, as the Chords row chains it (`chordChain`). */
  chain: string;
  /** A one-line chord (a bass): it ends no other target's block. */
  line: boolean;
}

/**
 * The pitch class a one-line chord (`count: 1`) of `notes` sounds: the lowest pitch, a symbol's
 * slash bass or root, the first degree; null when it names none.
 */
export function noteSetBassPc(notes: NoteSet, key: Key): number | null {
  switch (notes?.kind) {
    case 'pitches': {
      const ps = Array.isArray(notes.pitches) ? notes.pitches.filter(Number.isFinite) : [];
      return ps.length > 0 ? mod(roundTiesDown(Math.min(...ps)), 12) : null;
    }
    case 'chord': {
      if (typeof notes.symbol !== 'string') return null;
      const r = parseChord(notes.symbol, key);
      return r.ok ? (r.bass ?? r.root) : null;
    }
    case 'degrees': {
      const d = Array.isArray(notes.degrees) ? notes.degrees.filter(Number.isFinite) : [];
      return d.length > 0 ? degreesToPcs([d[0]], key)[0] : null;
    }
    default:
      return null;
  }
}

/** The harmony from t on (the union of the sounding blocks, ascending). */
interface Span {
  t: Seconds;
  pcs: readonly number[];
}

/** Chain key of a target (as `app/editor/rows.ts`): a block ends at the next on its chain. */
export const chordChain = (target: unknown): string => JSON.stringify(target ?? 'all');
const ALL = chordChain(undefined);

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
  private spans: Span[] | null = null;

  /** Adds a chord taking effect at t; `order` breaks ties at equal t (larger wins). */
  add(t: Seconds, order: number, pcs: readonly number[], chain = ALL, line = false): void {
    this.entries.push({ t, order, pcs, chain, line });
    this.spans = null;
  }

  private build(): Span[] {
    const e = this.entries.slice().sort((a, b) => a.t - b.t || a.order - b.order);
    const sounding = new Map<string, Entry>();
    const spans: Span[] = [];
    for (let j = 0; j < e.length;) {
      const t = e[j].t;
      for (; j < e.length && e[j].t === t; j++) {
        const x = e[j];
        // Blocks that started before it (not with it): all ends every one, a chord the chords.
        for (const [k, b] of sounding)
          if (b.t < t && (x.chain === ALL || (!x.line && !b.line))) sounding.delete(k);
        sounding.set(x.chain, x);
      }
      const set = new Set<number>();
      for (const b of sounding.values()) for (const p of b.pcs) set.add(p);
      spans.push({ t, pcs: [...set].sort((a, b) => a - b) });
    }
    return spans;
  }

  /** Pitch classes of the chord blocks sounding at t, or null before any chord. */
  pcsAt(t: Seconds): readonly number[] | null {
    const e = (this.spans ??= this.build());
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
