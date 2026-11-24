/**
 * STUB until M12 D1 merges (`src/core/compose-brief.ts`): the `ComposeBrief` type exactly as
 * PLAN.md M12 writes it, a placeholder `PROGRESSIONS` list, and `composeDirected` mapped onto
 * today's composer (seed, length, a mode from the mood). The swap: delete this file and point
 * its importers at `../core/compose-brief` (see docs/build-log.md, M12 D2).
 */

import { composeSteps, type Composition, type GenerateMode } from '../core/generate';

export type ComposeMood = 'calm' | 'bright' | 'dreamy' | 'dark' | 'driving';
export type ComposeLength = 60 | 120 | 180 | 300;
export type ComposeShape = 'build' | 'arc' | 'steady' | 'journey';
export type ComposePart = 'chords' | 'bass' | 'melody' | 'pulse' | 'bells';
export type ComposeStart =
  | { kind: 'none' }
  | { kind: 'progression'; name: string }
  | { kind: 'melody'; notes: { at: number; pitch: number; dur: number }[] };

/** What to compose (PLAN.md M12). A missing field means Surprise me. */
export interface ComposeBrief {
  seed: number;
  mood?: ComposeMood;
  length?: ComposeLength;
  shape?: ComposeShape;
  parts?: ComposePart[];
  start?: ComposeStart;
  key?: { tonic: number; mode: string };
  tempo?: number;
}

/** Named chord progressions to start from (placeholder names). */
export const PROGRESSIONS: readonly { name: string }[] = [
  { name: 'Pop: I–V–vi–IV' },
  { name: 'Canon' },
  { name: 'Andalusian' },
  { name: 'Circle of fifths' },
];

const MOOD_MODE: Record<ComposeMood, GenerateMode> = {
  calm: 'pentatonic',
  bright: 'lydian',
  dreamy: 'dorian',
  dark: 'aeolian',
  driving: 'dorian',
};
const MODES: readonly GenerateMode[] = ['dorian', 'aeolian', 'lydian', 'pentatonic'];

/** The composition for a brief, as ordered steps (today's composer under the stub). */
export function composeDirected(brief: ComposeBrief): Composition {
  const seed = brief.seed >>> 0;
  const mode = brief.mood ? MOOD_MODE[brief.mood] : MODES[seed % MODES.length];
  return composeSteps(seed, {
    mode,
    length: brief.length ?? 150,
    density: brief.mood === 'driving' ? 0.7 : brief.mood === 'calm' ? 0.3 : 0.45,
  });
}
