/** Unit tests for core/generate.ts (PLAN.md §11.3 Generate, §15 M1 acceptance). */

import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { activeAt, lifeAt, stackAt } from '../../../src/core/query';
import {
  SECTION_NAMES,
  generate,
  generateWithSections,
  splitStages,
  type GenerateMode,
  type GenerateOptions,
} from '../../../src/core/generate';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import { isScaleTone } from '../../../src/core/scales';
import type { CompiledScore, Moment, Piece } from '../../../src/core/types';
import { prototypeSections } from './prototype-compose';

const MODES: GenerateMode[] = ['dorian', 'aeolian', 'lydian', 'pentatonic'];
const PROTOTYPE_MODE: Record<GenerateMode, string> = {
  dorian: 'dorian',
  aeolian: 'aeolian',
  lydian: 'lydian',
  pentatonic: 'penta',
};
/** 20 seeds: the prototype's default, small ones, and some large ones. */
const SEEDS = [
  2611, 1, 2, 3, 7, 42, 99, 100, 777, 1234, 4096, 5000, 12345, 31337, 54321, 65535, 70001, 88888,
  99997, 99998,
];

/**
 * Per section of a generated piece, derived from the piece itself (not from generate()'s own
 * bookkeeping): the active-voice count after each moment that retargets voices (split, chord,
 * unison, merge) and at the section's end. Sections start at the moment labelled with their name;
 * Seed is the opening, before any moment.
 */
function pieceSections(piece: Piece): { name: string; retargets: number[]; end: number }[] {
  const out = [{ name: 'Seed', retargets: [] as number[], end: piece.start.length }];
  let active = piece.start.length;
  const ordered = piece.moments
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.at - b.m.at || a.i - b.i)
    .map(({ m }) => m);
  for (const m of ordered) {
    if (m.label && (SECTION_NAMES as readonly string[]).includes(m.label)) {
      out.push({ name: m.label, retargets: [], end: active });
    }
    const section = out[out.length - 1];
    if (m.type === 'split' || m.type === 'merge') active = m.count;
    if (m.type === 'split' || m.type === 'merge' || m.type === 'chord' || m.type === 'unison') {
      section.retargets.push(active);
    }
    section.end = active;
  }
  return out;
}

/**
 * Voices the lines heard at t stand for (Σ `stack`, revision 8): the prototype's voice count. A
 * unison makes one line of 12 voices; a merge's dying lines leave.
 */
function stackedVoicesAt(score: CompiledScore, t: number): number {
  let n = 0;
  for (const i of activeAt(score, t)) {
    const v = score.voices[i];
    const life = lifeAt(v, t);
    if (
      life?.died !== undefined &&
      life.died < score.duration &&
      t >= life.died - (life.fadeOut ?? 0)
    )
      continue;
    n += stackAt(v, t);
  }
  return n;
}

describe('generate: matches the prototype compose()', () => {
  it.each(MODES)('section sequence and active voices per section, 20 seeds, %s', (mode) => {
    for (const seed of SEEDS) {
      const expected = prototypeSections(seed, PROTOTYPE_MODE[mode]).map(
        ({ name, retargets, end }) => ({
          name,
          retargets,
          end,
        }),
      );
      const piece = generate(seed, { mode });
      expect(pieceSections(piece), `seed ${seed}`).toEqual(expected);
    }
  });

  it('the reference really is the prototype: 8 sections, 1 → 3 → 5 → 8 → 12 voices', () => {
    const s = prototypeSections(2611, 'dorian');
    expect(s.map((x) => x.name)).toEqual([...SECTION_NAMES]);
    expect(s.map((x) => x.end)).toEqual([1, 12, 12, 12, 12, 12, 12, 12]);
    expect(s[1].retargets).toEqual([3, 5, 8, 12]);
    expect(s[2].retargets).toHaveLength(6);
  });

  it('labels the first moment of each section, at the section start', () => {
    const { piece, sections } = generateWithSections(2611, { mode: 'dorian' });
    expect(sections.map((s) => s.name)).toEqual([...SECTION_NAMES]);
    const labelled = piece.moments.filter((m) => m.label !== undefined);
    expect(labelled.map((m) => m.label)).toEqual(SECTION_NAMES.slice(1));
    expect(labelled.map((m) => m.at)).toEqual(sections.slice(1).map((s) => s.at));
    expect(sections[0].at).toBe(0);
    for (let i = 1; i < sections.length; i++)
      expect(sections[i].at).toBeGreaterThan(sections[i - 1].at);
  });

  it('keeps the prototype timings: seed 8–10 s, split stages 7–8.5 s apart, about 2.5 minutes', () => {
    for (const seed of SEEDS) {
      const { piece, sections } = generateWithSections(seed, { mode: 'dorian' });
      expect(sections[1].at).toBeGreaterThanOrEqual(8);
      expect(sections[1].at).toBeLessThan(10);
      const splits = piece.moments.filter((m) => m.type === 'split');
      for (let i = 1; i < splits.length; i++) {
        const gap = splits[i].at - splits[i - 1].at;
        expect(gap).toBeGreaterThanOrEqual(7 - 1e-9);
        expect(gap).toBeLessThan(8.5 + 1e-9);
      }
      expect(piece.end.at).toBeGreaterThan(140);
      expect(piece.end.at).toBeLessThan(170);
      expect(piece.end.fade).toBe(6);
    }
  });
});

describe('generate: output', () => {
  it('is deterministic', () => {
    for (const mode of MODES) {
      const a = generate(31337, { mode });
      const b = generate(31337, { mode });
      expect(b).toEqual(a);
      expect(serializePiece(b)).toBe(serializePiece(a));
    }
  });

  it('never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random called');
    });
    try {
      expect(() => generate(5, { mode: 'lydian', length: 300, voices: 20 })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('depends on the seed', () => {
    const a = serializePiece(generate(1, { mode: 'dorian' }));
    const b = serializePiece(generate(2, { mode: 'dorian' }));
    expect(a).not.toBe(b);
  });

  it('passes parsePiece unchanged (every default already present)', () => {
    for (const mode of MODES) {
      for (const seed of SEEDS.slice(0, 5)) {
        const piece = generate(seed, { mode });
        const r = parsePiece(piece);
        if (!r.ok) throw new Error(r.errors.join('\n'));
        expect(r.warnings).toEqual([]);
        expect(r.piece).toEqual(piece);
      }
    }
  });

  it('gives every moment a unique, deterministic 6-character base62 id', () => {
    const piece = generate(2611, { mode: 'dorian', length: 600, voices: 32 });
    const ids = piece.moments.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{6}$/);
    expect(generate(2611, { mode: 'dorian' }).moments[0].id).toBe(
      generate(2611, { mode: 'aeolian' }).moments[0].id,
    );
    expect(generate(2611, { mode: 'dorian' }).moments[0].id).not.toBe(
      generate(2612, { mode: 'dorian' }).moments[0].id,
    );
  });

  it('sets up the piece like the prototype: A + mode, v1 on A3, range 38..84', () => {
    const scale: Record<GenerateMode, string> = {
      dorian: 'dorian',
      aeolian: 'aeolian',
      lydian: 'lydian',
      pentatonic: 'pentatonic-major',
    };
    for (const mode of MODES) {
      const p = generate(9, { mode });
      expect(p.key).toEqual({ tonic: 'A', scale: scale[mode] });
      expect(p.seed).toBe(9);
      expect(p.start).toEqual([{ voice: 'v1', pitch: 57 }]);
      expect(p.voices).toHaveLength(12);
      for (const v of p.voices) expect(v.range).toEqual([38, 84]);
      expect(Object.keys(p.timbres)).toEqual(['glass']);
    }
    expect(generate(9, { mode: 'pentatonic' }).meta.title).toBe('Pentatonic 9');
  });

  it('writes musical targets: scale tones in range, chords on scale degrees', () => {
    for (const mode of MODES) {
      for (const seed of SEEDS.slice(0, 8)) {
        const p = generate(seed, { mode });
        const pitchesOf = (m: Moment): number[] => {
          if ((m.type === 'chord' || m.type === 'split') && m.notes?.kind === 'pitches') {
            return m.notes.pitches;
          }
          return m.type === 'unison' && typeof m.pitch === 'number' ? [m.pitch] : [];
        };
        for (const m of p.moments) {
          for (const q of pitchesOf(m)) {
            expect(isScaleTone(q, p.key)).toBe(true);
            expect(q).toBeGreaterThanOrEqual(38);
            expect(q).toBeLessThanOrEqual(84);
          }
          if (m.type === 'chord' && m.notes.kind === 'degrees') {
            const [c] = m.notes.degrees;
            expect(m.notes.degrees).toEqual([c, c + 2, c + 4, c + 6]);
            expect(m.register?.[0]).toBeGreaterThanOrEqual(38);
            expect(m.register?.[1]).toBeLessThanOrEqual(84);
          }
          if (m.type === 'split') expect(pitchesOf(m)).toHaveLength(m.count);
        }
        // Home is the root; the Burst bass is the lowest note.
        const home = p.moments[p.moments.length - 1];
        expect(home).toMatchObject({ type: 'unison', pitch: 57, label: 'Home' });
        const burst = p.moments.find((m) => m.label === 'Burst');
        if (burst?.type !== 'chord' || burst.notes.kind !== 'pitches') throw new Error('no burst');
        expect(burst.notes.pitches[0]).toBe(Math.min(...burst.notes.pitches));
      }
    }
  });

  it('ports the walk: 24 one-second ticks, steps of 1–2 scale tones, bass leaps 5–12', () => {
    const walk = generate(2611, { mode: 'dorian' }).moments.find((m) => m.type === 'walk');
    expect(walk).toMatchObject({
      type: 'walk',
      grid: 1,
      density: 0.45,
      steps: [-2, -1, 1, 2],
      stepGlide: 0.27,
      bass: { leap: [5, 12] },
    });
    if (walk?.type !== 'walk') throw new Error('no walk');
    expect(walk.until - walk.at).toBe(24);
  });
});

describe('generate: options', () => {
  it('voices sets the pool and the split stages', () => {
    expect(splitStages(12)).toEqual([3, 5, 8, 12]);
    expect(splitStages(24)).toEqual([6, 10, 16, 24]);
    expect(splitStages(32)).toEqual([8, 13, 21, 32]);
    expect(splitStages(6)).toEqual([2, 3, 4, 6]);
    expect(splitStages(2)).toEqual([2]);
    for (const n of [2, 3, 6, 16, 24, 32]) {
      const p = generate(4, { mode: 'dorian', voices: n });
      expect(p.voices).toHaveLength(n);
      const sections = pieceSections(p);
      expect(sections.map((s) => s.name)).toEqual([...SECTION_NAMES]);
      expect(sections[1].retargets).toEqual(splitStages(n));
      expect(sections.slice(1).every((s) => s.end === n)).toBe(true);
      for (const m of p.moments) {
        if (m.type === 'chord' && m.notes.kind === 'pitches')
          expect(m.notes.pitches).toHaveLength(n);
      }
      expect(parsePiece(p).ok).toBe(true);
    }
    expect(generate(4, { mode: 'dorian', voices: 99 }).voices).toHaveLength(32);
    expect(generate(4, { mode: 'dorian', voices: 0 }).voices).toHaveLength(2);
  });

  it('length adds drift chords and walk ticks; every section stays', () => {
    const count = (o: GenerateOptions) => {
      const p = generate(8, o);
      const walk = p.moments.find((m) => m.type === 'walk');
      return {
        drifts: p.moments.filter((m) => m.type === 'chord' && m.notes.kind === 'degrees').length,
        ticks: walk?.type === 'walk' ? walk.until - walk.at : 0,
        end: p.end.at ?? 0,
        sections: pieceSections(p).map((s) => s.name),
      };
    };
    const natural = count({ mode: 'dorian' });
    expect(natural).toMatchObject({ drifts: 6, ticks: 24 });
    expect(count({ mode: 'dorian', length: 155 })).toMatchObject({ drifts: 6, ticks: 24 });
    for (const length of [240, 360, 600]) {
      const c = count({ mode: 'dorian', length });
      expect(c.sections).toEqual([...SECTION_NAMES]);
      expect(Math.abs(c.end - length) / length).toBeLessThan(0.1);
    }
    const floor = count({ mode: 'dorian', length: 100 });
    expect(floor).toMatchObject({ drifts: 1, ticks: 4 });
    expect(floor.sections).toEqual([...SECTION_NAMES]);
    // Below 100 s: the short form (generate-length.test.ts).
    expect(count({ mode: 'dorian', length: 30 }).end).toBe(30);
  });

  it('density sets the walk density, clamped to 0..1', () => {
    const density = (d: number) => {
      const w = generate(3, { mode: 'dorian', density: d }).moments.find((m) => m.type === 'walk');
      return w?.type === 'walk' ? w.density : NaN;
    };
    expect(density(0.8)).toBe(0.8);
    expect(density(2)).toBe(1);
    expect(density(-1)).toBe(0);
  });

  it('changing an option does not reshuffle unrelated choices', () => {
    // Keyed draws: density only touches the walk, so every other moment is identical.
    const a = generate(77, { mode: 'dorian', density: 0.2 });
    const b = generate(77, { mode: 'dorian', density: 0.9 });
    const strip = (p: Piece) => p.moments.filter((m) => m.type !== 'walk');
    expect(strip(b)).toEqual(strip(a));
  });
});

describe('generate: compiles', () => {
  it('compiles with no error diagnostics, 20 seeds in every mode', () => {
    for (const mode of MODES) {
      for (const seed of SEEDS) {
        const errors = compile(generate(seed, { mode })).diagnostics.filter(
          (d) => d.level === 'error',
        );
        expect(errors, `${mode} ${seed}`).toEqual([]);
      }
    }
  });

  it('the compiled lives give the expected active count at each section boundary', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const { piece, sections } = generateWithSections(seed, { mode: 'dorian' });
      const score = compile(piece);
      const expected = pieceSections(piece).map((s) => s.end);
      for (let i = 1; i < sections.length; i++) {
        const t = sections[i].at;
        // Just before the next section's first moment, which may split a stacked line at t.
        const alive = stackedVoicesAt(score, t - 1e-3);
        expect(alive, `seed ${seed}, end of ${sections[i - 1].name}`).toBe(expected[i - 1]);
      }
    }
  });
});
