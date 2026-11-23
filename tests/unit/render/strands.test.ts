/**
 * Thickness transitions (PLAN.md §11.3, owner 2026-11-21): lines bundle into a rope at a merge and
 * peel off it at a split; widths and places change continuously; filled outlines have round ends
 * only at a line's true ends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { crossfade } from '../../../src/core/ease';
import type {
  CompiledScore,
  CompiledVoice,
  Life,
  Segment,
  WeightChange,
} from '../../../src/core/types';
import { drawScore, pitchToY, timeToX, type ScoreStyle } from '../../../src/render';
import { outlineFrame, outlinePath, type PathSink } from '../../../src/render/outline';
import {
  STRAND_LAP,
  drawnLives,
  geometryAt,
  naturalWeight,
  strandFrame,
  strandMix,
  strandSlot,
  strandsOf,
  widthUnits,
} from '../../../src/render/strands';
import { crossfadePiece } from '../core/crossfade-fixtures';
import { pathCtx } from './path-ctx';

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
  weight?: WeightChange[],
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

/**
 * v1 (from 64) and v2 (from 55) glide 2–5 s onto v0's 60 and merge into it (weight 3), crossfading
 * over the last third of the glide as the compiler writes it; at 12 s two forks are born on 60 and
 * glide back out by 15 s, crossfading over the first third.
 */
function mergeSplit(): CompiledScore {
  const strand = (i: number, p: number): CompiledVoice =>
    voice(
      i,
      [
        { born: 0, fadeIn: 0, died: 5, fadeOut: 1, crossOut: true },
        { born: 12, fadeIn: 1, crossIn: true },
      ],
      [hold(0, 2, p), glide(2, 5, p, 60), glide(12, 15, 60, p), hold(15, 20, p)],
    );
  return {
    duration: 20,
    voices: [
      voice(
        0,
        [{ born: 0, fadeIn: 0 }],
        [hold(0, 20, 60)],
        [
          { t: 5, w: 3, over: 1, lead: 1, cross: true },
          { t: 12, w: 1, over: 1, cross: true },
        ],
      ),
      strand(1, 64),
      strand(2, 55),
    ],
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'C', scale: 'major' } }],
    referenceHz: 440,
    seed: 1,
  };
}

const PPS = 100;
const ROPE = widthUnits(3);

describe('bundles', () => {
  it('finds the merge and the split, strands in pitch order (highest first)', () => {
    const b = strandsOf(mergeSplit()).bundles;
    expect(b.map((x) => [x.split, x.t, x.anchor])).toEqual([
      [false, 5, 0],
      [true, 12, 0],
    ]);
    expect(b[0].members.map((m) => m.v)).toEqual([1, 0, 2]);
    expect(b[1].members.map((m) => m.v)).toEqual([1, 0, 2]);
    // Where strands may overlap: from the arriving glides' start, to the departing glides' end.
    expect([b[0].lo, b[0].hi, b[1].lo, b[1].hi]).toEqual([2, 5, 12, 15]);
  });

  it('a merged line ends at the meeting, unfaded; a split strand starts unfaded', () => {
    const s = mergeSplit();
    const f = strandFrame(s, PPS);
    const lives = drawnLives(f, s.voices[1]);
    expect(lives[0]).toMatchObject({ died: 5, fadeOut: 0 });
    expect(lives[1]).toMatchObject({ born: 12, fadeIn: 0 });
    expect(drawnLives(f, s.voices[0])).toBe(s.voices[0].lives);
  });
});

describe('strand geometry', () => {
  const s = mergeSplit();
  const f = strandFrame(s, PPS);
  const V = s.voices;
  const members = [V[1], V[0], V[2]];

  it('at the meeting the strands tile the merged line exactly', () => {
    const slots = members.map((v) => strandSlot(f, v, 5)!);
    const sum = slots.reduce((a, x) => a + x.share, 0);
    expect(sum).toBeCloseTo(ROPE, 12);
    // Side by side, top to bottom, no gap or overlap of the shares.
    expect(slots[0].slot - slots[0].share / 2).toBeCloseTo(-ROPE / 2, 12);
    for (let i = 1; i < 3; i++)
      expect(slots[i].slot - slots[i].share / 2).toBeCloseTo(
        slots[i - 1].slot + slots[i - 1].share / 2,
        12,
      );
    expect(slots[2].slot + slots[2].share / 2).toBeCloseTo(ROPE / 2, 12);
    // Weight-1 strands of a weight-3 rope: each √3/3 wide.
    for (const x of slots) expect(x.share).toBeCloseTo(ROPE / 3, 12);
    // Drawn: each strand's top edge at its slot, reaching at most its lap onto the next.
    for (let i = 0; i < 3; i++) {
      const g = { ...geometryAt(f, members[i], 5, -1) };
      expect(g.off - g.u / 2).toBeCloseTo(slots[i].slot - slots[i].share / 2, 12);
      expect(g.u).toBeCloseTo(slots[i].share + slots[i].lap, 12);
      expect(slots[i].lap).toBeLessThanOrEqual(STRAND_LAP);
    }
    expect(slots[2].lap).toBe(0);
    // The merged line starts at full width, centred.
    const after = { ...geometryAt(f, V[0], 5, 1) };
    expect(after.u).toBeCloseTo(ROPE, 12);
    expect(after.off).toBe(0);
  });

  it('widths and places change continuously into the meeting and out of the split', () => {
    for (const v of members) {
      for (const [a, b, side] of [
        [3, 5, -1],
        [12, 15, 1],
      ]) {
        let last = { ...geometryAt(f, v, a, side) };
        for (let t = a + 1e-3; t <= b; t += 1e-3) {
          const g = { ...geometryAt(f, v, t) };
          expect(Math.abs(g.u - last.u)).toBeLessThan(0.01);
          expect(Math.abs(g.off - last.off)).toBeLessThan(0.01);
          last = g;
        }
      }
    }
  });

  it('before the window and after the peel the lines are drawn on their own', () => {
    for (const v of members) {
      expect(strandMix(f, v, 1)).toBe(0);
      expect(strandMix(f, v, 5)).toBe(1);
      expect(strandMix(f, v, 12)).toBe(1);
      expect(strandMix(f, v, 16)).toBe(0);
    }
    expect({ ...geometryAt(f, V[0], 8) }).toEqual({ u: ROPE, off: 0 });
    expect({ ...geometryAt(f, V[1], 17) }).toEqual({ u: 1, off: 0 });
  });

  it('the bundling mix rises monotonically over the approach', () => {
    let last = 0;
    for (let t = 3; t <= 5; t += 0.01) {
      const e = strandMix(f, V[1], t);
      expect(e).toBeGreaterThanOrEqual(last - 1e-12);
      last = e;
    }
    expect(last).toBeCloseTo(1, 9);
  });

  it('at the split the strands tile the rope they leave', () => {
    const slots = members.map((v) => strandSlot(f, v, 12)!);
    expect(slots.reduce((a, x) => a + x.share, 0)).toBeCloseTo(ROPE, 12);
    expect(slots[0].slot - slots[0].share / 2).toBeCloseTo(-ROPE / 2, 12);
    expect(slots[2].slot + slots[2].share / 2).toBeCloseTo(ROPE / 2, 12);
    expect({ ...geometryAt(f, V[0], 12, -1) }.u).toBeCloseTo(ROPE, 12);
  });

  it('an edit (no merge) tapers its weight with a smootherstep, at least TAPER_PX long', () => {
    const v = voice(0, [{ born: 0, fadeIn: 0 }], [hold(0, 20, 60)], [{ t: 10, w: 4, over: 0 }]);
    const sc = { ...mergeSplit(), voices: [v] };
    const g = strandFrame(sc, PPS);
    expect(naturalWeight(g, v, 9.8)).toBe(1);
    expect(naturalWeight(g, v, 10.2)).toBe(4);
    expect(naturalWeight(g, v, 10)).toBeCloseTo(2.5, 12);
    let last = 1;
    for (let t = 9.8; t <= 10.2; t += 0.002) {
      const w = naturalWeight(g, v, t);
      expect(w).toBeGreaterThanOrEqual(last);
      expect(w - last).toBeLessThan(0.05);
      last = w;
    }
  });
});

/**
 * Merges and splits crossfade (owner 2026-11-21): drawn width follows the function of time the
 * engine fades the sound by (tests/dsp/crossfade.test.ts: a merging line's power share is
 * 1 − crossfade(u), a newborn's crossfade(u)), over the window the compiler wrote.
 */
describe('drawn width follows the crossfade', () => {
  const s = compile(crossfadePiece());
  const f = strandFrame(s, PPS);
  const lives = s.voices.flatMap((v) => v.lives.map((l) => ({ v, l })));

  it('finds a bundle for every crossfade the compiler wrote', () => {
    const b = strandsOf(s).bundles;
    const merges = lives.filter(({ l }) => l.crossOut).length;
    const splits = lives.filter(({ l }) => l.crossIn).length;
    expect(merges).toBe(3);
    expect(splits).toBe(3);
    let members = 0;
    for (const x of b) members += x.members.length - 1; // all but the anchor
    expect(members).toBe(merges + splits);
  });

  it('a merging strand bundles by crossfade(u) over its fade, to the meeting', () => {
    let checked = 0;
    for (const { v, l } of lives) {
      if (!l.crossOut) continue;
      const L = l.fadeOut!;
      const t0 = l.died! - L;
      for (let k = 1; k < 100; k++) {
        const t = t0 + (L * k) / 100;
        const x = crossfade(k / 100);
        expect(strandMix(f, v, t)).toBeCloseTo(x, 12);
        // Width: from its own √w to its share of the rope, by the same x (plus the lap, by x²).
        const slot = strandSlot(f, v, t)!;
        const nat = widthUnits(naturalWeight(f, v, t));
        const g = { ...geometryAt(f, v, t) };
        expect(g.u).toBeCloseTo(nat + (slot.share - nat) * x + slot.lap * x * x, 12);
        checked++;
      }
      expect(strandMix(f, v, t0 - 0.01)).toBe(0);
    }
    expect(checked).toBe(3 * 99);
  });

  it('a split strand peels off by 1 − crossfade(u) over its fade-in', () => {
    for (const { v, l } of lives) {
      if (!l.crossIn) continue;
      for (let k = 1; k < 100; k++) {
        const t = l.born + (l.fadeIn * k) / 100;
        expect(strandMix(f, v, t)).toBeCloseTo(1 - crossfade(k / 100), 12);
      }
      expect(strandMix(f, v, l.born + l.fadeIn + 0.01)).toBe(0);
    }
  });
});

interface Rec extends PathSink {
  ops: (string | number)[][];
}
function rec(): Rec {
  const ops: (string | number)[][] = [];
  return {
    ops,
    moveTo: (x, y) => ops.push(['M', x, y]),
    lineTo: (x, y) => ops.push(['L', x, y]),
    arc: (x, y, r, a0, a1) => ops.push(['A', x, y, r, a0, a1]),
    closePath: () => ops.push(['Z']),
  };
}
const F = (xs: number[]) => Float64Array.from(xs);

describe('outline', () => {
  const n = 11;
  const x = F([...Array(n)].map((_, i) => i * 10));
  const y = F(Array(n).fill(50));
  const w = F([...Array(n)].map((_, i) => 1 + (2 * i) / (n - 1)));
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const h = new Float64Array(n);
  outlineFrame(x, y, w, n, nx, ny, h);

  it('offsets a straight line by ±w/2, widths exact at the ends', () => {
    for (let i = 0; i < n; i++) {
      expect(nx[i]).toBeCloseTo(0, 12);
      expect(ny[i]).toBeCloseTo(1, 12);
      expect(h[i]).toBeCloseTo(w[i] / 2, 12);
    }
    const r = rec();
    outlinePath(r, x, y, nx, ny, h, 0, n - 1, false, false);
    expect(r.ops[0]).toEqual(['M', 0, 50.5]);
    expect(r.ops.some((o) => o[0] === 'A')).toBe(false);
    const pts = r.ops.filter((o) => o[0] !== 'Z');
    expect(pts[n - 1]).toEqual(['L', 100, 51.5]);
    expect(pts[n]).toEqual(['L', 100, 48.5]);
  });

  it('round ends only where asked, a half disc of the end width', () => {
    const r = rec();
    outlinePath(r, x, y, nx, ny, h, 0, n - 1, true, true);
    const arcs = r.ops.filter((o) => o[0] === 'A');
    expect(arcs).toHaveLength(2);
    expect(arcs[0].slice(1, 4)).toEqual([100, 50, 1.5]);
    expect(arcs[1].slice(1, 4)).toEqual([0, 50, 0.5]);
    for (const a of arcs)
      expect(Math.abs((a[4] as number) - (a[5] as number))).toBeCloseTo(Math.PI, 12);
    const s = rec();
    outlinePath(s, x, y, nx, ny, h, 0, n - 1, false, true);
    expect(s.ops.filter((o) => o[0] === 'A')).toHaveLength(1);
  });

  it('pieces that meet share their edge exactly (no gap, no overlap)', () => {
    const a = rec();
    const b = rec();
    outlinePath(a, x, y, nx, ny, h, 0, 5, false, false);
    outlinePath(b, x, y, nx, ny, h, 5, n - 1, false, false);
    const end = a.ops.filter((o) => o[0] !== 'Z').slice(5, 7);
    const start = [b.ops[0], b.ops[b.ops.length - 2]];
    expect(end.map((o) => o.slice(1))).toEqual(start.map((o) => o.slice(1)));
  });

  it('pushes straight ends along the line by extStart / extEnd, round ones not', () => {
    const r = rec();
    outlinePath(r, x, y, nx, ny, h, 0, n - 1, false, false, 2, 3);
    const pts = r.ops.filter((o) => o[0] !== 'Z');
    expect(pts[0]).toEqual(['M', -2, 50.5]);
    expect(pts[n - 1]).toEqual(['L', 103, 51.5]);
    expect(pts[n]).toEqual(['L', 103, 48.5]);
    expect(pts[2 * n - 1]).toEqual(['L', -2, 49.5]);
    const c = rec();
    outlinePath(c, x, y, nx, ny, h, 0, n - 1, true, true, 2, 3);
    const p = rec();
    outlinePath(p, x, y, nx, ny, h, 0, n - 1, true, true);
    expect(c.ops).toEqual(p.ops);
  });

  it('keeps the width through a bend', () => {
    const bx = F([0, 10, 10]);
    const by = F([0, 0, 10]);
    const bw = F([2, 2, 2]);
    const bnx = new Float64Array(3);
    const bny = new Float64Array(3);
    const bh = new Float64Array(3);
    outlineFrame(bx, by, bw, 3, bnx, bny, bh);
    // The outer corner point is √2 out: 1 px from both segments.
    const cx = bx[1] + bnx[1] * bh[1];
    const cy = by[1] + bny[1] * bh[1];
    expect(Math.abs(cy)).toBeCloseTo(1, 9);
    expect(Math.abs(cx - 10)).toBeCloseTo(1, 9);
  });
});

describe('drawn merge and split', () => {
  const style: ScoreStyle = {
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
    customColors: ['#aa0000', '#aa0001', '#aa0002'],
    futureOpacity: 1,
    hud: false,
    heads: false,
  };

  it('fills outlines, with no round ends at the meeting or the split', () => {
    const s = mergeSplit();
    const p = pathCtx();
    const view = drawScore(
      p.ctx,
      s,
      { start: 0, window: 20 },
      style,
      20,
      { width: 1000, height: 600 },
      1,
    );
    const lines = new Set(style.customColors);
    expect(p.strokes.filter((x) => lines.has(x.style as string))).toHaveLength(0);
    for (const t of [5, 12]) {
      const x = timeToX(view, t);
      for (const f of p.fills) for (const a of f.arcs) expect(Math.abs(a.x - x)).toBeGreaterThan(1);
    }
    // The merged lines stop at the meeting point (reaching 2 device px past it under a clip).
    const xm = timeToX(view, 5);
    for (const f of p.fills.filter((q) => q.style === '#aa0001'))
      for (const [px] of f.pts)
        expect(px <= xm + 2.01 || px >= timeToX(view, 12) - 2.01).toBe(true);
    // At the meeting the union of the strands spans the rope.
    const yc = pitchToY(view, 60);
    const near = p.fills.flatMap((f) => f.pts).filter(([px]) => Math.abs(px - xm) <= 2 + 1e-6);
    const top = Math.min(...near.map((q) => q[1]));
    const bottom = Math.max(...near.map((q) => q[1]));
    expect(top).toBeCloseTo(yc - (ROPE * 1.5) / 2, 2);
    expect(bottom).toBeCloseTo(yc + (ROPE * 1.5) / 2, 2);
  });
});

describe('ghost strands do not stack', () => {
  // Owner report 2026-11-21: a knot ahead of the playhead where lines split. Where future strands
  // may overlap they are drawn at full strength into a layer, composited once at the ghost opacity.
  const style: ScoreStyle = {
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
    customColors: ['#aa0000', '#aa0001', '#aa0002'],
    futureOpacity: 0.35,
    hud: false,
    heads: false,
  };
  const SIZE = { width: 1000, height: 600 };
  const STRANDS = new Set(['#aa0001', '#aa0002']);
  let layer: ReturnType<typeof pathCtx> | null = null;
  class FakeOffscreen {
    constructor(
      public width: number,
      public height: number,
    ) {}
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
  const draw = (s: CompiledScore, t: number, over: Partial<ScoreStyle> = {}) => {
    const p = pathCtx();
    const view = drawScore(p.ctx, s, { start: 0, window: 20 }, { ...style, ...over }, t, SIZE, 1);
    return { p, view };
  };
  /** The composited boxes: [x, y, w, h] per drawImage (its destination). */
  const boxes = (p: ReturnType<typeof pathCtx>) =>
    p.images.map((im) => im.args.slice(5, 9) as number[]);

  it('composites the merge and the split once each, at the ghost opacity', () => {
    const { p, view } = draw(mergeSplit(), 0);
    // The ghost's clip (seam and playhead cuts clip too, nonzero).
    expect(p.clips.filter((c) => c[0] === 'evenodd')).toEqual([['evenodd']]);
    expect(p.images.map((im) => im.alpha)).toEqual([0.35, 0.35]);
    for (const t of [5, 12]) {
      const x = timeToX(view, t);
      expect(boxes(p).filter(([x0, , w]) => x0 < x && x0 + w > x)).toHaveLength(1);
    }
    // Only around the overlaps: a few percent of the canvas.
    const area = boxes(p).reduce((sum, [, , w, h]) => sum + w * h, 0);
    expect(area).toBeLessThan(0.05 * SIZE.width * SIZE.height);
    // In the layer, strands are drawn at full strength; outside it, at the ghost opacity.
    const inLayer = layer!.fills.filter((f) => STRANDS.has(f.style as string));
    expect(inLayer.length).toBeGreaterThan(0);
    for (const f of inLayer) expect(f.alpha).toBeCloseTo(1, 12);
    const direct = p.fills.filter((f) => STRANDS.has(f.style as string));
    expect(direct.length).toBeGreaterThan(0);
    for (const f of direct) expect(f.alpha).toBeCloseTo(0.35, 12);
  });

  it('a selection dims the ghost; the selected future goes through the layer too', () => {
    const s = mergeSplit();
    for (const v of s.voices) v.segments = v.segments.map((x) => ({ ...x, momentId: 'm' }));
    const { p } = draw(s, 0, { highlight: new Set(['m']) });
    expect(p.images.map((im) => im.alpha)).toEqual([0.35 * 0.3, 0.35 * 0.3, 0.6, 0.6]);
  });

  it('draws as before where nothing overlaps ahead: the past, an opaque ghost, no bundles', () => {
    const cases: [number, Partial<ScoreStyle>][] = [
      [20, {}],
      [0, { futureOpacity: 1 }],
      [16, {}],
    ];
    for (const [t, over] of cases) {
      const a = draw(mergeSplit(), t, over);
      expect(a.p.images).toHaveLength(0);
      expect(a.p.clips.filter((c) => c[0] === 'evenodd')).toHaveLength(0);
      expect(layer).toBeNull();
      vi.unstubAllGlobals();
      const b = draw(mergeSplit(), t, over);
      vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
      expect(a.p.fills).toEqual(b.p.fills);
    }
  });
});
