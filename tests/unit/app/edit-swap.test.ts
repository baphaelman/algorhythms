import { beforeEach, describe, expect, it, vi } from 'vitest';

// One-off edits compile and post the swap before the store (and React) sees them; drags compile
// once per animation frame. Frames run only when the test flushes them.
const frames = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  const queue: ((t: number) => void)[] = [];
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  };
  return {
    queue,
    flush() {
      for (const cb of queue.splice(0)) cb(0);
    },
  };
});
const log = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: () => {
      log.push('swap');
      return ok();
    },
    whenReady: ok,
    loopAudio: ok,
  };
});

import { newPiece } from '../../../src/core/defaults';
import type { Piece } from '../../../src/core/types';
import { updateMoment } from '../../../src/app/editor/actions';
import { beginGesture, endGesture, undo, updateGesture } from '../../../src/app/editor/history';
import { patchMoment } from '../../../src/app/editor/ops';
import { loadPiece, usePlayer } from '../../../src/app/store';

function piece(): Piece {
  const p = newPiece({ seed: 5 });
  return {
    ...p,
    moments: [
      { id: 'spl001', type: 'split', at: 0, count: 3, voicing: 'even' },
      { id: 'c', type: 'chord', at: 2, notes: { kind: 'chord', symbol: 'C' } },
    ],
  } as Piece;
}

describe('edit → swap ordering', () => {
  beforeEach(() => {
    loadPiece(piece());
    frames.flush();
    log.length = 0;
  });

  it('a one-off edit posts the swap first, then stores piece and compiled together', () => {
    const unsub = usePlayer.subscribe((s, prev) => {
      log.push(`store piece:${s.piece !== prev.piece} compiled:${s.compiled !== prev.compiled}`);
    });
    expect(updateMoment('c', { notes: { kind: 'chord', symbol: 'Am' } })).toBe(true);
    unsub();
    expect(log).toEqual(['swap', 'store piece:true compiled:true']);
    expect(frames.queue).toHaveLength(0);
    const { compiled } = usePlayer.getState();
    expect(compiled.harmony?.find((h) => h.momentId === 'c')?.label).toMatch(/Am/);
  });

  it('undo compiles at once too', () => {
    const before = usePlayer.getState().compiled;
    updateMoment('c', { notes: { kind: 'chord', symbol: 'F' } });
    log.length = 0;
    expect(undo()).toBe(true);
    expect(log).toEqual(['swap']);
    expect(usePlayer.getState().compiled.voices.map((v) => v.segments)).toEqual(
      before.voices.map((v) => v.segments),
    );
  });

  it('a drag compiles once per frame; the end of the gesture adds no compile', () => {
    beginGesture('Drag');
    const c0 = usePlayer.getState().compiled;
    updateGesture((p) => patchMoment(p, 'c', { at: 2.5 }));
    updateGesture((p) => patchMoment(p, 'c', { at: 3 }));
    expect(log).toEqual([]);
    expect(usePlayer.getState().compiled).toBe(c0);
    frames.flush();
    expect(log).toEqual(['swap']);
    endGesture();
    frames.flush();
    expect(log).toEqual(['swap']);
  });

  it('a pending frame compile is skipped once a one-off edit has compiled the piece', () => {
    beginGesture('Drag');
    updateGesture((p) => patchMoment(p, 'c', { at: 2.5 }));
    updateMoment('c', { notes: { kind: 'chord', symbol: 'G' } });
    expect(log).toEqual(['swap']);
    frames.flush();
    expect(log).toEqual(['swap']);
  });
});
