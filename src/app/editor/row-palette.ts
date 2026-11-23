/**
 * The rows' palette (PLAN.md §6.4, M10b): Chord, Texture, Melody, Level, Sound, Key, their
 * shortcut letters and the default block each adds (build log "M10b-1 row model").
 */

import type {
  ChordMoment,
  CompiledScore,
  Moment,
  MomentId,
  MomentOf,
  MomentType,
  NoteSet,
  Piece,
  Seconds,
} from '../../core/types';
import { defaultMoment, withChordFill } from './new-moment';
import { rowsOf, setArrive, textureMoment, textureUntil, type RowName } from './rows';

export interface RowPaletteEntry {
  row: RowName;
  /** The moment type a new block on this row is (Texture: an Arpeggio pulse). */
  type: MomentType;
  /** Shortcut letter (upper case for display). */
  key: string;
  name: string;
  icon: string;
  /** Tooltip (without the shortcut). */
  hint: string;
}

export const ROW_PALETTE: readonly RowPaletteEntry[] = [
  {
    row: 'chords',
    type: 'chord',
    key: 'C',
    name: 'Chord',
    icon: '◆',
    hint: 'A chord, until the next one',
  },
  {
    row: 'texture',
    type: 'pulse',
    key: 'T',
    name: 'Texture',
    icon: '┇',
    hint: 'How the chords play',
  },
  {
    row: 'melody',
    type: 'tune',
    key: 'M',
    name: 'Melody',
    icon: '♪',
    hint: 'A melody on one line',
  },
  { row: 'level', type: 'level', key: 'L', name: 'Level', icon: '◢', hint: 'Fade notes' },
  {
    row: 'sound',
    type: 'timbre',
    key: 'S',
    name: 'Sound',
    icon: '◐',
    hint: 'Crossfade to another sound',
  },
  { row: 'key', type: 'key', key: 'K', name: 'Key', icon: '♯', hint: 'Change key or scale' },
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
 * A new block on `row` at `at` with id `id`. Chord: M10a's theory default (`defaultMoment`), or
 * `chordNotes`' notes when given, set to Land and filled to its size (`withChordFill`). Texture:
 * an Arpeggio to the end of the chord block under it. The rest: today's defaults.
 */
export function newBlock(
  row: RowName,
  at: Seconds,
  id: MomentId,
  piece: Piece,
  score: CompiledScore,
  chordNotes?: ChordNotesAt,
): Moment {
  switch (row) {
    case 'chords': {
      if (!chordNotes)
        return setArrive(
          defaultMoment('chord', at, id, piece, score),
          'land',
          piece.defaults.glide,
        );
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
      const until = textureUntil(rowsOf(piece, score), piece, at);
      return textureMoment('arpeggio', { id, at, until }, piece);
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

const ROW_OF_TYPE: ReadonlyMap<MomentType, RowName> = new Map(
  ROW_PALETTE.map((e) => [e.type, e.row] as const),
);

/**
 * What the palette, its shortcuts, drops and previews add for `type`: the row's new block for a
 * palette type (Chord lands; `pulse` is the Texture row's Arpeggio), else `defaultMoment`.
 */
export function paletteMoment<T extends MomentType>(
  type: T,
  at: Seconds,
  id: MomentId,
  piece: Piece,
  score: CompiledScore,
): MomentOf<T> {
  const row = ROW_OF_TYPE.get(type);
  return (
    row ? newBlock(row, at, id, piece, score) : defaultMoment(type, at, id, piece, score)
  ) as MomentOf<T>;
}
