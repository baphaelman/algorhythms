/**
 * `spread` (§6.2): p → c + factor·(p − c), then snaps (`scale`: the key in effect, ties down;
 * `chromatic`: nearest semitone, ties down; `none`).
 *
 * Factor ≥ 0 (§11.3 "Spread keeps its shape at range edges"): targets keep pitch order, stay in
 * range and are distinct notes, so the moment is `ordered` and nothing folds (§7.8):
 * - each side of c is compressed (one scale per side) so no target leaves its voice's range;
 * - targets snap inside the range;
 * - coinciding targets are nudged to the nearest free steps (minimal-displacement isotonic fit
 *   in step space, ties down), then repaired against the range bounds. `snap: 'none'` keeps its
 *   exact targets unless two coincide, then uses the semitone grid.
 * If the ranges can't hold them all apart, `spread-crowded` (warn) and some still coincide.
 *
 * A negative factor mirrors the voicing, which crosses every pair by design; it is treated like
 * `free` (exempt from the crossing guarantee) and keeps the plain formula.
 */

import { pitchOfDegreeIndex, scaleDegreeIndex, snapToScale } from '../scales';
import type { Key, Pitch, SpreadMoment } from '../types';
import { roundTiesDown } from '../voicing';
import { movesTo, type MomentEnv, type MomentPlan } from './types';

/** Targets closer than this coincide (snap 'none'). */
const SAME = 1e-6;

export function spreadMoment(m: SpreadMoment, env: MomentEnv): MomentPlan | null {
  const vs = env.targeted;
  if (vs.length === 0) {
    env.diag('info', 'no-targets', 'The spread targets no active voice.');
    return null;
  }
  if (!Number.isFinite(m.factor)) {
    env.diag('error', 'invalid-moment', 'The spread factor is not a number.');
    return null;
  }
  const dests = vs.map((v) => env.dest(v)); // ascending
  let c: Pitch;
  if (m.around === 'mean') {
    let s = 0;
    for (const d of dests) s += d;
    c = s / dests.length;
  } else if (m.around === 'median') {
    const n = dests.length;
    c = n % 2 === 1 ? dests[(n - 1) / 2] : (dests[n / 2 - 1] + dests[n / 2]) / 2;
  } else if (Number.isFinite(m.around)) {
    c = m.around;
  } else {
    env.diag('error', 'invalid-moment', 'The spread centre is not a number.');
    return null;
  }
  const f = m.factor;
  if (f < 0) {
    const targets = dests.map((d) => snapOne(c + f * (d - c), m.snap, env.key));
    return { ordered: false, intents: movesTo(vs, targets) };
  }
  const ranges = vs.map((v) => env.range(v));
  const targets = spreadInRange(dests, ranges, c, f, m.snap, env.key);
  if (!targets.ok) {
    env.diag(
      'warn',
      'spread-crowded',
      'The spread has more notes than their ranges can hold apart; some coincide.',
    );
  }
  return { ordered: true, intents: movesTo(vs, targets.pitches) };
}

function snapOne(x: Pitch, snap: SpreadMoment['snap'], key: Key): Pitch {
  if (snap === 'scale') return snapToScale(x, key);
  if (snap === 'chromatic') return roundTiesDown(x);
  return x;
}

/**
 * The factor ≥ 0 targets for ascending `dests` (see the module comment). Voices that share a
 * destination are one note and keep sharing it (in the intersection of their ranges). `ok` is
 * false when the ranges can't hold every note apart.
 */
export function spreadInRange(
  dests: readonly Pitch[],
  ranges: readonly (readonly [Pitch, Pitch])[],
  c: Pitch,
  f: number,
  snap: SpreadMoment['snap'],
  key: Key,
): { pitches: Pitch[]; ok: boolean } {
  const notes: Pitch[] = [];
  const noteRanges: [Pitch, Pitch][] = [];
  const noteOf: number[] = [];
  for (let i = 0; i < dests.length; i++) {
    const j = notes.length - 1;
    const [lo, hi] = ranges[i];
    if (j >= 0 && dests[i] - notes[j] < SAME) {
      const r = noteRanges[j];
      if (lo > r[0] && lo <= r[1]) r[0] = lo;
      if (hi < r[1] && hi >= r[0]) r[1] = hi;
    } else {
      notes.push(dests[i]);
      noteRanges.push([lo, hi]);
    }
    noteOf.push(notes.length - 1);
  }
  const r = spreadNotes(notes, noteRanges, c, f, snap, key);
  return { pitches: noteOf.map((j) => r.pitches[j]), ok: r.ok };
}

/** `spreadInRange` for distinct ascending `dests`. */
function spreadNotes(
  dests: readonly Pitch[],
  ranges: readonly (readonly [Pitch, Pitch])[],
  c: Pitch,
  f: number,
  snap: SpreadMoment['snap'],
  key: Key,
): { pitches: Pitch[]; ok: boolean } {
  const n = dests.length;
  // One compression per side: the largest k ≤ 1 that keeps every voice on it inside its range.
  let kLo = 1;
  let kHi = 1;
  for (let i = 0; i < n; i++) {
    const o = f * (dests[i] - c);
    const [lo, hi] = ranges[i];
    if (o < 0 && c >= lo && c + o < lo) kLo = Math.min(kLo, (c - lo) / -o);
    if (o > 0 && c <= hi && c + o > hi) kHi = Math.min(kHi, (hi - c) / o);
  }
  const raw = dests.map((d, i) => {
    const o = f * (d - c);
    const x = c + (o < 0 ? kLo : kHi) * o;
    const [lo, hi] = ranges[i];
    return x < lo ? lo : x > hi ? hi : x;
  });

  if (snap === 'none') {
    let apart = true;
    for (let i = 1; i < n; i++) if (raw[i] - raw[i - 1] < SAME) apart = false;
    if (apart) return { pitches: raw, ok: true };
  }
  const grid = snap === 'scale' ? scaleGrid(key) : CHROMATIC;
  const lo = ranges.map((r) => grid.ceil(r[0]));
  const hi = ranges.map((r) => grid.floor(r[1]));
  const g = raw.map((x, i) => {
    const s = grid.index(snap === 'scale' ? snapToScale(x, key) : roundTiesDown(x));
    return Math.max(lo[i], Math.min(hi[i], s));
  });
  const h = apartIndices(g, lo, hi);
  let ok = true;
  for (let i = 0; i < n; i++) {
    if (h[i] < lo[i] || h[i] > hi[i] || (i > 0 && h[i] <= h[i - 1])) ok = false;
  }
  if (!ok) inRangeInOrder(h, lo, hi);
  return { pitches: h.map((i) => grid.pitch(i)), ok };
}

/**
 * Crowded (some notes coincide): h in each voice's [lo, hi] and non-decreasing (seed
 * −625473937). Clamped to the bounds every ordered choice has (the highest lo at or below a
 * voice, the lowest hi at or above), then a running maximum, which stays within them. When the
 * ranges admit no ordered choice, just clamped to each range.
 */
function inRangeInOrder(h: number[], lo: readonly number[], hi: readonly number[]): void {
  const n = h.length;
  const u: number[] = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) u[i] = i + 1 < n && u[i + 1] < hi[i] ? u[i + 1] : hi[i];
  let l = -Infinity;
  let feasible = true;
  for (let i = 0; i < n; i++) {
    if (lo[i] > l) l = lo[i];
    if (l > u[i]) feasible = false;
  }
  l = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!feasible) {
      h[i] = Math.max(lo[i], Math.min(hi[i], h[i]));
      continue;
    }
    if (lo[i] > l) l = lo[i];
    let x = Math.max(l, Math.min(u[i], h[i]));
    if (i > 0 && x < h[i - 1]) x = h[i - 1];
    h[i] = x;
  }
}

/** A pitch grid: step indices, monotone in pitch. */
interface Grid {
  index(p: Pitch): number;
  pitch(i: number): Pitch;
  /** Index of the lowest grid pitch ≥ p. */
  ceil(p: Pitch): number;
  /** Index of the highest grid pitch ≤ p. */
  floor(p: Pitch): number;
}

const CHROMATIC: Grid = {
  index: (p) => p,
  pitch: (i) => i,
  ceil: (p) => Math.ceil(p),
  floor: (p) => Math.floor(p),
};

function scaleGrid(key: Key): Grid {
  const index = (p: Pitch) => scaleDegreeIndex(p, key);
  const pitch = (i: number) => pitchOfDegreeIndex(i, key);
  return {
    index,
    pitch,
    ceil: (p) => {
      const i = index(p);
      return pitch(i) < p ? i + 1 : i;
    },
    floor: (p) => {
      const i = index(p);
      return pitch(i) > p ? i - 1 : i;
    },
  };
}

/**
 * Strictly increasing step indices near `g` within [lo, hi] where possible. Already strictly
 * increasing input is returned as is; otherwise the nearest strictly increasing sequence
 * (pool-adjacent-violators on g[i] − i, rounded ties down), then a forward and a backward pass
 * against the bounds.
 */
function apartIndices(g: number[], lo: number[], hi: number[]): number[] {
  const n = g.length;
  let inc = true;
  for (let i = 1; i < n; i++) if (g[i] <= g[i - 1]) inc = false;
  if (inc) return g.slice();
  // PAV on y = g − i: blocks of (mean, size), merged while a block's mean falls below the last.
  const mean: number[] = [];
  const size: number[] = [];
  for (let i = 0; i < n; i++) {
    let mu = g[i] - i;
    let w = 1;
    while (mean.length > 0 && mean[mean.length - 1] > mu) {
      const pm = mean.pop()!;
      const pw = size.pop()!;
      mu = (pm * pw + mu * w) / (pw + w);
      w += pw;
    }
    mean.push(mu);
    size.push(w);
  }
  const h: number[] = [];
  for (let b = 0; b < mean.length; b++) {
    const z = roundTiesDown(mean[b]);
    for (let j = 0; j < size[b]; j++) h.push(z + h.length);
  }
  for (let i = 0; i < n; i++) if (h[i] < lo[i]) h[i] = lo[i];
  for (let i = 1; i < n; i++) if (h[i] <= h[i - 1]) h[i] = h[i - 1] + 1;
  for (let i = n - 1; i >= 0; i--) {
    if (h[i] > hi[i]) h[i] = hi[i];
    if (i < n - 1 && h[i] >= h[i + 1]) h[i] = h[i + 1] - 1;
  }
  return h;
}
