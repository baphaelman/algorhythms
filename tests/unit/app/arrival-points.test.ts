/** Arrival points (PLAN.md §11.3 "Every dot is draggable", revision 6). */
import { describe, expect, it } from 'vitest';
import {
  allArrivals,
  dotAction,
  hoverPick,
  momentArrivals,
  nearestIndex,
  segmentArrivals,
  type ArrivalDot,
  type DotMapping,
} from '../../../src/app/editor/arrival-points';
import { compile } from '../../../src/core/compiler/compile';
import type { ChordMoment, Key, Moment, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from '../core/compiler-fixtures';

const C_MAJOR: Key = { tonic: 'C', scale: 'major' };
const GLIDE = { length: 2, jitter: 0, stagger: 0 };

const shift: MomentInput = { id: 'sh', type: 'shift', at: 1, by: 2, unit: 'semitones' };
const chord: MomentInput = {
  id: 'c',
  type: 'chord',
  at: 5,
  notes: { kind: 'pitches', pitches: [50, 57, 60, 65] },
  voicing: 'even',
  assign: 'ordered',
};
const walk: MomentInput = {
  id: 'w',
  type: 'walk',
  at: 10,
  until: 16,
  grid: 1,
  density: 1,
  steps: [-1, 1],
  stepGlide: 0.25,
};
const note: MomentInput = { id: 'n', type: 'note', at: 8, from: 60, to: 62 };
const split: MomentInput = { id: 'sp', type: 'split', at: 25, count: 6, voicing: 'even' };

const make = (moments: MomentInput[]): Piece =>
  piece({ start: [48, 55, 60, 64], key: C_MAJOR, glide: GLIDE, end: { at: 40, fade: 1 }, moments });
const byId = (p: Piece, id: string): Moment => p.moments.find((m) => m.id === id)!;

describe('arrival points', () => {
  it('lands each moving voice at the end of its glide', () => {
    const s = compile(make([shift]));
    expect(segmentArrivals(s, 'sh')).toEqual([
      { t: 3, p: 50, v: 0 },
      { t: 3, p: 57, v: 1 },
      { t: 3, p: 62, v: 2 },
      { t: 3, p: 66, v: 3 },
    ]);
  });

  it('gives one dot per moment type', () => {
    const p = make([shift, chord, walk, note, split]);
    const s = compile(p);
    // A chord with its note list: every note at the span end, even voices that hold.
    const c = momentArrivals(s, byId(p, 'c'), [50, 57, 60, 65]);
    expect(c.map((d) => d.pitch)).toEqual([50, 57, 60, 65]);
    const end = s.momentSpans.find((x) => x.id === 'c')!.end;
    expect(c.every((d) => d.t === end && d.type === 'chord')).toBe(true);
    // Without the list: only the voices that move (50 and 57 hold after the shift).
    expect(momentArrivals(s, byId(p, 'c')).map((d) => d.pitch)).toEqual([60, 65]);
    // A walk: its steps, where each step's glide arrives.
    const w = momentArrivals(s, byId(p, 'w'));
    const steps = s.walkSteps.filter((x) => x.momentId === 'w');
    expect(w).toHaveLength(steps.length);
    expect(w[0]).toMatchObject({ t: steps[0].t + 0.25, pitch: steps[0].to, type: 'walk' });
    expect(w[0].step).toEqual({ momentId: 'w', tick: steps[0].tick, voice: steps[0].voice });
    // A note: `to` where it arrives.
    const n = momentArrivals(s, byId(p, 'n'));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'note', pitch: 62 });
    expect(n[0].t).toBeCloseTo(10, 6);
    // A split: births and moves land.
    expect(momentArrivals(s, byId(p, 'sp')).length).toBeGreaterThanOrEqual(2);
  });

  it('indexes every unmuted moment, sorted by time', () => {
    const p = make([shift, chord, walk, note, split]);
    const s = compile(p);
    const all = allArrivals(p, s);
    for (let i = 1; i < all.length; i++) expect(all[i].t).toBeGreaterThanOrEqual(all[i - 1].t);
    const expected = p.moments.flatMap((m) => momentArrivals(s, m)).length;
    expect(all).toHaveLength(expected);
    const muted = {
      ...p,
      moments: p.moments.map((m) => (m.id === 'sh' ? { ...m, muted: true } : m)),
    };
    expect(allArrivals(muted, compile(muted)).some((d) => d.momentId === 'sh')).toBe(false);
  });
});

describe('hover pick', () => {
  const map: DotMapping = { x: (t) => t * 10, y: (p) => -p * 10, t: (x) => x / 10 };
  const dot = (momentId: string, t: number, pitch: number, walkStep = false): ArrivalDot => ({
    momentId,
    type: walkStep ? 'walk' : 'chord',
    t,
    pitch,
    step: walkStep ? { momentId, tick: t, voice: 'v' } : undefined,
  });
  const dots = [
    dot('a', 1, 60),
    dot('a', 1, 64),
    dot('b', 3, 60),
    dot('w', 3, 70, true),
    dot('w', 4, 70, true),
  ];

  it('shows all dots of a moment near the pointer', () => {
    expect(hoverPick(dots, map, 10, -600, 12)).toEqual([dots[0], dots[1]]);
    expect(hoverPick(dots, map, 50, -600, 12)).toEqual([]);
  });

  it('shows only the near steps of a walk, and skips the excluded moment', () => {
    expect(hoverPick(dots, map, 30, -700, 8)).toEqual([dots[3]]);
    expect(hoverPick(dots, map, 30, -600, 12, 'b')).toEqual([]);
    expect(hoverPick(dots, map, 10, -600, 12, null, 1)).toEqual([dots[0]]);
  });
});

describe('dot actions', () => {
  const p = make([shift, chord, walk, note, split]);
  const notes = (m: ChordMoment) => (m.id === 'c' ? [50, 57, 60, 65] : null);

  it('dispatches by moment type', () => {
    expect(dotAction(p, { momentId: 'c', type: 'chord', t: 7, pitch: 60.2 }, notes)).toEqual({
      kind: 'chord',
      id: 'c',
      index: 2,
    });
    const step = { momentId: 'w', tick: 2, voice: 'v1' };
    expect(dotAction(p, { momentId: 'w', type: 'walk', t: 12, pitch: 60, step }, notes)).toEqual({
      kind: 'walk',
      step,
    });
    expect(dotAction(p, { momentId: 'n', type: 'note', t: 22, pitch: 62 }, notes)).toEqual({
      kind: 'note',
      id: 'n',
      change: 0,
    });
  });

  it('any other moment: a per-voice override; a dot without a voice, or a gone moment: none', () => {
    expect(
      dotAction(p, { momentId: 'sh', type: 'shift', t: 3, pitch: 57, voice: 1 }, notes),
    ).toEqual({ kind: 'override', id: 'sh', voice: 1 });
    expect(dotAction(p, { momentId: 'sp', type: 'split', t: 27, pitch: 62 }, notes)).toEqual({
      kind: 'none',
    });
    expect(dotAction(p, { momentId: 'zz', type: 'chord', t: 1, pitch: 50 }, () => null).kind).toBe(
      'none',
    );
  });

  it('dots carry their voice', () => {
    const s = compile(p);
    for (const id of ['sh', 'n', 'sp']) {
      for (const d of momentArrivals(s, byId(p, id))) {
        expect(d.voice).toBeDefined();
        const seg = s.voices[d.voice!].segments.find(
          (x) => x.momentId === id && Math.abs(x.t1 - d.t) < 1e-6,
        );
        expect(seg).toBeDefined();
      }
    }
  });

  it('nearestIndex picks the closest note, ties low', () => {
    expect(nearestIndex([48, 52, 56], 54)).toBe(1);
    expect(nearestIndex([48, 52, 56], 55)).toBe(2);
    expect(nearestIndex([], 55)).toBe(-1);
  });
});

describe('the opening (M4.5-27)', () => {
  it('an establishing chord has one dot per note where it comes in, for hover too', () => {
    const p = piece({ start: [50, 57] });
    const s = compile(p);
    const dots = allArrivals(p, s).filter((d) => d.momentId === 'start0');
    expect(dots.map((d) => [d.t, d.pitch, d.voice])).toEqual([
      [0, 50, 0],
      [0, 57, 1],
    ]);
    expect(segmentArrivals(s, 'start0')).toEqual([
      { t: 0, p: 50, v: 0 },
      { t: 0, p: 57, v: 1 },
    ]);
  });
});
