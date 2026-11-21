import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
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
    loopAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
  };
});

import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { Moment, Piece } from '../../../src/core/types';
import {
  MIN_END,
  MIN_TAIL,
  extendEnd,
  followContent,
  momentReach,
  withEnd,
} from '../../../src/app/editor/end';
import {
  beginGesture,
  edit,
  endGesture,
  undo,
  updateGesture,
} from '../../../src/app/editor/history';
import { effectTime, paletteEffects } from '../../../src/app/editor/palette-effects';
import { appendMoment } from '../../../src/app/editor/suggestions';
import {
  cameraOf,
  currentTime,
  fitWindow,
  loadPiece,
  panBy,
  seekTo,
  setWindow,
  usePlayer,
} from '../../../src/app/store';
import { canvasEnd } from '../../../src/render';

const uni = (id: string, at: number, length = 1): Moment =>
  ({
    id,
    type: 'unison',
    at,
    pitch: 'center',
    octaves: false,
    glide: { length, stagger: 0 },
  }) as unknown as Moment;

/** A split at 0 and a unison at 2 (1 s glide); explicit end at `end` unless undefined. */
function piece(end?: number): Piece {
  const p = newPiece({ seed: 7 });
  const moments = [
    { id: 'spl001', type: 'split', at: 0, count: 3, voicing: 'even' },
    uni('uni001', 2),
  ] as unknown as Moment[];
  const out: Piece = { ...p, moments, end: { ...p.end } };
  if (end === undefined) delete out.end.at;
  else out.end.at = end;
  return out;
}

describe('end extension (pure)', () => {
  it('momentReach covers the glide, per-voice arrivals and a note return', () => {
    const p = piece(20);
    expect(momentReach(uni('a', 5, 2), p)).toBe(7);
    const late = { ...uni('b', 5, 1), overrides: [{ voice: 0, end: 6 }] } as Moment;
    expect(momentReach(late, p)).toBe(11);
  });

  it('extendEnd moves an explicit end out to keep MIN_TAIL, never in', () => {
    const p = piece(10);
    expect(extendEnd(p, [uni('a', 30)]).end.at).toBe(31 + MIN_TAIL);
    expect(extendEnd(p, [uni('a', 3)])).toBe(p);
    expect(extendEnd(piece(), [uni('a', 30)]).end.at).toBeUndefined();
  });

  it('followContent extends only for added or changed moments', () => {
    const p = piece(10);
    const moved = { ...p, moments: [p.moments[0]!, { ...p.moments[1]!, at: 40 }] };
    expect(followContent(p, moved).end.at).toBe(45);
    // a piece with a moment already past the end is left alone by unrelated edits
    const cut = { ...p, moments: [...p.moments, uni('uni002', 50)] };
    const other = {
      ...cut,
      moments: [cut.moments[0]!, { ...cut.moments[1]!, at: 3 }, cut.moments[2]!],
    };
    expect(followContent(cut, other).end.at).toBe(10);
    // an edit that sets the end itself wins
    const both = { ...moved, end: { ...moved.end, at: 12 } };
    expect(followContent(p, both).end.at).toBe(12);
  });

  it('withEnd sets (rounded, at least MIN_END) or clears end.at', () => {
    const p = piece(10);
    expect(withEnd(p, 12.34567).end.at).toBe(12.346);
    expect(withEnd(p, -3).end.at).toBe(MIN_END);
    expect(withEnd(p, 10)).toBe(p);
    expect('at' in withEnd(p, undefined).end).toBe(false);
    expect(withEnd(piece(), undefined).end.at).toBeUndefined();
  });

  it('appendMoment still extends the end (shared logic)', () => {
    expect(appendMoment(piece(10), uni('uni009', 20)).end.at).toBe(25);
  });
});

describe('end extension through history', () => {
  beforeEach(() => loadPiece(piece(10)));

  it('an edit past an explicit end moves it out; undo restores it', () => {
    edit((p) => ({ ...p, moments: [...p.moments, uni('uni003', 30)] }), 'Add');
    expect(usePlayer.getState().piece.end.at).toBe(35);
    expect(usePlayer.getState().compiled.duration).toBeCloseTo(35, 6);
    undo();
    expect(usePlayer.getState().piece.end.at).toBe(10);
  });

  it('an automatic end follows content through the compiler', () => {
    loadPiece(piece());
    const d0 = usePlayer.getState().compiled.duration;
    edit((p) => ({ ...p, moments: [...p.moments, uni('uni003', 60)] }), 'Add');
    expect(usePlayer.getState().piece.end.at).toBeUndefined();
    expect(usePlayer.getState().compiled.duration).toBeGreaterThan(Math.max(d0, 60));
  });

  it('a drag extends the end with the cumulative change, and shrinks back when dragged back', () => {
    beginGesture('Move');
    const at = (t: number) => (p: Piece) => ({
      ...p,
      moments: [p.moments[0]!, { ...p.moments[1]!, at: t }],
    });
    updateGesture(at(40));
    expect(usePlayer.getState().piece.end.at).toBe(45);
    updateGesture(at(3));
    expect(usePlayer.getState().piece.end.at).toBe(10);
    updateGesture(at(20));
    endGesture();
    expect(usePlayer.getState().piece.end.at).toBe(25);
    undo();
    expect(usePlayer.getState().piece.end.at).toBe(10);
  });

  it('the end handle gesture sets end.at as one undo entry', () => {
    beginGesture('Move the end');
    updateGesture((p) => withEnd(p, 30));
    updateGesture((p) => withEnd(p, 18));
    endGesture();
    expect(usePlayer.getState().piece.end.at).toBe(18);
    expect(usePlayer.getState().compiled.duration).toBeCloseTo(18, 6);
    undo();
    expect(usePlayer.getState().piece.end.at).toBe(10);
  });
});

describe('open canvas in the store', () => {
  beforeEach(() => loadPiece(piece(10)));

  it('pans and zooms past the end, capped at the canvas end; Fit frames the piece', () => {
    const D = usePlayer.getState().compiled.duration;
    setWindow(5);
    panBy(100);
    expect(cameraOf().start).toBeCloseTo(100, 6);
    panBy(1e6);
    expect(cameraOf().start).toBeCloseTo(canvasEnd(D) - 5, 6);
    panBy(-1e7);
    expect(cameraOf().start).toBe(0);
    setWindow(1e6);
    expect(cameraOf().window).toBeCloseTo(canvasEnd(D), 6);
    panBy(30);
    fitWindow();
    expect(cameraOf()).toEqual({ start: 0, window: D });
  });

  it('a paused seek may go past the end (up to the canvas end)', () => {
    const D = usePlayer.getState().compiled.duration;
    seekTo(D + 20);
    expect(currentTime()).toBeCloseTo(D + 20, 6);
    seekTo(1e9);
    expect(currentTime()).toBeCloseTo(canvasEnd(D), 6);
  });
});

describe('adding past the end', () => {
  it('the palette reads the state just before the end, so moments there still act', () => {
    const p = piece(10);
    const score = compile(p);
    expect(effectTime(score, 5)).toBe(5);
    expect(effectTime(score, 40)).toBeCloseTo(9.99, 6);
    const fx = paletteEffects(p, score, 40);
    expect(fx.chord.effect).toBe(true);
    expect(fx.split.effect).toBe(true);
  });
});
