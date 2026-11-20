/**
 * Cases for the generate() byte-identity snapshot (generate-snapshot.json): natural length and
 * lengths at or above the 100 s floor, recorded before short pieces were added. Each hash is a
 * SHA-256 of the serialized piece.
 */

import { createHash } from 'node:crypto';
import type { GenerateMode, GenerateOptions } from '../../../src/core/generate';
import { serializePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';

const MODES: GenerateMode[] = ['dorian', 'aeolian', 'lydian', 'pentatonic'];
const SEEDS = [1, 2, 7, 2611, 31337, 99999];
const LENGTHS = [undefined, 100, 101, 117, 130, 155, 240, 600, 900];

export function snapshotCases(): { key: string; seed: number; opts: GenerateOptions }[] {
  const out: { key: string; seed: number; opts: GenerateOptions }[] = [];
  for (const mode of MODES)
    for (const seed of SEEDS)
      for (const length of LENGTHS)
        out.push({ key: `${mode} ${seed} ${length ?? 'natural'}`, seed, opts: { mode, length } });
  for (const voices of [2, 6, 24, 32])
    for (const length of [undefined, 120])
      out.push({
        key: `dorian 5 ${length ?? 'natural'} v${voices} d0.7`,
        seed: 5,
        opts: { mode: 'dorian', length, voices, density: 0.7 },
      });
  return out;
}

export function hashPiece(piece: Piece): string {
  return createHash('sha256').update(serializePiece(piece)).digest('hex');
}
