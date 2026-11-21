/**
 * Pulse pieces (R9-3b) shared by the dsp, MIDI and render-match tests, plus a short musical demo.
 */
import type { Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

/** Accents of `pulseGatePiece`, cycling. */
export const GATE_PATTERN = [1, 0.5, 0.75, 0.25];

/**
 * One held A4 with a `together` pulse: hits every `step` from 1 s to 5 s, the accents of
 * GATE_PATTERN, `decay` 0.3, `floor` as given. Ends at 6 s.
 */
export function pulseGatePiece(
  timbre = 'sine',
  opts: { floor?: number; step?: number; decay?: number; strike?: boolean } = {},
): Piece {
  const p = piece({
    pool: 2,
    start: [69],
    glide: { length: 1, stagger: 0, jitter: 0, ease: 'smootherstep' },
    moments: [
      {
        type: 'pulse',
        at: 1,
        until: 5,
        step: opts.step ?? 0.5,
        pattern: GATE_PATTERN,
        decay: opts.decay ?? 0.3,
        floor: opts.floor ?? 0,
        mode: 'together',
        ...(opts.strike === false ? { strike: false } : {}),
      },
    ],
    end: { at: 6, fade: 0.5 },
  });
  for (const v of p.voices) v.timbre = timbre;
  return p;
}

/**
 * Four voices: a `together` pulse (1/8 gate at 0.25 s, floor 0.15) from 1 s to 7 s over a chord
 * change at 3 s (the hits land on gliding lines), and an `updown` arpeggio over the top three
 * from 7.5 s to 10 s at floor 0. Ends at 11 s.
 */
export function pulseChordPiece(timbre = 'sine'): Piece {
  const p = piece({
    pool: 6,
    start: [57, 60, 64, 69],
    glide: { length: 1.2, stagger: 0.1, jitter: 0, ease: 'smootherstep' },
    moments: [
      {
        type: 'pulse',
        at: 1,
        until: 7,
        step: 0.25,
        pattern: [1, 0.4, 0.7, 0.4],
        decay: 0.2,
        floor: 0.15,
        mode: 'together',
      },
      {
        type: 'chord',
        at: 3,
        notes: { kind: 'pitches', pitches: [55, 59, 62, 67] },
        voicing: 'even',
        assign: 'ordered',
      },
      {
        type: 'pulse',
        at: 7.5,
        until: 10,
        step: 0.2,
        pattern: [1, 0.6],
        decay: 0.18,
        floor: 0,
        mode: 'updown',
        target: { rank: [1, 3] },
      },
    ],
    end: { at: 11, fade: 0.5 },
  });
  for (const v of p.voices) v.timbre = timbre;
  return p;
}

/**
 * Demo for the owner (R9-3b): 96 bpm in D dorian, Dm9 → Bbmaj9 → Gm9 → A7sus4 → Dm9. A glass pad
 * gated in eighths with an accent pattern, a pluck arpeggio (up-down sixteenths) over the gliding
 * chords, and an organ bass pulsing on beats 1 and 3. About 23 s.
 */
export function pulseDemoPiece(): Piece {
  const beat = 60 / 96;
  const bar = 4 * beat;
  const at = (bars: number): number => Math.round(bars * bar * 1e6) / 1e6;
  const pad = ['v1', 'v2', 'v3', 'v4'];
  const arp = ['v5', 'v6', 'v7'];
  const bass = ['v8'];
  const chord = (t: number, voices: string[], pitches: number[], length = 0.6): MomentInput => ({
    type: 'chord',
    at: t,
    target: { voices },
    notes: { kind: 'pitches', pitches },
    voicing: 'even',
    assign: 'ordered',
    glide: { length, stagger: 0.05, jitter: 0 },
  });
  const changes: [number, number[], number[], number][] = [
    [2, [50, 53, 57, 60], [65, 69, 72], 34],
    [4, [53, 57, 58, 62], [65, 70, 74], 31],
    [6, [50, 52, 55, 57], [64, 67, 69], 33],
    [8, [53, 57, 60, 64], [69, 72, 76], 38],
  ];
  const moments: MomentInput[] = [];
  for (const [b, padP, arpP, bassP] of changes) {
    moments.push(chord(at(b) - 0.3, pad, padP), chord(at(b) - 0.3, arp, arpP, 0.4));
    moments.push(chord(at(b) - 0.2, bass, [bassP], 0.25));
  }
  moments.push(
    {
      type: 'pulse',
      at: 0,
      until: at(9),
      step: beat / 2,
      pattern: [1, 0.35, 0.6, 0.35, 0.9, 0.35, 0.6, 0.5],
      decay: 0.28,
      floor: 0.2,
      mode: 'together',
      target: { voices: pad },
    },
    {
      type: 'pulse',
      at: at(1),
      until: at(9),
      step: beat / 4,
      pattern: [1, 0.55, 0.8, 0.55],
      decay: 0.14,
      floor: 0,
      mode: 'updown',
      target: { voices: arp },
    },
    {
      type: 'pulse',
      at: 0,
      until: at(9),
      step: beat,
      pattern: [1, 0, 0.7, 0],
      decay: 0.5,
      floor: 0.25,
      mode: 'together',
      target: { voices: bass },
    },
  );
  const p = piece({
    seed: 96,
    pool: 8,
    start: [53, 57, 60, 64, 69, 72, 76, 38],
    glide: { length: 0.6, stagger: 0.05, jitter: 0, ease: 'smootherstep' },
    moments,
    end: { at: at(9) + 2, fade: 1.5 },
  });
  p.meta.title = 'Pulse demo';
  p.view.gridBpm = 96;
  p.voices.forEach((v, i) => {
    if (i < 4) Object.assign(v, { timbre: 'glass', part: 'Pad', range: [48, 72], gain: 0.75 });
    else if (i < 7) Object.assign(v, { timbre: 'pluck', part: 'Arp', range: [60, 84], gain: 0.6 });
    else Object.assign(v, { timbre: 'organ', part: 'Bass', range: [28, 50], gain: 1 });
  });
  return p;
}
