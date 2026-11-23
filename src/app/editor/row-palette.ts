/**
 * The rows' palette (PLAN.md §6.4, M10b): Chord, Texture, Melody, Level, Sound, Key, their
 * shortcut letters and the default block each adds (build log "M10b-1 row model").
 */

import { activeAt } from '../../core/query';
import type {
  ChordMoment,
  CompiledScore,
  Moment,
  MomentId,
  NoteSet,
  Piece,
  Seconds,
} from '../../core/types';
import { defaultMoment, withChordFill } from './new-moment';
import { rowsOf, textureMoment, textureUntil, type RowName } from './rows';

export interface RowPaletteEntry {
  row: RowName;
  /** Shortcut letter (upper case for display). */
  key: string;
  name: string;
  icon: string;
  /** Tooltip (without the shortcut). */
  hint: string;
}

export const ROW_PALETTE: readonly RowPaletteEntry[] = [
  { row: 'chords', key: 'C', name: 'Chord', icon: '◆', hint: 'A chord, until the next one' },
  { row: 'texture', key: 'T', name: 'Texture', icon: '┇', hint: 'How the chords play' },
  { row: 'melody', key: 'M', name: 'Melody', icon: '♪', hint: 'A melody on one line' },
  { row: 'level', key: 'L', name: 'Level', icon: '◢', hint: 'Fade notes' },
  { row: 'sound', key: 'S', name: 'Sound', icon: '◐', hint: 'Crossfade to another sound' },
  { row: 'key', key: 'K', name: 'Key', icon: '♯', hint: 'Change key or scale' },
];

const BY_KEY: ReadonlyMap<string, RowName> = new Map(
  ROW_PALETTE.map((e) => [e.key.toLowerCase(), e.row] as const),
);

/** The row a key press adds to, or null (any modifier or an auto-repeat disqualifies it). */
export function rowForKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
    repeat?: boolean;
  },
): RowName | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return null;
  return BY_KEY.get(e.key.toLowerCase()) ?? null;
}

/**
 * The seam for the Chord default: the notes a new chord block at `at` gets. M10a's theory
 * default (core/suggest.ts) plugs in here; the fallback is today's (tonic, or IV on the tonic).
 */
export type ChordNotesAt = (piece: Piece, score: CompiledScore, at: Seconds) => NoteSet;

export const fallbackChordNotes: ChordNotesAt = (piece, score, at) =>
  defaultMoment('chord', at, '__probe', piece, score).notes;

/**
 * A new block on `row` at `at` with id `id`. Chord: `chordNotes`' notes, Land, filled to its
 * size (`withChordFill`). Texture: an Arpeggio to the end of the chord block under it. The rest:
 * today's defaults.
 */
export function newBlock(
  row: RowName,
  at: Seconds,
  id: MomentId,
  piece: Piece,
  score: CompiledScore,
  chordNotes: ChordNotesAt = fallbackChordNotes,
): Moment {
  switch (row) {
    case 'chords': {
      const m: ChordMoment = {
        id,
        at,
        type: 'chord',
        notes: chordNotes(piece, score, at),
        voicing: 'even',
        assign: 'ordered',
        glide: { land: true },
      };
      return withChordFill(m, piece, score, at);
    }
    case 'texture': {
      const read = Math.min(at, Math.max(0, score.duration - 0.01));
      const n = activeAt(score, read).length || 3;
      const until = textureUntil(rowsOf(piece, score), piece, at);
      return textureMoment('arpeggio', { id, at, until }, piece, n);
    }
    case 'melody':
      return defaultMoment('tune', at, id, piece, score);
    case 'level':
      return defaultMoment('level', at, id, piece, score);
    case 'sound':
      return defaultMoment('timbre', at, id, piece, score);
    case 'key':
      return defaultMoment('key', at, id, piece, score);
  }
}
