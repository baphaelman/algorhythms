/** Poster rows and explicit sizes (PLAN.md §12 "Rows and dimensions", owner 2026-11-23). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  POSTER_MAX_ROWS,
  drawPosterLayout,
  layoutPoster,
  posterLength,
  posterRows,
  posterSize,
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

/** A recording context: each stroked or filled path's points in device px (the transform applied). */
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
        if (prop === 'stroke' || prop === 'fill') strokes.push(pts);
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

describe('a laid-out poster with rows', () => {
  const piece = load('examples/songs/tide-pools.algorhythms.json');
  const compiled = compile(piece);
  const lay = (size: PosterSize, rows: number, doc: Piece['poster'] = {}) => {
    const px = posterSize(size);
    const base = { size: { w: px.width, h: px.height }, rows };
    return layoutPoster({ compiled, piece, doc, base });
  };

  it('takes explicit pixel sizes', () => {
    expect(posterSize({ width: 5000, height: 1200 })).toEqual({ width: 5000, height: 1200 });
  });

  it('stacks the rows: time labels after the first, one title, no nested clips', () => {
    for (const size of SIZES) {
      const L = lay(size, 4);
      const c = new SvgContext(L.width, L.height);
      drawPosterLayout(asCtx2D(c), compiled, L);
      const svg = c.toSvg();
      expect(svg).toMatch(/<svg[\s\S]*<\/svg>\s*$/);
      // No clip path inside another (WebKit determinism, build log v67).
      expect(svg).not.toMatch(/<clipPath id="[^"]+" clip-path=/);
      const t = texts(svg);
      const labels = L.rows.slice(1).map((r) => posterLength(r.start));
      const found = t.filter((m) => labels.includes(m[3]));
      expect(
        found.map((m) => m[3]),
        size,
      ).toEqual(labels);
      for (let i = 1; i < found.length; i++) {
        expect(Number(found[i][2])).toBeGreaterThan(Number(found[i - 1][2]));
      }
      expect(t.filter((m) => m[3] === piece.meta.title)).toHaveLength(1);
      // Section labels are drawn, none twice.
      const sect = Object.values(videoMarkers(piece).labels).map((l) => l.toUpperCase());
      const drawn = t.filter((m) => sect.includes(m[3])).map((m) => `${m[3]}@${m[1]},${m[2]}`);
      expect(drawn.length).toBeGreaterThan(0);
      expect(new Set(drawn).size).toBe(drawn.length);
    }
  });

  it('one time scale and pitch range; a line cut at a break continues in the next row', () => {
    const L = lay('16:9', 3, { look: { thickness: false } });
    const rec = deviceStrokes();
    drawPosterLayout(rec.ctx, compiled, L);
    expect(rec.nested()).toBe(0);
    const plots = L.rows.map((r) => r.plot);
    const len = (i: number) => L.rows[i].end - L.rows[i].start;
    for (const i of [1, 2]) expect(plots[i].w / len(i)).toBeCloseTo(plots[0].w / len(0), 6);
    const inRow = (i: number, ys: number[]) =>
      Math.min(...ys) >= plots[i].y - 0.5 && Math.max(...ys) <= plots[i].y + plots[i].h + 0.5;
    const right0 = plots[0].x + plots[0].w;
    const left1 = plots[1].x;
    // Line ends (caps, half the ribbon's width) may reach a unit past the plot.
    const tol = L.unit;
    const meanY = (pts: [number, number][]) => pts.reduce((a, p) => a + p[1], 0) / pts.length;
    // Lines reaching row 0's right edge and leaving row 1's left edge (y within the row), as
    // fractions of the row's height.
    const ends: number[] = [];
    const starts: number[] = [];
    for (const s of rec.strokes) {
      if (s.length < 3) continue;
      const xs = s.map((p) => p[0]);
      const ys = s.map((p) => p[1]);
      if (Math.max(...xs) - Math.min(...xs) < 4) continue;
      if (inRow(0, ys) && Math.abs(Math.max(...xs) - right0) < tol) {
        ends.push((meanY(s.filter((p) => p[0] > right0 - tol)) - plots[0].y) / plots[0].h);
      }
      if (inRow(1, ys) && Math.abs(Math.min(...xs) - left1) < tol) {
        starts.push((meanY(s.filter((p) => p[0] < left1 + tol)) - plots[1].y) / plots[1].h);
      }
    }
    expect(ends.length).toBeGreaterThan(0);
    for (const y of ends) expect(starts.some((s) => Math.abs(s - y) < 0.01)).toBe(true);
    // Nothing drawn past a row's plot.
    for (const s of rec.strokes) {
      for (const [x, y] of s) {
        for (let i = 0; i < plots.length; i++) {
          if (inRow(i, [y])) expect(x).toBeLessThanOrEqual(plots[i].x + plots[i].w + tol);
        }
      }
    }
  });
});
