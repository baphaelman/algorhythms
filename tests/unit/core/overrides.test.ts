/**
 * Per-voice overrides of a point moment (PLAN.md §11.3 "Every dot is draggable", revision 6).
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { CompiledScore, Moment, Piece, VoiceOverride } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const chord = (overrides?: VoiceOverride[]): MomentInput =>
  ({
    id: 'c',
    type: 'chord',
    at: 1,
    notes: { kind: 'pitches', pitches: [48, 60, 64, 67] },
    voicing: 'even',
    assign: 'ordered',
    ...(overrides ? { overrides } : {}),
  }) as MomentInput;

const base = (overrides?: VoiceOverride[], extra: MomentInput[] = []): Piece =>
  piece({
    start: [50, 57, 62, 69],
    glide: { length: 2, jitter: 0.3, stagger: 0.6 },
    moments: [chord(overrides), ...extra],
  });

/** End of voice v's last segment of moment `id`, and its pitch there. */
const arrival = (s: CompiledScore, v: number, id = 'c') => {
  const segs = s.voices[v].segments.filter((x) => x.momentId === id && x.p0 !== x.p1);
  const last = segs[segs.length - 1];
  return { t: last.t1, p: last.p1 };
};

describe('overrides', () => {
  it('pitch replaces that voice’s target; others unchanged', () => {
    const s0 = compile(base());
    const a0 = arrival(s0, 1);
    const s = compile(base([{ voice: 1, pitch: 61 }]));
    expect(arrival(s, 1).p).toBe(61);
    for (const v of [0, 2, 3]) expect(arrival(s, v).p).toBe(arrival(s0, v).p);
    expect(a0.p).not.toBe(61);
  });

  it('end sets that voice’s arrival (at + end); others keep their timing', () => {
    const s0 = compile(base());
    const s = compile(base([{ voice: 2, end: 4.5 }]));
    expect(arrival(s, 2).t).toBeCloseTo(1 + 4.5, 9);
    expect(pitchAt(s.voices[2], 5.5)).toBe(arrival(s0, 2).p);
    for (const v of [0, 1, 3]) expect(arrival(s, v).t).toBeCloseTo(arrival(s0, v).t, 9);
  });

  it('an end earlier than the start pulls the start in (≥ at), never below MIN_GLIDE', () => {
    const s = compile(base([{ voice: 3, end: 0 }]));
    const segs = s.voices[3].segments.filter((x) => x.momentId === 'c' && x.p0 !== x.p1);
    expect(segs[0].t0).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(arrival(s, 3).t).toBeCloseTo(1.01, 9);
  });

  it('pitch and end together; a later entry for the same voice wins per field', () => {
    const s = compile(
      base([
        { voice: 0, pitch: 45, end: 1 },
        { voice: 0, end: 3 },
      ]),
    );
    expect(arrival(s, 0)).toEqual({ t: expect.closeTo(4, 9) as number, p: 45 });
  });

  it('bad entries are ignored; key/level/walk moments ignore overrides', () => {
    const s0 = compile(base());
    const s = compile(base([{ voice: 99, pitch: 70 }, { voice: 1 }]));
    expect(s.voices).toStrictEqual(s0.voices);
    const lvl: MomentInput = { type: 'level', at: 2, gain: 0.5, over: 1 } as MomentInput;
    const withLvl = compile(base(undefined, [lvl]));
    const withLvlOv = compile(
      base(undefined, [{ ...lvl, overrides: [{ voice: 0, pitch: 80 }] } as MomentInput]),
    );
    expect(withLvlOv.voices).toStrictEqual(withLvl.voices);
  });

  it('round-trips through the file format', () => {
    const p = base([{ voice: 1, pitch: 61.5, end: 2.25 }]);
    const r = parsePiece(JSON.parse(serializePiece(p)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.piece.moments[1].overrides).toEqual([{ voice: 1, pitch: 61.5, end: 2.25 }]);
    const bad = { ...p, moments: [p.moments[0], { ...p.moments[1], overrides: [{ voice: -1 }] }] };
    expect(parsePiece(bad).ok).toBe(false);
  });

  it('incremental compile matches a full compile after editing an override', () => {
    const ic = createIncrementalCompiler();
    const p0 = base(undefined, [
      { type: 'split', at: 6, count: 2, voicing: 'even' } as MomentInput,
    ]);
    ic.compile(p0);
    const moments: Moment[] = p0.moments.map((m) =>
      m.id === 'm1' ? { ...m, overrides: [{ voice: 0, pitch: 52, end: 1.5 }] } : m,
    );
    const p1 = { ...p0, moments };
    expect(ic.compile(p1).voices).toStrictEqual(compile(p1).voices);
  });
});
