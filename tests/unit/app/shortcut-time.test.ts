import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { View } from '../../../src/render';

// The store needs a few browser globals and the audio module; stub them before importing it.
const frames = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
  return new Set<(v: View) => void>();
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
vi.mock('../../../src/app/loop', () => ({
  onScoreFrame: (fn: (v: View) => void) => {
    frames.add(fn);
    return () => frames.delete(fn);
  },
}));

import { newPiece } from '../../../src/core/defaults';
import { pointerTime, shortcutTime, trackPointer } from '../../../src/app/palette-drop';
import { loadPiece, seekTo } from '../../../src/app/store';

/** A tracked area whose left edge sits at clientX 100 (duck-typed element). */
function area(): HTMLElement {
  return Object.assign(new EventTarget(), {
    clientLeft: 0,
    getBoundingClientRect: () => ({ left: 100 }),
  }) as unknown as HTMLElement;
}

const pointer = (el: HTMLElement, type: string, clientX: number, pointerType = 'mouse') =>
  el.dispatchEvent(Object.assign(new Event(type), { clientX, pointerType }));

/** clientX for time `t` in a 50 px/s view starting at 0 over `area()`. */
const xOf = (t: number) => 100 + t * 50;

describe('shortcut time (§11.3: shortcuts add where the pointer is)', () => {
  let el: HTMLElement;
  let untrack: () => void;
  beforeEach(() => {
    untrack?.();
    const p = newPiece({ seed: 7 });
    loadPiece({ ...p, moments: [], view: { ...p.view, gridBpm: 60 } }); // beats every 1 s
    seekTo(3.3);
    el = area();
    untrack = trackPointer(el);
    for (const f of frames) f({ start: 0, pps: 50 } as View);
  });

  it('is the playhead before the pointer has been over a tracked area', () => {
    expect(pointerTime()).toBeNull();
    expect(shortcutTime()).toBeCloseTo(3.3);
  });

  it('is the time under the pointer, snapped like a drop (beats); Alt: free', () => {
    pointer(el, 'pointermove', xOf(7.2));
    expect(shortcutTime()).toBe(7);
    expect(shortcutTime(true)).toBe(7.2);
    pointer(el, 'pointermove', xOf(5.9));
    expect(shortcutTime()).toBe(6);
  });

  it('falls back to the playhead once the pointer leaves', () => {
    pointer(el, 'pointermove', xOf(7));
    pointer(el, 'pointerleave', xOf(7));
    expect(shortcutTime()).toBeCloseTo(3.3);
  });

  it('ignores touch', () => {
    pointer(el, 'pointermove', xOf(7), 'touch');
    expect(shortcutTime()).toBeCloseTo(3.3);
  });

  it('reads the area that was last under the pointer; leaving an old one changes nothing', () => {
    const other = area();
    const off = trackPointer(other);
    pointer(el, 'pointermove', xOf(4));
    pointer(other, 'pointermove', xOf(9));
    pointer(el, 'pointerleave', xOf(4));
    expect(shortcutTime()).toBe(9);
    off();
    expect(shortcutTime()).toBeCloseTo(3.3);
  });
});
