/**
 * Strands and ropes (PLAN.md §11.3 "Thickness transitions", owner 2026-11-21): where lines merge,
 * they bundle like strands into a rope. Over the last part of their approach the arriving lines
 * move to lie side by side in pitch order around the meeting pitch, and their widths scale so that
 * at the meeting point they tile the merged line's width (√W·base) exactly; the merged line
 * starts there at full width. A split mirrors it: the rope separates into strands that peel off
 * from their places in it. Drawing only: the compiled score (sound, weights) is not changed.
 *
 * Bundles are read off the compiled score: a merge is a death whose hand-over time matches a
 * weight rise of a line on the same pitch (the survivor); a split is a birth that matches a
 * weight fall of a line on the same pitch (the parent). Everything is cached per score; window
 * lengths depend on the zoom and are resolved per frame (`strandFrame`).
 *
 * One function of time drives each strand: `strandMix` (0 = the line on its own, 1 = bundled).
 * Widths and offsets are interpolated by it; a later loudness ramp in core can use the same curve.
 */

import { lifeAt, pitchAt, segmentIndexAt, weightAt, weightTargetAt } from '../core/query';
import type { CompiledScore, CompiledVoice, Life, Seconds, Segment } from '../core/types';
import { smootherstep } from './level';

/** Shortest bundling span on screen, px. */
export const STRAND_PX = 32;
/** Otherwise the last part of the converging (or departing) glide, as a fraction of it. */
export const STRAND_GLIDE = 1 / 3;
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
  /** Length of its glide into the meeting (merge) or away from it (split); 0 if it holds. */
  glide: Seconds;
  /** Split: when it starts to leave the rope's pitch (Infinity: never within its life). */
  depart: Seconds;
}

/** One merge or split: lines meeting (or parting) at one time on one line. */
export interface Bundle {
  split: boolean;
  /** Meeting (merge) or birth (split) time. */
  t: Seconds;
  /** The survivor or parent, and the index of its weight change there. */
  anchor: number;
  k: number;
  /** All strands, anchor included, top (highest pitch) first. */
  members: Member[];
}

interface VoiceStrands {
  /** The drawing's lives: a merged line ends at its meeting, a split's strand starts unfaded. */
  lives: Life[];
  /** Per weight change: drawn as a step (merge, split, birth) rather than a taper. */
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

function moving(s: Segment): boolean {
  return s.p0 !== s.p1 || (s.m0 ?? 0) !== 0 || s.curve !== undefined;
}

/** Length of the moving run of segments ending at t (0 if v holds there). */
function glideInto(v: CompiledVoice, t: Seconds): Seconds {
  const segs = v.segments;
  let i = segmentIndexAt(v, t - T_EPS);
  let start = t;
  while (i >= 0 && segs[i].t1 >= start - T_EPS && moving(segs[i])) {
    start = segs[i].t0;
    i--;
  }
  return t - start;
}

/** First departure of v from its pitch at or after t within its life, and that glide's length. */
function departure(v: CompiledVoice, t: Seconds, end: Seconds): { at: Seconds; glide: Seconds } {
  const segs = v.segments;
  let i = Math.max(0, segmentIndexAt(v, t + T_EPS));
  for (; i < segs.length && segs[i].t0 < end; i++) {
    const s = segs[i];
    if (s.t1 <= t || !moving(s)) continue;
    const at = s.t0 > t ? s.t0 : t;
    let e = s.t1;
    for (let k = i + 1; k < segs.length && segs[k].t0 <= e + T_EPS && moving(segs[k]); k++)
      e = segs[k].t1;
    return { at, glide: e - at };
  }
  return { at: Infinity, glide: 0 };
}

function weightIndex(v: CompiledVoice, t: Seconds, rise: boolean): number {
  const W = v.weight;
  if (!W) return -1;
  for (let k = 0; k < W.length; k++) {
    const c = W[k];
    if (c.t > t + T_EPS) break;
    if (Math.abs(c.t - t) > T_EPS) continue;
    const before = weightAt(v, c.t - T_EPS);
    if (rise ? c.w > before + 1e-9 : c.w < before - 1e-9) return k;
  }
  return -1;
}

function detect(score: CompiledScore): Strands {
  const V = score.voices;
  const byKey = new Map<string, Bundle>();
  const stepMarks: [number, number][] = [];
  const cutLife = new Map<Life, Seconds>(); // merged lives, ending at the meeting
  const unfaded = new Set<Life>(); // split strands, born unfaded

  const find = (
    me: CompiledVoice,
    t: Seconds,
    p: number,
    rise: boolean,
  ): { a: CompiledVoice; k: number } | null => {
    let best: { a: CompiledVoice; k: number } | null = null;
    let bestD = SAME;
    for (const a of V) {
      if (a === me || !a.weight || a.weight.length === 0) continue;
      const k = weightIndex(a, t, rise);
      if (k < 0) continue;
      const life = lifeAt(a, t);
      if (!life || (!rise && life.born >= t - T_EPS)) continue;
      const pa = pitchAt(a, t);
      if (pa === null) continue;
      const d = Math.abs(pa - p);
      if (d <= bestD) {
        if (d === bestD && best) continue;
        best = { a, k };
        bestD = d;
      }
    }
    return best;
  };
  const bundle = (split: boolean, a: CompiledVoice, k: number, t: Seconds): Bundle => {
    const key = `${split ? 's' : 'm'}${a.index}:${k}`;
    let b = byKey.get(key);
    if (!b) {
      b = { split, t, anchor: a.index, k, members: [] };
      byKey.set(key, b);
      stepMarks.push([a.index, k]);
    }
    return b;
  };

  for (const d of V) {
    for (const l of d.lives) {
      // A merge: d's fade starts when its weight passes to the survivor.
      if (l.died !== undefined) {
        const h = l.died - (l.fadeOut ?? 0);
        const pd = pitchAt(d, h < l.died ? h : l.died - T_EPS);
        const hit = pd === null ? null : find(d, h, pd, true);
        if (hit) {
          const t = hit.a.weight![hit.k].t;
          const b = bundle(false, hit.a, hit.k, t);
          b.members.push({
            v: d.index,
            w: weightTargetAt(d, t - T_EPS),
            glide: glideInto(d, t),
            depart: 0,
          });
          cutLife.set(l, t);
        }
      }
      // A split: d is born on its parent's pitch as the parent's weight falls.
      const pb = pitchAt(d, l.born);
      const hit = pb === null ? null : find(d, l.born, pb, false);
      if (hit) {
        const t = hit.a.weight![hit.k].t;
        const b = bundle(true, hit.a, hit.k, t);
        const dep = departure(d, t, l.died ?? Infinity);
        b.members.push({
          v: d.index,
          w: weightTargetAt(d, t + T_EPS),
          glide: dep.glide,
          depart: dep.at,
        });
        unfaded.add(l);
      }
    }
  }

  const bundles = [...byKey.values()].sort(
    (x, y) => x.t - y.t || Number(x.split) - Number(y.split),
  );
  for (const b of bundles) {
    const a = V[b.anchor];
    if (b.split) {
      const life = lifeAt(a, b.t)!;
      const dep = departure(a, b.t, life.died ?? Infinity);
      let last = -Infinity;
      for (const m of b.members) last = Math.max(last, m.depart);
      // The parent stays in the rope until the last strand has left (or it leaves itself).
      b.members.push({
        v: a.index,
        w: a.weight![b.k].w,
        glide: dep.glide,
        depart: Math.min(dep.at, last),
      });
    } else {
      b.members.push({
        v: a.index,
        w: b.k > 0 ? a.weight![b.k - 1].w : 1,
        glide: glideInto(a, b.t),
        depart: 0,
      });
    }
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
        const cut = cutLife.get(l);
        let out = l;
        if (cut !== undefined) out = { ...out, died: cut, fadeOut: 0 };
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

/** A strand's window in one bundle, for one zoom. Widths and offsets in base-width units. */
interface Win {
  split: boolean;
  t: Seconds;
  /** Merge: the mix rises from 0 at s0 to 1 at t. */
  s0: Seconds;
  /** Split: the mix is 1 from t to ps, falls to 0 at e1. */
  ps: Seconds;
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
  const span = STRAND_PX / pps;
  const V = score.voices;
  for (const b of strands.bundles) {
    let L = span;
    for (const m of b.members) L = Math.max(L, STRAND_GLIDE * m.glide);
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
      const s = strands.voices[m.v]!;
      const own = m.v === b.anchor ? L : Math.max(span, STRAND_GLIDE * m.glide);
      if (b.split) {
        let hi = Infinity;
        for (const e of s.events)
          if (e > b.t + T_EPS) {
            hi = e;
            break;
          }
        const life = lifeIn(s.lives, b.t + T_EPS);
        if (life?.died !== undefined && life.died < hi) hi = life.died;
        const ps = Math.min(Math.max(m.depart, b.t), hi);
        f.wins[m.v]!.push({
          split: true,
          t: b.t,
          s0: b.t,
          ps,
          e1: Math.min(ps + own, hi),
          slot,
          share,
          lap,
        });
      } else {
        let lo = -Infinity;
        for (const e of s.events) if (e < b.t - T_EPS) lo = e;
        const life = lifeIn(s.lives, b.t - T_EPS);
        if (life && life.born > lo) lo = life.born;
        const s0 = Math.max(b.t - own, lo);
        f.wins[m.v]!.push({ split: false, t: b.t, s0, ps: b.t, e1: b.t, slot, share, lap });
      }
    }
  }
  lastFrame = f;
  return f;
}

function lifeIn(lives: readonly Life[], t: Seconds): Life | null {
  for (const l of lives) if (t >= l.born && (l.died === undefined || t < l.died)) return l;
  return null;
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
 * point, or a split's birth until the strand leaves). Smootherstep in between. The one curve that
 * drives a strand's width and place; a loudness hand-over could follow it too.
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

function mixOf(w: Win, t: Seconds): number {
  if (w.split) {
    if (t <= w.ps) return 1;
    if (!(w.e1 > w.ps)) return 1;
    return 1 - smootherstep((t - w.ps) / (w.e1 - w.ps));
  }
  if (!(w.t > w.s0)) return 1;
  return smootherstep((t - w.s0) / (w.t - w.s0));
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
    const lo = w.split ? w.ps : w.s0;
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
