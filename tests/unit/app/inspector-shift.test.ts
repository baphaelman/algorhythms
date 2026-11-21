import { describe, expect, it } from 'vitest';
import {
  SHIFT_OCTAVES,
  formatShift,
  formatSigned,
  shiftAtPosition,
  shiftOctave,
  shiftPosition,
  snapShift,
} from '../../../src/app/ui/inspector/fields';

describe('shift amount slider (§11.3)', () => {
  it('octave size follows the unit and the key', () => {
    expect(shiftOctave('semitones', { tonic: 'C', scale: 'major' })).toBe(12);
    expect(shiftOctave('scaleSteps', { tonic: 'D', scale: 'dorian' })).toBe(7);
    expect(shiftOctave('scaleSteps', { tonic: 'A', scale: 'pentatonic-minor' })).toBe(5);
  });

  it('maps value to position centred on 0, ±2 octaves, clamped', () => {
    expect(SHIFT_OCTAVES).toBe(2);
    expect(shiftPosition(0, 7)).toBe(0.5);
    expect(shiftPosition(-14, 7)).toBe(0);
    expect(shiftPosition(14, 7)).toBe(1);
    expect(shiftPosition(7, 7)).toBe(0.75);
    expect(shiftPosition(-12, 12)).toBe(0.25);
    expect(shiftPosition(99, 12)).toBe(1);
  });

  it('position maps back to every integer step', () => {
    for (const n of [5, 7, 12])
      for (let v = -2 * n; v <= 2 * n; v++) expect(shiftAtPosition(shiftPosition(v, n), n)).toBe(v);
  });

  it('snaps to octave marks near them, else rounds to a step', () => {
    expect(snapShift(6.3, 7)).toBe(7);
    expect(snapShift(7.7, 7)).toBe(7);
    expect(snapShift(6.2, 7)).toBe(6);
    expect(snapShift(7.8, 7)).toBe(8);
    expect(snapShift(-11.4, 12)).toBe(-12);
    expect(snapShift(0.6, 12)).toBe(0);
    expect(Object.is(snapShift(-0.4, 7), 0)).toBe(true);
    expect(snapShift(-30, 7)).toBe(-14);
    expect(shiftAtPosition(0.74, 7)).toBe(7);
  });

  it('formats the signed value with octaves', () => {
    expect(formatSigned(-5)).toBe('−5');
    expect(formatShift(0, 7)).toBe('0');
    expect(formatShift(3, 7)).toBe('+3');
    expect(formatShift(-3, 7)).toBe('−3');
    expect(formatShift(7, 7)).toBe('+7 (+1 oct)');
    expect(formatShift(-24, 12)).toBe('−24 (−2 oct)');
  });
});
