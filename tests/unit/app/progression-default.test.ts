import { describe, expect, it } from 'vitest';
import { diatonicChords, readChord } from '../../../src/core/chord-spec';
import { parseChord } from '../../../src/core/chords';
import { SCALE_NAMES } from '../../../src/core/scales';
import type { Key, ScaleName } from '../../../src/core/types';
import { defaultProgressionSymbols } from '../../../src/app/editor/progression';

const EXPECTED: Record<ScaleName, string[]> = {
  major: ['I', 'vi', 'IV', 'V'],
  ionian: ['I', 'vi', 'IV', 'V'],
  minor: ['i', '♭VI', '♭III', '♭VII'],
  aeolian: ['i', '♭VI', '♭III', '♭VII'],
  dorian: ['i', 'IV', '♭VII', 'i'],
  phrygian: ['i', '♭II', '♭III', 'i'],
  lydian: ['I', 'II', 'V', 'I'],
  mixolydian: ['I', '♭VII', 'IV', 'I'],
  locrian: ['♭II', '♭vii', 'iv', '♭II'],
  'harmonic-minor': ['i', '♭VI', 'iv', 'V'],
  'melodic-minor': ['i', 'IV', 'V', 'i'],
  'pentatonic-major': ['I', 'vi', 'V', 'I'],
  'pentatonic-minor': ['i', '♭III', '♭VII', 'i'],
  blues: ['i', '♭III', '♭VII', 'i'],
  'whole-tone': ['I', 'II', '♭VII', 'I'],
  chromatic: ['I', 'vi', 'IV', 'V'],
};

/** Every symbol parses to a major or minor triad and, where the key has chips, lights one. */
function expectKeyChords(syms: readonly string[], key: Key): void {
  const chips = diatonicChords(key);
  for (const s of syms) {
    expect(parseChord(s, key).ok).toBe(true);
    const r = readChord(s, key)!;
    expect(['maj', 'min']).toContain(r.quality);
    if (chips.length > 0) {
      const lit = chips.filter(
        (d) => d.root === r.root && d.quality.id === r.quality && r.bass === 'any',
      );
      expect(lit.map((d) => d.numeral)).toEqual([s]);
    }
  }
}

describe('a new progression follows the key', () => {
  for (const scale of SCALE_NAMES) {
    for (const tonic of ['C', 'A', 'F#', 'Bb'] as const) {
      it(`${tonic} ${scale}`, () => {
        const key: Key = { tonic, scale };
        const syms = defaultProgressionSymbols(key);
        expect(syms).toEqual(EXPECTED[scale]);
        expectKeyChords(syms, key);
      });
    }
  }

  it('custom scales fall back to plain triads', () => {
    expect(
      defaultProgressionSymbols({ tonic: 'C', scale: { kind: 'custom', intervals: [0, 3, 7] } }),
    ).toEqual(['i', '♭VI', '♭VII', 'i']);
    expect(
      defaultProgressionSymbols({ tonic: 'C', scale: { kind: 'custom', intervals: [0, 4, 7] } }),
    ).toEqual(['I', 'IV', 'V', 'I']);
    // A custom 7-note scale (a dorian ♯4): its chips, never diminished.
    const key: Key = { tonic: 'D', scale: { kind: 'custom', intervals: [0, 2, 3, 6, 7, 9, 10] } };
    const syms = defaultProgressionSymbols(key);
    expect(syms).toHaveLength(4);
    expectKeyChords(syms, key);
  });
});
