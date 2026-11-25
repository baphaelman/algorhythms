/**
 * The bundled compositions (examples/songs and examples/experiments, CC0): songs with a melody line over chords.
 * Under "distinct notes" (PLAN rev 8) a melody that lands on another line's pitch merges into it
 * and the rest of the tune is lost, so each song must keep every line alive until its ending.
 * Rev 9 (docs/composing.md §1): written with parts, tunes and pulses, in few moments.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPiece } from '../../../src/core/canonical';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';

const ROOT = join(import.meta.dirname, '../../../examples');
/** Paths relative to examples/, e.g. `songs/kite-day.algorhythms.json`. */
const files = ['songs', 'experiments'].flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => `${d}/${f}`),
);

describe('compositions', () => {
  it('there are some, all CC0', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const json = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as {
        meta: { license?: string };
      };
      expect(json.meta.license, f).toBe('CC0-1.0');
    }
  });

  for (const f of files) {
    it(`${f}: every voice has a part; few moments; a tempo`, () => {
      const r = parsePiece(readFileSync(join(ROOT, f), 'utf8'));
      if (!r.ok) throw new Error(r.errors.join('; '));
      expect(
        r.piece.voices.every((v) => (v.part ?? '') !== ''),
        f,
      ).toBe(true);
      // Late Bloom (owner, 2026-11-25: added to Songs): every hand-voiced Rhodes and choir change
      // is a chord moment, and its sustained voices fade at each phrase.
      const cap = f.includes('night-ferry') ? 150 : f.includes('late-bloom') ? 210 : 100;
      expect(r.piece.moments.length, f).toBeLessThan(cap);
      expect(r.piece.view.gridBpm, f).toBeGreaterThan(0);
    });

    it(`${f}: is stored with canonical numbers (scripts/compositions/build.mjs)`, () => {
      const json = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Parameters<
        typeof canonicalPiece
      >[0];
      expect(canonicalPiece(json)).toEqual(json);
    });

    it(`${f}: compiles without warnings and no tune's line dies before the ending`, () => {
      const r = parsePiece(readFileSync(join(ROOT, f), 'utf8'));
      if (!r.ok) throw new Error(r.errors.join('; '));
      const score = compile(r.piece);
      const bad = score.diagnostics.filter((d) => d.level !== 'info');
      expect(bad, f).toEqual([]);
      const ending = r.piece.end.at ?? score.duration;
      // Parts that sing a tune: a merge there loses the rest of the melody. Other parts may
      // merge on purpose (Tide Pools, Interference).
      const sung = new Set(
        r.piece.moments.flatMap((m) =>
          m.type === 'tune' && m.target && typeof m.target === 'object' && 'part' in m.target
            ? [m.target.part]
            : [],
        ),
      );
      for (const [i, v] of score.voices.entries()) {
        if (!sung.has(r.piece.voices[i].part ?? '')) continue;
        // A tune rest (revision 10) ends a life and the comeback starts the next; a merge
        // (crossOut) or the last life ending early loses the melody.
        v.lives.forEach((life, k) => {
          if (life.died !== undefined && (life.crossOut || k === v.lives.length - 1))
            expect(life.died, `${f} ${v.id}`).toBeGreaterThanOrEqual(ending - 1);
        });
      }
    });
  }
});
