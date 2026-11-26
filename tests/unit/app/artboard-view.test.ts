import { describe, expect, it } from 'vitest';
import {
  clampView,
  fitView,
  pageRect,
  panBy,
  posterPoint,
  stepZoom,
  visibleRegion,
  zoomAt,
  zoomLimits,
  zoomText,
} from '../../../src/app/artboard-view';
import { artboardFit } from '../../../src/app/poster-workspace';

const box = { w: 1048, h: 648 };
const poster = { width: 3840, height: 2160 };

describe('artboard zoom', () => {
  it('Fit is the artboard fit, centred', () => {
    const v = fitView(box, poster);
    const f = artboardFit(box, poster);
    expect(v.zoom).toBeCloseTo(f.w / poster.width, 12);
    const p = pageRect(v, box, poster);
    expect(p.w).toBe(f.w);
    expect(p.h).toBe(f.h);
    expect(p.left).toBe((box.w - f.w) / 2);
    expect(zoomText(v.zoom)).toBe('26 %');
  });

  it('100 % is one poster pixel per CSS pixel', () => {
    const v = zoomAt(fitView(box, poster), 1, box, poster);
    const p = pageRect(v, box, poster);
    expect(p.w).toBe(poster.width);
    expect(p.h).toBe(poster.height);
    expect(zoomText(v.zoom)).toBe('100 %');
    expect(v.fit).toBe(false);
  });

  it('zooming at the pointer keeps the poster point under it', () => {
    const at = { x: 700, y: 200 };
    let v = fitView(box, poster);
    for (const z of [0.5, 1.7, 4, 0.9]) {
      const before = posterPoint(v, box, at.x, at.y);
      v = zoomAt(v, z, box, poster, at);
      const after = posterPoint(v, box, at.x, at.y);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
    // And the page sits where that point says.
    const p = pageRect(v, box, poster);
    const q = posterPoint(v, box, at.x, at.y);
    expect(p.left + q.x * v.zoom).toBeCloseTo(at.x, 6);
    expect(p.top + q.y * v.zoom).toBeCloseTo(at.y, 6);
  });

  it('clamps the zoom to a quarter of Fit … 800 %, and the centre to the poster', () => {
    const fit = fitView(box, poster).zoom;
    const { min, max } = zoomLimits(box, poster);
    expect(min).toBeCloseTo(fit / 4, 12);
    expect(max).toBe(8);
    expect(zoomAt(fitView(box, poster), 100, box, poster).zoom).toBe(8);
    expect(zoomAt(fitView(box, poster), 0.001, box, poster).zoom).toBeCloseTo(fit / 4, 12);
    const far = panBy(zoomAt(fitView(box, poster), 2, box, poster), 1e6, -1e6, box, poster);
    expect(far.cx).toBe(0);
    expect(far.cy).toBe(poster.height);
    // A tiny poster can still be zoomed to four times its fit.
    const tiny = { width: 100, height: 100 };
    expect(zoomLimits(box, tiny).max).toBeCloseTo(4 * fitView(box, tiny).zoom, 12);
  });

  it('a Fit view follows the box; a zoomed one keeps its zoom and centre', () => {
    const big = { w: 1600, h: 900 };
    expect(clampView(fitView(box, poster), big, poster)).toEqual(fitView(big, poster));
    const v = zoomAt(fitView(box, poster), 2, box, poster, { x: 300, y: 300 });
    const r = clampView(v, big, poster);
    expect(r.zoom).toBe(v.zoom);
    expect([r.cx, r.cy]).toEqual([v.cx, v.cy]);
  });

  it('panning moves the page by the drag', () => {
    const v = zoomAt(fitView(box, poster), 1, box, poster);
    const a = pageRect(v, box, poster);
    const b = pageRect(panBy(v, 30, -20, box, poster), box, poster);
    expect(b.left - a.left).toBeCloseTo(30, 9);
    expect(b.top - a.top).toBeCloseTo(-20, 9);
  });

  it('steps through round zooms, within the limits', () => {
    expect(stepZoom(1, 1, box, poster)).toBe(1.5);
    expect(stepZoom(1, -1, box, poster)).toBeCloseTo(2 / 3, 12);
    expect(stepZoom(0.27, 1, box, poster)).toBeCloseTo(1 / 3, 12);
    expect(stepZoom(8, 1, box, poster)).toBe(8);
  });

  it('the canvas covers only the page in view when zoomed in', () => {
    const fit = fitView(box, poster);
    const whole = visibleRegion(pageRect(fit, box, poster), box, poster, 2);
    expect(whole.whole).toBe(true);
    expect([whole.x, whole.y]).toEqual([0, 0]);
    expect(whole.w).toBe(Math.round(pageRect(fit, box, poster).w * 2));
    const v = zoomAt(fit, 8, box, poster);
    const r = visibleRegion(pageRect(v, box, poster), box, poster, 2);
    expect(r.whole).toBe(false);
    expect(r.w).toBeLessThanOrEqual(box.w * 2 + 1);
    expect(r.h).toBeLessThanOrEqual(box.h * 2 + 1);
    expect(r.scale).toBeCloseTo(16, 9);
    // Its top left is the page point at the box's top left.
    const p = pageRect(v, box, poster);
    expect(r.x).toBe(Math.floor(-p.left * 2));
  });
});
