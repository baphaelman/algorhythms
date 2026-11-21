/** Per-note weights in the inspector (revision 8, M4.5-29b): pure helpers. */
import { describe, expect, it } from 'vitest';
import {
  WEIGHT_MIN,
  noteLines,
  weightForNote,
  withOverride,
} from '../../../src/app/editor/overrides';
import { compile } from '../../../src/core/compiler/compile';
import { weightTargetAt } from '../../../src/core/query';
import type { Moment, Piece, VoiceOverride } from '../../../src/core/types';
import { piece, type MomentInput } from '../core/compiler-fixtures';

const NOTES = [48, 60, 64, 67];

const withChord = (overrides?: VoiceOverride[], pitches = NOTES): Piece =>
  piece({
    start: [50, 57, 62, 69],
    glide: { length: 2, jitter: 0, stagger: 0 },
    moments: [
      {
        id: 'c',
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches },
        voicing: 'even',
        assign: 'ordered',
        ...(overrides ? { overrides } : {}),
      } as MomentInput,
    ],
  });

const chordOf = (p: Piece): Moment => p.moments.find((m) => m.id === 'c')!;

describe('noteLines', () => {
  it('finds the line on each note, weight 1 with nothing joined', () => {
    const p = withChord();
    const lines = noteLines(compile(p), chordOf(p), NOTES);
    expect(lines.map((l) => l?.voice)).toEqual([0, 1, 2, 3]);
    expect(lines.every((l) => l?.weight === 1 && l.joined === 0)).toBe(true);
  });

  it('reads a weight override back', () => {
    const p = withChord([{ voice: 2, weight: 2.5 }]);
    const lines = noteLines(compile(p), chordOf(p), NOTES);
    expect(lines[2]).toEqual({ voice: 2, weight: 2.5, joined: 0 });
  });

  it('a note two lines merge on: the survivor, with the joined weight', () => {
    // Two lines on 64 (a literal list merges): the note's weight is 2, one of it joined.
    const notes = [48, 60, 64, 64];
    const p = withChord(undefined, notes);
    const s = compile(p);
    const [, , line] = noteLines(s, chordOf(p), notes);
    expect(line).not.toBeNull();
    expect(line!.weight).toBe(2);
    expect(line!.joined).toBe(1);
    // Asking for 3 sets the survivor's own weight to 2, and the note then weighs 3.
    const w = weightForNote(line!, 3);
    expect(w).toBe(2);
    const p2 = withChord([{ voice: line!.voice, weight: w }], notes);
    const s2 = compile(p2);
    expect(weightTargetAt(s2.voices[line!.voice], 8)).toBeCloseTo(3, 9);
    expect(noteLines(s2, chordOf(p2), notes)[2]?.weight).toBeCloseTo(3, 9);
  });

  it('null for a note no line rests on', () => {
    const p = withChord();
    expect(noteLines(compile(p), chordOf(p), [61])).toEqual([null]);
  });
});

describe('weightForNote', () => {
  it('subtracts what joins, never below the minimum', () => {
    expect(weightForNote({ voice: 0, weight: 1, joined: 0 }, 4)).toBe(4);
    expect(weightForNote({ voice: 0, weight: 3, joined: 2 }, 2)).toBe(WEIGHT_MIN);
    expect(weightForNote({ voice: 0, weight: 1, joined: 0 }, 1 / 3)).toBe(0.333);
  });
});

describe('withOverride', () => {
  it('keeps a weight when a dot drag edits pitch or end', () => {
    const list = withOverride([{ voice: 1, weight: 2 }], 1, { pitch: 62 });
    expect(list).toEqual([{ voice: 1, pitch: 62, weight: 2 }]);
    expect(withOverride(list, 1, { weight: 3 })).toEqual([{ voice: 1, pitch: 62, weight: 3 }]);
  });
});
