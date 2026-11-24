/**
 * M10 acceptance (PLAN §15), line 2, beyond suggest.test: Next on the compositions, and on every
 * built-in scale after a chord change, never offers a no-op or two cards of one job.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { momentEffectAt } from '../../../src/core/effect';
import { keyAt } from '../../../src/core/query';
import { SCALE_NAMES } from '../../../src/core/scales';
import { parsePiece } from '../../../src/core/schema';
import { suggestNext } from '../../../src/core/suggest';
import { theoryOf } from '../../../src/core/theory';
import type { CompiledScore, Key, Moment, Piece } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

const ROOT = join(import.meta.dirname, '../../../examples');
const compositions: [string, Piece][] = ['songs', 'experiments']
  .flatMap((d) => readdirSync(join(ROOT, d)).map((f) => join(d, f)))
  .filter((f) => f.endsWith('.algorhythms.json'))
  .map((f) => {
    const r = parsePiece(readFileSync(join(ROOT, f), 'utf8'));
    if (!r.ok) throw new Error(f);
    return [f, r.piece];
  });

const withMoment = (p: Piece, m: Moment): Piece => ({
  ...p,
  moments: [...p.moments, { ...m, id: 'sugg01' }].sort((a, b) => a.at - b.at),
});

/** Cards that change nothing: the effect check or the compiler says so. */
function check(name: string, p: Piece, s: CompiledScore, t: number, noops: string[]): number {
  const su = suggestNext(p, s, t);
  expect(su.length, `${name} @ ${t}`).toBeGreaterThanOrEqual(1);
  if (theoryOf(keyAt(s, t)) && su.every((x) => x.job !== undefined)) {
    expect(new Set(su.map((x) => x.job)).size, `${name} @ ${t}: jobs`).toBe(su.length);
  }
  for (const x of su) {
    const effect = momentEffectAt(p, s, x.moment).effect;
    const diags = compile(withMoment(p, x.moment)).diagnostics.filter(
      (d) => d.momentId === 'sugg01',
    );
    expect(
      diags.filter((d) => d.level === 'error'),
      `${name} @ ${t}: ${x.label}`,
    ).toEqual([]);
    if (!effect || diags.some((d) => d.code === 'no-effect'))
      noops.push(`${name} @ ${t}: ${x.label} (effect check ${effect})`);
  }
  return su.length;
}

describe('M10: Next never offers a no-op', () => {
  it('finds the compositions', () => expect(compositions.length).toBeGreaterThanOrEqual(10));
  for (const [name, p] of compositions) {
    it(`${name}: four times`, () => {
      const s = compile(p);
      let total = 0;
      const noops: string[] = [];
      for (let i = 0; i < 4; i++) {
        const t = Math.round(((i + 0.5) / 4) * s.duration * 0.9 * 1000) / 1000;
        total += check(name, p, s, t, noops);
      }
      expect(total).toBeGreaterThanOrEqual(8);
      expect(noops).toEqual([]);
    });
  }

  it('every built-in scale, after a chord change', () => {
    const noops: string[] = [];
    for (const scale of SCALE_NAMES) {
      const key = { tonic: 'D', scale } as Key;
      const change = {
        id: 'chg001',
        type: 'chord',
        at: 4,
        notes: { kind: 'degrees', degrees: [3, 5, 7] },
      } as unknown as Moment;
      const p = piece({
        start: [50, 57, 62, 65],
        key,
        moments: [change],
        end: { at: 30, fade: 1 },
      });
      const s = compile(p);
      expect(
        s.diagnostics.filter((d) => d.level === 'error'),
        scale,
      ).toEqual([]);
      check(scale, p, s, 8, noops);
    }
    expect(noops).toEqual([]);
  });
});
