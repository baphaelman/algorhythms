/**
 * Compose for me (M4.5-28, M4.5-38): the composer's steps place the structure in play order, then
 * the detail notes in one left-to-right sweep, and replay to generate()'s output. The structure is
 * byte-identical to generate() before the split; every partial composition is a playable piece.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { composeSteps, composedPiece, generate } from '../../../src/core/generate';
import { isScaleTone } from '../../../src/core/scales';
import { parsePiece } from '../../../src/core/schema';
import type { Moment, Piece } from '../../../src/core/types';
import { composeCases } from './compose-steps-cases';
import snapshot from './compose-steps-snapshot.json';
import { hashPiece } from './generate-snapshot-cases';

const structure = (p: Piece): Piece => ({
  ...p,
  moments: p.moments.filter((m) => m.type !== 'note'),
});

describe('composeSteps', () => {
  it('replays to generate() for 200 seeds; the structure matches the pre-split snapshot', () => {
    const cases = composeCases();
    expect(cases.length).toBe(200);
    expect(Object.keys(snapshot).length).toBe(200);
    for (const c of cases) {
      const piece = composedPiece(composeSteps(c.seed, c.opts));
      expect(piece).toEqual(generate(c.seed, c.opts));
      expect(hashPiece(structure(piece)), c.key).toBe((snapshot as Record<string, string>)[c.key]);
      // The file lists moments in time order.
      const ats = piece.moments.map((m) => m.at);
      expect(ats).toEqual([...ats].sort((a, b) => a - b));
    }
  });

  it('places the structure in play order, then one left-to-right detail sweep', () => {
    let details = 0;
    for (const c of composeCases()) {
      const { steps } = composeSteps(c.seed, c.opts);
      const firstDetail = steps.findIndex((s) => s.phase === 'detail');
      const cut = firstDetail < 0 ? steps.length : firstDetail;
      const struct = steps.slice(0, cut);
      const sweep = steps.slice(cut);
      expect(
        struct.every((s) => s.kind === 'add' && s.phase === 'structure'),
        c.key,
      ).toBe(true);
      expect(
        sweep.every((s) => s.phase === 'detail'),
        c.key,
      ).toBe(true);
      for (const part of [struct, sweep]) {
        const ats = part.map((s) => s.moment.at);
        for (let i = 1; i < ats.length; i++)
          expect(ats[i], c.key).toBeGreaterThanOrEqual(ats[i - 1]);
      }
      const placed = new Set<string>();
      for (const s of steps) {
        if (s.kind === 'add') {
          expect(placed.has(s.moment.id)).toBe(false);
          placed.add(s.moment.id);
        } else expect(placed.has(s.moment.id), c.key).toBe(true);
      }
      expect(placed.size).toBe(generate(c.seed, c.opts).moments.length);
      details += sweep.length;
    }
    // Most pieces get two or three detail notes.
    expect(details).toBeGreaterThan(400);
  });

  it('each moment is final when placed: Drift chords already voiced, short forms already fit', () => {
    for (const [seed, opts] of [
      [7, { mode: 'dorian' as const }],
      [3, { mode: 'lydian' as const, length: 45 }],
    ] as const) {
      const c = composeSteps(seed, opts);
      const done = composedPiece(c);
      for (const s of c.steps)
        expect(s.moment).toEqual(done.moments.find((m) => m.id === s.moment.id));
      const drift = c.steps.filter((s) => s.kind === 'add' && s.section === 'Drift');
      for (const s of drift)
        expect((s.moment as Moment & { register?: unknown }).register).toBeDefined();
    }
    expect(composedPiece(composeSteps(3, { mode: 'lydian', length: 45 })).end.at).toBe(45);
  });

  it('detail notes are upper neighbours of a held chord, inside its hold, and sound', () => {
    for (const c of composeCases().slice(0, 80)) {
      const piece = generate(c.seed, c.opts);
      const score = compile(piece);
      const moved = new Set<string>();
      for (const v of score.voices)
        for (const g of v.segments) if (g.momentId) moved.add(g.momentId);
      for (let i = 0; i < piece.moments.length; i++) {
        const m = piece.moments[i];
        if (m.type !== 'note') continue;
        const held = piece.moments[i - 1];
        const next = piece.moments[i + 1];
        if (held.type !== 'split' && held.type !== 'chord') throw new Error(c.key);
        if (held.notes?.kind !== 'pitches') throw new Error(c.key);
        expect(m.from).toBe(Math.max(...held.notes.pitches));
        expect(isScaleTone(m.to!, piece.key)).toBe(true);
        expect(m.to! - m.from!).toBeGreaterThan(0);
        expect(m.to! - m.from!).toBeLessThanOrEqual(4);
        // Out, held, back: over before the next moment.
        expect(m.at + 2 * m.glide!.length! + m.back!).toBeLessThan(next.at);
        expect(moved.has(m.id), c.key).toBe(true);
        expect(score.diagnostics.filter((d) => d.momentId === m.id)).toEqual([]);
      }
    }
  });

  it('every partial composition (Stop) is a valid piece that compiles without errors', () => {
    for (const [seed, opts] of [
      [11, { mode: 'dorian' as const }],
      [12, { mode: 'pentatonic' as const, length: 60, voices: 5 }],
      [13, { mode: 'aeolian' as const, length: 240, voices: 24, density: 0.8 }],
    ] as const) {
      const c = composeSteps(seed, opts);
      for (let k = 0; k <= c.steps.length; k++) {
        const piece = composedPiece(c, k);
        const parsed = parsePiece(JSON.parse(JSON.stringify(piece)));
        expect(parsed.ok, `${seed} step ${k}`).toBe(true);
        if (k < c.steps.length) expect(piece.end.at).toBe(undefined);
        const score = compile(piece);
        expect(score.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
        if (k >= 2) expect(score.duration).toBeGreaterThan(0);
      }
    }
  });

  it('a different input gives a different step list from the start (a restart)', () => {
    const a = composeSteps(100, { mode: 'dorian' });
    const b = composeSteps(101, { mode: 'dorian' });
    const c = composeSteps(100, { mode: 'dorian', voices: 6 });
    expect(a.steps[1]).not.toEqual(b.steps[1]);
    expect(a.steps[1]).not.toEqual(c.steps[1]);
    expect(composeSteps(100, { mode: 'dorian' })).toEqual(a);
  });
});
