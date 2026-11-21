/**
 * Distinct notes keep each example's balance (M4.5-29, PLAN §11.3 revision 8): at times when every
 * line rests, each pitch's share of the output power matches the pre-revision-8 compile (stacked
 * voices, recorded in examples.balance.json) within 0.5 dB, and as many such times as before
 * still exist. Walks step lines, not stacked voices, so their notes may differ: times from a walk's
 * start to the next point moment after it are skipped. An explicit merge (or a chord `count`
 * death) passes the dying lines' weight to their survivors (owner, 2026-11-21), which the stacked
 * compile did not: times from it to the next unison (which joins every line again) are skipped
 * too. M4.5-30 changed spread at range edges (it no longer folds), so times from a spread to the
 * next chord or unison are skipped as well. Never regenerate the fixture from the current compiler.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { restingPower } from './balance';

const EX = join(import.meta.dirname, '../../examples');
const BEFORE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'examples.balance.json'), 'utf8'),
) as Record<string, Record<string, Record<string, number>>>;

const files = readdirSync(EX)
  .filter((f) => f.endsWith('.algorhythms.json'))
  .sort();

describe('example balance through merges (revision 8)', () => {
  for (const f of files) {
    it(f, () => {
      const r = parsePiece(JSON.parse(readFileSync(join(EX, f), 'utf8')));
      if (!r.ok) throw new Error(f);
      const s = compile(r.piece);
      const ms = r.piece.moments;
      const walky = ms
        .filter((m) => m.type === 'walk')
        .map((w) => {
          const next = ms
            .filter((m) => m.type !== 'walk' && m.type !== 'key' && m.type !== 'level')
            .map((m) => m.at)
            .filter((at) => at >= (w.type === 'walk' ? w.until : w.at))
            .sort((a, b) => a - b)[0];
          return [w.at, next ?? Infinity] as const;
        });
      const merged = ms
        .filter((m) => m.type === 'merge' || (m.type === 'chord' && m.count !== undefined))
        .map((m) => {
          const next = ms
            .filter((u) => u.type === 'unison' && u.at > m.at)
            .map((u) => u.at)
            .sort((a, b) => a - b)[0];
          return [m.at, next ?? Infinity] as const;
        });
      const spread = ms
        .filter((m) => m.type === 'spread')
        .map((m) => {
          const next = ms
            .filter((u) => (u.type === 'chord' || u.type === 'unison') && u.at > m.at)
            .map((u) => u.at)
            .sort((a, b) => a - b)[0];
          return [m.at, next ?? Infinity] as const;
        });
      const skipped = [...walky, ...merged, ...spread];
      const before = BEFORE[f];
      let compared = 0;
      let worst = 0;
      let total = 0;
      for (const [t, old] of Object.entries(before)) {
        if (skipped.some(([a, b]) => Number(t) >= a && Number(t) < b)) continue;
        total++;
        const now = restingPower(s, Number(t));
        if (!now) continue;
        compared++;
        expect(Object.keys(now).sort().join(' '), `pitches at ${t}`).toEqual(
          Object.keys(old).sort().join(' '),
        );
        for (const [p, pw] of Object.entries(old)) {
          const db = Math.abs(10 * Math.log10(now[p] / pw));
          if (db > worst) worst = db;
        }
      }
      expect(compared).toBeGreaterThanOrEqual(total * 0.9);
      expect(compared).toBeGreaterThan(30);
      expect(worst).toBeLessThanOrEqual(0.5);
    });
  }
});
