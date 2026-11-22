/**
 * Frame cost (PLAN.md §10 budget, build log 2026-11-22 "Frame work"): the per-frame savings draw
 * exactly what was drawn before. Cached glide samples equal core/query `sample`; a steady frame
 * equals a cold one; dense points stay inside the varying ranges; the pitch gradient is made once
 * per view; the ghost layer covers only its boxes and gets only the strands that reach them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { generate } from '../../../src/core/generate';
import { sample } from '../../../src/core/query';
import type { CompiledScore, CompiledVoice, Life, Segment } from '../../../src/core/types';
import { drawScore, pitchToY, tokensOf, type Ctx2D, type ScoreStyle } from '../../../src/render';
import { outlineFrame } from '../../../src/render/outline';
import { sampleInto, samples, stableScale } from '../../../src/render/sampling';
import { pathCtx } from './path-ctx';

const noop = (): void => undefined;

/** Every call on the context, with the styles and alpha in force. */
function recorder(): { ctx: Ctx2D; calls: unknown[][]; gradients: () => number } {
  const calls: unknown[][] = [];
  let gradients = 0;
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '' };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient')
        return () => {
          gradients++;
          return { gradient: true, addColorStop: noop };
        };
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push([prop, ...args, target.fillStyle, target.strokeStyle, target.globalAlpha]);
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls, gradients: () => gradients };
}

const dense = compile(generate(7, { mode: 'dorian', voices: 24 }));
const style: ScoreStyle = {
  tokens: tokensOf('light'),
  dark: false,
  colors: 'pitch',
  oklch: true,
  customColors: [],
  futureOpacity: 0.35,
  hud: true,
};
const SIZE = { width: 1600, height: 620 };

describe('cached glide samples', () => {
  it('equal core/query sample, cold and at a steady scale', () => {
    const out = samples();
    for (const [maxStep, tol] of [
      [2 / 80, 0.02],
      [2 / 300, 0.005],
    ]) {
      for (let pass = 0; pass < 3; pass++) {
        stableScale(maxStep, tol); // pass 0 is cold; later passes reuse the cache
        for (const v of dense.voices) {
          for (const [a, b] of [
            [0, dense.duration],
            [41.3, 61.7],
            [60, 60.01],
            [12.5, 19],
          ]) {
            sampleInto(out, v, a, b, maxStep, tol);
            const want = sample(v, a, b, maxStep, tol);
            expect(out.n).toBe(want.length);
            // One assertion per range (per-point expects made this test slow on CI).
            let bad = -1;
            for (let k = 0; k < out.n && bad < 0; k++) {
              if (out.t[k] !== want[k][0] || !Object.is(out.p[k], want[k][1])) bad = k;
            }
            expect(bad, `voice ${v.index} [${a}, ${b}] first mismatch`).toBe(-1);
          }
        }
      }
    }
  });
});

describe('a steady frame', () => {
  it('draws what a cold frame draws (24 voices, following)', () => {
    for (const t of [30.25, 60.3, 75.7]) {
      const cam = { start: t - 7, window: 20 };
      const draw = () => {
        const r = recorder();
        drawScore(r.ctx, dense, cam, style, t, SIZE, 1);
        return r.calls;
      };
      // Cold: the scale differs from the frame before.
      drawScore(recorder().ctx, dense, { start: t - 7, window: 25 }, style, t, SIZE, 1);
      const cold = draw();
      const steady = draw();
      expect(steady).toEqual(cold);
      expect(draw()).toEqual(cold);
    }
  });

  it('makes the pitch gradient once per context while the view keeps its pitch range', () => {
    const r = recorder();
    for (let k = 0; k < 4; k++) {
      drawScore(r.ctx, dense, { start: 50 + k * 0.02, window: 20 }, style, 57 + k * 0.02, SIZE, 1);
    }
    expect(r.gradients()).toBe(1);
    drawScore(r.ctx, dense, { start: 50, window: 20 }, style, 57, { ...SIZE, height: 500 }, 1);
    expect(r.gradients()).toBe(2);
  });
});

const hold = (t0: number, t1: number, p: number): Segment => ({
  t0,
  t1,
  p0: p,
  p1: p,
  ease: 'linear',
});
const glide = (t0: number, t1: number, p0: number, p1: number): Segment => ({
  t0,
  t1,
  p0,
  p1,
  ease: 'smootherstep',
});
function voice(
  index: number,
  lives: Life[],
  segments: Segment[],
  weight?: CompiledVoice['weight'],
): CompiledVoice {
  const v: CompiledVoice = {
    id: `v${index}`,
    index,
    lives,
    segments,
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
function score(voices: CompiledVoice[], duration = 20): CompiledScore {
  return {
    duration,
    voices,
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'C', scale: 'major' } }],
    referenceHz: 440,
    seed: 1,
  };
}
const COLORS = ['#aa0000', '#aa0001', '#aa0002', '#aa0003', '#aa0004', '#aa0005'];
const flat: ScoreStyle = {
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
  customColors: COLORS,
  futureOpacity: 1,
  hud: false,
  heads: false,
};

describe('dense points', () => {
  it('stay in the varying range: a long hold with one weight taper', () => {
    // A 20 s hold whose weight changes at 10 s (an edit: a taper, drawn densely around it).
    const s = score([
      voice(0, [{ born: 0, fadeIn: 0 }], [hold(0, 20, 60)], [{ t: 10, w: 4, over: 0.5 }]),
    ]);
    const p = pathCtx();
    drawScore(p.ctx, s, { start: 0, window: 20 }, flat, 20, { width: 1000, height: 400 }, 1);
    const pts = p.fills.reduce((n, f) => n + f.pts.length, 0);
    // 50 px/s, 2 px steps: the taper (32 px, or 0.64 s) needs ~2 × 16 points; 20 s would be 1000.
    expect(pts).toBeGreaterThan(20);
    expect(pts).toBeLessThan(120);
    // The outline still spans the whole line, thin before the taper and thick after it.
    const xs = p.fills.flatMap((f) => f.pts.map(([x]) => x));
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(999);
  });
});

describe('the ghost layer', () => {
  // Two merges at 5 s, one around 60 and one around 84: each box gets only its own strands.
  const merge = (i0: number, p: number): CompiledVoice[] => {
    const strand = (i: number, q: number): CompiledVoice =>
      voice(
        i,
        [{ born: 0, fadeIn: 0, died: 5, fadeOut: 1, crossOut: true }],
        [hold(0, 2, q), glide(2, 5, q, p)],
      );
    return [
      voice(
        i0,
        [{ born: 0, fadeIn: 0 }],
        [hold(0, 20, p)],
        [{ t: 5, w: 3, over: 1, lead: 1, cross: true }],
      ),
      strand(i0 + 1, p + 4),
      strand(i0 + 2, p - 5),
    ];
  };
  const s = score([...merge(0, 60), ...merge(3, 84)]);
  let layer: ReturnType<typeof pathCtx> | null = null;
  let layerSize: [number, number] = [0, 0];
  class FakeOffscreen {
    constructor(
      public width: number,
      public height: number,
    ) {
      layerSize = [width, height];
    }
    getContext() {
      layer = pathCtx();
      return layer.ctx;
    }
  }
  beforeEach(() => {
    layer = null;
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('covers the boxes only, and gets only the strands that reach each box', () => {
    const size = { width: 1000, height: 600 };
    const ghostly = { ...flat, futureOpacity: 0.35 };
    const p = pathCtx();
    const view = drawScore(p.ctx, s, { start: 0, window: 20 }, ghostly, 0, size, 1);
    // Two boxes, composited from the layer's origin at the boxes' hull.
    expect(p.images).toHaveLength(2);
    const src = p.images.map((im) => im.args.slice(1, 5) as number[]);
    const dst = p.images.map((im) => im.args.slice(5, 9) as number[]);
    const ox = Math.min(...dst.map((d) => d[0]));
    const oy = Math.min(...dst.map((d) => d[1]));
    for (let i = 0; i < 2; i++) {
      expect(src[i]).toEqual([dst[i][0] - ox, dst[i][1] - oy, dst[i][2], dst[i][3]]);
      expect(src[i][0] + src[i][2]).toBeLessThanOrEqual(layerSize[0]);
      expect(src[i][1] + src[i][3]).toBeLessThanOrEqual(layerSize[1]);
    }
    expect(layerSize[0] * layerSize[1]).toBeLessThan(size.width * size.height);
    // Each strand is traced into its own box only: one fill per strand voice, all near its pitch.
    const fills = layer!.fills;
    const byVoice = new Map<string, number>();
    for (const f of fills)
      byVoice.set(f.style as string, (byVoice.get(f.style as string) ?? 0) + 1);
    expect([...byVoice.keys()].sort()).toEqual(COLORS.slice().sort());
    // As many as with that merge alone: none traced into the other merge's box.
    const alone = pathCtx();
    drawScore(alone.ctx, score(merge(0, 60)), { start: 0, window: 20 }, ghostly, 0, size, 1);
    for (const [color, n] of byVoice) {
      const i = COLORS.indexOf(color);
      const own = layer!.fills.filter((f) => f.style === COLORS[i % 3]).length;
      expect(n, `voice ${i}`).toBe(own);
      const yc = pitchToY(view, i < 3 ? 60 : 84); // path points are CSS px
      for (const f of fills.filter((x) => x.style === color)) {
        for (const [, y] of f.pts) expect(Math.abs(y - yc)).toBeLessThan(80);
      }
    }
  });
});

/** outlineFrame before it reused each point's outgoing direction as the next one's incoming. */
function outlineFrameRef(
  x: Float64Array,
  y: Float64Array,
  w: Float64Array,
  n: number,
  nx: Float64Array,
  ny: Float64Array,
  h: Float64Array,
): void {
  const unit = (dx: number, dy: number): [number, number] => {
    const l = Math.sqrt(dx * dx + dy * dy);
    return l > 1e-9 ? [dx / l, dy / l] : [0, 0];
  };
  let px = 1;
  let py = 0;
  for (let i = 0; i < n; i++) {
    let [ix, iy] = i > 0 ? unit(x[i] - x[i - 1], y[i] - y[i - 1]) : [0, 0];
    let [ox, oy] = i + 1 < n ? unit(x[i + 1] - x[i], y[i + 1] - y[i]) : [0, 0];
    if (ix === 0 && iy === 0) [ix, iy] = [ox, oy];
    if (ox === 0 && oy === 0) [ox, oy] = [ix, iy];
    if (ix === 0 && iy === 0) [ix, iy, ox, oy] = [px, py, px, py];
    let [tx, ty] = unit(ix + ox, iy + oy);
    if (tx === 0 && ty === 0) [tx, ty] = [ix, iy];
    nx[i] = -ty;
    ny[i] = tx;
    const c = -iy * nx[i] + ix * ny[i];
    const k = c > 1 / 2 ? 1 / c : 2;
    h[i] = (w[i] / 2) * (i === 0 || i === n - 1 ? 1 : k);
    px = ox;
    py = oy;
  }
}

describe('outline frame', () => {
  it('equals the two-sided computation bit for bit (repeats, reversals, bends)', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + (trial % 13) * 7;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        // Repeated points (zero-length segments), reversals and ordinary steps.
        x[i] = i === 0 ? 0 : r > 0.8 ? x[i - 1] : r < -0.8 ? x[i - 1] - 3 : x[i - 1] + 2 + r;
        y[i] = i === 0 ? 0 : r > 0.6 ? y[i - 1] : y[i - 1] + 10 * rnd();
        w[i] = 1 + Math.abs(rnd()) * 4;
      }
      const got = [new Float64Array(n), new Float64Array(n), new Float64Array(n)] as const;
      const want = [new Float64Array(n), new Float64Array(n), new Float64Array(n)] as const;
      outlineFrame(x, y, w, n, ...got);
      outlineFrameRef(x, y, w, n, ...want);
      for (let k = 0; k < 3; k++) expect(Array.from(got[k])).toEqual(Array.from(want[k]));
    }
  });
});
