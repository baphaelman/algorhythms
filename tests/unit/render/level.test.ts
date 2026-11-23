/** Line opacity by audible level (revision 9, "Silent lines vanish"). */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { pulseGainAt } from '../../../src/core/pulse';
import { piece } from '../core/compiler-fixtures';
import type { CompiledScore, CompiledVoice, LevelChange, Life } from '../../../src/core/types';
import {
  HIT_HALF_PX,
  HIT_WIDTH,
  LINE_WIDTH,
  OPACITY_EPS,
  PULSE_DRAW_FLOOR,
  drawScore,
  levelAt,
  lifeLevel,
  nearestLine,
  opacityAt,
  opacityBreaks,
  opacityIn,
  pitchToY,
  pulseDrawLevel,
  pulseHits,
  pulseLevel,
  timeToX,
  type CameraState,
  type Ctx2D,
  type ScoreStyle,
} from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';
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

  it('follows a pulse drawn by its envelope: hits, a visible floor, and breaks at the hits', () => {
    const v = pulsed().voices[0];
    expect(v.pulse?.length).toBeGreaterThan(0);
    expect(pulseGainAt(v, 4)).toBe(1);
    expect(opacityAt(v, 4)).toBeCloseTo(levelAt(v, 4), 12);
    // Audibly silent between hits, drawn at the floor (revision 10).
    expect(pulseGainAt(v, 3.7)).toBeCloseTo(0, 12);
    expect(pulseLevel(v, 3.7)).toBeCloseTo(0, 12);
    expect(pulseDrawLevel(v, 3.7)).toBe(PULSE_DRAW_FLOOR);
    expect(opacityAt(v, 3.7)).toBeCloseTo(PULSE_DRAW_FLOOR * levelAt(v, 3.7), 12);
    expect(opacityAt(v, 3.2)).toBeCloseTo(
      Math.max(pulseGainAt(v, 3.2), PULSE_DRAW_FLOOR) * levelAt(v, 3.2),
      12,
    );
    const br = opacityBreaks(v);
    expect(br).not.toBeNull();
    expect(Array.from(br!)).toContain(3);
  });
});

/** Two held voices, a floor-0 pulse on both from 2 to 6 (1 s steps, decay 0.4). */
function pulsed(floor = 0): CompiledScore {
  return compile(
    piece({
      pool: 2,
      start: [48, 55],
      glide: { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' },
      end: { at: 12, fade: 1 },
      moments: [
        {
          type: 'pulse',
          at: 2,
          until: 6,
          step: 1,
          pattern: [1, 0.5],
          decay: 0.4,
          floor,
          mode: 'together',
        },
      ],
    }),
  );
}

describe('pulse drawing (revision 10)', () => {
  const cam: CameraState = { window: 12, start: 0 };
  /** Fills of voice 0's line (RED) by x range, and its hit marks (narrow vertical strokes). */
  function draw(s: CompiledScore, t = 11, over: Partial<ScoreStyle> = {}) {
    const p = pathCtx();
    const view = drawScore(p.ctx, s, cam, style(over), t, SIZE, 1);
    const ticks = p.strokes.filter(
      (k) => k.style === RED && k.width === HIT_WIDTH && k.pts.length >= 2,
    );
    const marks: { x: number; h: number; alpha: number }[] = [];
    for (const k of ticks)
      for (let i = 0; i + 1 < k.pts.length; i += 2)
        marks.push({
          x: k.pts[i][0],
          h: Math.abs(k.pts[i + 1][1] - k.pts[i][1]) / 2,
          alpha: k.alpha,
        });
    return { p, view, marks };
  }

  it('a floor-0 pulse keeps the line at ≥ the draw floor across the region', () => {
    const s = pulsed();
    const v = s.voices[0];
    for (let t = 2; t < 6; t += 0.05) expect(opacityAt(v, t)).toBeGreaterThanOrEqual(0.15 - 1e-9);
    const { p, view } = draw(s);
    const x0 = timeToX(view, 2);
    const x1 = timeToX(view, 6);
    const inside = p.fills.filter(
      (f) => f.style === RED && f.pts.some(([x]) => x > x0 + 1 && x < x1 - 1),
    );
    expect(inside.length).toBeGreaterThan(0);
    expect(Math.min(...inside.map((f) => f.alpha))).toBeGreaterThanOrEqual(PULSE_DRAW_FLOOR - 0.03);
    // Continuous coverage: every 0.1 s of the region lies under some drawn fill.
    for (let t = 2.05; t < 6; t += 0.1) {
      const x = timeToX(view, t);
      const xs = inside.map((f) => f.pts.map((q) => q[0]));
      expect(xs.some((a) => Math.min(...a) <= x && Math.max(...a) >= x)).toBe(true);
    }
  });

  it('marks each hit with a tick across the line, longer and brighter at a higher accent', () => {
    const s = pulsed();
    const v = s.voices[0];
    const hits = pulseHits(v)!;
    const times = [];
    for (let i = 0; i < hits.length; i += 2) times.push(hits[i]);
    expect(times).toEqual([2, 3, 4, 5]);
    const { view, marks } = draw(s);
    expect(marks.map((m) => m.x)).toEqual(times.map((t) => timeToX(view, t)));
    const y = pitchToY(view, 48);
    expect(marks[0].h).toBeCloseTo(HIT_HALF_PX, 9);
    expect(marks[1].h).toBeLessThan(marks[0].h); // accent 0.5
    expect(marks[1].alpha).toBeLessThan(marks[0].alpha);
    expect(marks[0].alpha).toBe(1);
    expect(y).toBeGreaterThan(0);
    // Future hits at the ghost opacity.
    const g = draw(s, 3.5, { futureOpacity: 0.5 });
    const want = [1, marks[1].alpha, 0.5, 0.5 * marks[1].alpha];
    g.marks.forEach((m, i) => expect(m.alpha).toBeCloseTo(want[i], 1));
  });

  it('no hit marks and an unchanged drawing without a pulse', () => {
    const s = score([voice(0, 60, [{ t: 10, gain: 0, over: 2 }]), voice(1, 67)]);
    const p = pathCtx();
    drawScore(p.ctx, s, CAM, style(), 20, SIZE, 1);
    expect(p.strokes.some((k) => k.width === HIT_WIDTH)).toBe(false);
    expect(pulseHits(s.voices[0])).toBeNull();
    for (const t of [5, 11, 13]) expect(pulseDrawLevel(s.voices[0], t)).toBe(1);
    // Before and after a pulse region, the drawn opacity is the audible level.
    const q = pulsed().voices[0];
    for (const t of [1, 7, 10]) expect(opacityAt(q, t)).toBe(levelAt(q, t) * pulseLevel(q, t));
  });

  it('a pulse whose floor is above the draw floor draws as heard', () => {
    const v = pulsed(0.5).voices[0];
    for (const t of [2.1, 3.7, 4.2, 5.9]) expect(opacityAt(v, t)).toBeCloseTo(pulseLevel(v, t), 12);
  });

  it('heads follow the drawn level: a floor-0 head between hits is drawn at the floor', () => {
    const p = pathCtx();
    drawScore(p.ctx, pulsed(), cam, style({ heads: true }), 3.7, SIZE, 1);
    const heads = p.fills.filter((f) => f.pts.length === 0 && f.arcs.length === 1);
    expect(heads.length).toBe(2);
    for (const h of heads) expect(h.alpha).toBeCloseTo(PULSE_DRAW_FLOOR, 9);
  });
});

describe('minimum line opacity (revision 17)', () => {
  const cam: CameraState = { window: 12, start: 0 };
  /** Alphas of voice 0's line (RED) fills between the hits of its pulse (2..6 s). */
  function between(s: CompiledScore, over: Partial<ScoreStyle>): number[] {
    const p = pathCtx();
    const view = drawScore(p.ctx, s, cam, style(over), 11, SIZE, 1);
    const x0 = timeToX(view, 2);
    const x1 = timeToX(view, 6);
    return p.fills
      .filter((f) => f.style === RED && f.pts.some(([x]) => x > x0 + 1 && x < x1 - 1))
      .map((f) => f.alpha);
  }

  it('0 draws exactly as before', () => {
    const s = pulsed();
    const a = pathCtx();
    const b = pathCtx();
    drawScore(a.ctx, s, cam, style(), 11, SIZE, 1);
    drawScore(b.ctx, s, cam, style({ minLineOpacity: 0 }), 11, SIZE, 1);
    expect(b.fills).toEqual(a.fills);
    expect(b.strokes).toEqual(a.strokes);
  });

  it('a gated line is drawn at least the minimum between hits', () => {
    const s = pulsed();
    const v = s.voices[0];
    for (let t = 2; t < 6; t += 0.05) {
      expect(opacityIn(v, v.lives, t, 0.6)).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(opacityIn(v, v.lives, t, 0.6)).toBeGreaterThanOrEqual(opacityAt(v, t));
    }
    expect(Math.min(...between(s, {}))).toBeLessThan(0.3);
    const lifted = between(s, { minLineOpacity: 0.6 });
    expect(lifted.length).toBeGreaterThan(0);
    expect(Math.min(...lifted)).toBeGreaterThanOrEqual(0.6 - 1e-6);
  });

  it('SVG: the gated line between hits is at least the minimum', () => {
    const s = pulsed();
    const svg = (over: Partial<ScoreStyle>) => {
      // The pulse region only (2.2..5.8 s), past the playhead.
      const c = new SvgContext(SIZE.width, SIZE.height);
      drawScore(asCtx2D(c), s, { start: 2.2, window: 3.6 }, style(over), 11, SIZE, 1);
      return c.toSvg();
    };
    const alphas = (out: string) =>
      out
        .split('\n')
        .filter((l) => l.includes(`fill="${RED}"`) && l.startsWith('<path'))
        .map((l) => Number(/ opacity="([\d.]+)"/.exec(l)?.[1] ?? 1));
    expect(svg({ minLineOpacity: 0 })).toBe(svg({}));
    expect(Math.min(...alphas(svg({})))).toBeLessThan(0.3);
    expect(Math.min(...alphas(svg({ minLineOpacity: 0.6 })))).toBeGreaterThanOrEqual(0.6);
  });

  it('life fades still apply, and a line silenced by its level still vanishes', () => {
    const v = voice(0, 60, [{ t: 10, gain: 0, over: 4 }], [{ born: 0, fadeIn: 2 }]);
    expect(opacityIn(v, v.lives, 1, 0.6)).toBeCloseTo(lifeLevel(v.lives[0], 1), 12);
    expect(opacityIn(v, v.lives, 5, 0.6)).toBe(1);
    expect(opacityIn(v, v.lives, 12, 0.6)).toBe(0.6); // level 0.5: lifted
    expect(opacityIn(v, v.lives, 13.999, 0.6)).toBeLessThan(0.01);
    expect(opacityIn(v, v.lives, 15, 0.6)).toBe(0);
  });
});
