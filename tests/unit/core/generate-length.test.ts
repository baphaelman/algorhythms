/** generate() target lengths: the short form below 100 s, and byte identity at or above it. */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import {
  SECTION_NAMES,
  generate,
  generateWithSections,
  type GenerateMode,
} from '../../../src/core/generate';
import { parsePiece } from '../../../src/core/schema';
import { hashPiece, hashPieceAsV1, snapshotCases } from './generate-snapshot-cases';
import snapshot from './generate-snapshot.json';

const MODES: GenerateMode[] = ['dorian', 'aeolian', 'lydian', 'pentatonic'];
const SEEDS = [1, 2, 7, 42, 2611, 31337, 99999];
const LENGTHS = [30, 45, 60, 80, 100, 150];
/** The short form's minimum gap between consecutive retargeting moments (5.8 s × 0.75). */
const MIN_GAP = 4.35;

describe('generate: length', () => {
  it('ends within 10 % of the requested length, every mode', () => {
    for (const mode of MODES)
      for (const seed of SEEDS)
        for (const length of LENGTHS) {
          const end = generate(seed, { mode, length }).end.at ?? 0;
          expect(Math.abs(end - length) / length, `${mode} ${seed} ${length}: ${end}`).toBeLessThan(
            0.1,
          );
        }
  });

  it('short pieces end exactly at the target and keep the arc: Seed, Split, …, Home', () => {
    for (const seed of SEEDS)
      for (const length of [30, 37, 45, 60, 80, 99]) {
        const { piece, sections } = generateWithSections(seed, { mode: 'dorian', length });
        expect(piece.end.at).toBeCloseTo(length, 2);
        const names = sections.map((s) => s.name);
        expect(names.slice(0, 2)).toEqual(['Seed', 'Split']);
        expect(names[names.length - 1]).toBe('Home');
        // In prototype order.
        const order = names.map((n) => SECTION_NAMES.indexOf(n));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // The Split section still reaches the full voice count.
        const splits = piece.moments.filter((m) => m.type === 'split');
        expect(splits[splits.length - 1]).toMatchObject({ count: 12 });
        // Labels sit on each section's first moment.
        // (Seed's is the opening chord at 0.)
        expect(piece.moments.filter((m) => m.label).map((m) => m.label)).toEqual(names);
      }
  });

  it('longer short pieces contain more: 30 s has a Drift chord, 80 s the development', () => {
    for (const seed of SEEDS) {
      const names = (length: number) =>
        generateWithSections(seed, { mode: 'dorian', length }).sections.map((s) => s.name);
      expect(names(30)).toEqual(['Seed', 'Split', 'Drift', 'Home']);
      expect(names(80)).toEqual(expect.arrayContaining(['Gather', 'Burst', 'Walk', 'Thin']));
    }
  });

  it(`keeps moments at least ${MIN_GAP} s apart and glides shorter than the gaps`, () => {
    for (const mode of MODES)
      for (const seed of SEEDS)
        for (const length of [30, 45, 60, 80, 99]) {
          const full = generate(seed, { mode, length });
          // The detail notes are ornaments inside a hold (checked in compose-steps.test).
          const piece = { ...full, moments: full.moments.filter((m) => m.type !== 'note') };
          const ats = piece.moments.map((m) => m.at);
          for (let i = 1; i < ats.length; i++)
            expect(ats[i] - ats[i - 1], `${mode} ${seed} ${length}`).toBeGreaterThanOrEqual(
              MIN_GAP - 0.002,
            );
          for (let i = 0; i < piece.moments.length; i++) {
            const m = piece.moments[i];
            if (m.type === 'walk' || !m.glide?.length) continue;
            const next = i + 1 < ats.length ? ats[i + 1] : (piece.end.at ?? 0);
            expect(m.glide.length).toBeGreaterThanOrEqual(1);
            expect(m.glide.length + (m.glide.stagger ?? 0)).toBeLessThan(next - m.at);
          }
        }
  });

  it('compiles with no error diagnostics and parses cleanly', () => {
    for (const mode of MODES)
      for (const seed of SEEDS)
        for (const length of [30, 45, 60, 80]) {
          for (const voices of [undefined, 2, 6, 32]) {
            const piece = generate(seed, { mode, length, voices });
            const errors = compile(piece).diagnostics.filter((d) => d.level === 'error');
            expect(errors, `${mode} ${seed} ${length} ${voices}`).toEqual([]);
            const r = parsePiece(piece);
            expect(r.ok && r.warnings).toEqual([]);
          }
        }
  });

  it('is deterministic; nonsense lengths clamp to 30 s', () => {
    expect(hashPiece(generate(9, { mode: 'lydian', length: 45 }))).toBe(
      hashPiece(generate(9, { mode: 'lydian', length: 45 })),
    );
    expect(generate(9, { mode: 'lydian', length: 0 })).toEqual(
      generate(9, { mode: 'lydian', length: 30 }),
    );
    expect(generate(9, { mode: 'lydian', length: -5 }).end.at).toBe(30);
  });

  it('natural length and lengths ≥ 100 s are byte-identical to before the short form', () => {
    const cases = snapshotCases();
    expect(cases.length).toBe(Object.keys(snapshot).length);
    for (const c of cases) {
      // Revision 6 added `arrive: 'together'` to the default glide; the snapshot predates it.
      // M4.5-38 added the detail notes; the rest is unchanged.
      const full = generate(c.seed, c.opts);
      const piece = { ...full, moments: full.moments.filter((m) => m.type !== 'note') };
      expect(piece.defaults.glide.arrive).toBe('together');
      delete piece.defaults.glide.arrive;
      // Schema v2 (M4.5-27): compared as the version 1 file (the opening back in `start`).
      expect(hashPieceAsV1(piece), c.key).toBe((snapshot as Record<string, string>)[c.key]);
    }
  });
});
