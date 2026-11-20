/** Unit tests for core/scales.ts (PLAN.md §7.8). */

import { describe, expect, it } from 'vitest';
import {
  SCALES,
  SCALE_NAMES,
  degreesToPcs,
  isScaleTone,
  noteName,
  parsePitchClass,
  pitchClassOf,
  pitchOfDegreeIndex,
  pitchesWithPcs,
  scaleDegreeIndex,
  scaleIntervals,
  scalePcs,
  snapToScale,
  stepByScale,
} from '../../../src/core/scales';
import type { Key, PitchClass } from '../../../src/core/types';

const A_DORIAN: Key = { tonic: 'A', scale: 'dorian' };
const C_MAJOR: Key = { tonic: 'C', scale: 'major' };

describe('pitch classes', () => {
  it('maps all 17 PitchClass spellings', () => {
    const expected: Record<PitchClass, number> = {
      C: 0,
      'C#': 1,
      Db: 1,
      D: 2,
      'D#': 3,
      Eb: 3,
      E: 4,
      F: 5,
      'F#': 6,
      Gb: 6,
      G: 7,
      'G#': 8,
      Ab: 8,
      A: 9,
      'A#': 10,
      Bb: 10,
      B: 11,
    };
    for (const [name, pc] of Object.entries(expected)) {
      expect(pitchClassOf(name as PitchClass)).toBe(pc);
    }
  });

  it('parses wider spellings and rejects junk', () => {
    expect(parsePitchClass('Cb')).toBe(11);
    expect(parsePitchClass('B#')).toBe(0);
    expect(parsePitchClass('E#')).toBe(5);
    expect(parsePitchClass('Fb')).toBe(4);
    expect(parsePitchClass('F##')).toBe(7);
    expect(parsePitchClass('Fx')).toBe(7);
    expect(parsePitchClass('Bbb')).toBe(9);
    expect(parsePitchClass('F♯')).toBe(6);
    expect(parsePitchClass('B♭')).toBe(10);
    expect(parsePitchClass('g')).toBe(7);
    expect(parsePitchClass('H')).toBeNull();
    expect(parsePitchClass('')).toBeNull();
    expect(parsePitchClass('C#m')).toBeNull();
    expect(() => pitchClassOf('H' as PitchClass)).toThrow(RangeError);
  });

  it('names notes with octaves (MIDI 60 = C4)', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(57)).toBe('A3');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(61, true)).toBe('Db4');
    expect(noteName(59.6)).toBe('C4');
    expect(noteName(0)).toBe('C-1');
  });
});

describe('scale tables', () => {
  it('has every ScaleName with well-formed intervals', () => {
    expect([...SCALE_NAMES].sort()).toEqual(
      [
        'aeolian',
        'blues',
        'chromatic',
        'dorian',
        'harmonic-minor',
        'ionian',
        'locrian',
        'lydian',
        'major',
        'melodic-minor',
        'minor',
        'mixolydian',
        'pentatonic-major',
        'pentatonic-minor',
        'phrygian',
        'whole-tone',
      ].sort(),
    );
    for (const name of SCALE_NAMES) {
      const iv = SCALES[name];
      expect(iv[0]).toBe(0);
      for (let i = 1; i < iv.length; i++) expect(iv[i]).toBeGreaterThan(iv[i - 1]);
      expect(iv[iv.length - 1]).toBeLessThan(12);
    }
    expect(SCALES.major).toBe(SCALES.ionian);
    expect(SCALES.minor).toBe(SCALES.aeolian);
    expect(SCALES.dorian).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(SCALES.blues).toEqual([0, 3, 5, 6, 7, 10]);
    expect(Object.isFrozen(SCALES)).toBe(true);
    expect(Object.isFrozen(SCALES.dorian)).toBe(true);
  });

  it('modes of C major are rotations of the same pitch-class set', () => {
    const cMajor = scalePcs(C_MAJOR);
    const modes: [PitchClass, string][] = [
      ['D', 'dorian'],
      ['E', 'phrygian'],
      ['F', 'lydian'],
      ['G', 'mixolydian'],
      ['A', 'aeolian'],
      ['B', 'locrian'],
    ];
    for (const [tonic, scale] of modes) {
      expect(scalePcs({ tonic, scale: scale as Key['scale'] })).toEqual(cMajor);
    }
  });

  it('scalePcs sorts absolute pitch classes', () => {
    expect(scalePcs(A_DORIAN)).toEqual([0, 2, 4, 6, 7, 9, 11]); // A B C D E F# G
    expect(scalePcs({ tonic: 'Eb', scale: 'pentatonic-minor' })).toEqual([1, 3, 6, 8, 10]);
  });

  it('supports custom scales, normalising sloppy intervals', () => {
    const key: Key = {
      tonic: 'D',
      scale: { kind: 'custom', name: 'hirajoshi', intervals: [0, 2, 3, 7, 8] },
    };
    expect(scalePcs(key)).toEqual([2, 4, 5, 9, 10]);
    expect(scaleIntervals({ kind: 'custom', intervals: [7, 14, 3, 3] })).toEqual([0, 2, 3, 7]);
    expect(scaleIntervals({ kind: 'custom', intervals: [] })).toEqual([0]);
    expect(stepByScale(62, 5, key)).toBe(74);
    // A one-note scale steps by octaves.
    expect(stepByScale(61, 1, { tonic: 'C', scale: { kind: 'custom', intervals: [] } })).toBe(72);
  });

  it('isScaleTone', () => {
    expect(isScaleTone(57, A_DORIAN)).toBe(true);
    expect(isScaleTone(66, A_DORIAN)).toBe(true); // F#
    expect(isScaleTone(65, A_DORIAN)).toBe(false); // F
    expect(isScaleTone(57.5, A_DORIAN)).toBe(false);
  });
});

describe('snapping and degree indices', () => {
  it('snaps to the nearest scale tone, ties down', () => {
    expect(snapToScale(57, A_DORIAN)).toBe(57);
    expect(snapToScale(65, A_DORIAN)).toBe(64); // F is between E and F#: tie, down
    expect(snapToScale(65.01, A_DORIAN)).toBe(66);
    expect(snapToScale(56, A_DORIAN)).toBe(55); // G# between G and A: tie, down
    expect(snapToScale(57.4, A_DORIAN)).toBe(57);
    expect(snapToScale(60.5, { tonic: 'C', scale: 'chromatic' })).toBe(60);
    expect(snapToScale(61, C_MAJOR)).toBe(60);
    expect(snapToScale(63, C_MAJOR)).toBe(62);
    expect(snapToScale(-1, C_MAJOR)).toBe(-1); // B below C-1
    expect(snapToScale(Infinity, C_MAJOR)).toBe(Infinity);
    // Whole-tone: every odd semitone is a tie.
    expect(snapToScale(61, { tonic: 'C', scale: 'whole-tone' })).toBe(60);
  });

  it('numbers scale tones from the tonic', () => {
    // A dorian: A = 9 is index 0; A3 = 57 = 9 + 48 is index 4·7 = 28.
    expect(scaleDegreeIndex(9, A_DORIAN)).toBe(0);
    expect(scaleDegreeIndex(57, A_DORIAN)).toBe(28);
    expect(scaleDegreeIndex(59, A_DORIAN)).toBe(29);
    expect(scaleDegreeIndex(55, A_DORIAN)).toBe(27);
    expect(scaleDegreeIndex(0, C_MAJOR)).toBe(0);
    expect(scaleDegreeIndex(-1, C_MAJOR)).toBe(-1);
    expect(pitchOfDegreeIndex(28, A_DORIAN)).toBe(57);
    expect(pitchOfDegreeIndex(-1, A_DORIAN)).toBe(7); // the G just below index 0's A (9)
    expect(pitchOfDegreeIndex(-7, A_DORIAN)).toBe(-3); // the A an octave below
  });

  it('round-trips index → pitch → index over a wide range for every scale', () => {
    for (const scale of SCALE_NAMES) {
      for (const tonic of ['C', 'F#', 'Bb', 'A'] as PitchClass[]) {
        const key: Key = { tonic, scale };
        let prev = -Infinity;
        for (let i = -40; i <= 120; i++) {
          const p = pitchOfDegreeIndex(i, key);
          expect(p).toBeGreaterThan(prev);
          expect(isScaleTone(p, key)).toBe(true);
          expect(scaleDegreeIndex(p, key)).toBe(i);
          prev = p;
        }
      }
    }
  });

  it('steps by scale, snapping first', () => {
    expect(stepByScale(57, 1, A_DORIAN)).toBe(59);
    expect(stepByScale(57, 2, A_DORIAN)).toBe(60);
    expect(stepByScale(57, -1, A_DORIAN)).toBe(55);
    expect(stepByScale(57, 7, A_DORIAN)).toBe(69);
    expect(stepByScale(57, 0, A_DORIAN)).toBe(57);
    expect(stepByScale(65, 1, A_DORIAN)).toBe(66); // F snaps down to E, then steps to F#
    expect(stepByScale(57.3, 0, A_DORIAN)).toBe(57);
  });

  it('degreesToPcs is positional and wraps past the scale size', () => {
    expect(degreesToPcs([0, 2, 4, 6], A_DORIAN)).toEqual([9, 0, 4, 7]); // Am7
    // Degree 8 is degree 1 (B) an octave up; degree 9 is degree 2 (C) an octave up.
    expect(degreesToPcs([8, 9], A_DORIAN)).toEqual([11, 0]);
    expect(degreesToPcs([-1], A_DORIAN)).toEqual([7]); // G
    expect(degreesToPcs([0, 7, 14], A_DORIAN)).toEqual([9, 9, 9]);
    // PLAN.md §5's example [3, 5, 7, 9]: D F# A C, the dorian IV7.
    expect(degreesToPcs([3, 5, 7, 9], A_DORIAN)).toEqual([2, 6, 9, 0]);
    expect(degreesToPcs([0, 2, 4, 6], { tonic: 'A', scale: 'pentatonic-major' })).toEqual([
      9, 1, 6, 11,
    ]);
  });

  it('pitchesWithPcs lists candidates in a register', () => {
    expect(pitchesWithPcs([9, 0, 4], 55, 66)).toEqual([57, 60, 64]);
    expect(pitchesWithPcs([0], 47.5, 72)).toEqual([48, 60, 72]);
    expect(pitchesWithPcs([], 0, 127)).toEqual([]);
  });
});
