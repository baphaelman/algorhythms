import { describe, expect, it } from 'vitest';
import {
  CHORD_QUALITIES,
  chordSymbol,
  diatonicChords,
  qualityById,
  readChord,
  romanNumeral,
  type ChordBass,
} from '../../../src/core/chord-spec';
import { parseChord } from '../../../src/core/chords';
import type { Key } from '../../../src/core/types';

const C: Key = { tonic: 'C', scale: 'major' };
const A_MINOR: Key = { tonic: 'A', scale: 'minor' };
const F: Key = { tonic: 'F', scale: 'major' };
const E: Key = { tonic: 'E', scale: 'major' };

describe('slash chords on the root', () => {
  it('parses C/C and keeps the bass', () => {
    const r = parseChord('C/C', C);
    expect(r).toEqual({ ok: true, pcs: [0, 4, 7], root: 0, bass: 0 });
  });
  it('round-trips through the picker', () => {
    expect(chordSymbol({ root: 0, quality: 'maj', bass: 'root' }, C)).toBe('C/C');
    expect(readChord('C/C', C)).toEqual({ root: 0, quality: 'maj', bass: 'root' });
  });
});

describe('chordSymbol / readChord', () => {
  it('writes every quality and bass so it parses back to the same choices', () => {
    for (const key of [C, F, E, A_MINOR]) {
      for (let root = 0; root < 12; root++) {
        for (const c of CHORD_QUALITIES) {
          for (const bass of ['any', 'root', 'third', 'fifth'] as ChordBass[]) {
            const s = chordSymbol({ root, quality: c.id, bass }, key);
            expect(parseChord(s, key).ok, s).toBe(true);
            expect(readChord(s, key), s).toEqual({ root, quality: c.id, bass });
          }
        }
      }
    }
  });

  it('spells in the key', () => {
    expect(chordSymbol({ root: 10, quality: 'maj', bass: 'any' }, F)).toBe('Bb');
    expect(chordSymbol({ root: 6, quality: 'm7b5', bass: 'any' }, E)).toBe('F#m7b5');
    expect(chordSymbol({ root: 0, quality: 'maj', bass: 'third' }, C)).toBe('C/E');
    expect(chordSymbol({ root: 2, quality: 'm7', bass: 'fifth' }, C)).toBe('Dm7/A');
    expect(chordSymbol({ root: 0, quality: 'sus4', bass: 'third' }, C)).toBe('Csus4/F');
  });

  it('reads Roman numerals, unknown qualities and other basses', () => {
    expect(readChord('ii7', C)).toEqual({ root: 2, quality: 'm7', bass: 'any' });
    expect(readChord('I', C)).toEqual({ root: 0, quality: 'maj', bass: 'any' });
    expect(readChord('V7/V', C)).toEqual({ root: 2, quality: '7', bass: 'any' });
    expect(readChord('C13', C)).toEqual({ root: 0, quality: null, bass: 'any' });
    expect(readChord('C7/Bb', C)).toEqual({ root: 0, quality: '7', bass: 'other' });
    expect(readChord('C/D', C)).toEqual({ root: 0, quality: 'maj', bass: 'other' });
    expect(readChord('Xq', C)).toBeNull();
  });
});

describe('romanNumeral', () => {
  it('names chords in major and minor', () => {
    expect(romanNumeral(2, qualityById('m7'), C)).toBe('ii7');
    expect(romanNumeral(11, qualityById('dim'), C)).toBe('vii°');
    expect(romanNumeral(10, qualityById('maj'), C)).toBe('♭VII');
    expect(romanNumeral(6, qualityById('maj'), C)).toBe('♯IV');
    expect(romanNumeral(0, qualityById('maj'), A_MINOR)).toBe('♭III');
    expect(romanNumeral(11, qualityById('m7b5'), A_MINOR)).toBe('iiø7');
    expect(romanNumeral(4, null, C)).toBe('III');
  });
});

describe('diatonicChords', () => {
  it('lists the triads of a major key', () => {
    expect(diatonicChords(C).map((d) => `${d.numeral}:${d.symbol}`)).toEqual([
      'I:C',
      'ii:Dm',
      'iii:Em',
      'IV:F',
      'V:G',
      'vi:Am',
      'vii°:Bdim',
    ]);
  });
  it('spells flat keys and handles harmonic minor', () => {
    expect(diatonicChords(F).map((d) => d.symbol)).toContain('Bb');
    const hm = diatonicChords({ tonic: 'A', scale: 'harmonic-minor' });
    expect(hm.map((d) => d.numeral)).toEqual(['i', 'ii°', '♭III+', 'iv', 'V', '♭VI', 'vii°']);
  });
  it('is empty for scales without seven notes', () => {
    expect(diatonicChords({ tonic: 'C', scale: 'pentatonic-major' })).toEqual([]);
  });
});
