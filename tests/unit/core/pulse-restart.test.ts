/**
 * PLAN §6.4, revision 14 (M10b-2): `PulseMoment.restart` restarts the step counter (pattern and
 * voice walk) every `restart` s from `at`.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { pulseCycleSteps, pulseStepTime } from '../../../src/core/pulse';
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
    mode: 'updown',
    ...fields,
  } as MomentInput;
}

const make = (moments: MomentInput[], start = START): Piece =>
  piece({ pool: 8, start, glide: GLIDE, end: { at: 12, fade: 1 }, moments });

function hits(s: CompiledScore): { t: number; v: number; a: number }[] {
  const out: { t: number; v: number; a: number }[] = [];
  s.voices.forEach((cv, v) => {
    for (const r of cv.pulse ?? []) if (r.hit) out.push({ t: r.t, v, a: r.accent });
  });
  return out.sort((x, y) => x.t - y.t);
}

describe('pulse restart', () => {
  it('step times and cycle length', () => {
    expect(pulseCycleSteps(0.5, undefined)).toBe(0);
    expect(pulseCycleSteps(0.5, 2)).toBe(4);
    expect(pulseCycleSteps(0.5, 1.2)).toBe(3);
    expect(pulseCycleSteps(0.5, 0.2)).toBe(1);
    expect([0, 1, 2, 3, 4].map((k) => pulseStepTime(2, 0.5, 1.2, 3, k))).toEqual([
      2, 2.5, 3, 3.2, 3.7,
    ]);
  });

  it('absent: unchanged; set: the updown walk starts over each cycle', () => {
    expect(hits(compile(make([pulse()]))).map((h) => h.v)).toEqual([0, 1, 2, 3, 2, 1, 0, 1]);
    const s = compile(make([pulse({ restart: 2 })]));
    expect(hits(s).map((h) => h.v)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(hits(s).map((h) => h.t)).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
  });

  it('restarts the pattern and the grid when restart is not a whole number of steps', () => {
    const s = compile(make([pulse({ restart: 1.2, pattern: [1, 0.5], mode: 'up' })]));
    const h = hits(s);
    expect(h.map((x) => +x.t.toFixed(6))).toEqual([2, 2.5, 3, 3.2, 3.7, 4.2, 4.4, 4.9, 5.4, 5.6]);
    expect(h.map((x) => x.a)).toEqual([1, 0.5, 1, 1, 0.5, 1, 1, 0.5, 1, 1]);
    expect(h.map((x) => x.v)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
  });

  it('restarts mode order the same way', () => {
    const s = compile(make([pulse({ mode: 'order', order: [1, 3, 2, 4], restart: 1 })]));
    expect(hits(s).map((h) => h.v)).toEqual([0, 2, 0, 2, 0, 2, 0, 2]);
  });

  it('the same arpeggio for any number of lines: each bar starts on the lowest', () => {
    for (const start of [[48, 55], [48, 55, 60], START, [48, 52, 55, 60, 64]]) {
      const s = compile(make([pulse({ restart: 2 })], start));
      const firsts = hits(s).filter((h) => h.t === 2 || h.t === 4);
      expect(firsts.map((h) => h.v)).toEqual([0, 0]);
    }
  });

  it('a bad restart is pulse-invalid; the schema checks it', () => {
    const codes = (m: MomentInput): string[] =>
      compile(make([m]))
        .diagnostics.filter((d) => d.momentId === 'm0')
        .map((d) => d.code);
    expect(codes(pulse({ restart: 0 }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ restart: NaN }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ restart: 2 }))).toEqual([]);
    const base = make([]);
    const raw = (m: object): unknown => ({
      ...base,
      moments: [...base.moments, { id: 'p1', type: 'pulse', at: 1, until: 3, ...m }],
    });
    const ok = parsePiece(raw({ restart: 2 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.piece.moments[1]).toMatchObject({ restart: 2 });
    expect(parsePiece(raw({ restart: 0 })).ok).toBe(false);
  });

  it('incremental equals full across restart edits', () => {
    const p = make([
      pulse({ until: 10, step: 0.25, restart: 1 }),
      { type: 'split', at: 5, count: 6, voicing: 'even' },
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const edits: ((q: Piece) => void)[] = [
      (q) => ((q.moments[1] as PulseMoment).restart = 0.6),
      (q) => delete (q.moments[1] as PulseMoment).restart,
      (q) => ((q.moments[1] as PulseMoment).restart = 2),
    ];
    let q = p;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });
});
