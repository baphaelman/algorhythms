/**
 * PLAN §6.2 `pulse`, revision 10: mode 'order' (one voice per step, following a typed order,
 * cycling, wrapping past the voice count), rests, voices joining and leaving, schema, incremental.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { nextPulseOrder } from '../../../src/core/pulse';
import { pitchAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, Piece, PulseMoment } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const START = [48, 55, 60, 64];

function pulse(fields: Partial<PulseMoment> = {}): MomentInput {
  return {
    type: 'pulse',
    at: 2,
    until: 6,
    step: 0.5,
    pattern: [1],
    decay: 0.3,
    floor: 0.2,
    mode: 'order',
    order: [1, 3, 2, 4],
    ...fields,
  } as MomentInput;
}

const make = (moments: MomentInput[], start = START): Piece =>
  piece({ pool: 8, start, glide: GLIDE, end: { at: 12, fade: 1 }, moments });

function hitVoices(s: CompiledScore): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  s.voices.forEach((cv, v) => {
    for (const r of cv.pulse ?? []) if (r.hit) out.push({ t: r.t, v });
  });
  return out.sort((a, b) => a.t - b.t);
}
const seq = (s: CompiledScore): number[] => hitVoices(s).map((h) => h.v);

describe('nextPulseOrder', () => {
  it('cycles the order and wraps entries past the count', () => {
    let w = { index: -1, dir: 1 };
    const out: number[] = [];
    for (let k = 0; k < 6; k++) {
      const r = nextPulseOrder([1, 5, 3], 4, w);
      w = r.walk;
      out.push(r.voice);
    }
    // 5 wraps to (5 − 1) mod 4 = 0.
    expect(out).toEqual([0, 0, 2, 0, 0, 2]);
    expect(nextPulseOrder([2], 1, { index: -1, dir: 1 }).voice).toBe(0);
  });
});

describe('pulse mode order', () => {
  it('hits one voice per step, in the typed order, cycling', () => {
    expect(seq(compile(make([pulse()])))).toEqual([0, 2, 1, 3, 0, 2, 1, 3]);
    // Pitch order, not pool order: the voices start reversed in the pool.
    const s = compile(make([pulse({ order: [1, 2] })], [64, 60, 55, 48]));
    expect(seq(s)).toEqual([3, 2, 3, 2, 3, 2, 3, 2]);
  });

  it('an index past the voice count wraps modulo the count', () => {
    expect(seq(compile(make([pulse({ order: [5, 6, 8, 4] })])))).toEqual([0, 1, 3, 3, 0, 1, 3, 3]);
  });

  it('a rest hits nothing and does not advance the order (as up)', () => {
    const s = compile(make([pulse({ pattern: [1, 0] })]));
    const hv = hitVoices(s);
    expect(hv.map((h) => h.t)).toEqual([2, 3, 4, 5]);
    expect(hv.map((h) => h.v)).toEqual([0, 2, 1, 3]);
  });

  it('with order 1 2 3 4 matches up exactly', () => {
    const order = compile(make([pulse({ order: [1, 2, 3, 4], pattern: [1, 0, 0.5] })]));
    const up = compile(make([pulse({ mode: 'up', order: undefined, pattern: [1, 0, 0.5] })]));
    expect(order.voices.map((v) => v.pulse)).toEqual(up.voices.map((v) => v.pulse));
  });

  it('keeps its place in the order when voices join or leave', () => {
    // Four voices until the merge at 3.1 leaves two (the top two fade out).
    const s = compile(
      make([pulse({ until: 6 }), { type: 'merge', at: 3.1, count: 2, which: 'top', fade: 1 }]),
    );
    const hv = hitVoices(s);
    // Steps 2, 2.5, 3 walk four voices (1 3 2); from 3.5 two remain: entries 4 1 3 2 4 1 →
    // voices (e − 1) mod 2 = 1 0 0 1 1 0, pool 1 0 0 1 1 0.
    expect(hv.filter((h) => h.t <= 3).map((h) => h.v)).toEqual([0, 2, 1]);
    expect(hv.filter((h) => h.t > 3.2).map((h) => h.v)).toEqual([1, 0, 0, 1, 1]);
  });

  it('a step with one sounding voice hits it without advancing (as up)', () => {
    // Only v1 sounds until a split at 3.2 brings four lines.
    const s = compile(
      make([pulse({ until: 6 }), { type: 'split', at: 3.2, count: 4, voicing: 'even' }], [48]),
    );
    const hv = hitVoices(s);
    expect(hv.filter((h) => h.t <= 3).map((h) => h.v)).toEqual([0, 0, 0]);
    // The first step with several voices takes the order's first entry (1 3 2 4 1, in pitch
    // order at each step: the split's lines are still gliding).
    const late = hv.filter((h) => h.t > 3.2);
    expect(late.map((h) => h.t)).toEqual([3.5, 4, 4.5, 5, 5.5]);
    const rank = late.map((h) =>
      [0, 1, 2, 3]
        .sort((a, b) => pitchAt(s.voices[a], h.t)! - pitchAt(s.voices[b], h.t)! || a - b)
        .indexOf(h.v),
    );
    expect(rank).toEqual([0, 2, 1, 3, 0]);
  });

  it('reports a missing or bad order as pulse-invalid', () => {
    const codes = (m: MomentInput): string[] =>
      compile(make([m]))
        .diagnostics.filter((d) => d.momentId === 'm0')
        .map((d) => d.code);
    expect(codes(pulse({ order: undefined }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ order: [] }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ order: [0, 1] }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ order: [1.5] }))).toEqual(['pulse-invalid']);
    expect(codes(pulse())).toEqual([]);
    // Another mode ignores a leftover order.
    expect(codes(pulse({ mode: 'up', order: [0] }))).toEqual([]);
  });

  it('the schema accepts order and checks it', () => {
    const base = make([]);
    const raw = (m: object): unknown => ({
      ...base,
      moments: [...base.moments, { id: 'p1', type: 'pulse', at: 1, until: 3, ...m }],
    });
    const ok = parsePiece(raw({ mode: 'order', order: [1, 3, 2, 4] }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.piece.moments[1]).toMatchObject({ mode: 'order', order: [1, 3, 2, 4] });
    expect(parsePiece(raw({ mode: 'order' })).ok).toBe(false);
    expect(parsePiece(raw({ mode: 'order', order: [] })).ok).toBe(false);
    expect(parsePiece(raw({ mode: 'order', order: [0] })).ok).toBe(false);
    expect(parsePiece(raw({ mode: 'order', order: [1.5] })).ok).toBe(false);
  });

  it('incremental equals full across order edits', () => {
    const p = make([
      pulse({ until: 10, step: 0.25 }),
      { type: 'split', at: 5, count: 6, voicing: 'even' },
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const edits: ((q: Piece) => void)[] = [
      (q) => ((q.moments[1] as PulseMoment).order = [4, 3, 2, 1, 7]),
      (q) => ((q.moments[1] as PulseMoment).pattern = [1, 0, 0.5]),
      (q) => ((q.moments[1] as PulseMoment).mode = 'up'),
      (q) => ((q.moments[1] as PulseMoment).mode = 'order'),
    ];
    let q = p;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });
});
