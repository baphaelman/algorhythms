/** Poster rows and explicit sizes (PLAN.md §12 "Rows and dimensions", owner 2026-11-23). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  POSTER_CREDIT,
  POSTER_DPR,
  POSTER_MAX_ROWS,
  ROW_GAP,
  drawPoster,
  posterLayout,
  posterLength,
  posterRows,
  posterSize,
  posterStyle,
  videoMarkers,
  type Ctx2D,
  type PosterSize,
} from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

const ROOT = join(import.meta.dirname, '../../..');
const SIZES: PosterSize[] = ['16:9', '1:1', 'a4'];

function load(file: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

describe('posterRows', () => {
  it('cuts the piece into equal rows without a grid', () => {
    expect(posterRows(100, 1)).toEqual([{ start: 0, end: 100 }]);
    expect(posterRows(100, 4)).toEqual([
      { start: 0, end: 25 },
      { start: 25, end: 50 },
      { start: 50, end: 75 },
      { start: 75, end: 100 },
    ]);
    // Clamped to 1..8, whole.
    expect(posterRows(100, 0)).toHaveLength(1);
    expect(posterRows(100, 2.6)).toHaveLength(3);
    expect(posterRows(100, 20)).toHaveLength(POSTER_MAX_ROWS);
    expect(posterRows(0, 4)).toEqual([{ start: 0, end: 0 }]);
  });

  it('snaps each break to the nearest bar line; the last row may end short', () => {
    // 100 bpm 4/4: 2.4 s bars. 100 s / 3 = 33.33 → 33.6 (14 bars), 66.67 → 67.2 (28 bars).
    const r = posterRows(100, 3, { bpm: 100, meter: 4 });
    expect(r.map((x) => [x.start, x.end].map((v) => +v.toFixed(6)))).toEqual([
      [0, 33.6],
      [33.6, 67.2],
      [67.2, 100],
    ]);
    expect(r[2].end - r[2].start).toBeLessThan(r[0].end - r[0].start);
    // Meter defaults to 4; 3/4 at 60 bpm: 3 s bars.
    expect(posterRows(100, 2, { bpm: 60 })[0].end).toBeCloseTo(52, 9);
    expect(posterRows(100, 2, { bpm: 60, meter: 3 })[0].end).toBeCloseTo(51, 9);
  });

  it('does not snap when bars are too long for the rows', () => {
    // 8 s bars, 20 s in 8 rows: breaks would collide, so they stay even.
    const r = posterRows(20, 8, { bpm: 30, meter: 4 });
    expect(r.map((x) => x.end)).toEqual([2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20]);
  });
});

/** A recording context: each stroke's points in device px (the transform applied). */
function deviceStrokes(): { ctx: Ctx2D; strokes: [number, number][][]; nested: () => number } {
  const strokes: [number, number][][] = [];
  let pts: [number, number][] = [];
  let m = [1, 0, 0, 1, 0, 0];
  let depth = 0;
  /** Save depth of the innermost clip, 0 = none. */
  let clipAt = 0;
  let nested = 0;
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '' };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...a: number[]) => {
        if (prop === 'setTransform') m = a.slice(0, 6);
        if (prop === 'beginPath') pts = [];
        if (prop === 'moveTo' || prop === 'lineTo') {
          pts.push([m[0] * a[0] + m[2] * a[1] + m[4], m[1] * a[0] + m[3] * a[1] + m[5]]);
        }
        if (prop === 'stroke') strokes.push(pts);
        if (prop === 'save') depth++;
        if (prop === 'restore') {
          depth--;
          if (clipAt > depth) clipAt = 0;
        }
        if (prop === 'clip') {
          if (clipAt > 0) nested++;
          clipAt = depth;
        }
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, strokes, nested: () => nested };
}

const texts = (svg: string) => [
  ...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g),
];

describe('drawPoster with rows', () => {
  const piece = load('examples/songs/tide-pools.algorhythms.json');
  const compiled = compile(piece);
  const grid = { bpm: piece.view.gridBpm!, meter: piece.view.meter! };

  it('rows = 1 is the poster as before', () => {
    for (const size of SIZES) {
      const style = posterStyle({ theme: 'light', title: true, ...videoMarkers(piece) });
      const a = new SvgContext(3840, 2160);
      drawPoster(asCtx2D(a), compiled, { name: 'n' }, { size, style, title: true });
      const b = new SvgContext(3840, 2160);
      drawPoster(asCtx2D(b), compiled, { name: 'n' }, { size, style, title: true, rows: 1, grid });
      expect(b.toSvg()).toBe(a.toSvg());
    }
  });

  it('takes explicit pixel sizes', () => {
    expect(posterSize({ width: 5000, height: 1200 })).toEqual({ width: 5000, height: 1200 });
    expect(posterLayout({ width: 4500, height: 900 })).toEqual({
      width: 1000,
      height: 200,
      dpr: POSTER_DPR,
    });
  });

  it('stacks the rows: time labels after the first, one title block, no nested clips', () => {
    const style = posterStyle({ theme: 'light', title: true, ...videoMarkers(piece) });
    const c = new SvgContext(3840, 2160);
    const opts = { size: '16:9' as const, style, title: true, rows: 4, grid };
    const view = drawPoster(asCtx2D(c), compiled, { name: 'Tide' }, opts);
    const svg = c.toSvg();
    // No clip path inside another (WebKit determinism, build log v67).
    expect(svg).not.toMatch(/<clipPath id="[^"]+" clip-path=/);
    const t = texts(svg);
    const rows = posterRows(compiled.duration, 4, grid);
    const labels = rows.slice(1).map((r) => posterLength(r.start));
    const found = t.filter((m) => labels.includes(m[3]));
    expect(found.map((m) => m[3])).toEqual(labels);
    for (let i = 1; i < found.length; i++) {
      expect(Number(found[i][2])).toBeGreaterThan(Number(found[i - 1][2]));
    }
    for (const m of found) expect(Number(m[1])).toBeCloseTo(view.padL * POSTER_DPR, 1);
    expect(t.filter((m) => m[3] === 'Tide')).toHaveLength(1);
    expect(t.filter((m) => m[3] === POSTER_CREDIT)).toHaveLength(1);
    // Section labels are drawn, none twice.
    const sect = Object.values(videoMarkers(piece).labels).map((l) => l.toUpperCase());
    const drawn = t.filter((m) => sect.includes(m[3])).map((m) => `${m[3]}@${m[1]},${m[2]}`);
    expect(drawn.length).toBeGreaterThan(0);
    expect(new Set(drawn).size).toBe(drawn.length);
    // Every path's points (lines, markers) are above the title band.
    const bandTop = (view.height - view.padB + 6) * POSTER_DPR;
    let maxY = 0;
    for (const p of svg.matchAll(/<path d="([^"]+)"/g)) {
      for (const run of p[1].matchAll(/[ML]([^A-Za-z]+)/g)) {
        const nums = run[1].trim().split(/\s+/).map(Number);
        for (let i = 1; i < nums.length; i += 2) maxY = Math.max(maxY, nums[i]);
      }
    }
    expect(maxY).toBeLessThanOrEqual(bandTop + 0.01);
  });

  it('one time scale and pitch range; a line cut at a break continues in the next row', () => {
    const style = posterStyle({ theme: 'light', thickness: false });
    const n = 3;
    const rec = deviceStrokes();
    drawPoster(rec.ctx, compiled, { name: 'n' }, { size: '16:9', style, title: false, rows: n });
    expect(rec.nested()).toBe(0);
    const rows = posterRows(compiled.duration, n);
    const px = posterSize('16:9');
    const rowH = (px.height / POSTER_DPR - ROW_GAP * (n - 1)) / n;
    const top = (i: number) => Math.round(i * (rowH + ROW_GAP) * POSTER_DPR);
    const bottom = (i: number) => top(i) + rowH * POSTER_DPR;
    const span = rows[0].end - rows[0].start;
    const rowW = (i: number) => (px.width * (rows[i].end - rows[i].start)) / span;
    // Lines ending at row 0's right edge and starting at row 1's left edge (y within the row).
    const ends: number[] = [];
    const starts: number[] = [];
    for (const s of rec.strokes) {
      if (s.length < 2) continue;
      const ys = s.map((p) => p[1]);
      const inRow = (i: number) => Math.min(...ys) >= top(i) && Math.max(...ys) <= bottom(i);
      const first = s[0];
      const last = s[s.length - 1];
      if (inRow(0) && Math.abs(last[0] - rowW(0)) < 1 && first[0] < last[0] - 4) {
        ends.push(last[1] - top(0));
      }
      if (inRow(1) && Math.abs(first[0]) < 1 && last[0] > first[0] + 4) {
        starts.push(first[1] - top(1));
      }
    }
    expect(ends.length).toBeGreaterThan(0);
    for (const y of ends) expect(starts.some((s) => Math.abs(s - y) < 1.5)).toBe(true);
    // Nothing drawn past a row's width.
    for (const s of rec.strokes) {
      for (const [x, y] of s) {
        for (let i = 0; i < n; i++) {
          if (y >= top(i) && y <= bottom(i)) expect(x).toBeLessThanOrEqual(rowW(i) + 1);
        }
      }
    }
  });

  it('a 4-row SVG of every size renders', () => {
    for (const size of SIZES) {
      const style = posterStyle({ theme: 'dark', title: true, ...videoMarkers(piece) });
      const px = posterSize(size);
      const c = new SvgContext(px.width, px.height);
      drawPoster(asCtx2D(c), compiled, { name: 'n' }, { size, style, title: true, rows: 4, grid });
      expect(c.toSvg()).toMatch(/<svg[\s\S]*<\/svg>\s*$/);
    }
  });
});
