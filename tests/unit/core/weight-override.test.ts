/** Per-note weight overrides (revision 8 "Distinct notes": weight editable per note; M4.5-29b). */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { weightAt, weightTargetAt } from '../../../src/core/query';
import type { Moment, Piece, VoiceOverride } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const chord = (overrides?: VoiceOverride[], order?: boolean): MomentInput =>
  ({
    id: 'c',
    type: 'chord',
    at: 1,
    // Unsorted targets on purpose: the ordered chord sorts them; a weight must not unsort them.
    notes: { kind: 'pitches', pitches: [67, 48, 64, 60] },
    voicing: 'even',
    assign: order === false ? 'free' : 'ordered',
    ...(overrides ? { overrides } : {}),
  }) as MomentInput;

const base = (overrides?: VoiceOverride[], extra: MomentInput[] = []): Piece =>
  piece({
    start: [50, 57, 62, 69],
    glide: { length: 2, jitter: 0, stagger: 0 },
    moments: [chord(overrides), ...extra],
  });

describe('weight overrides', () => {
  it('a weight alone changes no path, only that line’s weight', () => {
    const s0 = compile(base());
    const s = compile(base([{ voice: 2, weight: 3 }]));
    for (let v = 0; v < 4; v++) expect(s.voices[v].segments).toStrictEqual(s0.voices[v].segments);
    expect(weightTargetAt(s.voices[2], 5)).toBe(3);
    for (const v of [0, 1, 3]) expect(weightAt(s.voices[v], 5)).toBe(1);
    expect(s.diagnostics).toStrictEqual(s0.diagnostics);
  });

  it('ramps over the glide length from the moment', () => {
    const s = compile(base([{ voice: 0, weight: 5 }]));
    const v = s.voices[0];
    expect(weightAt(v, 0.99)).toBe(1);
    expect(weightAt(v, 2)).toBeCloseTo(3, 9); // halfway through the 2 s glide
    expect(weightAt(v, 3)).toBe(5);
    expect(weightAt(v, 10)).toBe(5);
  });

  it('a pitch override with a weight still edits the path', () => {
    const s = compile(base([{ voice: 1, pitch: 61, weight: 2 }]));
    const segs = s.voices[1].segments.filter((x) => x.momentId === 'c' && x.p0 !== x.p1);
    expect(segs[segs.length - 1].p1).toBe(61);
    expect(weightTargetAt(s.voices[1], 5)).toBe(2);
  });

  it('carries into a later merge: the survivor gets the summed weight', () => {
    const p = base(
      [{ voice: 3, weight: 3 }],
      [{ id: 'u', type: 'unison', at: 6, pitch: 60, glide: { length: 1 } } as MomentInput],
    );
    const s = compile(p);
    const total = s.voices.reduce((a, v) => a + weightTargetAt(v, 9), 0);
    // Lines 0..2 (1 each) and line 3 (3) merge into one note of weight 6, the others fading out.
    const max = Math.max(...s.voices.map((v) => weightTargetAt(v, 9)));
    expect(max).toBeCloseTo(6, 9);
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it('incremental compile matches a full compile after editing a weight', () => {
    const ic = createIncrementalCompiler();
    const p0 = base(undefined, [
      { type: 'split', at: 6, count: 2, voicing: 'even' } as MomentInput,
    ]);
    ic.compile(p0);
    for (const w of [2, 0.5, 7]) {
      const moments: Moment[] = p0.moments.map((m) =>
        m.id === 'c' ? { ...m, overrides: [{ voice: 1, weight: w }] } : m,
      );
      const p1 = { ...p0, moments };
      expect(ic.compile(p1).voices).toStrictEqual(compile(p1).voices);
    }
  });
});
