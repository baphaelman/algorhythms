/**
 * R9-2 (PLAN §5 `Glide.land`, §11.3 "Land on the beat", §18 revision 9): `land` moments arrive at
 * `at`; splits and merges honour stagger and order.
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { decisionTime, landing, sanitizeGlide } from '../../../src/core/compiler/glide';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { defaultGlide } from '../../../src/core/defaults';
import { momentEffectAt } from '../../../src/core/effect';
import { freezeChord } from '../../../src/core/freeze-chord';
import { pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { CompiledScore, GlideOrder, Moment, Piece } from '../../../src/core/types';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';

const START = [48, 55, 60, 64];
const DM9 = { kind: 'chord' as const, symbol: 'Dm9' };

function chord(at: number, glide: Record<string, unknown> = {}, id = 'c'): MomentInput {
  return {
    id,
    type: 'chord',
    at,
    notes: DM9,
    voicing: 'even',
    assign: 'ordered',
    glide: { land: true, ...glide },
  } as MomentInput;
}

/** Segments moment `id` wrote that move. */
function moves(s: CompiledScore, id: string) {
  return s.voices.flatMap((v) => v.segments.filter((g) => g.momentId === id && g.p0 !== g.p1));
}
const span = (s: CompiledScore, id: string) => s.momentSpans.find((x) => x.id === id)!;

describe('land: together', () => {
  it('every moving voice arrives exactly at `at`; the moment decides length + stagger before', () => {
    for (const seed of [1, 2, 3, 4]) {
      const p = piece({
        seed,
        start: START,
        glide: { length: 2, jitter: 0.3, stagger: 1 },
        moments: [chord(10)],
      });
      const { score: s, trace } = compileWithTrace(p);
      const ms = moves(s, 'c');
      expect(ms.length).toBeGreaterThan(1);
      for (const g of ms) {
        expect(g.t1).toBeCloseTo(10, 9);
        expect(g.t0).toBeGreaterThanOrEqual(7 - 1e-9);
        expect(g.t0).toBeLessThan(8);
      }
      expect(trace.moments.find((m) => m.id === 'c')!.t).toBe(7);
      expect(span(s, 'c').end).toBeCloseTo(10, 9);
      expect(span(s, 'c').start).toBe(Math.min(...ms.map((g) => g.t0)));
      // The same chord without land lands where it would, so the notes are the same.
      const q = piece({
        seed,
        start: START,
        glide: { length: 2, jitter: 0.3, stagger: 1 },
        moments: [chord(10, { land: false })],
      });
      expect(chordAt(s, 20)).toEqual(chordAt(compile(q), 20));
    }
  });

  it('a lone voice glides length + stagger', () => {
    const s = compile(
      piece({
        start: [60],
        glide: { length: 2, jitter: 0.5, stagger: 1 },
        moments: [{ type: 'pin', at: 10, voice: 'v1', pitch: 65, glide: { land: true } }],
      }),
    );
    const [g] = moves(s, 'm0');
    expect(g.t0).toBe(7);
    expect(g.t1).toBeCloseTo(10, 9);
  });
});

describe('land: spread', () => {
  it('the earliest starts at at − length − stagger, the last arrives about at', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const glide = { length: 2, jitter: 0.2, stagger: 1.2, arrive: 'spread' as const };
      const s = compile(piece({ seed, start: START, glide, moments: [chord(10)] }));
      const ms = moves(s, 'c');
      const n = new Set(s.voices.filter((v) => v.segments.some((g) => ms.includes(g)))).size;
      const t0 = Math.min(...ms.map((g) => g.t0));
      const t1 = Math.max(...ms.map((g) => g.t1));
      expect(t0).toBeGreaterThanOrEqual(10 - 3.2 - 1e-9);
      // Rank 0 starts in the first stratum unless the crossing rule gave it a later timing.
      expect(t0).toBeLessThan(10 - 3.2 + 1.2);
      // Last start within the stagger's last stratum, ± jitter on its length.
      expect(t1).toBeGreaterThan(10 - 1.2 / n - 0.4 - 1e-9);
      expect(t1).toBeLessThan(10 + 0.4 + 1e-9);
    }
  });
});

describe('land: the clamp at 0', () => {
  it('a lead-in before 0 starts at 0 and shrinks, still arriving at `at`', () => {
    const glide = { length: 2, jitter: 0.3, stagger: 1 };
    const s = compile(piece({ start: START, glide, moments: [chord(1.5)] }));
    const ms = moves(s, 'c');
    expect(ms.length).toBeGreaterThan(1);
    for (const g of ms) {
      expect(g.t0).toBeGreaterThanOrEqual(0);
      expect(g.t0).toBeLessThan(0.5); // the stagger, halved
      expect(g.t1).toBeCloseTo(1.5, 9);
    }
    const l = landing(1.5, sanitizeGlide(glide, defaultGlide()));
    expect(l.start).toBe(0);
    expect(l.glide.length).toBeCloseTo(1, 12);
    expect(l.glide.stagger).toBeCloseTo(0.5, 12);
  });

  it('decisionTime: at for unlanded, key, level and walk moments', () => {
    const d = sanitizeGlide({ length: 2, stagger: 1 }, defaultGlide());
    const m = (x: object) => ({ id: 'x', at: 10, ...x }) as Moment;
    expect(decisionTime(m({ type: 'chord', glide: { land: true } }), d)).toBe(7);
    expect(decisionTime(m({ type: 'chord', glide: { land: true, length: 5 } }), d)).toBe(4);
    expect(decisionTime(m({ type: 'chord' }), d)).toBe(10);
    expect(decisionTime(m({ type: 'level', glide: { land: true } }), d)).toBe(10);
    expect(decisionTime(m({ type: 'key', glide: { land: true } }), d)).toBe(10);
    expect(decisionTime(m({ type: 'chord' }), { ...d, land: true })).toBe(7);
    expect(decisionTime(m({ type: 'chord', glide: { land: false } }), { ...d, land: true })).toBe(
      10,
    );
  });
});

describe('land: overlapping moments', () => {
  const glide = { length: 2, jitter: 0, stagger: 0 };
  const end = { at: 30, fade: 1 };
  const shift = (at: number, by: number, land: boolean, id: string): MomentInput => ({
    id,
    type: 'shift',
    at,
    by,
    unit: 'semitones',
    glide: { land, length: land ? 3 : 2 },
  });

  it('decides on the destinations of an earlier moment still moving at its lead-in', () => {
    // a moves 60 → 65 over 6–8; b (land at 10, lead 3) decides at 7 and interrupts it.
    const s = compile(
      piece({
        start: [60],
        glide,
        end,
        moments: [shift(6, 5, false, 'a'), shift(10, 2, true, 'b')],
      }),
    );
    const v = s.voices[0];
    expect(pitchAt(v, 20)).toBe(67);
    const b = v.segments.find((g) => g.momentId === 'b')!;
    expect(b.t0).toBe(7);
    expect(b.t1).toBeCloseTo(10, 9);
    // The join is C¹: no jump at 7.
    expect(pitchAt(v, 7 + 1e-7)!).toBeCloseTo(pitchAt(v, 7 - 1e-7)!, 4);
  });

  it('a moment whose marker falls inside the lead-in acts after it and interrupts it', () => {
    // b decides at 7, a at 8: a reads b's destination and wins the voice from 8 on.
    const s = compile(
      piece({
        start: [60],
        glide,
        end,
        moments: [shift(10, 2, true, 'b'), shift(8, 5, false, 'a')],
      }),
    );
    const v = s.voices[0];
    expect(pitchAt(v, 20)).toBe(67);
    expect(v.segments.find((g) => g.momentId === 'a')!.t0).toBe(8);
    expect(s.diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
  });
});

describe('land: key and silence', () => {
  it('reads the key in effect at its `at`, not at its lead-in', () => {
    const key: MomentInput = { id: 'k', type: 'key', at: 10, key: { tonic: 'D', scale: 'major' } };
    const deg = (land: boolean): MomentInput =>
      ({
        id: 'c',
        type: 'chord',
        at: 10,
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'close',
        assign: 'ordered',
        glide: { land },
      }) as MomentInput;
    const glide = { length: 2, jitter: 0, stagger: 1 };
    const end = { at: 30, fade: 1 };
    const landed = compile(piece({ start: START, glide, end, moments: [key, deg(true)] }));
    const plain = compile(piece({ start: START, glide, end, moments: [key, deg(false)] }));
    expect(chordAt(landed, 20)).toEqual(chordAt(plain, 20));
    expect(new Set(chordAt(landed, 20).map((p) => p % 12))).toEqual(new Set([2, 6, 9]));
    expect(landed.harmony?.at(-1)?.label).toBe(plain.harmony?.at(-1)?.label);
  });

  it('from silence it waits for its marker: an establishing chord comes in on the beat', () => {
    const s = compile(piece({ start: [], glide: { length: 2, stagger: 1 }, moments: [chord(5)] }));
    const born = s.voices.flatMap((v) => v.lives.map((l) => l.born));
    expect(born.length).toBeGreaterThan(1);
    for (const b of born) expect(b).toBe(5);
    expect(s.diagnostics.map((d) => d.code)).not.toContain('no-effect');
  });
});

describe('land: no-effect, effect checks and freezing read the decision time', () => {
  // A chord at 9 (non-land) moves 60 → 64 by 9.5. A land unison on 64 at 10 (lead 2) would
  // decide at 8; the chord decides inside its lead-in with an earlier marker, so it waits for it
  // (build log "Land always arrives") and finds the line on 64: no effect, landed or not.
  const base = (): Piece =>
    piece({
      start: [60],
      glide: { length: 0.5, jitter: 0, stagger: 0 },
      moments: [
        {
          id: 'c',
          type: 'chord',
          at: 9,
          notes: { kind: 'pitches', pitches: [64] },
          voicing: 'even',
          assign: 'ordered',
        },
      ],
    });
  const unison = (land: boolean, at = 10): Moment =>
    ({
      id: 'u',
      type: 'unison',
      at,
      pitch: 64,
      octaves: false,
      glide: { land, length: 2 },
    }) as Moment;

  it('momentEffectAt and the compiler agree', () => {
    const p = base();
    const s = compile(p);
    // At 10 or 10.5 the landed unison waits for the chord (no effect, as unlanded); at 8.75 the
    // chord's marker is later, so the unison decides first and moves the line.
    for (const at of [10, 10.5, 8.75])
      for (const land of [true, false]) {
        const u = unison(land, at);
        const q = { ...p, moments: [...p.moments, u] };
        const noEffect = compile(q).diagnostics.some(
          (d) => d.code === 'no-effect' && d.momentId === 'u',
        );
        expect(momentEffectAt(p, s, u).effect, `${at} ${land}`).toBe(!noEffect);
        expect(noEffect, `${at} ${land}`).toBe(at > 9);
      }
  });

  it('freezeChord sees a land chord where it decides', () => {
    const p = piece({
      start: START,
      glide: { length: 2, jitter: 0, stagger: 1 },
      moments: [
        chord(10),
        // A later marker, decided at 8.5, after the chord (7): it must not shape the frozen chord.
        { id: 'x', type: 'shift', at: 10.5, by: 7, unit: 'semitones', glide: { land: true } },
      ],
    });
    const f = freezeChord(p, compile(p), 'c')!;
    const alone = piece({
      start: START,
      glide: { length: 2, jitter: 0, stagger: 1 },
      moments: [chord(10)],
    });
    expect(f.notes).toEqual(freezeChord(alone, compile(alone), 'c')!.notes);
  });

  it('freezeChord of a land chord that waits keeps what the compiler gives it', () => {
    // x (at 8.5) decides inside the chord's lead-in (7–10): the chord waits for it.
    const p = piece({
      start: START,
      glide: { length: 2, jitter: 0, stagger: 1 },
      moments: [chord(10), { id: 'x', type: 'shift', at: 8.5, by: 7, unit: 'semitones' }],
    });
    (p.moments[1] as { voicing: string }).voicing = 'nearest';
    const s = compile(p);
    const f = freezeChord(p, s, 'c')!;
    expect([...(f.notes as { pitches: number[] }).pitches].sort((a, b) => a - b)).toEqual(
      chordAt(s, 12),
    );
  });
});

describe('land: incremental compile equals a full compile', () => {
  it('edits that move a lead-in, toggle land or change a key it reads', () => {
    const p = piece({
      start: START,
      glide: { length: 2, jitter: 0.3, stagger: 1 },
      moments: [
        { id: 'a', type: 'shift', at: 3, by: 2, unit: 'semitones' },
        chord(12, {}, 'c1'),
        { id: 'b', type: 'spread', at: 14, factor: 1.4, around: 'mean', snap: 'scale' },
        { id: 'k', type: 'key', at: 18, key: { tonic: 'F', scale: 'dorian' } },
        {
          id: 'd',
          type: 'chord',
          at: 20,
          notes: { kind: 'degrees', degrees: [0, 2, 4, 6] },
          voicing: 'even',
          assign: 'ordered',
          glide: { land: true, length: 4 },
        },
        { id: 'e', type: 'shift', at: 30, by: -3, unit: 'semitones' },
      ],
    });
    const inc = createIncrementalCompiler();
    const edits: ((q: Piece) => void)[] = [
      (q) => (q.moments[2].at = 11),
      (q) => (q.moments[1].glide = { land: false }),
      (q) => (q.moments[1].glide = { land: true, length: 6 }),
      (q) => ((q.moments[4] as { key: Piece['key'] }).key = { tonic: 'G', scale: 'major' }),
      (q) => (q.moments[4].at = 17.5),
      (q) => (q.moments[6].glide = { land: true, length: 15 }),
      (q) => (q.moments[5].glide = { land: true, length: 25, stagger: 2 }),
    ];
    let q = p;
    expect(inc.compile(q)).toEqual(compile(q));
    for (const edit of edits) {
      q = structuredClone(q);
      edit(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });
});

describe('land: schema', () => {
  it('round-trips land on defaults and moments; absent stays absent', () => {
    const p = piece({ start: START, moments: [chord(10)] });
    p.defaults.glide.land = true;
    const r = parsePiece(JSON.parse(serializePiece(p)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.piece.defaults.glide.land).toBe(true);
    expect(r.piece.moments[1].glide?.land).toBe(true);
    const plain = parsePiece(JSON.parse(serializePiece(piece({ start: START }))));
    expect(plain.ok && 'land' in plain.piece.defaults.glide).toBe(false);
  });
});

describe('split and merge honour stagger and order (revision 9)', () => {
  const ORDERS: GlideOrder[] = ['random', 'low-first', 'high-first', 'center-out', 'outside-in'];
  /** Rank of each of four voices (sorted low to high) by order (glide.ts drawTimings). */
  const RANKS: Record<Exclude<GlideOrder, 'random'>, number[]> = {
    'low-first': [0, 1, 2, 3],
    'high-first': [3, 2, 1, 0],
    'center-out': [2, 0, 1, 3],
    'outside-in': [0, 2, 3, 1],
  };
  const T = 2;
  const STAGGER = 2;
  const ranksOf = (starts: number[]) => starts.map((t) => Math.floor(((t - T) * 4) / STAGGER));

  it.each(ORDERS)('split, order %s: newborns start by their rank', (order) => {
    // Each newborn forks from the line 2 below its target (siblings of one parent forking in
    // order on one side would start out of order with each other: the crossing rule then times
    // them together).
    for (const seed of [1, 2, 3]) {
      const s = compile(
        piece({
          seed,
          pool: 8,
          start: [50, 60, 70, 80],
          glide: { length: 2, jitter: 0, stagger: STAGGER, order, arrive: 'spread' },
          end: { at: 20, fade: 1 },
          moments: [
            {
              type: 'split',
              at: T,
              count: 8,
              notes: { kind: 'pitches', pitches: [50, 52, 60, 62, 70, 72, 80, 82] },
              voicing: 'even',
            },
          ],
        }),
      );
      // The newborns, low to high by target.
      const born = s.voices
        .filter((v) => v.lives.length > 0 && v.lives[0].born > 0)
        .map((v) => ({ t: v.lives[0].born, to: pitchAt(v, 19)!, p0: v.segments[0].p0 }))
        .sort((a, b) => a.to - b.to);
      expect(born.map((b) => b.to)).toEqual([52, 62, 72, 82]);
      for (const b of born) expect(b.p0).toBe(b.to - 2);
      const ranks = ranksOf(born.map((b) => b.t));
      if (order === 'random') expect([...ranks].sort()).toEqual([0, 1, 2, 3]);
      else expect(ranks, `seed ${seed}`).toEqual(RANKS[order]);
    }
  });

  it.each(ORDERS)('merge, order %s: dying lines start by their rank', (order) => {
    for (const seed of [1, 2, 3]) {
      const s = compile(
        piece({
          seed,
          pool: 8,
          start: [48, 50, 58, 60, 68, 70, 78, 80],
          glide: { length: 2, jitter: 0, stagger: STAGGER, order, arrive: 'spread' },
          end: { at: 20, fade: 1 },
          moments: [
            {
              type: 'merge',
              at: T,
              count: 4,
              which: 'top',
              fade: 0.5,
              target: { voices: ['v1', 'v3', 'v5', 'v7'] },
            },
          ],
        }),
      );
      const starts = ['v1', 'v3', 'v5', 'v7'].map((id) => {
        const v = s.voices.find((x) => x.id === id)!;
        const g = v.segments.find((x) => x.momentId === 'm0' && x.p0 !== x.p1)!;
        expect(g.p1).toBe(g.p0 + 2); // into its neighbour above
        expect(v.lives[0].died).toBeDefined();
        return g.t0;
      });
      const ranks = ranksOf(starts);
      if (order === 'random') expect([...ranks].sort()).toEqual([0, 1, 2, 3]);
      else expect(ranks, `seed ${seed}`).toEqual(RANKS[order]);
    }
  });

  it('land applies to births and deaths too', () => {
    for (const type of ['split', 'merge'] as const) {
      const m: MomentInput =
        type === 'split'
          ? {
              type,
              at: 10,
              count: 5,
              notes: { kind: 'pitches', pitches: [52, 56, 60, 64, 68] },
              voicing: 'even',
              glide: { land: true },
            }
          : { type, at: 10, count: 2, which: 'top', fade: 0.5, glide: { land: true } };
      const s = compile(
        piece({
          pool: 8,
          start: type === 'split' ? [60] : [48, 55, 60, 64, 67],
          glide: { length: 2, jitter: 0.2, stagger: 1 },
          end: { at: 30, fade: 1 },
          moments: [m],
        }),
      );
      const ms = moves(s, 'm0');
      expect(ms.length).toBeGreaterThan(1);
      for (const g of ms) {
        expect(g.t0).toBeGreaterThanOrEqual(7 - 1e-9);
        expect(g.t1).toBeCloseTo(10, 9);
      }
    }
  });
});
