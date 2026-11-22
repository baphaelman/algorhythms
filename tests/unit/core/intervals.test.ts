import { describe, expect, it } from 'vitest';
import { intervalName, semitoneText, spreadText } from '../../../src/core/intervals';

describe('interval names (HUD spread, PLAN §12 "Export look")', () => {
  it('names simple intervals', () => {
    expect(intervalName(0)).toBe('unison');
    expect(intervalName(3)).toBe('minor 3rd');
    expect(intervalName(4)).toBe('major 3rd');
    expect(intervalName(5)).toBe('4th');
    expect(intervalName(6)).toBe('tritone');
    expect(intervalName(7)).toBe('5th');
    expect(intervalName(11)).toBe('major 7th');
    expect(intervalName(12)).toBe('octave');
  });

  it('names compound intervals', () => {
    expect(intervalName(19)).toBe('octave + 5th');
    expect(intervalName(16)).toBe('octave + major 3rd');
    expect(intervalName(24)).toBe('2 octaves');
    expect(intervalName(31)).toBe('2 octaves + 5th');
    expect(intervalName(-7)).toBe('5th');
  });

  it('names only within 10 cents of a whole semitone', () => {
    expect(intervalName(18.92)).toBe('octave + 5th');
    expect(intervalName(19.1)).toBe('octave + 5th');
    expect(intervalName(18.85)).toBeNull();
    expect(intervalName(18.5)).toBeNull();
    expect(intervalName(NaN)).toBeNull();
  });

  it('writes semitones whole, or with one decimal while gliding', () => {
    expect(semitoneText(19)).toBe('19');
    expect(semitoneText(19.001)).toBe('19');
    expect(semitoneText(18.63)).toBe('18.6');
    expect(semitoneText(18.96)).toBe('19.0');
    expect(spreadText(19)).toBe('19 st · octave + 5th');
    expect(spreadText(18.6)).toBe('18.6 st');
    expect(spreadText(18.95)).toBe('19.0 st · octave + 5th');
    expect(spreadText(0)).toBe('0 st · unison');
  });
});
