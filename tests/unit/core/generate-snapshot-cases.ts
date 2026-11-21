/**
 * Cases for the generate() byte-identity snapshot (generate-snapshot.json): natural length and
 * lengths at or above the 100 s floor, recorded before short pieces were added. Each hash is a
 * SHA-256 of the serialized piece.
 */

import { createHash } from 'node:crypto';
import type { GenerateMode, GenerateOptions } from '../../../src/core/generate';
import { layoutJson, serializePiece } from '../../../src/core/schema';
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

/**
 * The hash `piece` (schema v2) had as the version 1 file it replaces: the opening chord at 0
 * (one note) back in `start`, `version: 1`, keys in the version 1 order. Equal to a snapshot
 * hash, it shows generate() changed only by the start becoming a moment (M4.5-27).
 */
export function hashPieceAsV1(piece: Piece): string {
  const [opening, ...rest] = piece.moments;
  if (opening.type !== 'chord' || opening.notes.kind !== 'pitches' || opening.at !== 0)
    throw new Error('no opening chord');
  const v2 = JSON.parse(serializePiece({ ...piece, moments: rest })) as Record<string, unknown>;
  const v1: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(v2)) {
    v1[k] = k === 'version' ? 1 : v;
    if (k === 'voices')
      v1.start = opening.notes.pitches.map((pitch, i) => ({ voice: piece.voices[i].id, pitch }));
  }
  return createHash('sha256').update(layoutJson(v1)).digest('hex');
}
