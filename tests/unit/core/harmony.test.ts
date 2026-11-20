import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { harmonyLabel, nameChord, spellPc } from '../../../src/core/harmony';
import { chordAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { Key, NoteSet } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const C: Key = { tonic: 'C', scale: 'major' };
const A_MINOR: Key = { tonic: 'A', scale: 'minor' };
const label = (t: number, s = score): string | null => chordAt(s, t)?.label ?? null;

const chord = (at: number, notes: NoteSet): MomentInput => ({
  type: 'chord',
  at,
  notes,
  voicing: 'even',
  assign: 'ordered',
});

const score = compile(
  piece({
    start: [48, 55, 64, 72],
    key: C,
    moments: [
      chord(4, { kind: 'chord', symbol: 'ii7' }),
      { type: 'walk', at: 8, until: 12, grid: 0.5, density: 1, steps: [-1, 1], stepGlide: 0.2 },
      chord(14, { kind: 'chord', symbol: 'F#m7b5' }),
      chord(18, { kind: 'pitches', pitches: [45, 53, 60, 65] }),
      chord(22, { kind: 'pitches', pitches: [48, 49, 50, 51] }),
      { type: 'level', at: 24, gain: 0.5, over: 1 },
      { type: 'unison', at: 26, pitch: 57, octaves: true },
      { type: 'key', at: 28, key: { tonic: 'F', scale: 'major' } },
      chord(30, { kind: 'chord', symbol: 'bVII' }),
      chord(34, { kind: 'chord', symbol: 'V7/V' }),
      chord(38, { kind: 'chord', symbol: 'viiø7' }),
    ],
  }),
);

describe('chordAt over a compiled piece', () => {
  it('is null before the first harmony moment (start pitches are not a moment)', () => {
    expect(label(0)).toBeNull();
    expect(label(3.99)).toBeNull();
  });

  it('shows a Roman numeral with its letter chord from the moment time', () => {
    expect(label(4)).toBe('ii7 · Dm7');
    expect(label(7)).toBe('ii7 · Dm7');
  });

  it('keeps the previous chord through a walk, level and key moments', () => {
    expect(label(10)).toBe('ii7 · Dm7');
    expect(label(13.9)).toBe('ii7 · Dm7');
    expect(label(25)).toBe(label(22.5));
    expect(label(29)).toBe('A (unison)');
  });

  it('shows written letter symbols with ♯/♭ glyphs', () => {
    expect(label(15)).toBe('F♯m7♭5');
  });

  it('names explicit pitches, with the bass as an inversion', () => {
    expect(label(19)).toBe('F/A');
  });

  it('lists the pitch classes of an unrecognised set from the bass up', () => {
    expect(label(23)).toBe('C C♯ D D♯');
  });

  it('spells numerals in the key in effect (F major after the key moment)', () => {
    expect(label(31)).toBe('♭VII · E♭');
    expect(label(35)).toBe('V7/V · G7');
    expect(label(39)).toBe('viiø7 · Eø7');
  });

  it('records pitch classes and bass of the destinations', () => {
    const h = chordAt(score, 19)!;
    expect(h.bass).toBe(9);
    expect([...h.pcs].sort((a, b) => a - b)).toEqual([0, 5, 9]);
    expect(h.momentId).toBe('m3');
  });

  it('is absent on hand-built scores without a harmony timeline', () => {
    expect(chordAt({ ...score, harmony: undefined }, 10)).toBeNull();
  });
});

describe('example pieces', () => {
  const dir = join(import.meta.dirname, '../../../examples');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const compiled = (f: string) => {
    const r = parsePiece(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!r.ok) throw new Error(f);
    return compile(r.piece);
  };

  it('every example has a sorted harmony timeline starting after t = 0', () => {
    for (const f of files) {
      const h = compiled(f).harmony!;
      expect(h.length, f).toBeGreaterThan(3);
      expect(h[0].t, f).toBeGreaterThan(0);
      for (let i = 1; i < h.length; i++) expect(h[i].t).toBeGreaterThanOrEqual(h[i - 1].t);
      for (const e of h) expect(e.label, f).not.toBe('');
    }
  });

  it('the cartographer’s rain: numerals, applied slash and ♭VII in A minor', () => {
    const s = compiled('the-cartographers-rain.algorhythms.json');
    expect(label(90, s)).toBe('iv7 · Dm7');
    expect(label(95, s)).toBe('VI/A · F♯/A');
    expect(label(100, s)).toBe('♭VII · G');
    expect(label(5, s)).toBeNull();
  });
});

describe('nameChord', () => {
  it('recognises triads, sevenths and extensions', () => {
    expect(nameChord([0, 4, 7], 0, C)).toBe('C');
    expect(nameChord([9, 0, 4, 7], 9, C)).toBe('Am7');
    expect(nameChord([0, 4, 7, 9], 0, C)).toBe('C6');
    expect(nameChord([11, 2, 5, 9], 11, C)).toBe('Bm7♭5');
    expect(nameChord([7, 11, 2, 5, 9], 7, C)).toBe('G9');
  });

  it('prefers the bass as root, otherwise writes an inversion', () => {
    expect(nameChord([7, 0, 2], 7, C)).toBe('Gsus4');
    expect(nameChord([0, 2, 7], 0, C)).toBe('Csus2');
    expect(nameChord([4, 7, 0], 4, C)).toBe('C/E');
  });

  it('handles one pitch class and unrecognised sets', () => {
    expect(nameChord([9], 9, C)).toBe('A (unison)');
    expect(nameChord([0, 1], 0, C)).toBe('C C♯');
    expect(nameChord([], 0, C)).toBe('');
  });
});

describe('spellPc', () => {
  it('spells scale tones by degree letter and others by the signature', () => {
    expect(spellPc(6, { tonic: 'G', scale: 'major' })).toBe('F♯');
    expect(spellPc(10, { tonic: 'F', scale: 'major' })).toBe('B♭');
    expect(spellPc(3, { tonic: 'D', scale: 'minor' })).toBe('E♭'); // off-scale in a flat key
    expect(spellPc(3, C)).toBe('D♯');
    expect(spellPc(5, { tonic: 'C#', scale: 'major' })).toBe('E♯');
  });
});

describe('harmonyLabel', () => {
  it('formats numerals with case-derived quality', () => {
    expect(harmonyLabel('iv', [], 0, A_MINOR)).toBe('iv · Dm');
    expect(harmonyLabel('vii°7', [], 0, C)).toBe('vii°7 · B°7');
    expect(harmonyLabel('I/E', [], 0, C)).toBe('I/E · C/E');
    expect(harmonyLabel('#iv', [], 0, C)).toBe('♯iv · F♯m');
  });

  it('falls back to recognition when there is no or an invalid symbol', () => {
    expect(harmonyLabel(undefined, [0, 4, 7], 0, C)).toBe('C');
    expect(harmonyLabel('IIX', [2, 5, 9], 2, C)).toBe('Dm');
  });
});
