/**
 * Thickness transitions (PLAN.md §11.3, owner 2026-11-21): lines bundle into a rope at a merge and
 * peel off it at a split; widths and places change continuously; filled outlines have round ends
 * only at a line's true ends.
 */

import { describe, expect, it } from 'vitest';
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
 * v1 (from 64) and v2 (from 55) glide 2–5 s onto v0's 60 and merge into it (weight 3, the
 * compiler's 0.1 s hand-over); at 12 s two forks are born on 60 and glide back out by 15 s.
 */
function mergeSplit(): CompiledScore {
  const strand = (i: number, p: number): CompiledVoice =>
    voice(
      i,
      [
        { born: 0, fadeIn: 0, died: 5.1, fadeOut: 0.1 },
        { born: 12, fadeIn: 0.1 },
      ],
      [hold(0, 2, p), glide(2, 5, p, 60), hold(5, 5.1, 60), glide(12, 15, 60, p), hold(15, 20, p)],
    );
  return {
    duration: 20,
    voices: [
      voice(
        0,
        [{ born: 0, fadeIn: 0 }],
        [hold(0, 20, 60)],
        [
          { t: 5, w: 3, over: 0.1 },
          { t: 12, w: 1, over: 0.1 },
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
    // The merged lines stop at the meeting point.
    const xm = timeToX(view, 5);
    for (const f of p.fills.filter((q) => q.style === '#aa0001'))
      for (const [px] of f.pts)
        expect(px <= xm + 0.01 || px >= timeToX(view, 12) - 0.01).toBe(true);
    // At the meeting the union of the strands spans the rope.
    const yc = pitchToY(view, 60);
    const near = p.fills.flatMap((f) => f.pts).filter(([px]) => Math.abs(px - xm) < 1e-6);
    const top = Math.min(...near.map((q) => q[1]));
    const bottom = Math.max(...near.map((q) => q[1]));
    expect(top).toBeCloseTo(yc - (ROPE * 1.5) / 2, 9);
    expect(bottom).toBeCloseTo(yc + (ROPE * 1.5) / 2, 9);
  });
});
