import { describe, expect, it } from 'vitest';
import type { FollowMode } from '../../../src/core/types';
import {
  MIN_WINDOW,
  PAGE_LAND_X,
  PAGE_TURN_X,
  SMOOTH_X,
  axisOf,
  cameraAt,
  canvasEnd,
  clampStart,
  clampWindow,
  followStart,
  pitchToY,
  sliderToWindow,
  timeToX,
  windowToSlider,
  xToTime,
  yToPitch,
  zoomAnchor,
  zoomAround,
  type CameraScore,
} from '../../../src/render';

const score: CameraScore = { duration: 200, pitchRange: [40, 88] };
const size = { width: 1600, height: 900 };
const D = 200;
/** The open canvas of a 200 s piece: max(4 × 200, 200 + 600). */
const L = 800;

/** Plays from 0 to D at 60 fps under `mode`; returns [t, start] per frame. */
function play(mode: FollowMode, window: number, start0 = 0): [number, number][] {
  const out: [number, number][] = [];
  let start = start0;
  for (let t = 0; t <= D; t += 1 / 60) {
    start = followStart(mode, start, t, window, D);
    out.push([t, start]);
  }
  return out;
}

describe('window scale', () => {
  it('slider and window are inverse on a log scale', () => {
    for (const w of [2, 3.7, 20, 77, 200, 700]) {
      expect(sliderToWindow(windowToSlider(w, 200), 200)).toBeCloseTo(w, 9);
    }
    expect(sliderToWindow(0, 200)).toBeCloseTo(2, 9);
    expect(sliderToWindow(1, 200)).toBeCloseTo(L, 9);
    // log scale: the middle is the geometric mean
    expect(sliderToWindow(0.5, 200)).toBeCloseTo(Math.sqrt(2 * L), 9);
  });

  it('clamps to [2 s, the open canvas]; a missing window fits the piece', () => {
    expect(clampWindow(0.1, 200)).toBe(MIN_WINDOW);
    expect(clampWindow(9999, 200)).toBe(L);
    expect(clampWindow(500, 200)).toBe(500);
    expect(clampWindow(NaN, 200)).toBe(200);
    expect(clampWindow(1.5, 1.5)).toBe(2);
  });

  it('the open canvas is max(4 × the piece, the end + 10 min)', () => {
    expect(canvasEnd(200)).toBe(800);
    expect(canvasEnd(60)).toBe(660);
    expect(canvasEnd(1000)).toBe(4000);
    expect(canvasEnd(0)).toBe(600);
    expect(canvasEnd(NaN)).toBe(600);
  });
});

describe('start clamping', () => {
  it('keeps start in [0, canvas end − window]: free past the piece, never before 0', () => {
    expect(clampStart(-5, 20, D)).toBe(0);
    expect(clampStart(500, 20, D)).toBe(500);
    expect(clampStart(5000, 20, D)).toBe(L - 20);
    expect(clampStart(42, 20, D)).toBe(42);
    expect(clampStart(NaN, 20, D)).toBe(0);
    // a window as wide as the canvas never scrolls
    expect(clampStart(50, L, D)).toBe(0);
  });

  it('cameraAt clamps start and window to the open canvas', () => {
    const v = cameraAt(score, { start: 190, window: 20 }, 199, size);
    expect(v.start).toBe(190);
    expect(v.tR).toBe(210);
    const wide = cameraAt(score, { start: 30, window: 1e6 }, 50, size);
    expect([wide.start, wide.window]).toEqual([0, L]);
    expect(timeToX(wide, L)).toBeCloseTo(size.width, 9);
  });
});

describe('follow', () => {
  it('Smooth holds the playhead at 35 % (±1 %) away from the ends', () => {
    const w = 20;
    for (const [t, start] of play('smooth', w)) {
      const head = (t - start) / w;
      if (t > SMOOTH_X * w + 1e-9 && t < D - (1 - SMOOTH_X) * w - 1e-9) {
        expect(Math.abs(head - SMOOTH_X)).toBeLessThan(0.01);
      }
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(D - w);
    }
  });

  it('Smooth near the ends: the playhead moves across a still view', () => {
    expect(followStart('smooth', 0, 3, 20, D)).toBe(0);
    expect(followStart('smooth', 0, 199, 20, D)).toBe(180);
  });

  it('Page jumps when the playhead passes 92 % and lands it at 8 %', () => {
    const w = 20;
    const frames = play('page', w);
    let jumps = 0;
    for (let i = 1; i < frames.length; i++) {
      const [t, start] = frames[i];
      const prev = frames[i - 1][1];
      const head = (t - start) / w;
      // (once clamped at the end, the playhead runs on to the right edge)
      if (start < D - w) expect(head).toBeLessThan(PAGE_TURN_X + 0.01);
      if (start !== prev) {
        jumps++;
        // the jump happens at 92 % and lands at 8 % (or is clamped at the piece's end)
        expect((t - prev) / w).toBeGreaterThanOrEqual(PAGE_TURN_X - 0.01);
        if (start < D - w) expect(Math.abs(head - PAGE_LAND_X)).toBeLessThan(0.01);
        else expect(start).toBe(D - w);
      }
    }
    expect(jumps).toBeGreaterThan(5);
    // between jumps the view does not move
    expect(followStart('page', 40, 45, 20, D)).toBe(40);
  });

  it('Page brings a playhead that left the view back at 8 %', () => {
    expect(followStart('page', 100, 30, 20, D)).toBeCloseTo(30 - PAGE_LAND_X * 20, 9);
  });

  it('Off never moves the view (only clamps it to the canvas)', () => {
    for (const [, start] of play('off', 20, 77)) expect(start).toBe(77);
    expect(followStart('off', 190, 10, 20, D)).toBe(190);
    expect(followStart('off', 5000, 10, 20, D)).toBe(L - 20);
    // Page leaves a view panned past the end alone while the playhead is in it
    expect(followStart('page', 250, 255, 20, D)).toBe(250);
  });

  it('a playhead resting past the end is followed out there', () => {
    expect(followStart('smooth', 0, 300, 20, D)).toBeCloseTo(300 - SMOOTH_X * 20, 9);
    expect(followStart('page', 0, 300, 20, D)).toBeCloseTo(300 - PAGE_LAND_X * 20, 9);
  });

  it('at Fit nothing scrolls in any mode', () => {
    for (const mode of ['smooth', 'page', 'off'] as const) {
      for (const [, start] of play(mode, D)) expect(start).toBe(0);
    }
  });
});

describe('zoom', () => {
  it('anchors on the playhead when it is visible, else the view centre', () => {
    expect(zoomAnchor(40, 20, 47)).toBe(47);
    expect(zoomAnchor(40, 20, 10)).toBe(50);
    expect(zoomAnchor(40, 20, 90)).toBe(50);
  });

  it('keeps the anchor time at the same x', () => {
    const before = { start: 40, window: 20 };
    for (const next of [5, 10, 33, 60]) {
      const after = zoomAround(before, next, 47, D);
      const x0 = timeToX(axisOf(before, 1000), 47);
      const x1 = timeToX(axisOf(after, 1000), 47);
      expect(x1).toBeCloseTo(x0, 9);
      expect(after.window).toBe(next);
    }
  });

  it('clamps the window and the start', () => {
    expect(zoomAround({ start: 40, window: 20 }, 1e6, 47, D)).toEqual({ start: 0, window: L });
    expect(zoomAround({ start: 40, window: 20 }, 0.1, 47, D).window).toBe(MIN_WINDOW);
    // zooming out near the end goes past the piece, keeping the anchor
    const z = zoomAround({ start: 180, window: 20 }, 60, 199, D);
    expect(z.start).toBeCloseTo(142, 9);
    // ...but not past the canvas end or before 0
    expect(zoomAround({ start: 780, window: 20 }, 100, 780, D).start).toBe(L - 100);
    expect(zoomAround({ start: 1, window: 20 }, 100, 2, D).start).toBe(0);
  });
});

describe('mapping', () => {
  it('time <-> x is one linear map: (t − start) · width / window', () => {
    const a = axisOf({ start: 30, window: 20 }, 1000);
    expect(a.pps).toBe(50);
    expect(timeToX(a, 30)).toBe(0);
    expect(timeToX(a, 50)).toBe(1000);
    expect(xToTime(a, 500)).toBe(40);
    // a View maps exactly like the axis it came from
    const v = cameraAt(score, { start: 30, window: 20 }, 40, { width: 1000, height: 500 });
    for (const t of [30, 33.3, 40, 50]) expect(timeToX(v, t)).toBeCloseTo(timeToX(a, t), 9);
    expect(v.xHead).toBeCloseTo(500, 9);
  });

  it('time <-> x and pitch <-> y are inverses', () => {
    for (const cam of [
      { start: 3, window: 6 },
      { start: 50, window: 120 },
      { start: 0, window: 200 },
    ]) {
      const v = cameraAt(score, cam, 77.7, size);
      for (const t of [0, 12.5, 77.7, 199]) expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 8);
      for (const p of [40, 55.25, 69, 88]) expect(yToPitch(v, pitchToY(v, p))).toBeCloseTo(p, 8);
    }
  });

  it('higher pitches are nearer the top, within the padded plot area', () => {
    const v = cameraAt(score, { start: 0, window: 20 }, 0, size);
    expect(pitchToY(v, 88)).toBeCloseTo(v.padT, 9);
    expect(pitchToY(v, 40)).toBeCloseTo(size.height - v.padB, 9);
    expect(pitchToY(v, 70)).toBeLessThan(pitchToY(v, 60));
  });

  it('a pitchRange override replaces the auto-fit', () => {
    const v = cameraAt(score, { start: 0, window: 20, pitchRange: [60, 72] }, 0, size);
    expect([v.pLo, v.pHi]).toEqual([60, 72]);
  });
});
