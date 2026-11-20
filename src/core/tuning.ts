/**
 * Tuning: pitch ↔ frequency (PLAN.md §5 `tuning`). Only 12-TET ships in v1; Scala is Later.
 *
 * Pitch is a fractional MIDI note number (69 = A4) everywhere in the model; Hz appears only at
 * synthesis time. Uses the portable exp2/log2 (§7.11), so core/ gets the same Hz on every engine.
 */

import { exp2, log2 } from './math';
import type { Pitch } from './types';

/** Default Hz of pitch 69 (A4). */
export const DEFAULT_REFERENCE_HZ = 440;

/** 12-TET: Hz of pitch `p`, given the Hz of pitch 69. hzOf(69, 440) = 440 exactly. */
export function hzOf(p: Pitch, referenceHz: number = DEFAULT_REFERENCE_HZ): number {
  return referenceHz * exp2((p - 69) / 12);
}

/** 12-TET: the (fractional) pitch of a frequency, given the Hz of pitch 69. Inverse of `hzOf`. */
export function pitchOfHz(hz: number, referenceHz: number = DEFAULT_REFERENCE_HZ): Pitch {
  return 69 + 12 * log2(hz / referenceHz);
}
