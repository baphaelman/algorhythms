/**
 * Strands and ropes (PLAN.md §11.3 "Thickness transitions", owner 2026-11-21): where lines merge,
 * they bundle like strands into a rope. Over the last part of their approach the arriving lines
 * move to lie side by side in pitch order around the meeting pitch, and their widths scale so that
 * at the meeting point they tile the merged line's width (√W·base) exactly; the merged line
 * starts there at full width. A split mirrors it: the rope separates into strands that peel off
 * from their places in it.
 *
 * Merges and splits crossfade (owner 2026-11-21): the sound and the drawing follow one function
 * of time. The compiler writes each crossfade into the score (a merging line's `Life.crossOut`
 * fade, ending where it meets the merged line; a newborn's `Life.crossIn` fade; the matching
 * `cross` weight change on the merged line or parent), and a strand bundles along core/ease
 * `crossfade` over exactly that window: `strandMix` is X(u) for a merge and 1 − X(u) for a
 * split, and the engine sounds a strand at power w·(1 − strandMix). Everything is cached per
 * score.
 */

import { crossfade } from '../core/ease';
import { pitchAt, weightTargetAt } from '../core/query';
import type { CompiledScore, CompiledVoice, Life, Seconds } from '../core/types';
import { smootherstep } from './level';

/** Shortest taper of a weight change that is not a merge or split (an edit), px. */
export const TAPER_PX = 32;
/** Thinnest and thickest drawn weights (line width ∝ √weight between them). */
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 16;
/**
 * Each strand but the lowest reaches this far (base-width units, at most that strand's width)
 * onto the strand below it as it bundles: adjacent anti-aliased edges would otherwise leave the tiled rope lighter than the line
 * it becomes.
 */
export const STRAND_LAP = 0.4;
/** Pitches this close count as one note. */
const SAME = 0.02;
const T_EPS = 1e-6;

/** Width of a line of weight w in units of the base width: √w, clamped. */
export function widthUnits(w: number): number {
  if (w === 1) return 1;
  return Math.sqrt(w > WEIGHT_MAX ? WEIGHT_MAX : w > WEIGHT_MIN ? w : WEIGHT_MIN);
}

interface Member {
  /** Pool index. */
  v: number;
  /** Weight it brings to (merge) or takes from (split) the rope. */
  w: number;
  /** Its crossfade window: [t − len, t] for a merge, [t, t + len] for a split. */
  len: Seconds;
}

/** One merge or split: lines meeting (or parting) at one time on one line. */
export interface Bundle {
  split: boolean;
  /** Meeting (merge) or birth (split) time. */
  t: Seconds;
  /** The merged line or the parent. */
  anchor: number;
  /** All strands, anchor included, top (highest pitch) first. */
  members: Member[];
}

interface VoiceStrands {
  /** The drawing's lives: a merged line ends at its meeting, a split's strand starts unfaded. */
  lives: Life[];
  /** Per weight change: drawn as a step at its `t` (merge, split, birth) rather than a taper. */
  steps: Uint8Array;
  /** Sorted times where this line's drawn geometry jumps (its bundles). */
  events: number[];
}

interface Strands {
  bundles: Bundle[];
  voices: (VoiceStrands | null)[];
}

const cache = new WeakMap<CompiledScore, Strands>();

/** The bundles of a compiled score, cached. */
export function strandsOf(score: CompiledScore): Strands {
  let s = cache.get(score);
  if (!s) {
    s = detect(score);
    cache.set(score, s);
  }
  return s;
}

/** Index of v's crossfade weight change made at t (rising: a merge, falling: a split), or −1. */
function crossIndex(v: CompiledVoice, t: Seconds, merge: boolean): number {
  const W = v.weight;
  if (!W) return -1;
  for (let k = 0; k < W.length; k++) {
    const c = W[k];
    if (c.t > t + T_EPS) break;
    if (!c.cross || Math.abs(c.t - t) > T_EPS) continue;
    // A merge's ramp ends at t (lead = over); a split's starts there.
    const lead = c.lead ?? 0;
    if (merge ? lead === c.over : lead === 0 && c.over > 0) return k;
  }
  return -1;
}

function detect(score: CompiledScore): Strands {
  const V = score.voices;
  const byKey = new Map<string, Bundle>();
  const stepMarks: [number, number][] = [];
  const cutLife = new Set<Life>(); // merged lives, ending at the meeting unfaded
  const unfaded = new Set<Life>(); // split strands, born unfaded

  const find = (me: CompiledVoice, t: Seconds, p: number, merge: boolean): CompiledVoice | null => {
    let best: CompiledVoice | null = null;
    let bestD = SAME;
    for (const a of V) {
      if (a === me || !a.weight || a.weight.length === 0) continue;
      const k = crossIndex(a, t, merge);
      if (k < 0) continue;
      const pa = pitchAt(a, merge ? t + T_EPS : t - T_EPS) ?? pitchAt(a, t);
      if (pa === null) continue;
      const d = Math.abs(pa - p);
      if (d <= bestD) {
        if (d === bestD && best) continue;
        best = a;
        bestD = d;
      }
    }
    if (best) {
      for (let k = 0; k < best.weight!.length; k++) {
        const c = best.weight![k];
        if (c.cross && Math.abs(c.t - t) <= T_EPS) stepMarks.push([best.index, k]);
      }
    }
    return best;
  };
  const bundle = (split: boolean, a: CompiledVoice, t: Seconds): Bundle => {
    const key = `${split ? 's' : 'm'}${a.index}:${t}`;
    let b = byKey.get(key);
    if (!b) {
      b = { split, t, anchor: a.index, members: [] };
      byKey.set(key, b);
    }
    return b;
  };

  for (const d of V) {
    for (const l of d.lives) {
      // A merge: d crossfades out, ending where it meets the merged line.
      if (l.crossOut && l.died !== undefined) {
        const t = l.died;
        const pd = pitchAt(d, t - T_EPS);
        const a = pd === null ? null : find(d, t, pd, true);
        if (a) {
          bundle(false, a, t).members.push({
            v: d.index,
            w: weightTargetAt(d, t - T_EPS),
            len: l.fadeOut ?? 0,
          });
          cutLife.add(l);
        }
      }
      // A split: d crossfades in on its parent's pitch as the parent's weight falls.
      if (l.crossIn) {
        const t = l.born;
        const pb = pitchAt(d, t);
        const a = pb === null ? null : find(d, t, pb, false);
        if (a) {
          bundle(true, a, t).members.push({
            v: d.index,
            w: weightTargetAt(d, t + T_EPS),
            len: l.fadeIn,
          });
          unfaded.add(l);
        }
      }
    }
  }

  const bundles = [...byKey.values()].sort(
    (x, y) => x.t - y.t || Number(x.split) - Number(y.split),
  );
  for (const b of bundles) {
    const a = V[b.anchor];
    let len = 0;
    for (const m of b.members) if (m.len > len) len = m.len;
    b.members.push({
      v: a.index,
      w: b.split ? weightTargetAt(a, b.t + T_EPS) : weightTargetAt(a, b.t - T_EPS),
      len,
    });
    sortByPitch(V, b);
  }

  const voices: (VoiceStrands | null)[] = V.map(() => null);
  const info = (i: number): VoiceStrands => {
    let s = voices[i];
    if (!s) {
      const v = V[i];
      s = {
        lives: v.lives,
        steps: new Uint8Array(v.weight?.length ?? 0),
        events: [],
      };
      voices[i] = s;
    }
    return s;
  };
  for (const [i, k] of stepMarks) info(i).steps[k] = 1;
  for (const b of bundles) for (const m of b.members) info(m.v).events.push(b.t);
  for (const s of voices) s?.events.sort((x, y) => x - y);
  V.forEach((v, i) => {
    const s = v.weight && v.weight.length > 0 ? info(i) : voices[i];
    if (!s) return;
    // A weight set at a birth is a step too.
    v.weight?.forEach((c, k) => {
      if (v.lives.some((l) => Math.abs(l.born - c.t) <= T_EPS)) s.steps[k] = 1;
    });
    if (v.lives.some((l) => cutLife.has(l) || unfaded.has(l))) {
      s.lives = v.lives.map((l) => {
        let out = l;
        if (cutLife.has(l)) out = { ...out, fadeOut: 0 };
        if (unfaded.has(l)) out = { ...out, fadeIn: 0 };
        return out;
      });
    }
  });
  return { bundles, voices };
}

/** Highest pitch first, judged just before a merge (or after a split), then further away. */
function sortByPitch(V: readonly CompiledVoice[], b: Bundle): void {
  const dir = b.split ? 1 : -1;
  const p0 = pitchAt(V[b.anchor], b.t + dir * T_EPS) ?? 0;
  const at = (m: Member, dt: number): number => pitchAt(V[m.v], b.t + dir * dt) ?? p0;
  b.members.sort((x, y) => {
    for (const dt of [0.01, 0.05, 0.2, 0.5, 1, 2, 4]) {
      const d = at(y, dt) - at(x, dt);
      if (Math.abs(d) > 1e-6) return d;
    }
    return x.v - y.v;
  });
}

/** A strand's window in one bundle. Widths and offsets in base-width units. */
interface Win {
  split: boolean;
  t: Seconds;
  /** Merge: the mix rises from 0 at s0 to 1 at t (its crossfade). */
  s0: Seconds;
  /** Split: the mix falls from 1 at t to 0 at e1 (its crossfade). */
  e1: Seconds;
  /** Centre offset in the rope (y down) and width there. */
  slot: number;
  share: number;
  /** Overlap onto the strand below (STRAND_LAP, 0 for the lowest). */
  lap: number;
}

/** Strand windows of one score at one zoom. */
export interface StrandFrame {
  strands: Strands;
  pps: number;
  /** Taper length of an edit's weight change, s. */
  taper: Seconds;
  wins: (Win[] | null)[];
}

let lastFrame: StrandFrame | null = null;

/** The strand windows for drawing `score` at `pps` px/s (the last one is reused). */
export function strandFrame(score: CompiledScore, pps: number): StrandFrame {
  const strands = strandsOf(score);
  if (lastFrame && lastFrame.strands === strands && lastFrame.pps === pps) return lastFrame;
  const f: StrandFrame = {
    strands,
    pps,
    taper: TAPER_PX / pps,
    wins: strands.voices.map((s) => (s && s.events.length > 0 ? [] : null)),
  };
  const V = score.voices;
  for (const b of strands.bundles) {
    // The rope: the merged line just after a merge; the parent as drawn just before a split.
    let A: number;
    let off = 0;
    if (b.split) {
      geometryAt(f, V[b.anchor], b.t, -1);
      A = geo.u;
      off = geo.off;
    } else {
      A = naturalUnits(f, V[b.anchor], b.t + T_EPS);
    }
    let sum = 0;
    for (const m of b.members) sum += m.w;
    let y = off - A / 2;
    const shareOf = (m: Member): number => (sum > 0 ? (A * m.w) / sum : A / b.members.length);
    for (let j = 0; j < b.members.length; j++) {
      const m = b.members[j];
      const below = b.members[j + 1];
      const lap = below ? Math.min(STRAND_LAP, shareOf(below)) : 0;
      const share = shareOf(m);
      const slot = y + share / 2;
      y += share;
      f.wins[m.v]!.push({
        split: b.split,
        t: b.t,
        s0: b.split ? b.t : b.t - m.len,
        e1: b.split ? b.t + m.len : b.t,
        slot,
        share,
        lap,
      });
    }
  }
  lastFrame = f;
  return f;
}

/** The drawing's lives of voice v (see `VoiceStrands.lives`). */
export function drawnLives(f: StrandFrame, v: CompiledVoice): readonly Life[] {
  return f.strands.voices[v.index]?.lives ?? v.lives;
}

/** True when v bundles somewhere (its drawing needs the outline path). */
export function hasStrands(f: StrandFrame, v: CompiledVoice): boolean {
  return f.wins[v.index] !== null;
}

/** Sorted times where v's drawn geometry jumps (its merges and splits). */
export function strandEvents(f: StrandFrame, v: CompiledVoice): readonly number[] {
  return f.strands.voices[v.index]?.events ?? NO_EVENTS;
}
const NO_EVENTS: number[] = [];

/**
 * The drawn weight of v at t, before bundling: merges, splits and births step; any other weight
 * change (an edit) tapers with a smootherstep over max(its ramp, TAPER_PX), centred on its ramp.
 */
export function naturalWeight(f: StrandFrame, v: CompiledVoice, t: Seconds): number {
  const W = v.weight;
  if (!W || W.length === 0) return 1;
  const steps = f.strands.voices[v.index]?.steps;
  let w = 1;
  let prev = 1;
  const half = f.taper / 2;
  for (let k = 0; k < W.length; k++) {
    const c = W[k];
    if (c.t - half > t) break;
    const d = c.w - prev;
    prev = c.w;
    if (steps?.[k]) {
      if (t >= c.t) w += d;
      continue;
    }
    const L = c.over > f.taper ? c.over : f.taper;
    const u = (t - (c.t + c.over / 2 - L / 2)) / L;
    w += u >= 1 ? d : u > 0 ? d * smootherstep(u) : 0;
  }
  return w;
}

function naturalUnits(f: StrandFrame, v: CompiledVoice, t: Seconds): number {
  return widthUnits(naturalWeight(f, v, t));
}

/** The active window of v at t, or null. */
function winAt(f: StrandFrame, v: CompiledVoice, t: Seconds): Win | null {
  const ws = f.wins[v.index];
  if (!ws) return null;
  for (const w of ws) {
    if (w.split ? t >= w.t && t <= w.e1 : t >= w.s0 && t <= w.t) return w;
  }
  return null;
}

/**
 * How bundled v is at t: 0 = drawn on its own, 1 = a strand of its rope (at a merge's meeting
 * point, or a split's birth). In between it follows core/ease `crossfade` over the crossfade the
 * compiler wrote, the same curve the engine fades the strand's sound by (power w·(1 − mix)).
 */
export function strandMix(f: StrandFrame, v: CompiledVoice, t: Seconds): number {
  const w = winAt(f, v, t);
  return w ? mixOf(w, t) : 0;
}

/** v's place in its rope at t (base-width units), while it is a strand; else null. */
export function strandSlot(
  f: StrandFrame,
  v: CompiledVoice,
  t: Seconds,
): { slot: number; share: number; lap: number } | null {
  const w = winAt(f, v, t);
  return w ? { slot: w.slot, share: w.share, lap: w.lap } : null;
}

/** The crossfade of a strand: X(u) through a merge's window, 1 − X(u) through a split's. */
function mixOf(w: Win, t: Seconds): number {
  if (w.split) {
    if (!(w.e1 > w.t)) return 1;
    return 1 - crossfade((t - w.t) / (w.e1 - w.t));
  }
  if (!(w.t > w.s0)) return 1;
  return crossfade((t - w.s0) / (w.t - w.s0));
}

/** Out-parameter of `geometryAt`: width and centre offset (y down), in base-width units. */
const geo = { u: 1, off: 0 };

/**
 * Drawn width and centre offset of v at t, in units of the base width, written to the returned
 * (shared) object. `side` −1/+1 takes the limit from the left/right at a bundle time.
 */
export function geometryAt(
  f: StrandFrame,
  v: CompiledVoice,
  t: Seconds,
  side = 0,
): { u: number; off: number } {
  const tt = side === 0 ? t : t + side * T_EPS * 0.5;
  const nat = naturalUnits(f, v, tt);
  const w = winAt(f, v, tt);
  if (!w) {
    geo.u = nat;
    geo.off = 0;
    return geo;
  }
  const e = mixOf(w, tt);
  const lap = w.lap * e * e;
  geo.u = nat + (w.share - nat) * e + lap;
  geo.off = w.slot * e + lap / 2;
  return geo;
}

/**
 * Time ranges over which v's drawn geometry changes (strand windows and weight tapers) that
 * intersect [a, b], as a flat [lo, hi, lo, hi, …] list. The drawing samples them densely.
 */
export function varyingRanges(f: StrandFrame, v: CompiledVoice, a: Seconds, b: Seconds): number[] {
  const out: number[] = [];
  for (const w of f.wins[v.index] ?? []) {
    const lo = w.split ? w.t : w.s0;
    const hi = w.split ? w.e1 : w.t;
    if (hi > a && lo < b) out.push(lo, hi);
  }
  const W = v.weight;
  if (W) {
    const steps = f.strands.voices[v.index]?.steps;
    for (let k = 0; k < W.length; k++) {
      if (steps?.[k]) continue;
      const c = W[k];
      const L = c.over > f.taper ? c.over : f.taper;
      const lo = c.t + c.over / 2 - L / 2;
      if (lo + L > a && lo < b) out.push(lo, lo + L);
    }
  }
  return out;
}
