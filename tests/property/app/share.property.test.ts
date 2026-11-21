/**
 * Share links round-trip exactly (PLAN.md §15 M5): for random pieces, opening a piece's link gives
 * back exactly the canonical piece, and re-encoding the opened piece gives the same link.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeShareLink, encodeShareLink } from '../../../src/app/share';
import {
  canonicalPiece,
  roundLevel,
  roundOther,
  roundStep,
  roundTime,
} from '../../../src/core/canonical';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import { pieceArb } from '../core/compiler-arbitraries';

const BASE = 'https://example.org/';

function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

/** Float noise on every moment time and level gain, as edits might leave it. */
const noiseArb = fc.array(fc.double({ min: -0.01, max: 0.01, noNaN: true }), {
  minLength: 32,
  maxLength: 32,
});

function addNoise(p: Piece, noise: number[]): Piece {
  return {
    ...p,
    moments: p.moments.map((m, i) => {
      const at = Math.max(0, m.at + noise[i % noise.length]);
      return m.type === 'level'
        ? { ...m, at, gain: Math.max(0, m.gain + noise[(i + 7) % noise.length]) }
        : { ...m, at };
    }),
  };
}

describe('share links (property)', () => {
  it('decode(encode(p)) is the canonical p, and encode(decode(link)) is the link', async () => {
    await fc.assert(
      fc.asyncProperty(pieceArb({ parts: true }), noiseArb, async (raw, noise) => {
        const piece = parsed(addNoise(raw, noise));
        expect(canonicalPiece(piece)).toBe(piece);
        const link = await encodeShareLink(piece, BASE);
        expect(link).toMatch(/#p=2\./); // canonical pieces always pack as v2
        const back = parsed(await decodeShareLink(link));
        expect(back).toEqual(piece);
        expect(await encodeShareLink(back, BASE)).toBe(link);
      }),
      { numRuns: 150 },
    );
  });

  it('every rounding rule is idempotent and keeps the sign', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (x) => {
        for (const r of [roundTime, roundStep, roundLevel, roundOther]) {
          const y = r(x);
          expect(r(y)).toBe(y);
          expect(Math.sign(y)).toBe(Math.sign(x) === 0 ? Math.sign(y) : Math.sign(x));
        }
      }),
      { numRuns: 2000 },
    );
  });
});
