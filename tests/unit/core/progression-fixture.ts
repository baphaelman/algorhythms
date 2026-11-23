/** A piece that plays a chord progression (theory and Next tests). */
import type { Key, Moment, Piece } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

/**
 * Plays `symbols` (numerals in `key`) every 4 s from silence, close-voiced in [52, 72] (one line
 * per note of the first chord); `extra` moments are added as given.
 */
export function progression(key: Key, symbols: string[], extra: Moment[] = []): Piece {
  return piece({
    start: [],
    key,
    end: { at: 4 * symbols.length + 20, fade: 1 },
    moments: [
      ...symbols.map((symbol, i) => ({
        type: 'chord' as const,
        at: 4 * i,
        notes: { kind: 'chord' as const, symbol },
        voicing: 'close' as const,
        register: [52, 72] as [number, number],
        assign: 'ordered' as const,
      })),
      ...extra,
    ],
  });
}
