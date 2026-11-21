/**
 * The bundled compositions (examples/compositions, CC0): songs with a melody line over chords.
 * Under "distinct notes" (PLAN rev 8) a melody that lands on another line's pitch merges into it
 * and the rest of the tune is lost, so each song must keep every line alive until its ending.
 * Rev 9 (docs/composing.md §1): written with parts, tunes and pulses, in few moments.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';

const DIR = join(import.meta.dirname, '../../../examples/compositions');
const files = readdirSync(DIR).filter((f) => f.endsWith('.algorhythms.json'));

describe('compositions', () => {
  it('there are some, all CC0', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const json = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { meta: { license?: string } };
      expect(json.meta.license, f).toBe('CC0-1.0');
    }
  });

  for (const f of files) {
    it(`${f}: every voice has a part; few moments; a tempo`, () => {
      const r = parsePiece(readFileSync(join(DIR, f), 'utf8'));
      if (!r.ok) throw new Error(r.errors.join('; '));
      expect(
        r.piece.voices.every((v) => (v.part ?? '') !== ''),
        f,
      ).toBe(true);
      expect(r.piece.moments.length, f).toBeLessThan(f.startsWith('night-ferry') ? 150 : 100);
      expect(r.piece.view.gridBpm, f).toBeGreaterThan(0);
    });

    it(`${f}: compiles without warnings and no line dies before the ending`, () => {
      const r = parsePiece(readFileSync(join(DIR, f), 'utf8'));
      if (!r.ok) throw new Error(r.errors.join('; '));
      const score = compile(r.piece);
      const bad = score.diagnostics.filter((d) => d.level !== 'info');
      expect(bad, f).toEqual([]);
      const ending = r.piece.end.at ?? score.duration;
      for (const v of score.voices) {
        for (const life of v.lives) {
          if (life.died !== undefined)
            expect(life.died, `${f} ${v.id}`).toBeGreaterThanOrEqual(ending - 1);
        }
      }
    });
  }
});
