/** Next-move suggestions (PLAN.md §11.3 revision 6): `suggestNext`. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { momentEffectAt } from '../../../src/core/effect';
import { generate } from '../../../src/core/generate';
import { parsePiece } from '../../../src/core/schema';
import { SUGGEST_ID, suggestNext } from '../../../src/core/suggest';
import type { Moment, Piece } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const examples: [string, Piece][] = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.algorhythms.json'))
  .map((f) => {
    const r = parsePiece(readFileSync(join(EXAMPLES, f), 'utf8'));
    if (!r.ok) throw new Error(f);
    return [f, r.piece];
  });

const withMoment = (p: Piece, m: Moment): Piece => ({
  ...p,
  moments: [...p.moments, { ...m, id: 'sugg01' }].sort((a, b) => a.at - b.at),
});

describe('suggestNext', () => {
  it('is deterministic for a piece and time, and varies with the seed', () => {
    const p = generate(7);
    const s = compile(p);
    const a = suggestNext(p, s, 40);
    expect(suggestNext(p, s, 40)).toEqual(a);
    expect(a.length).toBeGreaterThanOrEqual(3);
    const labels = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const q = { ...p, seed };
      for (const x of suggestNext(q, compile(q), 40)) labels.add(x.label);
    }
    expect(labels.size).toBeGreaterThan(a.length);
  });

  it('opens a unison into a chord, walks, collapses and labels them', () => {
    const uni = piece({ start: [57, 57, 57, 57], key: { tonic: 'A', scale: 'dorian' } });
    const su = suggestNext(uni, compile(uni), 2);
    expect(su[0].kind).toBe('open');
    expect(su[0].label).toMatch(/^Open to A/);
    expect(su.some((x) => x.kind === 'walk' || x.kind === 'collapse')).toBe(false);

    const ch = piece({ start: [45, 52, 57, 60, 64, 67], key: { tonic: 'A', scale: 'dorian' } });
    const sc = suggestNext(ch, compile(ch), 2);
    const labels = sc.map((x) => x.label);
    expect(labels.some((l) => /^Move to [A-G]/.test(l))).toBe(true);
    expect(labels.some((l) => /^Walk (8|12|16) s$/.test(l))).toBe(true);
    for (const x of sc) {
      expect(x.moment.id).toBe(SUGGEST_ID);
      expect(x.moment.at).toBe(2);
      expect(x.moment.seed).toBeTypeOf('number');
    }
    const one = piece({ start: [57] });
    expect(suggestNext(one, compile(one), 2)[0].label).toMatch(/^Split to \d+ · /);
  });

  it('never suggests a no-effect moment, and returns none when nothing sounds', () => {
    const p = piece({ start: [], moments: [] });
    expect(suggestNext(p, compile(p), 1)).toEqual([]);
    for (const [, ex] of examples) {
      const s = compile(ex);
      for (let t = 1; t < s.duration; t += s.duration / 9) {
        for (const x of suggestNext(ex, s, t)) {
          expect(momentEffectAt(ex, s, x.moment).effect, x.label).toBe(true);
        }
      }
    }
  });

  it('every suggestion compiles without errors and is not flagged no-effect (all examples)', () => {
    let total = 0;
    for (const [name, ex] of examples) {
      const s = compile(ex);
      for (let i = 0; i < 6; i++) {
        const t = Math.round(((i + 0.5) / 6) * s.duration * 0.9 * 1000) / 1000;
        const su = suggestNext(ex, s, t);
        expect(su.length, `${name} @ ${t}`).toBeGreaterThanOrEqual(3);
        expect(new Set(su.map((x) => x.label)).size).toBe(su.length);
        for (const x of su) {
          total++;
          const out = compile(withMoment(ex, x.moment));
          const bad = out.diagnostics.filter(
            (d) => d.momentId === 'sugg01' && (d.level === 'error' || d.code === 'no-effect'),
          );
          expect(bad, `${name} @ ${t}: ${x.label}`).toEqual([]);
          expect(out.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
        }
      }
    }
    expect(total).toBeGreaterThan(80);
  });
});
