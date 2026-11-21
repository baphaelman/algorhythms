/**
 * Merges and splits crossfade (PLAN.md §11.3): a piece with every kind of crossfade, shared by
 * the core, dsp and render tests.
 * - 1 s: a four-line unison (one line of weight 4) splits into a chord; the forks leave at
 *   staggered times, so the parent's crossfades overlap;
 * - 6 s: an explicit pitch list sends two moving lines onto two resting ones (coincidence joins);
 * - 10 s: a merge moment sends the last two lines into one (a death glide).
 */
import type { Piece } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

export function crossfadePiece(timbre = 'sine'): Piece {
  const p = piece({
    pool: 8,
    start: [60, 60, 60, 60],
    glide: { length: 2, stagger: 0.3, jitter: 0, arrive: 'spread', ease: 'smootherstep' },
    moments: [
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: [55, 60, 64, 67] },
        voicing: 'even',
        assign: 'ordered',
      },
      {
        type: 'chord',
        at: 6,
        notes: { kind: 'pitches', pitches: [60, 60, 64, 64] },
        voicing: 'even',
        assign: 'ordered',
      },
      { type: 'merge', at: 10, count: 1, which: 'top', fade: 1 },
    ],
    end: { at: 16, fade: 1 },
  });
  for (const v of p.voices) v.timbre = timbre;
  return p;
}

/** Before the end fade: every crossfade of `crossfadePiece` is over by then. */
export const CROSSFADE_PIECE_UNTIL = 14.9;

/**
 * tests/dsp/clicks.test.ts's moment-ends piece (a split to 7 lines, then a merge to 3), where the
 * pop bisect found the unison group gain h stepping ~30 % in one block as gliding lines met.
 */
export function lockMergePiece(timbre = 'sine'): Piece {
  const p = piece({
    pool: 8,
    start: [48, 55, 60, 64],
    glide: { length: 1.2, stagger: 0.3, jitter: 0, arrive: 'together', ease: 'smootherstep' },
    moments: [
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: [50, 57, 62, 65] },
        voicing: 'even',
        assign: 'ordered',
      },
      { type: 'pin', at: 3.5, voice: 'v1', pitch: 45, glide: { length: 0.15, ease: 'smoothstep' } },
      { type: 'level', at: 4.5, target: { voices: ['v2', 'v3'] }, gain: 0.5, over: 0.4 },
      { type: 'split', at: 6, count: 7, voicing: 'even' },
      { type: 'merge', at: 10, count: 3, which: 'top', fade: 1 },
      { type: 'level', at: 13, target: { voices: ['v2', 'v3'] }, gain: 1, over: 0.2 },
    ],
    end: { at: 16, fade: 1 },
  });
  for (const v of p.voices) v.timbre = timbre;
  return p;
}
