/**
 * Compose for me (M4.5-28): the composer's steps replay to generate()'s output, byte for byte as
 * before the split; every partial composition is a valid, playable piece.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { composeSteps, composedPiece, generate } from '../../../src/core/generate';
import { parsePiece } from '../../../src/core/schema';
import type { Moment } from '../../../src/core/types';
import { composeCases } from './compose-steps-cases';
import snapshot from './compose-steps-snapshot.json';
import { hashPiece } from './generate-snapshot-cases';

describe('composeSteps', () => {
  it('replays to the pre-split generate() output for 200 seeds (snapshot)', () => {
    const cases = composeCases();
    expect(cases.length).toBe(200);
    expect(Object.keys(snapshot).length).toBe(200);
    for (const c of cases) {
      const piece = composedPiece(composeSteps(c.seed, c.opts));
      expect(hashPiece(piece), c.key).toBe((snapshot as Record<string, string>)[c.key]);
      expect(piece).toEqual(generate(c.seed, c.opts));
    }
  });

  it('adds every moment once, in time order; edits only moments already placed', () => {
    for (const c of composeCases().slice(0, 60)) {
      const { steps } = composeSteps(c.seed, c.opts);
      const placed = new Set<string>();
      let last = -Infinity;
      for (const s of steps) {
        if (s.kind === 'add') {
          expect(placed.has(s.moment.id)).toBe(false);
          expect(s.moment.at).toBeGreaterThanOrEqual(last);
          last = s.moment.at;
          placed.add(s.moment.id);
        } else {
          expect(placed.has(s.moment.id), c.key).toBe(true);
        }
      }
      expect(placed.size).toBe(generate(c.seed, c.opts).moments.length);
    }
  });

  it('the register pass edits each Drift chord after the Drift chords are placed', () => {
    const { steps } = composeSteps(7, { mode: 'dorian' });
    const drift = steps.filter((s) => s.kind === 'add' && s.section === 'Drift');
    const register = steps.filter((s) => s.kind === 'edit' && s.pass === 'register');
    expect(drift.length).toBe(6);
    expect(register.map((s) => s.moment.id)).toEqual(drift.map((s) => s.moment.id));
    for (const s of drift)
      expect((s.moment as Moment & { register?: unknown }).register).toBe(undefined);
    const lastDrift = steps.indexOf(drift[drift.length - 1]);
    const firstEdit = steps.indexOf(register[0]);
    const gather = steps.findIndex((s) => s.kind === 'add' && s.section === 'Gather');
    expect(firstEdit).toBeGreaterThan(lastDrift);
    expect(gather).toBeGreaterThan(steps.indexOf(register[register.length - 1]));
    // A full-form piece has no fit pass.
    expect(steps.some((s) => s.kind === 'edit' && s.pass === 'fit')).toBe(false);
  });

  it('a short form is laid out at its natural pace, then fit to the length', () => {
    const c = composeSteps(3, { mode: 'lydian', length: 45 });
    const fit = c.steps.filter((s) => s.kind === 'edit' && s.pass === 'fit');
    expect(fit.length).toBeGreaterThan(2);
    const firstFit = c.steps.indexOf(fit[0]);
    expect(c.steps.slice(firstFit).every((s) => s.kind === 'edit' && s.pass === 'fit')).toBe(true);
    const before = composedPiece(c, firstFit);
    const after = composedPiece(c);
    const home = (p: typeof before) => p.moments[p.moments.length - 1].at;
    expect(home(before)).toBeGreaterThan(home(after));
    expect(after.end.at).toBe(45);
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
