/** Dragging arrival dots through the store (§11.3 "Every dot is draggable", Keep lines in order). */
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

import { dragArrival, stepNote } from '../../../src/app/editor/actions';
import { momentArrivals } from '../../../src/app/editor/arrival-points';
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

function drag(dot: Parameters<typeof dragArrival>[0], ...to: number[]): void {
  const d = dragArrival(dot)!;
  expect(d).not.toBeNull();
  for (const p of to) d.to(p);
  d.end();
}

describe('dragging arrival dots', () => {
  it('another moment: adds a note at the arrival, one undo entry', () => {
    const dot = dotsOf('sh')[1];
    expect(dot).toMatchObject({ t: 3, pitch: 57 });
    drag(dot, 58, 59);
    const n = moments().find((m) => m.type === 'note' && m.id !== 'n') as NoteMoment;
    expect(n).toMatchObject({ at: 3, from: 57, to: 59 });
    expect(n.order).toBeUndefined();
    expect(useEditor.getState().undoLabel).toBe('Add note');
    expect(useEditor.getState().selection).toEqual([n.id]);
    expect(undo()).toBe(true);
    expect(moments()).toHaveLength(4);
  });

  it('a note added with Keep lines in order on stores order', () => {
    setKeepOrder(true);
    drag(dotsOf('sh')[0], 52);
    expect(moments().find((m) => m.type === 'note' && m.id !== 'n')).toMatchObject({
      order: true,
    });
  });

  it('a chord: freezes it and edits that note', () => {
    const dot = dotsOf('c')[0];
    drag(dot, dot.pitch + 1);
    const c = byId('c') as ChordMoment;
    expect(c.frozenFrom).toBeDefined();
    expect(c.byVoice).toBe(true);
    expect(useEditor.getState().undoLabel).toBe('Freeze chord and move note');
    undo();
    expect((byId('c') as ChordMoment).frozenFrom).toBeUndefined();
  });

  it('a walk: freezes it and moves that step', () => {
    const dot = dotsOf('w')[0];
    drag(dot, dot.pitch + 2);
    const w = byId('w') as WalkMoment;
    expect(w.fixed?.find((f) => f.tick === dot.step!.tick && f.voice === dot.step!.voice)).toEqual({
      tick: dot.step!.tick,
      voice: dot.step!.voice,
      pitch: dot.pitch + 2,
    });
    expect(useEditor.getState().undoLabel).toBe('Freeze walk and move step');
  });

  it('a note: sets `to` and writes the order preference', () => {
    setKeepOrder(true);
    drag(dotsOf('n')[0], 65);
    expect(byId('n')).toMatchObject({ to: 65, order: true });
    expect(useEditor.getState().undoLabel).toBe('Move note');
    setKeepOrder(false);
    stepNote('n', 1);
    expect(byId('n')).toMatchObject({ to: 67 });
    expect((byId('n') as NoteMoment).order).toBeUndefined();
  });
});
