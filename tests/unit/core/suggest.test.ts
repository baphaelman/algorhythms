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
import { chordAt, piece } from './compiler-fixtures';
import { pitchClassOf } from '../../../src/core/scales';
import { keyAt } from '../../../src/core/query';

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

  it('never suggests a no-effect moment; from silence, an opening (M4.5-27)', () => {
    const p = piece({ start: [], moments: [] });
    const open = suggestNext(p, compile(p), 1);
    expect(open.map((x) => x.label)).toEqual(['Start on Am', 'Start on A']);
    // In a major key the triad and the tonic share a name: the unison says so (one React key each).
    const major = piece({ start: [], moments: [], key: { tonic: 'C', scale: 'major' } });
    expect(suggestNext(major, compile(major), 10).map((x) => x.label)).toEqual([
      'Start on C',
      'Start on C (unison)',
    ]);
    for (const x of open) expect(momentEffectAt(p, compile(p), x.moment).effect).toBe(true);
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

  it('Home is a tonic unison and sounds like the numeric one (rev 8)', () => {
    let seen = 0;
    for (const [name, ex] of examples) {
      const s = compile(ex);
      for (let i = 0; i < 8; i++) {
        const t = Math.round(((i + 0.5) / 8) * s.duration * 0.9 * 1000) / 1000;
        for (const x of suggestNext(ex, s, t, 12)) {
          if (x.kind !== 'collapse' || !x.label.startsWith('Home')) continue;
          const m = x.moment;
          expect(m.type === 'unison' && m.pitch, `${name} @ ${t}`).toBe('tonic');
          const upTo = {
            ...ex,
            moments: ex.moments.filter((y) => y.at <= t),
            end: { at: t + 40, fade: 1 },
          };
          const after = chordAt(compile(withMoment(upTo, m)), t + 15);
          const pc = pitchClassOf(keyAt(s, t).tonic);
          const same = [-2, -1, 0, 1, 2].some((o) => {
            const pitch = pc + 12 * (Math.round((after[0] - pc) / 12) + o);
            const numeric = { ...m, pitch } as Moment;
            const got = chordAt(compile(withMoment(upTo, numeric)), t + 15);
            return got.length === after.length && got.every((q, k) => q === after[k]);
          });
          expect(same, `${name} @ ${t}: ${x.label}`).toBe(true);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('a home suggestion follows a key change written after it', () => {
    const ch = piece({ start: [45, 52, 57, 60, 64, 67], key: { tonic: 'A', scale: 'dorian' } });
    const late = { ...ch, end: { at: 4, fade: 1 } };
    const x = suggestNext(late, compile(late), 3, 12).find((y) => y.label.startsWith('Home'))!;
    expect(x.moment).toMatchObject({ type: 'unison', pitch: 'tonic' });
    const inA = chordAt(compile(withMoment(ch, x.moment)), 20);
    const inB = chordAt(
      compile(withMoment({ ...ch, key: { tonic: 'B', scale: 'dorian' } }, x.moment)),
      20,
    );
    expect(inB.map((p, i) => p - inA[i])).toEqual(inA.map(() => 2));
  });
});
