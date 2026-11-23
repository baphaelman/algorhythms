/**
 * New → "Like the video" (PLAN.md §6.4): the demo's video preset as moments. A minor at 80 bpm,
 * six 2-bar chord blocks set to Float: one note, bloom to six, two chords, gather to one note,
 * bloom to seven with a Wander texture. Only chord and walk moments.
 */

import { newPiece } from '../../core/defaults';
import type { ChordMoment, NoteSet, Piece } from '../../core/types';
import { FLOAT_GLIDE, textureMoment } from './rows';

const BPM = 80;
const BLOCK = 2 * 4 * (60 / BPM);

/** The blocks: notes and Notes: n (count 1 sounds the chord's root). */
const BLOCKS: readonly [NoteSet, number][] = [
  [{ kind: 'chord', symbol: 'i' }, 1],
  [{ kind: 'chord', symbol: 'i9' }, 6],
  [{ kind: 'chord', symbol: 'bVImaj9' }, 6],
  [{ kind: 'chord', symbol: 'iv9' }, 6],
  [{ kind: 'chord', symbol: 'V' }, 1],
  [{ kind: 'chord', symbol: 'i9' }, 7],
];

export function likeTheVideo(opts: { seed: number; now?: string }): Piece {
  const piece = newPiece({
    seed: opts.seed,
    now: opts.now,
    title: 'Like the video',
    key: { tonic: 'A', scale: 'minor' },
  });
  piece.view = { ...piece.view, gridBpm: BPM, meter: 4 };
  const chords = BLOCKS.map(([notes, count], i): ChordMoment => ({
    id: `video${i + 1}`,
    type: 'chord',
    at: i * BLOCK,
    notes,
    voicing: 'even',
    assign: 'ordered',
    count,
    glide: { ...FLOAT_GLIDE },
  }));
  const last = (BLOCKS.length - 1) * BLOCK;
  const wander = textureMoment('wander', { id: 'video7', at: last, until: last + BLOCK }, piece);
  piece.moments = [...chords, wander];
  return piece;
}
