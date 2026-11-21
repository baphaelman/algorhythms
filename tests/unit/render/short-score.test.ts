/**
 * Guard (2026-11-21): a score shorter than its paddings (≲ 82 px with the HUD, the drawer open)
 * gave a negative glide tolerance, so every glide subdivided to the depth limit (millions of
 * path points, 1–6 s a frame). The path size must not grow as the score gets shorter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    const score = load('examples/compositions/kite-day.algorhythms.json');
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

  for (const file of [
    'examples/compositions/kite-day.algorhythms.json',
    'examples/compositions/harbour-song.algorhythms.json',
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
