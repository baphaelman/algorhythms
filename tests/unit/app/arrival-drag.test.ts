/**
 * Dragging arrival dots through the store (§11.3 "Every dot is draggable", revision 6: the dot
 * moves; Keep lines in order), and adding a point inside a walk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
});
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
  };
});

import {
  addPointDrag,
  clearOverride,
  clearOverrides,
  dragArrival,
  stepNote,
} from '../../../src/app/editor/actions';
import { momentArrivals, type ArrivalDot } from '../../../src/app/editor/arrival-points';
import { tickAt, walkAt } from '../../../src/app/editor/walk-steps';
import { pitchAt } from '../../../src/core/query';
import { undo, useEditor } from '../../../src/app/editor/history';
import { setKeepOrder } from '../../../src/app/editor/line-order';
import { loadPiece, usePlayer } from '../../../src/app/store';
import type { ChordMoment, Moment, NoteMoment, WalkMoment } from '../../../src/core/types';
import { piece } from '../core/compiler-fixtures';

const moments = (): Moment[] => usePlayer.getState().piece.moments;
const byId = (id: string) => moments().find((m) => m.id === id)!;
const dotsOf = (id: string) => momentArrivals(usePlayer.getState().compiled, byId(id));

beforeEach(() => {
  setKeepOrder(false);
  loadPiece(
    piece({
      start: [48, 55, 60, 64],
      key: { tonic: 'C', scale: 'major' },
      glide: { length: 2, jitter: 0, stagger: 0 },
      end: { at: 40, fade: 1 },
      moments: [
        { id: 'sh', type: 'shift', at: 1, by: 2, unit: 'semitones' },
        {
          id: 'c',
          type: 'chord',
          at: 5,
          notes: { kind: 'chord', symbol: 'Am' },
          voicing: 'even',
          assign: 'ordered',
        },
        {
          id: 'w',
          type: 'walk',
          at: 10,
          until: 14,
          grid: 1,
          density: 1,
          steps: [-1, 1],
          stepGlide: 0.25,
        },
        { id: 'n', type: 'note', at: 20, from: 60, to: 62 },
      ],
    }),
  );
});

/** Drags `dot` through `to` = [pitch, t] pairs (t defaults to the dot's own time). */
function drag(dot: ArrivalDot, ...to: (number | [number, number])[]): void {
  const d = dragArrival(dot)!;
  expect(d).not.toBeNull();
  for (const x of to) {
    if (Array.isArray(x)) d.to(x[0], x[1]);
    else d.to(x, dot.t);
  }
  d.end();
}

const score = () => usePlayer.getState().compiled;

describe('dragging arrival dots (revision 6: the dot moves)', () => {
  it('another moment: a vertical drag writes that voice’s pitch override, no new moment', () => {
    const dot = dotsOf('sh')[1];
    expect(dot).toMatchObject({ t: 3, pitch: 57 });
    expect(dot.voice).toBeDefined();
    drag(dot, 58, 59);
    expect(moments()).toHaveLength(4);
    expect(byId('sh').overrides).toEqual([{ voice: dot.voice, pitch: 59 }]);
    expect(useEditor.getState().undoLabel).toBe('Move shift note');
    // The dot stays at its time, on the new pitch.
    const moved = dotsOf('sh').find((d) => d.voice === dot.voice)!;
    expect(moved).toMatchObject({ t: 3, pitch: 59 });
    expect(undo()).toBe(true);
    expect(byId('sh').overrides).toBeUndefined();
  });

  it('another moment: a sideways drag sets that voice’s arrival (`end`)', () => {
    const dot = dotsOf('sh')[0];
    drag(dot, [dot.pitch, 4.5]);
    expect(byId('sh').overrides).toEqual([{ voice: dot.voice, end: 3.5 }]);
    const moved = dotsOf('sh').find((d) => d.voice === dot.voice)!;
    expect(moved.t).toBeCloseTo(4.5, 9);
    expect(moved.pitch).toBe(dot.pitch);
    // The other voices keep their arrival.
    expect(
      dotsOf('sh')
        .filter((d) => d.voice !== dot.voice)
        .every((d) => d.t === 3),
    ).toBe(true);
  });

  it('a chord: freezes it and edits that note; sideways sets that voice’s arrival', () => {
    const dot = dotsOf('c')[0];
    drag(dot, dot.pitch + 1);
    const c = byId('c') as ChordMoment;
    expect(c.frozenFrom).toBeDefined();
    expect(c.byVoice).toBe(true);
    expect(c.overrides).toBeUndefined();
    expect(useEditor.getState().undoLabel).toBe('Freeze chord and move note');
    undo();
    expect((byId('c') as ChordMoment).frozenFrom).toBeUndefined();
    const d0 = dotsOf('c').find((d) => d.voice !== undefined)!;
    drag(d0, [d0.pitch, 9]);
    expect(byId('c').overrides).toEqual([{ voice: d0.voice, end: 4 }]);
  });

  it('a walk: freezes it and moves that step in pitch and time', () => {
    const dot = dotsOf('w')[0];
    drag(dot, dot.pitch + 2);
    const w = byId('w') as WalkMoment;
    expect(w.fixed?.find((f) => f.tick === dot.step!.tick && f.voice === dot.step!.voice)).toEqual({
      tick: dot.step!.tick,
      voice: dot.step!.voice,
      pitch: dot.pitch + 2,
    });
    expect(useEditor.getState().undoLabel).toBe('Freeze walk and move step');
    undo();
    // Sideways by half a tick: the step moves to a fractional tick and arrives where dropped.
    const n0 = score().walkSteps.length;
    drag(dot, [dot.pitch, dot.t + 0.5]);
    const fixed = (byId('w') as WalkMoment).fixed!;
    expect(fixed.some((f) => f.tick === dot.step!.tick && f.voice === dot.step!.voice)).toBe(false);
    const moved = fixed.find((f) => f.tick === dot.step!.tick + 0.5 && f.voice === dot.step!.voice);
    expect(moved).toBeDefined();
    const rec = score().walkSteps.find((s) => s.tick === moved!.tick && s.voice === moved!.voice);
    expect(rec!.t + 0.25).toBeCloseTo(dot.t + 0.5, 9);
    expect(score().walkSteps.length).toBe(n0);
  });

  it('a note: sets `to` and writes the order preference; sideways sets its arrival', () => {
    setKeepOrder(true);
    drag(dotsOf('n')[0], 65);
    expect(byId('n')).toMatchObject({ to: 65, order: true });
    expect(useEditor.getState().undoLabel).toBe('Move note');
    setKeepOrder(false);
    stepNote('n', 1);
    expect(byId('n')).toMatchObject({ to: 67 });
    expect((byId('n') as NoteMoment).order).toBeUndefined();
    // A note that sounds (the walk moved the line `n` names): sideways sets its arrival.
    const v = score().voices[0];
    const add = addPointDrag(30, v.index, pitchAt(v, 30)!);
    add.to(pitchAt(v, 30)! + 2);
    add.end();
    const id = useEditor.getState().selection[0];
    const d = dotsOf(id)[0];
    expect(d.voice).toBe(v.index);
    drag(d, [d.pitch, d.t + 1]);
    expect(byId(id).overrides).toEqual([
      { voice: v.index, end: Math.round((d.t + 1 - 30) * 1000) / 1000 },
    ]);
    expect(dotsOf(id)[0].t).toBeCloseTo(d.t + 1, 2);
  });

  it('clearOverride / clearOverrides remove them (one undo entry each)', () => {
    const [a, b] = dotsOf('sh');
    drag(a, 52);
    drag(b, 59);
    expect(byId('sh').overrides).toHaveLength(2);
    expect(clearOverride('sh', a.voice!)).toBe(true);
    expect(byId('sh').overrides).toEqual([{ voice: b.voice, pitch: 59 }]);
    expect(useEditor.getState().undoLabel).toBe('Clear override');
    expect(clearOverrides('sh')).toBe(true);
    expect(byId('sh').overrides).toBeUndefined();
    undo();
    expect(byId('sh').overrides).toHaveLength(1);
  });
});

describe('adding a point (double-click / N-click)', () => {
  it('on a walk line: inserts a step into the walk (freezing it), one undo entry', () => {
    const s0 = score();
    const steps0 = s0.walkSteps.filter((s) => s.momentId === 'w').length;
    // A voice holding inside the walk, between ticks.
    const v = s0.voices[0];
    const t = 11.6;
    const from = pitchAt(v, t)!;
    const d = addPointDrag(t, v.index, from);
    d.to(from + 1);
    d.end();
    const w = byId('w') as WalkMoment;
    expect(w.fixed).toBeDefined();
    expect(moments()).toHaveLength(4);
    expect(w.fixed!.find((f) => f.voice === v.id && f.tick === 1.6)).toEqual({
      tick: 1.6,
      voice: v.id,
      pitch: from + 1,
    });
    expect(score().walkSteps.filter((s) => s.momentId === 'w')).toHaveLength(steps0 + 1);
    expect(useEditor.getState().undoLabel).toBe('Freeze walk and add step');
    expect(useEditor.getState().selection).toEqual(['w']);
    undo();
    expect((byId('w') as WalkMoment).fixed).toBeUndefined();
  });

  it('outside a walk: adds a note moment at the press time', () => {
    const v = score().voices[0];
    const from = pitchAt(v, 30)!;
    const d = addPointDrag(30, v.index, from);
    d.to(from + 2);
    d.end();
    const n = moments().find((m) => m.type === 'note' && m.id !== 'n') as NoteMoment;
    expect(n).toMatchObject({ at: 30, from, to: from + 2 });
    expect(useEditor.getState().undoLabel).toBe('Add note');
  });
});

describe('walk insertion helpers', () => {
  const w = { at: 10, until: 14, grid: 1 } as WalkMoment;
  it('tickAt snaps near-integer ticks and rejects times outside the walk', () => {
    expect(tickAt(w, 12.0004)).toBe(2);
    expect(tickAt(w, 12.25)).toBe(2.25);
    expect(tickAt(w, 9.9)).toBeNull();
    expect(tickAt(w, 14)).toBeNull();
  });

  it('walkAt: only a walk that targets the voice at t; the later walk drives', () => {
    const p = usePlayer.getState().piece;
    expect(walkAt(p, score(), 0, 11)?.id).toBe('w');
    expect(walkAt(p, score(), 0, 15)).toBeNull();
    const only = {
      ...p,
      moments: p.moments.map((m) => (m.id === 'w' ? { ...m, target: { voices: ['v2'] } } : m)),
    } as typeof p;
    expect(walkAt(only, score(), 0, 11)).toBeNull();
    expect(walkAt(only, score(), 1, 11)?.id).toBe('w');
    const two = {
      ...p,
      moments: [...p.moments, { ...byId('w'), id: 'w2', at: 11, until: 13 }],
    } as typeof p;
    expect(walkAt(two, score(), 0, 12)?.id).toBe('w2');
    expect(walkAt(two, score(), 0, 10.5)?.id).toBe('w');
  });
});
