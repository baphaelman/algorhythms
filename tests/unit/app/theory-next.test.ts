import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { momentEffectAt } from '../../../src/core/effect';
import { parsePiece } from '../../../src/core/schema';
import { chordDefaultAt } from '../../../src/core/suggest';
import type { Key, Moment, Piece } from '../../../src/core/types';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { paletteMoment } from '../../../src/app/editor/row-palette';
import { PALETTE } from '../../../src/app/editor/shortcuts';
import { fitOf } from '../../../src/app/editor/chord-fit';
import { piece } from '../core/compiler-fixtures';
import { progression } from '../core/progression-fixture';

const C: Key = { tonic: 'C', scale: 'major' };

describe('theory-aware Add → Chord (§11.3 rev 14)', () => {
  it('uses the chord that best fits the spot', () => {
    const p = progression(C, ['I', 'V']);
    p.moments = p.moments.map((m) => (m.at === 4 ? { ...m, at: 8 } : m));
    const m = defaultMoment('chord', 4, 'new001', p, compile(p));
    expect(m).toMatchObject({
      id: 'new001',
      at: 4,
      type: 'chord',
      notes: { kind: 'chord', symbol: 'IV' },
      voicing: 'even',
    });
  });

  it('keeps the old default in a key without chord theory', () => {
    const p = piece({ start: [], moments: [], key: { tonic: 'B', scale: 'locrian' } });
    const m = defaultMoment('chord', 2, 'new001', p, compile(p));
    expect(m.notes).toEqual({ kind: 'degrees', degrees: [0, 2, 4] });
  });
});

/** `m` added: its error and `no-effect` diagnostics. */
function compiledWith(p: Piece, m: Moment): string[] {
  return compile({ ...p, moments: [...p.moments, m] })
    .diagnostics.filter(
      (d) => d.momentId === m.id && (d.level === 'error' || d.code === 'no-effect'),
    )
    .map((d) => d.code);
}

const read = (f: string): Piece => {
  const r = parsePiece(readFileSync(f, 'utf8'));
  if (!r.ok) throw new Error(f);
  return r.piece;
};

describe('Add → Chord is never a no-op where a chord can change something', () => {
  it('just after a change: a split’s staggered births count (the land chord decides before them)', () => {
    // e2e context-moments' piece: one A; a split to 4 at 0 whose births start over the next
    // 0.6 s. A landing chord at 1 s decides at 0 (its lead-in clamped), where the compiler already
    // counts the 4 lines; the check used to see one and grey Add → Chord.
    const p = read('examples/tidewater-hymn.algorhythms.json');
    p.moments = [
      ...p.moments.filter((m) => m.id === 'start0'),
      { id: 'spl001', type: 'split', at: 0, count: 4, voicing: 'even' },
      {
        id: 'uni001',
        type: 'unison',
        at: 2,
        pitch: 'center',
        octaves: false,
        glide: { length: 0.5, stagger: 0 },
      },
    ];
    const s = compile(p);
    for (const t of [0.5, 1, 1.5]) {
      const m = paletteMoment('chord', t, 'add001', p, s);
      expect(m.glide?.land, `${t}`).toBe(true);
      // The best chord itself (no fallback): it changes something.
      expect(m.notes, `${t}`).toEqual(chordDefaultAt(p, s, t)!.moment.notes);
      expect(momentEffectAt(p, s, m), `${t}`).toEqual({ effect: true });
      expect(compiledWith(p, m), `${t}`).toEqual([]);
    }
  });

  it('falls back to the next-best chord when the best changes nothing', () => {
    // Little Round at 2.091 s: only the Bass line sounds (F); the best chord, F, adds notes the
    // Bass part has no voice for, so it would change nothing.
    const p = read('examples/songs/little-round.algorhythms.json');
    const s = compile(p);
    const best = chordDefaultAt(p, s, 2.091)!;
    expect(best.name).toBe('F');
    const m = paletteMoment('chord', 2.091, 'add001', p, s);
    expect(m.notes).not.toEqual(best.moment.notes);
    expect(momentEffectAt(p, s, m).effect).toBe(true);
    expect(compiledWith(p, m)).toEqual([]);
    // With no `fits`, chordDefaultAt keeps the best.
    expect(chordDefaultAt(p, s, 2.091, () => false)).toEqual(best);
  });

  it('on every example and composition, at four times, Add → Chord has an effect', () => {
    const dirs = ['examples', 'examples/songs', 'examples/experiments'];
    const files = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.algorhythms.json'))
        .map((f) => join(d, f)),
    );
    expect(files.length).toBeGreaterThanOrEqual(15);
    const bad: string[] = [];
    for (const f of files) {
      const p = read(f);
      const s = compile(p);
      for (let i = 0; i < 4; i++) {
        const t = Math.round(((i + 0.5) / 4) * s.duration * 0.9 * 1000) / 1000;
        const m = paletteMoment('chord', t, 'add001', p, s);
        const effect = momentEffectAt(p, s, m).effect;
        const diags = compiledWith(p, m);
        if (!effect || diags.length > 0) bad.push(`${f} @ ${t}: ${effect} ${diags.join(',')}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('chord picker fit marks', () => {
  it('marks rank 0 best and ranks 1–2 good', () => {
    expect([0, 1, 2, 3, undefined].map(fitOf)).toEqual([
      'best',
      'good',
      'good',
      undefined,
      undefined,
    ]);
  });
});

describe('palette', () => {
  it('has no note or pin', () => {
    expect(PALETTE.map((e) => e.type)).not.toEqual(expect.arrayContaining(['note']));
    expect(PALETTE.map((e) => e.type)).not.toEqual(expect.arrayContaining(['pin']));
  });
});
