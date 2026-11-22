import { describe, expect, it } from 'vitest';
import { isMinorType, numeralHint } from '../../../src/app/ui/inspector/fields';
import { parseChord } from '../../../src/core/chords';
import type { Key, ScaleName } from '../../../src/core/types';

const Am: Key = { tonic: 'A', scale: 'minor' };
const Dm: Key = { tonic: 'D', scale: 'aeolian' };

describe('numeralHint (composing.md §3 #10)', () => {
  it('suggests the flat for VI, III and VII in minor, spelled in the key', () => {
    expect(numeralHint('VI', Am)).toEqual({
      numeral: 'VI',
      note: 'F♯',
      flat: '♭VI',
      flatNote: 'F',
      fixed: 'bVI',
    });
    expect(numeralHint('III', Dm)).toMatchObject({ note: 'F♯', flatNote: 'F', fixed: 'bIII' });
    expect(numeralHint('VII7', Dm)).toMatchObject({ note: 'C♯', flatNote: 'C', fixed: 'bVII7' });
    expect(numeralHint('VI', { tonic: 'C', scale: 'minor' })).toMatchObject({
      note: 'A',
      flatNote: 'A♭',
    });
    expect(numeralHint('VI', Dm)).toMatchObject({ note: 'B', flatNote: 'B♭' });
  });

  it('keeps case, suffix and slash bass; the fix parses to the flat root', () => {
    const h = numeralHint('vi7/E', Am);
    expect(h?.fixed).toBe('bvi7/E');
    const r = parseChord(h?.fixed ?? '', Am);
    expect(r.ok && r.root).toBe(5);
  });

  it('covers any degree whose flat is in the scale', () => {
    expect(numeralHint('II', { tonic: 'E', scale: 'phrygian' })).toMatchObject({ flatNote: 'F' });
    expect(numeralHint('V', { tonic: 'B', scale: 'locrian' })).toMatchObject({ flatNote: 'F' });
    expect(numeralHint('VII', { tonic: 'A', scale: 'pentatonic-minor' })).toMatchObject({
      flatNote: 'G',
    });
    // Dorian has a natural 6th: VI is in the scale, VII is not.
    expect(numeralHint('VI', { tonic: 'D', scale: 'dorian' })).toBeNull();
    expect(numeralHint('VII', { tonic: 'D', scale: 'dorian' })).not.toBeNull();
  });

  it('stays quiet in major keys, for in-scale numerals, flats, letters and applied chords', () => {
    expect(numeralHint('VI', { tonic: 'C', scale: 'major' })).toBeNull();
    expect(numeralHint('VII', { tonic: 'G', scale: 'mixolydian' })).toBeNull();
    expect(numeralHint('iv', Am)).toBeNull();
    expect(numeralHint('bVI', Am)).toBeNull();
    expect(numeralHint('F', Am)).toBeNull();
    expect(numeralHint('VII', { tonic: 'A', scale: 'harmonic-minor' })).toBeNull(); // G♯ is in it
    expect(numeralHint('VI', { tonic: 'A', scale: 'pentatonic-minor' })).toBeNull(); // F is not
    expect(numeralHint('VII/V', Am)).toBeNull();
    expect(numeralHint('VIq', Am)).toBeNull();
  });

  it('knows the minor-type modes', () => {
    const minor: ScaleName[] = [
      'minor',
      'dorian',
      'phrygian',
      'locrian',
      'harmonic-minor',
      'melodic-minor',
      'pentatonic-minor',
    ];
    const major: ScaleName[] = [
      'major',
      'lydian',
      'mixolydian',
      'pentatonic-major',
      'whole-tone',
      'chromatic',
    ];
    for (const scale of minor) expect(isMinorType({ tonic: 'A', scale })).toBe(true);
    for (const scale of major) expect(isMinorType({ tonic: 'A', scale })).toBe(false);
  });
});
