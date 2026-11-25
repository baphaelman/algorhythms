/** Export sections (PLAN.md §12 "Exports you can shape", rev 15): span maths, camera, poster. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import { evalSegment } from '../../../src/core/segment';
import type { Piece } from '../../../src/core/types';
import {
  MIN_SECTION,
  MIN_WINDOW,
  barSeconds,
  clampSpan,
  clockText,
  drawPosterLayout,
  drawVideoFrame,
  isWholeSpan,
  layoutPoster,
  pitchExtent,
  pitchExtentIn,
  posterCamera,
  posterMeta,
  posterRows,
  posterSpan,
  sectionText,
  snapToBar,
  stepBar,
  videoCamera,
  videoFrameCount,
  videoFrameTime,
  videoMarkers,
  videoSpan,
  videoStyle,
  type Ctx2D,
  type PosterBase,
} from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

const ROOT = join(import.meta.dirname, '../../..');

function load(file: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

/** 176 s, no grid. */
const rain = load('examples/the-cartographers-rain.algorhythms.json');
const rainC = compile(rain);

describe('section maths', () => {
  it('bars, snapping and steps', () => {
    expect(barSeconds({ bpm: 100, meter: 4 })).toBeCloseTo(2.4);
    expect(barSeconds({ bpm: 60 })).toBe(4); // meter defaults to 4
    expect(barSeconds(undefined)).toBe(0);
    expect(barSeconds({ bpm: 0 })).toBe(0);
    expect(snapToBar(3.5, { bpm: 100 })).toBeCloseTo(2.4);
    expect(snapToBar(3.7, { bpm: 100 })).toBeCloseTo(4.8);
    expect(snapToBar(3.7)).toBe(3.7);
    // Strictly the next / previous bar line, from on or off a line.
    expect(stepBar(4.8, 1, { bpm: 100 })).toBeCloseTo(7.2);
    expect(stepBar(4.8, -1, { bpm: 100 })).toBeCloseTo(2.4);
    expect(stepBar(5, 1, { bpm: 100 })).toBeCloseTo(7.2);
    expect(stepBar(5, -1, { bpm: 100 })).toBeCloseTo(4.8);
    expect(stepBar(5, 1, undefined, 0.5)).toBe(5.5);
  });

  it('clamps a span into the piece, at least MIN_SECTION long', () => {
    expect(clampSpan({ start: -5, end: 500 }, 100)).toEqual({ start: 0, end: 100 });
    expect(clampSpan({ start: 50, end: 50.5 }, 100)).toEqual({ start: 50, end: 50 + MIN_SECTION });
    expect(clampSpan({ start: 50, end: 50.5 }, 100, 'end')).toEqual({
      start: 50.5 - MIN_SECTION,
      end: 50.5,
    });
    expect(clampSpan({ start: 99.5, end: 120 }, 100)).toEqual({
      start: 100 - MIN_SECTION,
      end: 100,
    });
    expect(clampSpan({ start: NaN, end: NaN }, 100)).toEqual({ start: 0, end: 100 });
    expect(isWholeSpan({ start: 0, end: 100 }, 100)).toBe(true);
    expect(isWholeSpan(undefined, 100)).toBe(true);
    expect(isWholeSpan({ start: 0, end: 90 }, 100)).toBe(false);
  });

  it('title text', () => {
    expect(clockText(148)).toBe('2:28');
    expect(sectionText({ start: 45, end: 90 }, 148)).toBe('0:45–1:30 of 2:28');
    expect(posterMeta(148, 'A minor')).toBe('2:28 · A minor');
    expect(posterMeta(148, 'A minor', { start: 45, end: 90 })).toBe(
      '0:45 · 0:45–1:30 of 2:28 · A minor',
    );
  });
});

describe('pitchExtentIn', () => {
  it('fits only the lines sounding in the span, inside the piece’s range', () => {
    const whole = pitchExtent(rainC);
    expect(pitchExtentIn(rainC, 0, rainC.duration)).toEqual(whole);
    const [lo, hi] = pitchExtentIn(rainC, 60, 105);
    expect(lo).toBeGreaterThanOrEqual(whole[0] - 1e-9);
    expect(hi).toBeLessThanOrEqual(whole[1] + 1e-9);
    // Every sounding pitch in the span is inside, with the 1.5 st margin.
    let pLo = Infinity;
    let pHi = -Infinity;
    for (const v of rainC.voices) {
      for (const s of v.segments) {
        for (let t = Math.max(60, s.t0); t <= Math.min(105, s.t1); t += 0.05) {
          const p = evalSegment(s, t);
          pLo = Math.min(pLo, p);
          pHi = Math.max(pHi, p);
        }
      }
    }
    expect(lo).toBeLessThanOrEqual(pLo - 1.5 + 1e-6);
    expect(hi).toBeGreaterThanOrEqual(pHi + 1.5 - 1e-6);
    expect(hi - lo).toBeGreaterThanOrEqual(12 - 1e-9);
  });

  it('a span narrower than the piece fits tighter somewhere', () => {
    const whole = pitchExtent(rainC);
    let tighter = false;
    for (let a = 0; a + 45 <= rainC.duration; a += 15) {
      const [lo, hi] = pitchExtentIn(rainC, a, a + 45);
      if (hi - lo < whole[1] - whole[0] - 1) tighter = true;
    }
    expect(tighter).toBe(true);
  });

  it('nothing sounding: the piece’s range', () => {
    expect(pitchExtentIn(rainC, 1e6, 1e6 + 10)).toEqual(pitchExtent(rainC));
  });
});

describe('posterRows within a section', () => {
  it('splits [start, end] evenly, breaks snapped to the piece’s bar lines', () => {
    expect(posterRows(90, 3, undefined, 45)).toEqual([
      { start: 45, end: 60 },
      { start: 60, end: 75 },
      { start: 75, end: 90 },
    ]);
    // 100 bpm: 2.4 s bars. 45 + 15 = 60 → 60 (25 bars); 75 → 74.4.
    const r = posterRows(90, 3, { bpm: 100 }, 45);
    expect(r.map((x) => [+x.start.toFixed(6), +x.end.toFixed(6)])).toEqual([
      [45, 60],
      [60, 74.4],
      [74.4, 90],
    ]);
    expect(posterRows(90, 1, undefined, 45)).toEqual([{ start: 45, end: 90 }]);
  });
});

describe('video within a section', () => {
  const sec = { start: 60, end: 105 };

  it('frame k is at the section start + k / fps, held at its end', () => {
    expect(videoFrameTime(0, 30, sec.end, sec.start)).toBe(60);
    expect(videoFrameTime(30, 30, sec.end, sec.start)).toBe(61);
    expect(videoFrameTime(5000, 30, sec.end, sec.start)).toBe(105);
    // The default start is 0, as before.
    expect(videoFrameTime(30, 30, 100)).toBe(1);
    expect(videoFrameCount(45, 30)).toBe(1350);
    expect(videoFrameCount(45.01, 30)).toBe(1351);
  });

  it('Whole shows the section full width; Follow stays inside it', () => {
    const o = { aspect: '16:9' as const, section: sec };
    expect(videoCamera('whole', rainC, 80, o)).toMatchObject({ start: 60, window: 45 });
    const f = { ...o, window: 10 };
    for (const t of [0, 60, 61, 80, 104, 105, 200]) {
      const c = videoCamera('follow', rainC, t, f);
      expect(c.window).toBeCloseTo(10);
      expect(c.start).toBeGreaterThanOrEqual(60 - 1e-9);
      expect(c.start + c.window).toBeLessThanOrEqual(105 + 1e-9);
    }
    // Playhead at 35 % inside the section, as Follow does inside the piece.
    const mid = videoCamera('follow', rainC, 80, { ...f, followAt: 0.35 });
    expect(mid.start).toBeCloseTo(80 - 3.5);
    // A window longer than the section: the section.
    expect(videoCamera('follow', rainC, 80, { ...o, window: 500 })).toMatchObject({
      start: 60,
      window: 45,
    });
    // Without a section, as before.
    expect(videoCamera('whole', rainC, 80, { aspect: '16:9' })).toMatchObject({
      start: 0,
      window: Math.max(MIN_WINDOW, rainC.duration),
    });
  });

  it('videoSpan clips to the piece', () => {
    expect(videoSpan(100)).toEqual({ start: 0, end: 100 });
    expect(videoSpan(100, { start: 90, end: 150 })).toEqual({ start: 90, end: 100 });
    expect(videoSpan(100, { start: -3, end: 20 })).toEqual({ start: 0, end: 20 });
  });

  it('frame 0 draws the section’s start', () => {
    const style = videoStyle({ theme: 'dark', ...videoMarkers(rain) });
    const opts = { aspect: '16:9' as const, size: '720' as const, camera: 'whole' as const, style };
    const svg = new SvgContext(1280, 720);
    const view = drawVideoFrame(asCtx2D(svg), rainC, { ...opts, section: sec }, 0, 30);
    expect(view.t).toBe(60);
    expect(view.start).toBe(60);
    expect(view.window).toBe(45);
    const last = drawVideoFrame(asCtx2D(svg), rainC, { ...opts, section: sec }, 1349, 30);
    expect(last.t).toBeCloseTo(60 + 1349 / 30);
  });
});

describe('poster of a section', () => {
  const sec = { start: 45, end: 90 };

  it('posterSpan: none for absent or whole', () => {
    expect(posterSpan(rainC)).toBeUndefined();
    expect(posterSpan(rainC, { start: 0, end: rainC.duration })).toBeUndefined();
    expect(posterSpan(rainC, sec)).toEqual(sec);
  });

  it('camera: the section, its pitch range fitted unless the piece’s is kept', () => {
    const cam = posterCamera(rainC, undefined, sec);
    expect(cam.start).toBe(45);
    expect(cam.window).toBe(45);
    expect(cam.pitchRange).toEqual(pitchExtentIn(rainC, 45, 90));
    expect(posterCamera(rainC, undefined, sec, true).pitchRange).toEqual(pitchExtent(rainC));
    expect(posterCamera(rainC).start).toBe(0);
  });

  function svgOf(base: PosterBase): { svg: string; t: number } {
    const L = layoutPoster({ compiled: rainC, piece: rain, base });
    const svg = new SvgContext(L.width, L.height);
    drawPosterLayout(asCtx2D(svg) as Ctx2D, rainC, L);
    return { svg: svg.toSvg(), t: L.rows[0].start };
  }

  it('draws the section, with its times in the title block; rows split it', () => {
    const one = svgOf({ section: sec });
    expect(one.t).toBe(45);
    expect(one.svg).toContain('0:45 · 0:45–1:30 of 2:56');
    const whole = svgOf({});
    expect(whole.svg).not.toContain(' of 2:56');
    const rows = svgOf({ section: sec, rows: 3 });
    // Row labels at 1:00 and 1:15 (rows after the first), the title once.
    expect(rows.svg).toContain('>1:00<');
    expect(rows.svg).toContain('>1:15<');
    expect(rows.svg.split('0:45–1:30 of 2:56').length).toBe(2);
  });

  it('only the section’s section labels are drawn', () => {
    const labels = Object.entries(videoMarkers(rain).labels);
    const times = videoMarkers(rain).markerTimes;
    const inside = labels.filter(([id]) => times[id] >= 45 && times[id] <= 90);
    const outside = labels.filter(([id]) => times[id] < 40 || times[id] > 95);
    expect(inside.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    const { svg } = svgOf({ section: sec });
    for (const [, l] of outside) expect(svg).not.toContain(`>${l.toUpperCase()}<`);
  });
});
