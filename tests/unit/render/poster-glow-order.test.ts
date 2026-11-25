/** Poster glow order (M14 P4 follow-up): every part's glow is drawn under every part's lines. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  POSTER_LOOK,
  SvgContext,
  asCtx2D,
  drawPosterLayout,
  layoutPoster,
} from '../../../src/render';

const r = parsePiece(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../examples/songs/kite-day.algorhythms.json'),
      'utf8',
    ),
  ),
);
if (!r.ok) throw new Error(r.errors.join('; '));
const piece: Piece = r.piece;
const compiled = compile(piece);

describe('poster glow order', () => {
  it('draws every part’s glow before any part’s lines', () => {
    const L = layoutPoster({
      compiled,
      piece,
      look: { ...POSTER_LOOK, glow: 0.8 },
      base: { rows: 1 },
    });
    const c = new SvgContext(L.width, L.height);
    drawPosterLayout(asCtx2D(c), compiled, L);
    const paths = c.toSvg().match(/<path[^>]*>/g) ?? [];
    // Glow paths carry a blur filter; lines (and everything after) do not.
    const blurred = paths.flatMap((p, i) => (p.includes('filter="url(') ? [i] : []));
    expect(blurred.length).toBeGreaterThan(0);
    const last = Math.max(...blurred);
    expect(blurred.length).toBe(last - Math.min(...blurred) + 1);
    expect(paths.length - last).toBeGreaterThan(100);
  });
});
