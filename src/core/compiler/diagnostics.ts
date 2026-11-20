/**
 * Stable diagnostic codes (types.ts `Diagnostic.code`). Tests and the UI match on these, so never
 * rename one; add new ones instead.
 */

import type { DiagnosticLevel } from '../types';

export const DIAGNOSTIC_CODES: Readonly<
  Record<string, { level: DiagnosticLevel; meaning: string }>
> = {
  // Piece level
  'too-many-voices': { level: 'error', meaning: 'More than 32 pool voices; the rest are ignored.' },
  'duplicate-voice-id': {
    level: 'error',
    meaning: 'Two pool voices share an id; later ones are ignored.',
  },
  'duplicate-moment-id': {
    level: 'warn',
    meaning: 'Two moments share an id, so they share random draws.',
  },
  'unknown-voice': { level: 'warn', meaning: 'A voice id that is not in the pool.' },
  'start-duplicate': { level: 'warn', meaning: 'A voice is listed twice in `start`.' },
  'start-out-of-range': { level: 'info', meaning: 'A start pitch was folded into its range.' },
  // Moment validity
  'unknown-moment-type': {
    level: 'error',
    meaning: 'The moment type is not one this build knows.',
  },
  'invalid-time': { level: 'error', meaning: 'The moment time is not a non-negative number.' },
  'invalid-moment': { level: 'error', meaning: 'A required field is missing or not a number.' },
  'walk-invalid': { level: 'error', meaning: 'A walk needs grid > 0 and until > at.' },
  'after-end': { level: 'info', meaning: 'The moment is at or after the end of the piece.' },
  // Targets and notes
  'no-targets': { level: 'info', meaning: 'The moment targets no active voice.' },
  'chord-parse': { level: 'error', meaning: 'The chord symbol could not be parsed.' },
  'empty-notes': { level: 'error', meaning: 'The notes resolve to nothing.' },
  'empty-register': { level: 'error', meaning: 'No note of the chord lies in the register.' },
  'targets-dropped': {
    level: 'info',
    meaning: 'More notes than voices; the extra notes were dropped.',
  },
  'walk-note-ignored': {
    level: 'info',
    meaning:
      'A frozen walk note is invalid, past the walk, or for a voice not active, still moving or driven by another walk.',
  },
  'walk-note-blocked': {
    level: 'warn',
    meaning:
      'A frozen walk note would cross or touch a neighbour or leave the range; the voice holds.',
  },
  'pin-inactive': { level: 'error', meaning: 'The pinned voice is not active at that time.' },
  // Births and deaths
  'pool-exhausted': {
    level: 'warn',
    meaning: 'Not enough dormant voices; the split was truncated.',
  },
  'split-no-births': {
    level: 'info',
    meaning: 'Enough voices are already active; nobody is born.',
  },
  'no-effect': {
    level: 'info',
    meaning:
      'The moment changes nothing at its time: no pitch target, audible count, level or key change (revision 6).',
  },
  'merge-nothing': {
    level: 'info',
    meaning: 'The active count is already at or below the target.',
  },
  // Ranges and crossings
  'range-fold': { level: 'info', meaning: 'Targets outside a voice range were folded by octave.' },
  'invalid-target': {
    level: 'warn',
    meaning: 'A moment produced a non-finite target pitch; the voice keeps its destination.',
  },
  'range-too-narrow': {
    level: 'warn',
    meaning: 'A range narrower than an octave; a target was clamped.',
  },
  'crossing-untargeted': {
    level: 'info',
    meaning: 'A moment with a subset target moves voices through voices outside it.',
  },
  'crossing-unresolved': {
    level: 'info',
    meaning: 'Timing merges and the velocity clamp could not remove a crossing.',
  },
};
