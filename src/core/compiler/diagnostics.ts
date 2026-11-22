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
  'unknown-part': { level: 'warn', meaning: 'A `{ part }` target names no part of the pool.' },
  // Retired with schema v1's `start` (M4.5-27); kept so the codes are never reused.
  'start-duplicate': { level: 'warn', meaning: 'Retired (v1): a voice listed twice in `start`.' },
  'start-out-of-range': { level: 'info', meaning: 'Retired (v1): a start pitch was folded.' },
  'wobble-ignored': {
    level: 'info',
    meaning: 'A timbre sets `wobble`, which has no effect since lines never share a pitch (rev 8).',
  },
  // Moment validity
  'unknown-moment-type': {
    level: 'info',
    meaning: 'The moment type is not one this build knows (a newer file); it is kept, not played.',
  },
  'invalid-time': { level: 'error', meaning: 'The moment time is not a non-negative number.' },
  'invalid-moment': { level: 'error', meaning: 'A required field is missing or not a number.' },
  'walk-invalid': { level: 'error', meaning: 'A walk needs grid > 0 and until > at.' },
  'pulse-invalid': {
    level: 'error',
    meaning: 'A pulse needs step > 0, until > at and a non-empty pattern of numbers.',
  },
  'tune-invalid': {
    level: 'error',
    meaning: 'A tune needs a list of notes, each with a numeric pitch and a length > 0.',
  },
  'after-end': { level: 'info', meaning: 'The moment is at or after the end of the piece.' },
  'unknown-timbre': {
    level: 'warn',
    meaning: 'A timbre moment names no key of `timbres` and no built-in preset; it is skipped.',
  },
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
  'note-not-sounding': {
    level: 'warn',
    meaning: "A note moment's `from` is not sounding on a targeted voice; nothing changes.",
  },
  'note-back-skipped': {
    level: 'info',
    meaning: "A note moment's return was skipped: a later moment moved the note away.",
  },
  'tune-lost': {
    level: 'info',
    meaning:
      "A tune's line stopped sounding and its target has no other; the remaining notes are skipped.",
  },
  // Births and deaths
  'pool-exhausted': {
    level: 'warn',
    meaning: 'Not enough dormant voices; the split (or chord count) was truncated.',
  },
  'count-limited': {
    level: 'info',
    meaning: 'A chord count needs more deaths than it targets voices; one targeted voice stays.',
  },
  'split-no-births': {
    level: 'info',
    meaning: 'Enough voices are already active; nobody is born.',
  },
  'no-effect': {
    level: 'info',
    meaning:
      'The moment changes nothing at its time: no pitch target, audible count, level, key or timbre change (revision 6). A warning when nothing it targets is sounding.',
  },
  'merge-nothing': {
    level: 'info',
    meaning: 'The active count is already at or below the target.',
  },
  // Ranges and crossings
  'range-fold': { level: 'info', meaning: 'Targets outside a voice range were folded by octave.' },
  'fold-apart': {
    level: 'warn',
    meaning:
      'A target folded by octave onto another line of its part; it took the nearest free note so the lines do not merge.',
  },
  'invalid-target': {
    level: 'warn',
    meaning: 'A moment produced a non-finite target pitch; the voice keeps its destination.',
  },
  'spread-crowded': {
    level: 'warn',
    meaning: 'A spread (factor ≥ 0) has more notes than its ranges hold apart; some coincide.',
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
