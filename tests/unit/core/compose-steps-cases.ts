/**
 * 200 generate() cases for the compose-steps snapshot (compose-steps-snapshot.json), recorded
 * from generate() before it was split into steps (M4.5-28). Seeds, modes, lengths (short and full
 * forms), note counts and densities all vary. Each hash is a SHA-256 of the serialized piece.
 */

import type { GenerateMode, GenerateOptions } from '../../../src/core/generate';

const MODES: GenerateMode[] = ['dorian', 'aeolian', 'lydian', 'pentatonic'];
const LENGTHS = [undefined, 30, 45, 60, 80, 99, 100, 150, 240, 600, 900];
const VOICES = [12, 2, 5, 12, 24, 32, 7];
const DENSITIES = [0.45, 0, 0.3, 0.7, 1];

export function composeCases(): { key: string; seed: number; opts: GenerateOptions }[] {
  const out: { key: string; seed: number; opts: GenerateOptions }[] = [];
  for (let i = 0; i < 200; i++) {
    const seed = i % 2 === 0 ? i : Math.imul(i, 0x9e3779b1) >>> 0;
    const opts: GenerateOptions = {
      mode: MODES[i % MODES.length],
      length: LENGTHS[i % LENGTHS.length],
      voices: VOICES[i % VOICES.length],
      density: DENSITIES[i % DENSITIES.length],
    };
    const key = `${seed} ${opts.mode} ${opts.length ?? 'natural'} v${opts.voices} d${opts.density}`;
    out.push({ key, seed, opts });
  }
  return out;
}
