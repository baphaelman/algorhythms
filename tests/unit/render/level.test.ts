/** Line opacity by audible level (revision 9, "Silent lines vanish"). */

import { describe, expect, it } from 'vitest';
import type { CompiledScore, CompiledVoice, LevelChange, Life } from '../../../src/core/types';
import {
  LINE_WIDTH,
  OPACITY_EPS,
  drawScore,
  levelAt,
  lifeLevel,
  nearestLine,
  opacityAt,
  opacityBreaks,
  pitchToY,
  type CameraState,
  type Ctx2D,
  type ScoreStyle,
} from '../../../src/render';
import { pathCtx } from './path-ctx';

interface Stroke {
  stroke: unknown;
  alpha: number;
  width: number;
  dashed: boolean;
  x: number;
}

/** A context double that records each stroke's colour, alpha, width, dash and first x. */
function fakeCtx(): { ctx: Ctx2D; strokes: Stroke[]; fills: { alpha: number }[] } {
  const strokes: Stroke[] = [];
  const fills: { alpha: number }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, strokeStyle: '', lineWidth: 1 };
  let x = NaN;
  let dash: number[] = [];
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        if (prop === 'setLineDash') dash = args[0] as number[];
        if (prop === 'beginPath') x = NaN;
        if (prop === 'moveTo' && x !== x) x = args[0] as number;
        if (prop === 'fill') fills.push({ alpha: target.globalAlpha as number });
        if (prop === 'stroke')
          strokes.push({
            stroke: target.strokeStyle,
            alpha: target.globalAlpha as number,
            width: target.lineWidth as number,
            dashed: dash.length > 0,
            x,
          });
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, strokes, fills };
}

const RED = '#aa0001';
const BLUE = '#aa0002';

function voice(
  index: number,
  p: number,
  level: LevelChange[] = [],
  lives: Life[] = [{ born: 0, fadeIn: 0 }],
): CompiledVoice {
  return {
    id: `v${index}`,
    index,
    lives,
    segments: [{ t0: 0, t1: 40, p0: p, p1: p, ease: 'linear', momentId: `m${index}` }],
    timbre: [{ t: 0, preset: 'sine', fade: 0 }],
    level,
    gain: 0.2,
    pan: 0,
    mute: false,
    solo: false,
    sends: {},
  };
}

function score(voices: CompiledVoice[], spans: CompiledScore['momentSpans'] = []): CompiledScore {
  return {
    duration: 40,
    voices,
    walkSteps: [],
    momentSpans: spans,
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

describe('levelAt', () => {
  it('is 1 before the first change, ramps linearly, steps when over is 0', () => {
    const v = voice(0, 60, [
      { t: 10, gain: 0, over: 4 },
      { t: 20, gain: 0.5, over: 0 },
    ]);
    expect(levelAt(v, 5)).toBe(1);
    expect(levelAt(v, 12)).toBeCloseTo(0.5, 12);
    expect(levelAt(v, 15)).toBe(0);
    expect(levelAt(v, 20)).toBe(0.5);
  });

  it('a change interrupting a ramp starts from the level in effect then', () => {
    const v = voice(0, 60, [
      { t: 0, gain: 0, over: 10 },
      { t: 5, gain: 1, over: 5 },
    ]);
    expect(levelAt(v, 5)).toBeCloseTo(0.5, 12);
    expect(levelAt(v, 7.5)).toBeCloseTo(0.75, 12);
    expect(levelAt(v, 10)).toBe(1);
  });
});

describe('lifeLevel', () => {
  const life: Life = { born: 2, died: 10, fadeIn: 2, fadeOut: 2 };
  it('fades in and out with a smootherstep, 0 outside the life', () => {
    expect(lifeLevel(life, 1.9)).toBe(0);
    expect(lifeLevel(life, 2)).toBe(0);
    expect(lifeLevel(life, 3)).toBeCloseTo(0.5, 12);
    expect(lifeLevel(life, 2.5)).toBeLessThan(0.25); // smootherstep, not linear
    expect(lifeLevel(life, 6)).toBe(1);
    expect(lifeLevel(life, 9)).toBeCloseTo(0.5, 12);
    expect(lifeLevel(life, 10)).toBe(0);
  });
  it('rises monotonically through the fade-in', () => {
    let last = -1;
    for (let t = 2; t <= 4; t += 0.1) {
      const w = lifeLevel(life, t);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });
});

describe('opacityAt', () => {
  it('multiplies level and life, ignores voice gain, clamps to 0..1', () => {
    const v = voice(0, 60, [{ t: 0, gain: 4, over: 0 }], [{ born: 0, fadeIn: 2 }]);
    expect(v.gain).toBe(0.2);
    expect(opacityAt(v, 1)).toBe(1); // 4 · 0.5, clamped
    expect(opacityAt(v, 0.2)).toBeCloseTo(4 * lifeLevel(v.lives[0], 0.2), 12);
    const w = voice(1, 60, [{ t: 0, gain: -1, over: 0 }]);
    expect(opacityAt(w, 5)).toBe(0);
    expect(opacityAt(voice(2, 60, [], [{ born: 5, fadeIn: 0 }]), 1)).toBe(0); // dormant
  });

  it('opacityBreaks is null for a line at full level throughout, and cached', () => {
    expect(opacityBreaks(voice(0, 60))).toBeNull();
    const v = voice(0, 60, [{ t: 10, gain: 0, over: 4 }]);
    const b = opacityBreaks(v);
    expect(Array.from(b!)).toEqual([0, 10, 14]);
    expect(opacityBreaks(v)).toBe(b);
  });
});

describe('drawn opacity', () => {
  it('a line at full level draws as before; a level-0 line is not drawn after its ramp', () => {
    const v1 = voice(1, 67, [{ t: 10, gain: 0, over: 0 }]);
    const p = pathCtx();
    drawScore(p.ctx, score([voice(0, 60), v1]), CAM, style(), 20, SIZE, 1);
    const red = p.strokes.filter((s) => s.style === RED);
    expect(red).toHaveLength(2);
    expect(red.every((s) => s.alpha === 1 && s.width === LINE_WIDTH)).toBe(true);
    const blue = p.fills.filter((s) => s.style === BLUE);
    expect(blue.length).toBeGreaterThan(0);
    // Nothing drawn right of 10 s (x 250), and no round end at the cut.
    expect(blue.every((s) => s.pts.every(([x]) => x <= 250 + 1e-9))).toBe(true);
    expect(blue.every((s) => s.arcs.every((a) => a.x < 249))).toBe(true);
  });

  it('a fade-in fills thin slices of rising opacity, times the dim and ghost', () => {
    const v = voice(0, 60, [], [{ born: 10, fadeIn: 4 }]);
    const p = pathCtx();
    drawScore(p.ctx, score([v]), CAM, style({ futureOpacity: 0.5 }), 0, SIZE, 1);
    const red = p.fills
      .filter((s) => s.style === RED)
      .map((s) => ({ alpha: s.alpha, x: Math.min(...s.pts.map((q) => q[0])) }))
      .sort((a, b) => a.x - b.x);
    expect(red.length).toBeGreaterThan(3);
    for (let i = 1; i < red.length; i++)
      expect(red[i].alpha).toBeGreaterThanOrEqual(red[i - 1].alpha);
    expect(red[0].alpha).toBeLessThan(0.1);
    expect(red[red.length - 1].alpha).toBe(0.5);
  });

  it('heads follow the opacity; a silent head is not drawn', () => {
    const v0 = voice(0, 60, [{ t: 0, gain: 0.5, over: 0 }]);
    const v1 = voice(1, 67, [{ t: 0, gain: 0, over: 0 }]);
    const p = pathCtx();
    drawScore(p.ctx, score([v0, v1]), CAM, style({ heads: true }), 20, SIZE, 1);
    const heads = p.fills.filter((f) => f.pts.length === 0 && f.arcs.length === 1);
    expect(heads.map((f) => f.alpha)).toEqual([0.5]);
  });

  it('a selected silent line gets a dotted trace (traces on); off in the player', () => {
    const v1 = voice(1, 67, [{ t: 10, gain: 0, over: 2 }]);
    const s = score([voice(0, 60), v1], [{ id: 'lv', start: 10, end: 12 }]);
    const hl = new Set(['lv']);
    const a = fakeCtx();
    drawScore(a.ctx, s, CAM, style({ highlight: hl }), 20, SIZE, 1);
    expect(a.strokes.some((x) => x.dashed)).toBe(false);
    const b = fakeCtx();
    drawScore(b.ctx, s, CAM, style({ highlight: hl, traces: true }), 20, SIZE, 1);
    const dots = b.strokes.filter((x) => x.dashed);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.every((x) => x.stroke === BLUE && x.x >= 250)).toBe(true);
    // The hovered voice too, without a selection.
    const c = fakeCtx();
    drawScore(c.ctx, s, CAM, style({ traces: true, traceVoice: 1 }), 20, SIZE, 1);
    expect(c.strokes.some((x) => x.dashed && x.stroke === BLUE)).toBe(true);
    const d = fakeCtx();
    drawScore(d.ctx, s, CAM, style({ traces: true, traceVoice: 0 }), 20, SIZE, 1);
    expect(d.strokes.some((x) => x.dashed)).toBe(false);
  });

  it('hover still finds a silent line, unless audibleOnly', () => {
    const s = score([voice(0, 60, [{ t: 0, gain: 0, over: 0 }])]);
    const view = drawScore(fakeCtx().ctx, s, CAM, style(), 20, SIZE, 1);
    const x = 500;
    const y = pitchToY(view, 60);
    expect(nearestLine(s, view, x, y)?.voice).toBe(0);
    expect(nearestLine(s, view, x, y, undefined, true, true)).toBeNull();
    expect(OPACITY_EPS).toBeGreaterThan(0);
  });
});
