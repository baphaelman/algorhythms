/**
 * Guard (2026-11-21): a score shorter than its paddings (≲ 82 px with the HUD, the drawer open)
 * gave a negative glide tolerance, so every glide subdivided to the depth limit (millions of
 * path points, 1–6 s a frame). The path size must not grow as the score gets shorter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import {
  DEFAULT_FUTURE_OPACITY,
  LIGHT_TOKENS,
  cameraAt,
  cameraScore,
  chordTolerance,
  drawScore,
  followStart,
  hudLines,
  scorePads,
  type Ctx2D,
} from '../../../src/render';

const ROOT = join(import.meta.dirname, '../../..');

/** A 2D-context stand-in that only counts path points. */
function countingCtx(): { ctx: Ctx2D; points: () => number } {
  let n = 0;
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '' };
  const count = (): void => {
    n++;
  };
  const noop = (): void => {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return prop === 'lineTo' || prop === 'moveTo' ? count : noop;
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, points: () => n };
}

function load(file: string) {
  const parsed = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return compile(parsed.piece);
}

function points(file: string, height: number): number {
  const score = load(file);
  const { ctx, points } = countingCtx();
  for (const f of [0.3, 0.6]) {
    const t = score.duration * f;
    drawScore(
      ctx,
      score,
      { start: followStart('smooth', 0, t, 12, score.duration), window: 12 },
      {
        tokens: LIGHT_TOKENS,
        dark: false,
        colors: 'pitch',
        oklch: false,
        futureOpacity: DEFAULT_FUTURE_OPACITY,
        hud: true,
      },
      t,
      { width: 1200, height },
      1,
    );
  }
  return points();
}

describe('short score', () => {
  it('chord tolerance stays positive at any height (no plot: Infinity, the step bound rules)', () => {
    const score = load('examples/songs/kite-day.algorhythms.json');
    for (const h of [20, 60, 80, 82, 83, 143, 400, 800, 4000]) {
      const view = cameraAt(
        cameraScore(score),
        { start: 0, window: 12 },
        0,
        { width: 1200, height: h },
        true,
      );
      const tol = chordTolerance(view);
      expect(tol, `${h}px`).toBeGreaterThan(0);
    }
  });

  it('the plot height is > 0 and upright for canvas heights 20–4000 px (pads shrink)', () => {
    const score = load('examples/songs/kite-day.algorhythms.json');
    for (const hud of [true, false]) {
      for (let h = 20; h <= 4000; h += h < 300 ? 1 : 37) {
        const v = cameraAt(
          cameraScore(score),
          { start: 0, window: 12 },
          0,
          { width: 1200, height: h },
          hud,
        );
        const plot = v.height - v.padT - v.padB;
        expect(plot, `${h}px hud ${hud}`).toBeGreaterThan(0);
        expect(plot / h).toBeGreaterThanOrEqual(0.4 - 1e-9);
        expect(v.padT).toBeGreaterThan(0);
      }
    }
    // Unchanged where the pads fit (≥ 137 px with the HUD): 28 / 54, then 8 % / 15 %.
    expect(scorePads(143)).toEqual({ padT: 28, padB: 54 });
    expect(scorePads(800)).toEqual({ padT: 64, padB: 120 });
    expect(scorePads(100, false)).toEqual({ padT: 28, padB: 16 });
    // Shrunk proportionally below: 82 px keeps 40 % plot, pads in the 28:54 ratio.
    const p = scorePads(82);
    expect(p.padT + p.padB).toBeCloseTo(82 * 0.6, 9);
    expect(p.padT / p.padB).toBeCloseTo(28 / 54, 9);
    expect(scorePads(0)).toEqual({ padT: 0, padB: 0 });
  });

  it('HUD lines that do not fit the shrunk bottom pad are hidden; the rest stay inside it', () => {
    expect(hudLines(54)).toBe(3);
    expect(hudLines(120)).toBe(3);
    expect(hudLines(40)).toBe(2);
    expect(hudLines(29)).toBe(1);
    expect(hudLines(15)).toBe(0);
    const score = load('examples/songs/kite-day.algorhythms.json');
    for (const h of [20, 40, 60, 82, 100, 137, 143, 400]) {
      const ys: number[] = [];
      const { ctx } = countingCtx();
      const g = ctx as unknown as Record<string, unknown>;
      const fill = vi.fn((s: string, _x: number, y: number) => {
        if (/^(f\(n\)|notes|t {2})/.test(s)) ys.push(y);
      });
      const proxy = new Proxy(g, {
        get: (t, k: string) => (k === 'fillText' ? fill : t[k]),
        set: (t, k: string, val: unknown) => {
          t[k] = val;
          return true;
        },
      }) as unknown as Ctx2D;
      const view = drawScore(
        proxy,
        score,
        { start: 0, window: 12 },
        {
          tokens: LIGHT_TOKENS,
          dark: false,
          colors: 'pitch',
          oklch: false,
          futureOpacity: DEFAULT_FUTURE_OPACITY,
          hud: true,
        },
        score.duration * 0.3,
        { width: 1200, height: h },
        1,
      );
      expect(ys.length, `${h}px`).toBe(hudLines(view.padB));
      for (const y of ys) {
        expect(y - 9, `${h}px`).toBeGreaterThanOrEqual(view.height - view.padB);
        expect(y).toBeLessThanOrEqual(h);
      }
      if (h >= 137)
        expect(ys).toEqual([h - view.padB + 22, h - view.padB + 36, h - view.padB + 50]);
    }
  });

  for (const file of [
    'examples/songs/kite-day.algorhythms.json',
    'examples/songs/harbour-song.algorhythms.json',
    'examples/tidewater-hymn.algorhythms.json',
  ]) {
    it(`path size does not grow as the score shrinks: ${file.split('/').pop()}`, () => {
      const at400 = points(file, 400);
      expect(at400).toBeGreaterThan(100);
      for (const h of [143, 82, 80, 60])
        expect(points(file, h), `${h}px`).toBeLessThanOrEqual(at400);
    });
  }
});
