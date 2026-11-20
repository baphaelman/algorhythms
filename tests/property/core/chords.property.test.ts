/** Property tests for core/chords.ts (fast-check). */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseChord } from '../../../src/core/chords';
import type { Key } from '../../../src/core/types';

const KEY: Key = { tonic: 'A', scale: 'dorian' };
const pieces = fc.constantFrom(
  'C',
  'D',
  'F#',
  'Bb',
  'I',
  'ii',
  'bVII',
  'vii',
  'm',
  'M',
  'maj',
  'dim',
  '°',
  'ø',
  'aug',
  '+',
  '-',
  '5',
  '6',
  '7',
  '9',
  '11',
  '13',
  'sus',
  'sus2',
  'add9',
  'b9',
  '#11',
  'b5',
  'alt',
  'no3',
  '(',
  ')',
  ',',
  '/',
  'E',
  'V',
  'x',
  ' ',
);

describe('chord parser properties', () => {
  it('never throws, and returns well-formed results', () => {
    const check = (symbol: string): void => {
      const r = parseChord(symbol, KEY);
      if (r.ok) {
        expect(r.pcs.length).toBeGreaterThan(0);
        expect(new Set(r.pcs).size).toBe(r.pcs.length);
        for (const pc of r.pcs) expect(pc >= 0 && pc < 12 && Number.isInteger(pc)).toBe(true);
        expect(r.pcs).toContain(r.root);
        if (r.bass !== undefined) expect(r.pcs).toContain(r.bass);
      } else {
        expect(r.error.length).toBeGreaterThan(0);
      }
    };
    fc.assert(fc.property(fc.string(), check), { numRuns: 500 });
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 6 }), (parts) => check(parts.join(''))),
      { numRuns: 2000 },
    );
  });
});
