/** Shift-drag by octaves (PLAN.md §11.3 "Shift-drag moves by octaves"; M4.5-33). Pure. */
import { describe, expect, it } from 'vitest';
import type { ArrivalDot } from '../../../src/app/editor/arrival-points';
import { groupTargets } from '../../../src/app/editor/group-move';
import {
  octaveGuides,
  octaveLabel,
  octaveSnap,
  octaveSpan,
} from '../../../src/app/editor/octave-drag';
import type { Key } from '../../../src/core/types';

const C: Key = { tonic: 'C', scale: 'major' };
const dot = (t: number, pitch: number, voice?: number): ArrivalDot => ({
  momentId: 'm',
  type: 'chord',
  t,
  pitch,
  voice,
});

describe('octaveSnap', () => {
  it('rounds to the nearest whole octave from the start', () => {
    const span = octaveSpan([{ pitch: 60 }]);
    expect(octaveSnap(60, 65.9, span)).toBe(0);
    expect(octaveSnap(60, 66.1, span)).toBe(1);
    expect(octaveSnap(60, 71, span)).toBe(1);
    expect(octaveSnap(60, 49, span)).toBe(-1);
    expect(octaveSnap(60, 35, span)).toBe(-2);
    expect(octaveSnap(60.5, 72.5, span)).toBe(1); // a fractional start keeps its offset
  });

  it('clamps to the line range', () => {
    const span = octaveSpan([{ pitch: 60, range: [48, 79] }]);
    expect(span).toEqual([-1, 1]);
    expect(octaveSnap(60, 100, span)).toBe(1);
    expect(octaveSnap(60, 10, span)).toBe(-1);
    // No range: MIDI 0..127.
    expect(octaveSpan([{ pitch: 60 }])).toEqual([-5, 5]);
    expect(octaveSpan([{ pitch: 120 }])).toEqual([-10, 0]);
  });

  it('several dots share one span, so all move by the same octaves', () => {
    const span = octaveSpan([
      { pitch: 48, range: [36, 84] },
      { pitch: 72, range: [36, 84] },
    ]);
    expect(span).toEqual([-1, 1]);
    expect(octaveSnap(48, 84, span)).toBe(1); // the high dot caps it at +1
  });

  it('a dot already outside its range does not block a move back in or keep others still', () => {
    expect(octaveSpan([{ pitch: 30, range: [36, 84] }])).toEqual([0, 4]);
    expect(octaveSpan([{ pitch: 90, range: [36, 84] }])).toEqual([-4, 0]);
    // A range narrower than an octave: no move.
    expect(octaveSpan([{ pitch: 60, range: [58, 65] }])).toEqual([0, 0]);
  });
});

describe('octaveGuides and octaveLabel', () => {
  it('a guide at each reachable octave of the start', () => {
    expect(octaveGuides(60, [-1, 2])).toEqual([48, 60, 72, 84]);
    expect(octaveGuides(60, [0, 0])).toEqual([60]);
  });

  it('labels with a real minus sign', () => {
    expect(octaveLabel(1)).toBe('+1 oct');
    expect(octaveLabel(-2)).toBe('−2 oct');
    expect(octaveLabel(0)).toBe('0 oct');
  });
});

describe('groupTargets with an octave move', () => {
  it('single dot: exactly 12 semitones, time kept', () => {
    const a = dot(1, 64);
    expect(groupTargets([a], a, 76, 1, () => C, true).map((m) => [m.pitch, m.t])).toEqual([
      [76, 1],
    ]);
  });

  it('multi-dot: every dot by the same octaves, off-scale dots too', () => {
    const a = dot(1, 60, 0);
    const b = dot(1, 64, 1);
    const c = dot(1, 61, 2);
    const span = octaveSpan([a, b, c].map((d) => ({ pitch: d.pitch, range: [36, 96] as const })));
    const k = octaveSnap(a.pitch, 85, span);
    expect(k).toBe(2);
    const out = groupTargets([a, b, c], a, a.pitch + 12 * k, 1, () => C, true);
    expect(out.map((m) => m.pitch)).toEqual([84, 88, 85]);
  });
});
