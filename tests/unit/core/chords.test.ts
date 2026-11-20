/** Unit tests for core/chords.ts (PLAN.md §7.3). Expected chords are written as note names. */

import { describe, expect, it } from 'vitest';
import { parseChord } from '../../../src/core/chords';
import { parsePitchClass } from '../../../src/core/scales';
import type { Key } from '../../../src/core/types';

const C_MAJOR: Key = { tonic: 'C', scale: 'major' };
const A_DORIAN: Key = { tonic: 'A', scale: 'dorian' };

/** 'C E G' → [0, 4, 7], in the given order. */
function pcs(notes: string): number[] {
  return notes.split(' ').map((n) => {
    const pc = parsePitchClass(n);
    if (pc === null) throw new Error(`bad note ${n}`);
    return pc;
  });
}

/** [symbol, expected notes in stacking order]. */
const LETTER_CHORDS: [string, string][] = [
  // Triads
  ['C', 'C E G'],
  ['Cm', 'C Eb G'],
  ['Cmin', 'C Eb G'],
  ['Cmi', 'C Eb G'],
  ['C-', 'C Eb G'],
  ['CM', 'C E G'],
  ['Cmaj', 'C E G'],
  ['Cdim', 'C Eb Gb'],
  ['C°', 'C Eb Gb'],
  ['Co', 'C Eb Gb'],
  ['Caug', 'C E G#'],
  ['C+', 'C E G#'],
  ['Csus2', 'C D G'],
  ['Csus4', 'C F G'],
  ['Csus', 'C F G'],
  ['C5', 'C G'],
  // Sixths
  ['C6', 'C E G A'],
  ['Cm6', 'C Eb G A'],
  ['C69', 'C E G A D'],
  ['C6/9', 'C E G A D'],
  ['Cm6/9', 'C Eb G A D'],
  ['Cmaj6', 'C E G A'],
  // Sevenths
  ['C7', 'C E G Bb'],
  ['Cmaj7', 'C E G B'],
  ['CM7', 'C E G B'],
  ['Cma7', 'C E G B'],
  ['CΔ', 'C E G B'],
  ['CΔ7', 'C E G B'],
  ['C∆7', 'C E G B'],
  ['Cm7', 'C Eb G Bb'],
  ['C-7', 'C Eb G Bb'],
  ['Cmin7', 'C Eb G Bb'],
  ['CmM7', 'C Eb G B'],
  ['Cm(maj7)', 'C Eb G B'],
  ['Cmmaj7', 'C Eb G B'],
  ['C-Δ7', 'C Eb G B'],
  ['Cdim7', 'C Eb Gb A'],
  ['C°7', 'C Eb Gb A'],
  ['Co7', 'C Eb Gb A'],
  ['Cm7b5', 'C Eb Gb Bb'],
  ['Cmin7(b5)', 'C Eb Gb Bb'],
  ['Cø', 'C Eb Gb Bb'],
  ['Cø7', 'C Eb Gb Bb'],
  ['CØ7', 'C Eb Gb Bb'],
  ['C+7', 'C E G# Bb'],
  ['Caug7', 'C E G# Bb'],
  ['C7+', 'C E G# Bb'],
  ['C7#5', 'C E G# Bb'],
  ['C7+5', 'C E G# Bb'],
  ['C+M7', 'C E G# B'],
  ['Caug(maj7)', 'C E G# B'],
  ['C7sus4', 'C F G Bb'],
  ['C7sus2', 'C D G Bb'],
  ['C6(maj7)', 'C E G A B'],
  // Extensions
  ['C9', 'C E G Bb D'],
  ['Cm9', 'C Eb G Bb D'],
  ['Cmaj9', 'C E G B D'],
  ['CM9', 'C E G B D'],
  ['C9sus4', 'C F G Bb D'],
  ['C11', 'C G Bb D F'],
  ['Cm11', 'C Eb G Bb D F'],
  ['Cmaj11', 'C E G B D F'],
  ['C13', 'C E G Bb D A'],
  ['Cm13', 'C Eb G Bb D F A'],
  ['Cmaj13', 'C E G B D A'],
  ['Cø9', 'C Eb Gb Bb D'],
  // Additions and omissions
  ['Cadd9', 'C E G D'],
  ['Cadd2', 'C E G D'],
  ['Cmadd9', 'C Eb G D'],
  ['Cm(add9)', 'C Eb G D'],
  ['Cadd11', 'C E G F'],
  ['Cadd4', 'C E G F'],
  ['Cadd13', 'C E G A'],
  ['Csus4add9', 'C F G D'],
  ['C7no3', 'C G Bb'],
  ['C7omit5', 'C E Bb'],
  ['C(no3)', 'C G'],
  // Alterations
  ['C7b9', 'C E G Bb Db'],
  ['C7#9', 'C E G Bb D#'],
  ['C7(b9)', 'C E G Bb Db'],
  ['C7(b9,#11)', 'C E G Bb Db F#'],
  ['C7(#9, b13)', 'C E G Bb D# Ab'],
  ['C7-9', 'C E G Bb Db'],
  ['C9b5', 'C E Gb Bb D'],
  ['C9#11', 'C E G Bb D F#'],
  ['Cmaj7#11', 'C E G B F#'],
  ['Cmaj9#11', 'C E G B D F#'],
  ['C13b9', 'C E G Bb Db A'],
  ['C7b13', 'C E G Bb Ab'],
  ['C7(9,13)', 'C E G Bb D A'],
  ['C7alt', 'C E Bb Db D# F# Ab'],
  ['Calt', 'C E Bb Db D# F# Ab'],
  // Other roots and accidentals
  ['Am9', 'A C E G B'],
  ['F#m7b5', 'F# A C E'],
  ['Bb7', 'Bb D F Ab'],
  ['Ebmaj7', 'Eb G Bb D'],
  ['Abm', 'Ab B Eb'],
  ['Db', 'Db F Ab'],
  ['C#dim7', 'C# E G Bb'],
  ['G♯m', 'G# B D#'],
  ['B♭7', 'Bb D F Ab'],
  ['Cb', 'B Eb Gb'],
  ['E#', 'F A C'],
  [' D m7 ', 'D F A C'],
];

describe('parseChord: letter chords', () => {
  it.each(LETTER_CHORDS)('%s', (symbol, notes) => {
    const r = parseChord(symbol, C_MAJOR);
    expect(r).toEqual({ ok: true, pcs: pcs(notes), root: pcs(notes)[0] });
  });

  it('ignores the key for letter chords', () => {
    expect(parseChord('Am7', A_DORIAN)).toEqual(parseChord('Am7', C_MAJOR));
  });
});

describe('parseChord: slash bass', () => {
  it.each([
    ['C/E', 'C E G', 'E'],
    ['C/G', 'C E G', 'G'],
    ['Am7/G', 'A C E G', 'G'],
    ['D/F#', 'D F# A', 'F#'],
    ['G7/B', 'G B D F', 'B'],
    ['C/Bb', 'C E G Bb', 'Bb'], // a bass outside the chord is appended
    ['F/G', 'F A C G', 'G'],
    ['C6/9/E', 'C E G A D', 'E'],
  ])('%s', (symbol, notes, bass) => {
    const r = parseChord(symbol, C_MAJOR);
    expect(r).toEqual({ ok: true, pcs: pcs(notes), root: pcs(notes)[0], bass: pcs(bass)[0] });
  });
});

describe('parseChord: Roman numerals', () => {
  /** [symbol, key, expected notes, root]. */
  const cases: [string, Key, string][] = [
    ['I', C_MAJOR, 'C E G'],
    ['ii', C_MAJOR, 'D F A'],
    ['ii7', C_MAJOR, 'D F A C'],
    ['iii', C_MAJOR, 'E G B'],
    ['IV', C_MAJOR, 'F A C'],
    ['IVmaj7', C_MAJOR, 'F A C E'],
    ['IVΔ7', C_MAJOR, 'F A C E'],
    ['V', C_MAJOR, 'G B D'],
    ['V7', C_MAJOR, 'G B D F'],
    ['V9', C_MAJOR, 'G B D F A'],
    ['Vsus4', C_MAJOR, 'G C D'],
    ['V7sus4', C_MAJOR, 'G C D F'],
    ['vi', C_MAJOR, 'A C E'],
    ['vi7', C_MAJOR, 'A C E G'],
    ['vii°', C_MAJOR, 'B D F'],
    ['vii°7', C_MAJOR, 'B D F Ab'],
    ['viiø7', C_MAJOR, 'B D F A'],
    ['viidim', C_MAJOR, 'B D F'],
    ['bVII', C_MAJOR, 'Bb D F'],
    ['bIII', C_MAJOR, 'Eb G Bb'],
    ['bVI', C_MAJOR, 'Ab C Eb'],
    ['#iv°', C_MAJOR, 'F# A C'],
    ['#ivø7', C_MAJOR, 'F# A C E'],
    ['III+', C_MAJOR, 'E G# C'],
    ['iM7', C_MAJOR, 'C Eb G B'],
    ['Im7', C_MAJOR, 'C Eb G Bb'],
    ['I6', C_MAJOR, 'C E G A'],
    ['IIm7', C_MAJOR, 'D F A C'],
    ['♭VII', C_MAJOR, 'Bb D F'],
    // Relative to the tonic on major-scale degrees, whatever the mode.
    ['i', A_DORIAN, 'A C E'],
    ['i7', A_DORIAN, 'A C E G'],
    ['ii7', A_DORIAN, 'B D F# A'],
    ['IV', A_DORIAN, 'D F# A'],
    ['IV7', A_DORIAN, 'D F# A C'],
    ['bVII', A_DORIAN, 'G B D'],
    ['bIII', A_DORIAN, 'C E G'],
    ['v7', A_DORIAN, 'E G B D'],
    ['I', { tonic: 'Eb', scale: 'pentatonic-minor' }, 'Eb G Bb'],
    ['V', { tonic: 'F#', scale: { kind: 'custom', intervals: [0, 1, 5] } }, 'C# F G#'],
    // Applied chords.
    ['V/V', C_MAJOR, 'D F# A'],
    ['V7/V', C_MAJOR, 'D F# A C'],
    ['V7/ii', C_MAJOR, 'A C# E G'],
    ['vii°7/V', C_MAJOR, 'F# A C Eb'],
    ['V7/IV', A_DORIAN, 'A C# E G'],
  ];

  it.each(cases)('%s in %o', (symbol, key, notes) => {
    const r = parseChord(symbol, key);
    expect(r).toEqual({ ok: true, pcs: pcs(notes), root: pcs(notes)[0] });
  });

  it('takes a slash bass after a numeral', () => {
    expect(parseChord('I/E', C_MAJOR)).toEqual({ ok: true, pcs: pcs('C E G'), root: 0, bass: 4 });
    expect(parseChord('V7/B', C_MAJOR)).toEqual({
      ok: true,
      pcs: pcs('G B D F'),
      root: 7,
      bass: 11,
    });
  });
});

describe('parseChord: errors', () => {
  it.each([
    [''],
    ['   '],
    ['H7'],
    ['X'],
    ['7'],
    ['am7'],
    ['Cxyz'],
    ['C7b'],
    ['Cadd'],
    ['Csus3'],
    ['C/H'],
    ['C/'],
    ['C/E/G'],
    ['C7(b9'],
    ['C7b9)'],
    ['C7,9'],
    ['Cm5'],
    ['C12'],
    ['Iv'],
    ['VIII'],
    ['V/X'],
    ['C/vii7'],
  ])('%j is rejected with a readable message', (symbol) => {
    const r = parseChord(symbol, C_MAJOR);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(10);
      expect(r.error).toMatch(/^[A-Z]/);
    }
  });

  it('names the problem', () => {
    const msg = (s: string): string => {
      const r = parseChord(s, C_MAJOR);
      return r.ok ? '' : r.error;
    };
    expect(msg('')).toMatch(/empty/);
    expect(msg('Cxyz')).toContain("'xyz'");
    expect(msg('am7')).toMatch(/capital letter \(A\)/);
    expect(msg('C/H')).toContain("'H'");
    expect(msg('C7(b9')).toMatch(/parenthes/);
    expect(msg('H7')).toMatch(/note \(A–G\) or a Roman numeral/);
  });
});

describe('parseChord: output shape', () => {
  it('never repeats a pitch class and keeps them in 0..11', () => {
    for (const [symbol] of LETTER_CHORDS) {
      const r = parseChord(symbol, C_MAJOR);
      if (!r.ok) throw new Error(r.error);
      expect(new Set(r.pcs).size).toBe(r.pcs.length);
      for (const pc of r.pcs) {
        expect(Number.isInteger(pc)).toBe(true);
        expect(pc).toBeGreaterThanOrEqual(0);
        expect(pc).toBeLessThan(12);
      }
      expect(r.pcs[0]).toBe(r.root);
    }
  });

  it('transposes with the root', () => {
    let checked = 0;
    for (const [symbol] of LETTER_CHORDS) {
      if (!symbol.startsWith('C')) continue;
      const c = parseChord(symbol, C_MAJOR);
      const d = parseChord('D' + symbol.slice(1), C_MAJOR);
      if (!c.ok || !d.ok) throw new Error(symbol);
      expect(d.pcs).toEqual(c.pcs.map((pc) => (pc + 2) % 12));
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });
});
