/**
 * Chord `count` (PLAN.md §6.2 chord row, §7.4; revision 6) and `freezeChord` (§11.3).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { crossfadeLength } from '../../../src/core/ease';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { freezeChord } from '../../../src/core/freeze-chord';
import { activeAt, lifeAt, pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { ChordMoment, CompiledScore, Moment, Piece } from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

// Slowest test 2.6 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const GLIDE = { length: 3, jitter: 0.3, stagger: 1.5, ease: 'smootherstep' as const };
const START = [48, 55, 60, 64, 67];

function chord(count: number | undefined, extra: Partial<ChordMoment> = {}): MomentInput {
  return {
    id: 'c',
    type: 'chord',
    at: 1,
    notes: { kind: 'chord', symbol: 'Dm9' },
    voicing: 'even',
    assign: 'ordered',
    ...(count === undefined ? {} : { count }),
    ...extra,
  };
}

/** Segments the moment wrote that move. */
function moveSegs(s: CompiledScore, id: string) {
  return s.voices.flatMap((v) =>
    v.segments.filter((g) => g.momentId === id && g.p0 !== g.p1).map((g) => ({ v: v.index, g })),
  );
}

const codes = (s: CompiledScore) => s.diagnostics.map((d) => d.code);

describe('chord count', () => {
  it('equal to the active count, or absent: the same score', () => {
    const base = compile(piece({ start: START, glide: GLIDE, moments: [chord(undefined)] }));
    const same = compile(piece({ start: START, glide: GLIDE, moments: [chord(5)] }));
    expect(same).toEqual(base);
  });

  it('up: births fork from their parents and the count becomes `count`', () => {
    const p = piece({ start: START, glide: GLIDE, end: { at: 20, fade: 1 }, moments: [chord(8)] });
    const s = compile(p);
    expect(codes(s).filter((c) => c !== 'range-fold')).toEqual([]);
    expect(activeAt(s, 10)).toHaveLength(8);
    // Dm9 = D F A C E: 8 distinct targets, every voice on a chord tone.
    const pcs = new Set(chordAt(s, 10).map((x) => ((x % 12) + 12) % 12));
    expect([...pcs].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 9]);
    expect(new Set(chordAt(s, 10)).size).toBe(8);
    for (const v of s.voices.slice(5, 8)) {
      const life = v.lives[0];
      // Born on a sounding voice's pitch at that instant (§7.4).
      const p0 = v.segments[0].p0;
      const parents = s.voices.slice(0, 5).map((u) => pitchAt(u, life.born));
      expect(parents.some((x) => x !== null && Math.abs(x - p0) < 1e-9)).toBe(true);
      expect(life.fadeIn).toBe(1.5); // max(0.5, length / 2)
    }
  });

  it('up beyond the pool is truncated (pool-exhausted)', () => {
    const s = compile(
      piece({ start: START, pool: 6, glide: GLIDE, end: { at: 20, fade: 1 }, moments: [chord(9)] }),
    );
    expect(codes(s)).toContain('pool-exhausted');
    expect(activeAt(s, 10)).toHaveLength(6);
  });

  it('down: the outer voices die into a survivor’s target, crossfading over the approach', () => {
    const p = piece({ start: START, glide: GLIDE, end: { at: 20, fade: 1 }, moments: [chord(3)] });
    const s = compile(p);
    expect(activeAt(s, 12)).toHaveLength(3);
    // Outer: the lowest and highest voices die.
    expect(s.voices[0].lives[0].died).toBeLessThan(20);
    expect(s.voices[4].lives[0].died).toBeLessThan(20);
    const survivors = [1, 2, 3].map((i) => pitchAt(s.voices[i], 12)!);
    for (const i of [0, 4]) {
      const v = s.voices[i];
      const g = v.segments.filter((x) => x.momentId === 'c').at(-1)!;
      const to = g.curve ? g.curve.p1 : g.p1;
      expect(survivors).toContain(to);
      // Merges and splits crossfade (2026-11-21): silent where it meets its survivor, after a
      // fade over the end of the approach.
      expect(v.lives[0].died).toBeCloseTo(g.t1, 9);
      expect(v.lives[0].fadeOut).toBeCloseTo(crossfadeLength(g.t1 - g.t0), 9);
      expect(v.lives[0].crossOut).toBe(true);
    }
  });

  it('down with a subset target keeps one targeted voice (count-limited)', () => {
    const s = compile(
      piece({ start: START, glide: GLIDE, moments: [chord(1, { target: { rank: [0, 1] } })] }),
    );
    expect(codes(s)).toContain('count-limited');
    expect(activeAt(s, 12)).toHaveLength(4);
  });

  it('with stagger, births, deaths and moves arrive together; lines never cross', () => {
    for (const count of [2, 3, 7, 9]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const p = piece({
          seed,
          start: START,
          glide: { ...GLIDE, stagger: 2, order: 'random' },
          moments: [chord(count)],
        });
        const s = compile(p);
        expect(codes(s)).not.toContain('crossing-unresolved');
        const ends = moveSegs(s, 'c').map((x) => x.g.t1);
        expect(Math.max(...ends) - Math.min(...ends), `${count}/${seed}`).toBeLessThan(1e-9);
        // No pair of sounding lines is clearly below and later clearly above (0.05 st: linear
        // sub-sample touches aside, §7.2 checks 64 samples).
        const n = s.voices.length;
        const below = new Uint8Array(n * n);
        for (let t = 1; t <= ends[0] + 0.5; t += 0.005) {
          const ps = s.voices.map((v) => (lifeAt(v, t) ? pitchAt(v, t) : null));
          for (let a = 0; a < n; a++)
            for (let b = 0; b < n; b++) {
              const x = ps[a];
              const y = ps[b];
              if (x === null || y === null) continue;
              if (x < y - 0.05) below[a * n + b] = 1;
              if (x > y + 0.05) expect(below[a * n + b], `${count}/${seed} t=${t}`).toBe(0);
            }
        }
      }
    }
  });

  it('no-effect: births doubling parents, deaths into a unison', () => {
    const one = (start: number[], m: MomentInput, range?: [number, number]) => {
      const s = compile(piece({ start, glide: GLIDE, moments: [m], ...(range ? { range } : {}) }));
      return s.diagnostics.filter((d) => d.code === 'no-effect' && d.momentId === m.id);
    };
    const uni: MomentInput = chord(3, { notes: { kind: 'pitches', pitches: [60] } });
    // Births double only when no free octave is in range (PLAN §11.3 rev 7).
    expect(one([60, 60], uni, [55, 66])).toHaveLength(1);
    expect(one([60, 60], uni)).toEqual([]);
    expect(one([60, 60, 60, 60], { ...uni, count: 1 } as MomentInput)).toHaveLength(1);
    // A new pitch, or a death that leaves a pitch unsounded, is an effect.
    expect(one([60, 64], chord(3, { notes: { kind: 'pitches', pitches: [60, 64, 67] } }))).toEqual(
      [],
    );
    expect(
      one([60, 64, 67], chord(2, { notes: { kind: 'pitches', pitches: [60, 64, 67] } })),
    ).toEqual([]);
  });

  it('palette helper: agrees with the compiler, and treats chord deaths as dying', () => {
    const p = piece({
      start: START,
      pool: 9,
      glide: GLIDE,
      end: { at: 40, fade: 1 },
      moments: [chord(3), { id: 'u', type: 'unison', at: 15, pitch: 60, octaves: false }],
    });
    const s = compile(p);
    const probes: Moment[] = [
      {
        id: 'probe',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [60] },
        voicing: 'even',
        assign: 'ordered',
        count: 1,
      },
      {
        id: 'probe',
        type: 'chord',
        at: 0,
        notes: { kind: 'chord', symbol: 'C' },
        voicing: 'even',
        assign: 'ordered',
        count: 6,
      },
      { id: 'probe', type: 'merge', at: 0, count: 3, which: 'top', fade: 1 },
      { id: 'probe', type: 'split', at: 0, count: 9, voicing: 'even' },
    ];
    // Not inside a stagger window: the palette ignores the cancellation of pending moves.
    for (const t of [0.5, 6, 12, 25]) {
      for (const probe of probes) {
        const m = { ...probe, at: t } as Moment;
        const q = structuredClone(p);
        q.moments.push(m);
        const compiled =
          compile(q).diagnostics.filter((d) => d.code === 'no-effect' && d.momentId === 'probe')
            .length === 0;
        expect(
          momentEffectAt(p, s, m).effect,
          `${m.type} ${String((m as { count?: number }).count)} at ${t}`,
        ).toBe(compiled);
      }
    }
    // During the chord's death fades the dying voices no longer count: a merge to 3 does nothing.
    expect(s.voices[0].lives[0].died).toBeGreaterThan(6);
    const merge: Moment = { id: 'probe', type: 'merge', at: 6, count: 3, which: 'top', fade: 1 };
    expect(momentEffectAt(p, s, merge).effect).toBe(false);
  });

  it('schema: round-trips, 1..pool size, integers only', () => {
    const p = piece({ start: START, pool: 8, moments: [chord(6)] });
    const parsed = parsePiece(JSON.parse(serializePiece(p)));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    expect((parsed.piece.moments[1] as ChordMoment).count).toBe(6);
    expect(parsed.warnings).toEqual([]);
    const withCount = (count: unknown) => {
      const j = JSON.parse(serializePiece(p));
      j.moments[0].count = count;
      return parsePiece(j);
    };
    expect(withCount(8).ok).toBe(true);
    for (const bad of [0, 9, 2.5, 'three']) {
      const r = withCount(bad);
      expect(r.ok && r.warnings.length === 0, String(bad)).toBe(false);
    }
    const none = JSON.parse(serializePiece(p));
    delete none.moments[0].count;
    const r = parsePiece(none);
    expect(r.ok && (r.piece.moments[0] as ChordMoment).count).toBeUndefined();
  });

  it('incremental compile equals full compile', () => {
    const p = piece({
      start: START,
      pool: 10,
      glide: GLIDE,
      moments: [
        chord(8),
        { id: 's', type: 'shift', at: 6, by: 2, unit: 'scaleSteps' },
        chord(3, { id: 'c2', at: 11, notes: { kind: 'chord', symbol: 'G7' } }),
        { id: 'sp', type: 'split', at: 17, count: 6, voicing: 'even' },
      ],
    });
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    for (const count of [5, 1, 10, undefined]) {
      const q = structuredClone(p);
      const c2 = q.moments[2] as ChordMoment;
      if (count === undefined) delete c2.count;
      else c2.count = count;
      expect(inc.compile(q)).toEqual(compile(q));
      expect(inc.stats.mode).toBe('resume');
    }
    const q = structuredClone(p);
    (q.moments[0] as ChordMoment).count = 2;
    expect(inc.compile(q)).toEqual(compile(q));
  });
});

describe('freezeChord', () => {
  /** Replaces the chord with its frozen form; returns both scores' voices. */
  function refreeze(p: Piece, id: string) {
    const s = compile(p);
    const frozen = freezeChord(p, s, id);
    expect(frozen, id).not.toBeNull();
    const q = structuredClone(p);
    q.moments = q.moments.map((m) => (m.id === id ? frozen! : m));
    return { s, t: compile(q), frozen: frozen! };
  }

  it('reproduces every chord of every example', () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.algorhythms.json'));
    let n = 0;
    for (const f of files) {
      const parsed = parsePiece(JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')));
      if (!parsed.ok) throw new Error(f);
      for (const m of parsed.piece.moments) {
        if (m.type !== 'chord' || m.muted) continue;
        // Revision 8: a `free` chord splitting a merged line gets ordered fork timings when
        // frozen (same notes and weights, different staggers).
        if (m.assign === 'free') continue;
        const { s, t, frozen } = refreeze(parsed.piece, m.id);
        expect(frozen.notes.kind).toBe('pitches');
        expect(frozen.assign).toBe('ordered');
        expect(t.voices, `${f} ${m.id}`).toEqual(s.voices);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it('pitches low→high, count kept, one per voice that sounds the chord', () => {
    for (const count of [undefined, 3, 8]) {
      const p = piece({ start: START, glide: GLIDE, moments: [chord(count)] });
      const { s, t, frozen } = refreeze(p, 'c');
      const ps = (frozen.notes as { pitches: number[] }).pitches;
      expect(ps).toEqual([...ps].sort((a, b) => a - b));
      expect(ps).toHaveLength(count ?? 5);
      expect(frozen.count).toBe(count);
      expect(t.voices).toEqual(s.voices);
    }
  });

  it('reproduces chords inside a piece (after other moments, mid-glide, subsets)', () => {
    const p = piece({
      start: START,
      pool: 10,
      glide: { ...GLIDE, stagger: 2 },
      moments: [
        { id: 'a', type: 'shift', at: 1, by: 3, unit: 'semitones' },
        chord(undefined, { id: 'b', at: 2.5, notes: { kind: 'chord', symbol: 'Em7' } }),
        chord(7, { id: 'c', at: 9, notes: { kind: 'degrees', degrees: [0, 2, 4, 6] } }),
        chord(undefined, { id: 'd', at: 15, target: { rank: [1, 3] }, voicing: 'nearest' }),
        chord(4, { id: 'e', at: 21, notes: { kind: 'chord', symbol: 'F/A' }, voicing: 'close' }),
      ],
    });
    for (const id of ['b', 'c', 'd', 'e']) {
      const { s, t } = refreeze(p, id);
      expect(t.voices, id).toEqual(s.voices);
    }
  });

  it('null for a chord that was not applied, or a non-chord', () => {
    const p = piece({
      start: START,
      moments: [
        chord(undefined, { id: 'bad', notes: { kind: 'chord', symbol: 'H#q' } }),
        { id: 's', type: 'shift', at: 2, by: 1, unit: 'semitones' },
      ],
    });
    const s = compile(p);
    expect(freezeChord(p, s, 'bad')).toBeNull();
    expect(freezeChord(p, s, 's')).toBeNull();
    expect(freezeChord(p, s, 'nope')).toBeNull();
  });
});
