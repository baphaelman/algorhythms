import { describe, expect, it } from 'vitest';
import {
  MIN_WINDOW,
  cameraAt,
  clampWindow,
  easeOverview,
  pitchToY,
  sliderToWindow,
  timeToX,
  windowBlend,
  windowToSlider,
  xToTime,
  yToPitch,
  type CameraScore,
} from '../../../src/render';

const score: CameraScore = { duration: 200, pitchRange: [40, 88] };
const size = { width: 1600, height: 900 };

describe('window scale', () => {
  it('slider and window are inverse on a log scale', () => {
    for (const w of [2, 3.7, 20, 77, 200]) {
      expect(sliderToWindow(windowToSlider(w, 200), 200)).toBeCloseTo(w, 9);
    }
    expect(sliderToWindow(0, 200)).toBeCloseTo(2, 9);
    expect(sliderToWindow(1, 200)).toBeCloseTo(200, 9);
    // log scale: the middle is the geometric mean
    expect(sliderToWindow(0.5, 200)).toBeCloseTo(Math.sqrt(2 * 200), 9);
  });

  it('clamps to [2 s, whole piece], and short pieces never go below 2 s', () => {
    expect(clampWindow(0.1, 200)).toBe(MIN_WINDOW);
    expect(clampWindow(9999, 200)).toBe(200);
    expect(clampWindow(NaN, 200)).toBe(200);
    expect(clampWindow(5, 1.5)).toBe(2);
  });
});

describe('blend limits', () => {
  it('is 0 up to 40 % of the piece, 1 at the whole piece, and monotonic between', () => {
    expect(windowBlend(2, 200)).toBe(0);
    expect(windowBlend(80, 200)).toBeCloseTo(0, 12);
    expect(windowBlend(200, 200)).toBe(1);
    let prev = 0;
    for (let w = 80; w <= 200; w += 4) {
      const b = windowBlend(w, 200);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it('follow: playhead at 78 %, window seconds across', () => {
    const v = cameraAt(score, { window: 20, overview: 0 }, 60, size);
    expect(v.blend).toBe(0);
    expect(v.xHead).toBeCloseTo(1600 * 0.78, 9);
    expect(v.pps).toBeCloseTo(1600 / 20, 9);
    expect(v.tR - v.tL).toBeCloseTo(20, 9);
    expect(timeToX(v, 60)).toBeCloseTo(v.xHead, 9);
  });

  it('honours playheadX', () => {
    const v = cameraAt(score, { window: 20, overview: 0, playheadX: 0.5 }, 60, size);
    expect(v.xHead).toBeCloseTo(800, 9);
  });

  it('overview: the whole piece fits between the paddings, at any t', () => {
    for (const cam of [
      { window: 200, overview: 0 },
      { window: 5, overview: 1 },
    ]) {
      const a = cameraAt(score, cam, 0, size);
      const b = cameraAt(score, cam, 150, size);
      expect(a.blend).toBe(1);
      expect(timeToX(a, 0)).toBeCloseTo(a.padL, 6);
      expect(timeToX(a, 200)).toBeCloseTo(size.width - a.padR, 6);
      expect(timeToX(b, 0)).toBeCloseTo(a.padL, 6); // the picture does not move with t
      expect(b.xHead).toBeCloseTo(a.padL + 150 * a.pps, 6);
    }
  });

  it('pixels per second are log-interpolated between follow and overview', () => {
    const half = cameraAt(score, { window: 20, overview: 0.5 }, 60, size);
    const f = cameraAt(score, { window: 20, overview: 0 }, 60, size);
    const o = cameraAt(score, { window: 20, overview: 1 }, 60, size);
    expect(half.pps).toBeCloseTo(Math.sqrt(f.pps * o.pps), 6);
    expect(half.xHead).toBeCloseTo((f.xHead + o.xHead) / 2, 6);
  });

  it('overview tween eases from 0 to 1 over 2.4 s, and is instant with reduced motion', () => {
    expect(easeOverview(0, 1, 0)).toBe(0);
    expect(easeOverview(0, 1, 1200)).toBeCloseTo(0.5, 12);
    expect(easeOverview(0, 1, 2400)).toBe(1);
    expect(easeOverview(1, 0, 99999)).toBe(0);
    expect(easeOverview(0, 1, 10, true)).toBe(1);
  });
});

describe('pan', () => {
  it('moves the content, not the clock: the playhead drifts the other way', () => {
    const a = cameraAt(score, { window: 20, overview: 0 }, 60, size);
    const b = cameraAt(score, { window: 20, overview: 0, pan: -5 }, 60, size);
    expect(b.tc).toBeCloseTo(55, 9);
    expect(b.xAnchor).toBeCloseTo(a.xHead, 9);
    expect(b.xHead).toBeCloseTo(a.xHead + 5 * a.pps, 9);
    expect(timeToX(b, 60)).toBeCloseTo(b.xHead, 9);
  });

  it('is clamped to the piece and fades out in the overview', () => {
    expect(cameraAt(score, { window: 20, overview: 0, pan: -1e6 }, 60, size).tc).toBe(0);
    expect(cameraAt(score, { window: 20, overview: 0, pan: 1e6 }, 60, size).tc).toBe(200);
    const o = cameraAt(score, { window: 20, overview: 1, pan: 30 }, 60, size);
    expect(o.tc).toBe(60);
  });
});

describe('mapping round trips', () => {
  it('time <-> x and pitch <-> y are inverses, in follow, blended and overview views', () => {
    for (const cam of [
      { window: 6, overview: 0, pan: 3 },
      { window: 120, overview: 0 },
      { window: 20, overview: 0.4 },
      { window: 200, overview: 1 },
    ]) {
      const v = cameraAt(score, cam, 77.7, size);
      for (const t of [0, 12.5, 77.7, 199]) expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 8);
      for (const p of [40, 55.25, 69, 88]) expect(yToPitch(v, pitchToY(v, p))).toBeCloseTo(p, 8);
    }
  });

  it('higher pitches are nearer the top, within the padded plot area', () => {
    const v = cameraAt(score, { window: 20, overview: 0 }, 0, size);
    expect(pitchToY(v, 88)).toBeCloseTo(v.padT, 9);
    expect(pitchToY(v, 40)).toBeCloseTo(size.height - v.padB, 9);
    expect(pitchToY(v, 70)).toBeLessThan(pitchToY(v, 60));
  });

  it('a pitchRange override replaces the auto-fit', () => {
    const v = cameraAt(score, { window: 20, overview: 0, pitchRange: [60, 72] }, 0, size);
    expect([v.pLo, v.pHi]).toEqual([60, 72]);
  });
});
