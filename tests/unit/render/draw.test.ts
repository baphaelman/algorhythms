import { describe, expect, it } from 'vitest';
import { motionAt } from '../../../src/core/query';
import type { CompiledScore, CompiledVoice, Segment } from '../../../src/core/types';
import { drawScore, type CameraState, type Ctx2D, type ScoreStyle } from '../../../src/render';

// --- a recording stand-in for CanvasRenderingContext2D -----------------------------------------

interface Call {
  op: string;
  args: unknown[];
  fill: unknown;
  stroke: unknown;
  alpha: number;
}

function fakeCtx(): { ctx: Ctx2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '' };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({
          op: prop,
          args,
          fill: target.fillStyle,
          stroke: target.strokeStyle,
          alpha: target.globalAlpha as number,
        });
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls };
}

// --- tiny scores ------------------------------------------------------------------------------

const hold = (t0: number, t1: number, p: number): Segment => ({
  t0,
  t1,
  p0: p,
  p1: p,
  ease: 'smootherstep',
});

function voice(index: number, segments: Segment[], lives?: CompiledVoice['lives']): CompiledVoice {
  return {
    id: `v${index}`,
    index,
    lives: lives ?? [{ born: segments[0].t0, fadeIn: 0 }],
    segments,
    timbre: [{ t: 0, preset: 'sine', fade: 0 }],
    level: [],
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sends: {},
  };
}

/** A pool voice that never sounds, to keep indices aligned. */
const silent = (index: number): CompiledVoice => ({
  ...voice(index, [hold(0, 1, 60)]),
  lives: [],
  segments: [],
});

function score(voices: CompiledVoice[]): CompiledScore {
  return {
    duration: 100,
    voices,
    walkSteps: [],
    momentSpans: [
      { id: 'm1', start: 10, end: 14 },
      { id: 'm2', start: 40, end: 44 },
    ],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'D', scale: 'dorian' } }],
    referenceHz: 440,
    seed: 1,
  };
}

const TOKENS = {
  paper: '#000001',
  ink: '#000002',
  ink2: '#000003',
  rule: '#000004',
  accent: '#000005',
  panel: '#000006',
};
const RED = '#aa0001';
const BLUE = '#aa0002';
const style = (over: Partial<ScoreStyle> = {}): ScoreStyle => ({
  tokens: TOKENS,
  dark: false,
  colors: 'custom',
  oklch: true,
  customColors: [RED, BLUE, '#aa0003'],
  futureOpacity: 0,
  hud: true,
  labels: { m1: 'Intro' },
  ...over,
});
const SIZE = { width: 1000, height: 600 };
/** The prototype-like follow framing: the playhead at 78 % of the width. */
const cam = (window: number, t: number): CameraState => ({ window, start: t - 0.78 * window });

const flatHold = voice(0, [hold(0, 100, 60)]);
const glider = voice(1, [
  hold(0, 20, 55),
  { t0: 20, t1: 30, p0: 55, p1: 70, ease: 'smootherstep' },
  hold(30, 100, 70),
]);

/** The lineTo/moveTo points of every stroked path drawn in `color`. */
function paths(calls: Call[], color: string): { x: number; y: number; op: string }[][] {
  const out: { x: number; y: number; op: string }[][] = [];
  let cur: { x: number; y: number; op: string }[] = [];
  for (const c of calls) {
    if (c.op === 'beginPath') cur = [];
    else if (c.op === 'moveTo' || c.op === 'lineTo') {
      cur.push({ x: c.args[0] as number, y: c.args[1] as number, op: c.op });
    } else if (c.op === 'stroke' && c.stroke === color) out.push(cur);
  }
  return out;
}

describe('layers', () => {
  it('paints background, grid, markers, lines, heads, playhead and HUD back to front', () => {
    const { ctx, calls } = fakeCtx();
    drawScore(ctx, score([flatHold, glider]), cam(20, 25), style(), 25, SIZE, 1);
    const at = (pred: (c: Call) => boolean): number => {
      const i = calls.findIndex(pred);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const text = (re: RegExp) => (c: Call) => c.op === 'fillText' && re.test(c.args[0] as string);
    const bg = at((c) => c.op === 'fillRect' && c.fill === TOKENS.paper);
    const grid = at(text(/^A\d \d+ Hz$/));
    const marker = at(text(/^INTRO$/));
    const line = at((c) => c.op === 'stroke' && c.stroke === RED);
    const head = at((c) => c.op === 'arc');
    const headLabel = at(text(/^\d+\.\d\d Hz/));
    const hud = at(text(/^voices/));
    // the playhead is the last rule-coloured stroke before the HUD
    let playhead = -1;
    calls.forEach((c, i) => {
      if (c.op === 'stroke' && c.stroke === TOKENS.rule && i < hud) playhead = i;
    });
    expect(bg).toBe(0 + calls.findIndex((c) => c.op === 'fillRect'));
    expect(bg).toBeLessThan(grid);
    expect(grid).toBeLessThan(marker);
    expect(marker).toBeLessThan(line);
    expect(line).toBeLessThan(head);
    expect(head).toBeLessThan(headLabel);
    expect(headLabel).toBeLessThan(playhead);
    expect(playhead).toBeLessThan(hud);
  });

  it('scales by dpr and omits the HUD when disabled', () => {
    const { ctx, calls } = fakeCtx();
    drawScore(ctx, score([flatHold]), cam(20, 25), style({ hud: false }), 25, SIZE, 2);
    expect(calls[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
    expect(calls.some((c) => c.op === 'fillText' && /^voices/.test(c.args[0] as string))).toBe(
      false,
    );
  });

  it('draws moment markers at markerTimes when given, else at the span start', () => {
    const introX = (over: Partial<ScoreStyle>): number => {
      const { ctx, calls } = fakeCtx();
      const view = drawScore(ctx, score([flatHold]), cam(40, 25), style(over), 25, SIZE, 1);
      const c = calls.find((x) => x.op === 'fillText' && x.args[0] === 'INTRO');
      return (c?.args[1] as number) - 4 - -view.start * view.pps;
    };
    const pps = (() => {
      const { ctx } = fakeCtx();
      return drawScore(ctx, score([flatHold]), cam(40, 25), style(), 25, SIZE, 1).pps;
    })();
    expect(introX({}) / pps).toBeCloseTo(10, 1);
    expect(introX({ markerTimes: { m1: 9.5 } }) / pps).toBeCloseTo(9.5, 1);
    // missing ids fall back to the span start
    expect(introX({ markerTimes: { m2: 30 } }) / pps).toBeCloseTo(10, 1);
  });

  it('labels A lines with their Hz', () => {
    const { ctx, calls } = fakeCtx();
    drawScore(ctx, score([flatHold, glider]), cam(20, 25), style(), 25, SIZE, 1);
    const labels = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(labels).toContain('A4 440 Hz');
    expect(labels).toContain('A3 220 Hz');
  });

  it('marks labelled moments full height and unlabelled ones with a tick', () => {
    const { ctx, calls } = fakeCtx();
    const sc = score([flatHold]);
    drawScore(ctx, sc, cam(60, 30), style(), 30, SIZE, 1);
    const segs = paths(calls, TOKENS.rule).filter((p) => p.length === 2 && p[0].x === p[1].x);
    const heights = segs.map((p) => Math.abs(p[1].y - p[0].y)).sort((a, b) => a - b);
    // two ticks/lines for m1 (full height) and m2 (short), plus the playhead (full height)
    expect(heights.some((h) => h < 20)).toBe(true);
    expect(heights.filter((h) => h > 300).length).toBeGreaterThanOrEqual(2);
  });
});

describe('lines', () => {
  it('draws a hold as one straight segment', () => {
    const { ctx, calls } = fakeCtx();
    drawScore(ctx, score([flatHold]), cam(20, 50), style(), 50, SIZE, 1);
    const ps = paths(calls, RED);
    expect(ps).toHaveLength(1); // the past only
    expect(ps[0].map((p) => p.op)).toEqual(['moveTo', 'lineTo']);
    expect(ps[0][0].y).toBe(ps[0][1].y);
  });

  it('samples a glide about every 2 px at any scale', () => {
    const counts: number[] = [];
    for (const win of [10, 40]) {
      const { ctx, calls } = fakeCtx();
      drawScore(ctx, score([silent(0), glider]), cam(win, 35), style(), 35, SIZE, 1);
      const ps = paths(calls, BLUE);
      expect(ps).toHaveLength(1);
      const pps = SIZE.width / win;
      const x0 = Math.max(0, 1000 * 0.78 + (20 - 35) * pps); // the glide, clipped at the left edge
      const x1 = 1000 * 0.78 + (30 - 35) * pps;
      const xs = ps[0].map((p) => p.x).filter((x) => x >= x0 - 1e-6 && x <= x1 + 1e-6);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThanOrEqual(2 + 1e-6);
      const mean = (x1 - x0) / (xs.length - 1);
      expect(mean).toBeGreaterThan(0.9);
      expect(mean).toBeLessThanOrEqual(2);
      counts.push((xs.length - 1) / ((x1 - x0) / pps)); // samples per second
    }
    // a 4x smaller scale needs about 4x (3x to 9x: steps halve) fewer samples per second
    expect(counts[1]).toBeLessThan(counts[0] / 3);
    expect(counts[1]).toBeGreaterThan(counts[0] / 9);
  });

  it('lifts the pen between lives', () => {
    const v = voice(
      0,
      [hold(0, 30, 60), hold(50, 100, 62)],
      [
        { born: 0, died: 30, fadeIn: 0 },
        { born: 50, fadeIn: 0 },
      ],
    );
    const { ctx, calls } = fakeCtx();
    drawScore(ctx, score([v]), cam(100, 100), style(), 100, SIZE, 1);
    const ps = paths(calls, RED);
    expect(ps[0].filter((p) => p.op === 'moveTo')).toHaveLength(2);
  });

  it('draws the past solid and the future as a ghost at futureOpacity', () => {
    for (const [opacity, ghost] of [
      [0, false],
      [0.3, true],
    ] as const) {
      const { ctx, calls } = fakeCtx();
      drawScore(
        ctx,
        score([flatHold]),
        cam(20, 50),
        style({ futureOpacity: opacity }),
        50,
        SIZE,
        1,
      );
      const alphas = calls.filter((c) => c.op === 'stroke' && c.stroke === RED).map((c) => c.alpha);
      expect(alphas).toContain(1);
      expect(alphas.includes(0.3)).toBe(ghost);
      // the ghost covers only [t, right edge]
      if (ghost) {
        const [past, future] = paths(calls, RED);
        expect(past[past.length - 1].x).toBeCloseTo(780, 6);
        expect(future[0].x).toBeCloseTo(780, 6);
      }
    }
  });
});

describe('heads', () => {
  it('draws a dot per active voice and merges equal pitches as ×N', () => {
    const { ctx, calls } = fakeCtx();
    const a = voice(0, [hold(0, 100, 60)]);
    const b = voice(1, [hold(0, 100, 60)]);
    const c = voice(2, [hold(0, 100, 67)]);
    const dormant = voice(3, [hold(70, 100, 50)]);
    drawScore(ctx, score([a, b, c, dormant]), cam(20, 50), style(), 50, SIZE, 1);
    const dots = calls.filter((x) => x.op === 'arc' && x.args[2] === 2.6);
    expect(dots).toHaveLength(3);
    const labels = calls.filter((x) => x.op === 'fillText').map((x) => x.args[0] as string);
    expect(labels).toContain('261.63 Hz ×2');
    expect(labels).toContain('392.00 Hz');
    expect(labels.some((l) => /^voices +3 \/ 4$/.test(l))).toBe(true);
  });

  it('draws a motion ring with opacity = motionAt while gliding, none while holding', () => {
    const sc = score([silent(0), glider]);
    const mid = motionAt(glider, 24);
    expect(mid).toBeGreaterThan(0.5);
    const gliding = fakeCtx();
    drawScore(gliding.ctx, sc, cam(20, 24), style(), 24, SIZE, 1);
    const ring = gliding.calls.find((c) => c.op === 'arc' && c.args[2] === 6.5);
    expect(ring?.alpha).toBeCloseTo(mid, 9);
    const holding = fakeCtx();
    drawScore(holding.ctx, sc, cam(20, 50), style(), 50, SIZE, 1);
    expect(holding.calls.some((c) => c.op === 'arc' && c.args[2] === 6.5)).toBe(false);
  });

  it('draws heads at Fit too (no overview fade), and none when disabled', () => {
    const o = fakeCtx();
    drawScore(o.ctx, score([flatHold]), { window: 100, start: 0 }, style(), 50, SIZE, 1);
    expect(o.calls.some((c) => c.op === 'arc')).toBe(true);
    const off = fakeCtx();
    drawScore(off.ctx, score([flatHold]), cam(20, 50), style({ heads: false }), 50, SIZE, 1);
    expect(off.calls.some((c) => c.op === 'arc')).toBe(false);
  });
});
