/** Line thickness by weight (revision 8, "Distinct notes": weight drawn as line thickness). */

import { describe, expect, it } from 'vitest';
import type { CompiledScore, CompiledVoice, WeightChange } from '../../../src/core/types';
import {
  HIGHLIGHT_WIDTH,
  LINE_WIDTH,
  drawScore,
  pitchToY,
  weightWidth,
  type CameraState,
  type Ctx2D,
  type ScoreStyle,
} from '../../../src/render';
import { pathCtx } from './path-ctx';

interface Stroke {
  stroke: unknown;
  width: number;
  /** x of the path's first point. */
  x: number;
}

/** A context double that records each stroke's colour, width and first x. */
function fakeCtx(): { ctx: Ctx2D; strokes: Stroke[] } {
  const strokes: Stroke[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, strokeStyle: '', lineWidth: 1 };
  let x = NaN;
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        if (prop === 'beginPath') x = NaN;
        if (prop === 'moveTo' && x !== x) x = args[0] as number;
        if (prop === 'stroke')
          strokes.push({ stroke: target.strokeStyle, width: target.lineWidth as number, x });
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, strokes };
}

const RED = '#aa0001';
const BLUE = '#aa0002';

function voice(index: number, p: number, weight?: WeightChange[]): CompiledVoice {
  const v: CompiledVoice = {
    id: `v${index}`,
    index,
    lives: [{ born: 0, fadeIn: 0 }],
    segments: [{ t0: 0, t1: 40, p0: p, p1: p, ease: 'linear', momentId: 'm' }],
    timbre: [{ t: 0, preset: 'sine', fade: 0 }],
    level: [],
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sends: {},
  };
  if (weight) v.weight = weight;
  return v;
}

function score(voices: CompiledVoice[]): CompiledScore {
  return {
    duration: 40,
    voices,
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'D', scale: 'major' } }],
    referenceHz: 440,
    seed: 1,
  };
}

const style = (over: Partial<ScoreStyle> = {}): ScoreStyle => ({
  tokens: {
    paper: '#000001',
    ink: '#000002',
    ink2: '#000003',
    rule: '#000004',
    accent: '#000005',
    panel: '#000006',
  },
  dark: false,
  colors: 'custom',
  oklch: true,
  customColors: [RED, BLUE],
  futureOpacity: 1,
  hud: false,
  heads: false,
  ...over,
});
const SIZE = { width: 1000, height: 600 };
const CAM: CameraState = { window: 40, start: 0 };

describe('weightWidth', () => {
  it('is the base width at weight 1 and grows as √w, readable up to 8', () => {
    expect(weightWidth(1, LINE_WIDTH)).toBe(LINE_WIDTH);
    expect(weightWidth(1, HIGHLIGHT_WIDTH)).toBe(HIGHLIGHT_WIDTH);
    expect(weightWidth(4, LINE_WIDTH)).toBeCloseTo(3, 12);
    let last = LINE_WIDTH;
    for (let w = 2; w <= 8; w++) {
      const px = weightWidth(w, LINE_WIDTH);
      expect(px - last).toBeGreaterThan(0.15); // each step still visibly thicker
      last = px;
    }
    expect(weightWidth(8, LINE_WIDTH)).toBeLessThan(4.5);
  });

  it('clamps tiny and huge weights', () => {
    expect(weightWidth(0, LINE_WIDTH)).toBe(LINE_WIDTH * 0.5);
    expect(weightWidth(1000, LINE_WIDTH)).toBe(LINE_WIDTH * 4);
  });
});

describe('drawn thickness', () => {
  it('weight-1 lines draw as before: one stroke at 1.5 px', () => {
    const { ctx, strokes } = fakeCtx();
    drawScore(ctx, score([voice(0, 60), voice(1, 67)]), CAM, style(), 20, SIZE, 1);
    const red = strokes.filter((s) => s.stroke === RED);
    expect(red.length).toBe(2); // past and future
    expect(red.every((s) => s.width === LINE_WIDTH)).toBe(true);
  });

  it('a weighted line is thicker, tapering smoothly through an edit', () => {
    // Voice 0: weight 1 → 4 from 10 s over 4 s (an edit: no merge). Voice 1: weight 2 throughout.
    const w0: WeightChange[] = [{ t: 10, w: 4, over: 4 }];
    const s = score([voice(0, 60, w0), voice(1, 67, [{ t: 0, w: 2, over: 0 }])]);
    const { ctx, fills } = pathCtx();
    const view = drawScore(ctx, s, CAM, style(), 30, SIZE, 1);
    const yc = pitchToY(view, 60);
    const red = fills
      .filter((f) => f.style === RED)
      .flatMap((f) => f.pts)
      .filter(([, y]) => y > yc)
      .sort((a, b) => a[0] - b[0]);
    const half = (x: number) => red.filter((p) => Math.abs(p[0] - x) < 1).map((p) => p[1] - yc);
    expect(half(0).length).toBeGreaterThan(0);
    expect(half(0).every((h) => Math.abs(h - LINE_WIDTH / 2) < 1e-9)).toBe(true);
    expect(half(1000).every((h) => Math.abs(h - 1.5) < 1e-9)).toBe(true);
    // Through the taper: never thinner going right, no step bigger than a sliver.
    for (let i = 1; i < red.length; i++) {
      expect(red[i][1] - red[i - 1][1]).toBeGreaterThanOrEqual(-1e-9);
      if (red[i][0] - red[i - 1][0] < 3) expect(red[i][1] - red[i - 1][1]).toBeLessThan(0.1);
    }
    const yb = pitchToY(view, 67);
    const blue = fills.filter((f) => f.style === BLUE).flatMap((f) => f.pts);
    expect(blue.length).toBeGreaterThan(0);
    for (const [, y] of blue)
      expect(Math.abs(y - yb)).toBeCloseTo((LINE_WIDTH * Math.SQRT2) / 2, 9);
  });

  it('highlighted segments keep their weight', () => {
    const s = score([voice(0, 60, [{ t: 0, w: 4, over: 0 }]), voice(1, 67)]);
    const { ctx, fills, strokes } = pathCtx();
    const view = drawScore(ctx, s, CAM, style({ highlight: new Set(['m']) }), 20, SIZE, 1);
    const yc = pitchToY(view, 60);
    const widths = new Set(
      fills
        .filter((f) => f.style === RED)
        .flatMap((f) => f.pts)
        .map(([, y]) => Math.round(Math.abs(y - yc) * 2000) / 1000),
    );
    expect(widths).toEqual(new Set([3, HIGHLIGHT_WIDTH * 2]));
    const blue = new Set(strokes.filter((x) => x.style === BLUE).map((x) => x.width));
    expect(blue).toEqual(new Set([LINE_WIDTH, HIGHLIGHT_WIDTH]));
  });
});
