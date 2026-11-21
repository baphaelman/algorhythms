/**
 * Planning a point moment's moves (PLAN.md §7.1 step 3 "moment", §7.2, §7.4, §7.5).
 *
 * Given the intents a moment function returned, the planner:
 * 1. folds targets into ranges (§7.8);
 * 2. draws start offsets and durations (stagger, order, jitter; §5, §7.7) for every moving,
 *    newborn and dying voice alike (revision 9: splits and merges honour stagger and order); a
 *    newborn forks from its parent's pitch at its own start (§7.4); under `arrive: 'together'`
 *    (default, revision 6) every duration instead runs to one shared end (the latest start + the
 *    moment's jittered length, or the arrival of a `land` moment), so start changes below
 *    (adoption, pull-back) keep that end;
 * 3. under `ordered`, sets each mover's overshoot limit L = min(1 semitone, gap to its neighbour)
 *    (§7.5) and enforces the crossing guarantee (§7.2): every adjacent pair of targeted voices is
 *    sampled at 64 points over the moment's window; if a pair crosses, the overtaking voice adopts
 *    the overtaken voice's start time and duration (timing groups merge, union-find), repeated
 *    until no pair crosses. A voice still gliding from an earlier moment that gets overtaken is
 *    re-timed with the group (it gets a move to its own destination). A pair that crosses before
 *    its group starts (in glides left over from an earlier moment) gets the group's start pulled
 *    back to just before the crossing. Where equal timing cannot remove a crossing caused by
 *    carried velocity, m₀ is tightened (`crossScale`); whatever is left is reported
 *    (`crossing-unresolved`);
 * 4. for subset selectors, reports moves through untargeted voices (`crossing-untargeted`).
 *
 * All curves are read from projections (project.ts), which run the simulation's own code.
 */

import { CHECK_SAMPLES, FREE_LIMITS, MAX_OVERSHOOT, type OvershootLimits } from '../interrupt';
import type { DiagnosticLevel, Glide, Pitch, Seconds } from '../types';
import { IntentKind, type MomentPlan } from '../moments/types';
import { arrivesTogether, birthFadeIn, drawTimings, MIN_GLIDE, sharedEnd } from './glide';
import { Projector, type Projection, type Tentative } from './project';
import { foldIntoRange } from './range';
import type { Birth, Move, VoiceRun } from './voice';

/** Order reversals smaller than this are touching, not crossing (semitones). */
export const CROSS_EPS = 1e-9;

/**
 * Local copy of CHECK_SAMPLES for the hot loops: under Vitest's module runner an imported binding
 * is a getter call on every read.
 */
const SAMPLES = CHECK_SAMPLES;
/** The crossing scan skips blocks of BLOCK samples that provably cannot cross (BLOCKS of them). */
const BLOCK = 8;
const BLOCKS = SAMPLES / BLOCK;

/**
 * Scratch for the crossing check, reused across moments (the compiler is single-threaded and
 * planMoment does not nest): per part, SAMPLES pitches and BLOCKS [low, high] bounds, each with
 * the generation it was computed for. Generations only grow, so stale entries never match.
 */
let SAMP = new Float64Array(0);
let SAMP_STAMP = new Float64Array(0);
let BLK = new Float64Array(0);
let BLK_STAMP = new Float64Array(0);
let genSeq = 0;
/** Check times of the moment being planned. */
const TIMES = new Float64Array(SAMPLES);

/**
 * A packed array of n copies of v. Per-moment arrays are plain arrays: a small typed array costs
 * an off-heap allocation.
 */
function filled(n: number, v: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(v);
  return a;
}
const nextGen = (): number => ++genSeq;

const enum PartKind {
  Fixed = 0,
  Move = 1,
  Birth = 2,
  Death = 3,
}

interface Part {
  voice: number;
  kind: PartKind;
  /** Final pitch: the target, or the committed destination for fixed voices. */
  to: Pitch;
  /** Committed destination before this moment (for newborns: the parent's). */
  preDest: Pitch;
  /** Births: pool index of the parent, or −1. */
  parent: number;
  fade: Seconds;
  /** Deaths: the survivor it merges into, or −1. */
  into: number;
  /** The voice is not born yet: its move cannot start before this time. */
  deferT: Seconds;
  limits: OvershootLimits;
  crossScale: number;
  move: Move | null;
  birth: Birth | null;
  /**
   * Generation of the part's projection, from `nextGen`: renewed whenever its curve may change.
   * Its cached samples and block bounds (in the scratch arrays, at its part index) are valid
   * while their stamps equal it.
   */
  gen: number;
  /** Index in `parts`. */
  slot: number;
  /** Cached pitch bounds over the window (valid for the current projection). */
  bnd: [Pitch, Pitch] | null;
  /** The part's projection, cached (cleared with `gen`). */
  proj: Projection | null;
}

/** What the planner needs from the compiler. */
/** Compile option: 'forbid' (default) enforces §7.2; 'allow' skips it. */
export type CrossingsMode = 'forbid' | 'allow';

export interface PlanHost {
  readonly voices: readonly VoiceRun[];
  readonly t: Seconds;
  readonly momentId: string;
  readonly momentIndex: number;
  readonly glide: Glide;
  readonly seed: number;
  /** 'allow' skips crossing enforcement and its diagnostics (dev toggle). */
  readonly crossings?: CrossingsMode;
  /**
   * Revision 9 `land`: the arrival time (`at`; `t` is then the lead-in start). Under 'together'
   * every move ends there; under 'spread' the timings are as usual from `t`.
   */
  readonly land?: Seconds;
  /** Committed destination (after the targeted voices' pending moves were cancelled). */
  dest(v: number): Pitch;
  diag(level: DiagnosticLevel, code: string, message: string): void;
}

/** Trace of one planned moment, for property tests (compileWithTrace). */
export interface PlanTrace {
  /** Participants in crossing-check order (pool indices); empty unless ordered. */
  order: number[];
  /** Pool indices that got a move, birth or death. */
  movers: number[];
  window: [Seconds, Seconds];
  ordered: boolean;
  /** Per mover: its overshoot limits and crossing scale. */
  limits: { voice: number; up: number; down: number; crossScale: number }[];
}

export interface PlanResult {
  births: Birth[];
  moves: Move[];
  trace: PlanTrace;
}

/**
 * Plans the moves of a moment. `targeted` are the targeted active voices (sorted by committed
 * destination); `subset` is true when the selector is not 'all' (§7.2 scope).
 */
export function planMoment(
  host: PlanHost,
  plan: MomentPlan,
  targeted: readonly number[],
  subset: boolean,
): PlanResult {
  const { voices, t: T, glide, seed } = host;
  const ordered = plan.ordered;
  const enforceCrossings = host.crossings !== 'allow';

  // 1. Ranges (§7.8).
  let folded = 0;
  let clamped = 0;
  let invalid = 0;
  for (const it of plan.intents) {
    const r = voices[it.voice].range;
    if (!Number.isFinite(it.to)) {
      // A moment function must never return a non-finite target (NaN would reach the output and
      // the voice-leading search); keep the voice where it is heading instead.
      invalid++;
      const keep =
        it.kind === IntentKind.Birth
          ? it.parent !== undefined && it.parent >= 0
            ? host.dest(it.parent)
            : NaN
          : host.dest(it.voice);
      it.to = Number.isFinite(keep) ? keep : (r[0] + r[1]) / 2;
    }
    const f = foldIntoRange(it.to, r[0], r[1]);
    if (f.folded) folded++;
    if (f.clampedToRange) clamped++;
    it.to = f.p;
  }
  if (invalid > 0) {
    host.diag('warn', 'invalid-target', `${invalid} target(s) were not finite pitches; kept.`);
  }
  if (folded > 0) {
    host.diag(
      'info',
      'range-fold',
      `${folded} target(s) outside a voice's range were folded by octave.`,
    );
  }
  if (clamped > 0) {
    host.diag(
      'warn',
      'range-too-narrow',
      `${clamped} target(s) could not be folded into a range narrower than an octave; clamped.`,
    );
  }

  // 2. Participants.
  const parts: Part[] = [];
  const partOf = new Map<number, number>();
  const mk = (voice: number, kind: PartKind, to: Pitch, preDest: Pitch): Part => {
    const run = voices[voice];
    const p: Part = {
      voice,
      kind,
      to,
      preDest,
      parent: -1,
      fade: 0,
      into: -1,
      deferT: run.pendingBirth ? run.pendingBirth.t : -Infinity,
      limits: FREE_LIMITS,
      crossScale: 1,
      move: null,
      birth: null,
      gen: nextGen(),
      slot: parts.length,
      bnd: null,
      proj: null,
    };
    partOf.set(voice, parts.length);
    parts.push(p);
    return p;
  };
  for (const it of plan.intents) {
    if (it.kind === IntentKind.Birth) continue;
    const d = host.dest(it.voice);
    if (it.kind === IntentKind.Death) {
      const p = mk(it.voice, PartKind.Death, it.to, d);
      p.fade = it.fade ?? 0;
      p.into = it.into ?? -1;
    } else if (it.to !== d) {
      mk(it.voice, PartKind.Move, it.to, d);
    } else if (ordered) {
      mk(it.voice, PartKind.Fixed, d, d);
    }
  }
  if (ordered) {
    for (const v of targeted) if (!partOf.has(v)) mk(v, PartKind.Fixed, host.dest(v), host.dest(v));
  }
  for (const it of plan.intents) {
    if (it.kind !== IntentKind.Birth) continue;
    const parent = it.parent ?? -1;
    const p = mk(it.voice, PartKind.Birth, it.to, parent >= 0 ? host.dest(parent) : it.to);
    p.parent = parent;
    // A parent not born yet (a newborn of an earlier moment) cannot be forked from before it
    // sounds: the newborn waits for it (§7.4).
    const pb = parent >= 0 ? voices[parent].pendingBirth : null;
    p.deferT = pb ? pb.t : -Infinity;
  }
  const n = parts.length;

  // 3. Timings (§5, §7.4, §7.7): stratified offsets over every mover, newborn and dying voice,
  // ranked by `order` from the pitch it starts on (newborns: the parent's), then its target
  // (revision 9: splits and merges honour stagger and order).
  const movers = parts
    .map((_, i) => i)
    .filter((i) => parts[i].kind !== PartKind.Fixed)
    .sort(
      (a, b) =>
        parts[a].preDest - parts[b].preDest ||
        parts[a].to - parts[b].to ||
        parts[a].voice - parts[b].voice,
    );
  const drawn = drawTimings(
    movers.map((i) => ({ hash: voices[parts[i].voice].hash, index: parts[i].voice })),
    glide,
    seed,
  );
  const uf = filled(n, 0);
  const gStart = filled(n, 0);
  const gDur = filled(n, 0);
  const gLink = filled(n, -1);
  for (let i = 0; i < n; i++) uf[i] = i;
  movers.forEach((i, r) => {
    gStart[i] = T + drawn[r].offset;
    gDur[i] = drawn[r].dur;
  });
  const find = (i: number): number => {
    while (uf[i] !== i) {
      uf[i] = uf[uf[i]];
      i = uf[i];
    }
    return i;
  };
  const startOf = (i: number): Seconds => {
    const r = find(i);
    const s = gLink[r] >= 0 ? startOf(gLink[r]) : gStart[r];
    return s > parts[i].deferT ? s : parts[i].deferT;
  };
  // Arrive together (§7.2, revision 6): every duration runs to one shared end, the latest drawn
  // start plus the moment's jittered length. Fix-ups (adoption, pull-back) only copy existing
  // starts or move them earlier, and keep that end.
  const together = arrivesTogether(glide);
  let lastStart = T;
  if (together) {
    for (let i = 0; i < n; i++) {
      if (parts[i].kind === PartKind.Fixed) continue;
      const s = startOf(i);
      if (s > lastStart) lastStart = s;
    }
  }
  // Land (revision 9): the caller started the moment its lead-in before the arrival.
  const endT = together ? (host.land ?? sharedEnd(lastStart, glide, seed)) : 0;
  const durOf = together
    ? (i: number): Seconds => {
        const d = endT - startOf(i);
        return d > MIN_GLIDE ? d : MIN_GLIDE;
      }
    : (i: number): Seconds => gDur[find(i)];

  // 4. Overshoot limits (§7.5): L = min(1, gap to the neighbour) under `ordered`.
  const order = parts.map((_, i) => i);
  if (ordered) {
    order.sort(
      (a, b) =>
        parts[a].to - parts[b].to ||
        parts[a].preDest - parts[b].preDest ||
        parts[a].voice - parts[b].voice,
    );
    for (let k = 0; k < n; k++) {
      const p = parts[order[k]];
      if (p.kind === PartKind.Fixed) continue;
      let up = MAX_OVERSHOOT;
      let down = MAX_OVERSHOOT;
      if (k + 1 < n) {
        const q = parts[order[k + 1]];
        const g = Math.min(Math.abs(q.preDest - p.preDest), Math.abs(q.to - p.to));
        if (g < up) up = g;
      }
      if (k > 0) {
        const q = parts[order[k - 1]];
        const g = Math.min(Math.abs(q.preDest - p.preDest), Math.abs(q.to - p.to));
        if (g < down) down = g;
      }
      p.limits = { up, down };
    }
  }

  // Tentative records.
  const ease = glide.ease;
  const makeMove = (p: Part, i: number): Move => ({
    voice: p.voice,
    t0: startOf(i),
    dur: durOf(i),
    to: p.to,
    ease,
    momentId: host.momentId,
    limits: p.limits,
    crossScale: p.crossScale,
    death: p.kind === PartKind.Death ? { fade: p.fade, into: p.into } : undefined,
    cancelled: false,
    momentIndex: host.momentIndex,
  });
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    if (p.kind === PartKind.Fixed) continue;
    p.move = makeMove(p, i);
    if (p.kind === PartKind.Birth) {
      p.birth = {
        voice: p.voice,
        t: p.move.t0,
        parent: p.parent,
        pitch: p.to,
        fadeIn: birthFadeIn(glide),
        momentId: host.momentId,
      };
    }
  }
  const tentative = new Map<number, Tentative>();
  for (const p of parts) {
    if (p.move) tentative.set(p.voice, { birth: p.birth, moves: [p.move] });
  }
  const projector = new Projector(voices, (v) => tentative.get(v));

  // A newborn's path reads its parent's (left-limit) state, so a change to a voice's schedule
  // also invalidates the voices it parents: this moment's newborns and pending ones.
  const children = new Map<number, number[]>();
  const addChild = (parent: number, child: number): void => {
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  };
  for (const run of voices) {
    const b = tentative.get(run.index)?.birth ?? run.pendingBirth;
    if (b && b.parent >= 0) addChild(b.parent, run.index);
  }
  const touched = filled(n, 0);
  /** Per-part version, bumped whenever its curve may change. */
  const ver = filled(n, 0);
  /** Per adjacent pair k: 1 + versions at which it was last found clear (0 = unknown). */
  const clearAt = filled(n, 0);
  const invalidate = (v: number, depth = 0): void => {
    projector.invalidate(v);
    const pi = partOf.get(v);
    if (pi !== undefined) {
      parts[pi].gen = nextGen();
      parts[pi].proj = null;
      parts[pi].bnd = null;
      touched[pi] = 1;
      ver[pi]++;
    }
    if (depth < 40) for (const c of children.get(v) ?? []) invalidate(c, depth + 1);
  };

  /** Re-applies group timings and scales to the tentative records; invalidates what changed. */
  const sync = (): void => {
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      if (!p.move) continue;
      const s = startOf(i);
      const d = durOf(i);
      if (s !== p.move.t0 || d !== p.move.dur || p.crossScale !== p.move.crossScale) {
        p.move.t0 = s;
        p.move.dur = d;
        p.move.crossScale = p.crossScale;
        if (p.birth) p.birth.t = s;
        invalidate(p.voice);
      }
    }
  };

  // Window: the moment's time to the latest end of anything moving. Timing adoption only copies
  // timings that exist (deferred starts included below), so this bound holds throughout.
  let we = T;
  let maxDur = 0;
  let maxDefer = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const e = p.move ? p.move.t0 + p.move.dur : projector.get(p.voice).lastGlideEnd();
    if (e > we) we = e;
    if (p.move && p.move.dur > maxDur) maxDur = p.move.dur;
    if (p.deferT > maxDefer) maxDefer = p.deferT;
  }
  if (maxDefer + maxDur > we) we = maxDefer + maxDur;
  const times = TIMES;
  for (let j = 0; j < SAMPLES; j++) times[j] = T + ((we - T) * j) / (SAMPLES - 1);
  if (SAMP.length < n * SAMPLES) {
    SAMP = new Float64Array(n * SAMPLES);
    SAMP_STAMP = new Float64Array(n * SAMPLES);
    BLK = new Float64Array(n * 2 * BLOCKS);
    BLK_STAMP = new Float64Array(n * BLOCKS);
  }
  const samp = SAMP;
  const sampStamp = SAMP_STAMP;
  const blk = BLK;
  const blkStamp = BLK_STAMP;
  const projOf = (p: Part): Projection => p.proj ?? (p.proj = projector.get(p.voice));
  /** Pitch of a part at check time j (cached). */
  const sampleAt = (p: Part, j: number): Pitch => {
    const k = p.slot * SAMPLES + j;
    if (sampStamp[k] !== p.gen) {
      samp[k] = projOf(p).pitchAt(times[j]);
      sampStamp[k] = p.gen;
    }
    return samp[k];
  };
  /** All samples of a part (filled in time order); a view, overwritten when the part changes. */
  const sample = (p: Part): Float64Array => {
    for (let j = 0; j < SAMPLES; j++) sampleAt(p, j);
    const o = p.slot * SAMPLES;
    return samp.subarray(o, o + SAMPLES);
  };
  const boundsOf = (p: Part): [Pitch, Pitch] => p.bnd ?? (p.bnd = projOf(p).bounds(T, we));
  /** Bounds of a part over check block b: the offset of [low, high] in `blk`. */
  const blockOf = (p: Part, b: number): number => {
    const k = p.slot * BLOCKS + b;
    if (blkStamp[k] !== p.gen) {
      const j = b * BLOCK;
      projOf(p).boundsIn(times[j], times[j + BLOCK - 1], blk, 2 * k);
      blkStamp[k] = p.gen;
    }
    return 2 * k;
  };

  /** Reference sample of the last `crossing` call (first sample where both sound). */
  let crossRef = 0;
  /** Part index of the newborn of the last `crossing` call that returned −3. */
  let crossBirth = -1;
  /**
   * First sample index where lo is above hi; −1 if none; −2 if they are already out of order at
   * the first sample where both sound (not this moment's doing); −3 if a newborn of this moment
   * starts out of order (sets `crossBirth`). Sets `crossRef`.
   *
   * Samples are read lazily: after the reference sample, a block of BLOCK samples is skipped when
   * the pair's bounds over it (`Projection.boundsIn`) prove no sample there can be out of order.
   * The result is the same as scanning every sample.
   */
  const crossing = (lo: Part, hi: Part): number => {
    // Exact pruning: if lo's highest possible pitch is not above hi's lowest, they cannot cross.
    const bl = boundsOf(lo);
    const bh = boundsOf(hi);
    if (bl[1] <= bh[0] + CROSS_EPS) return -1;
    if (!projOf(lo).anyOrder || !projOf(hi).anyOrder) {
      sample(lo); // fill in time order, as `pitchAt` then requires
      sample(hi);
    } else {
      // A newborn of this moment starts in order with its neighbour (M4.5-17): checked at its
      // birth instant, which the sample grid can miss.
      for (const p of [lo, hi]) {
        if (p.kind !== PartKind.Birth || !p.birth) continue;
        const tb = p.birth.t;
        const x = projOf(lo).pitchAt(tb);
        const y = projOf(hi).pitchAt(tb);
        if (x > y + CROSS_EPS) {
          crossBirth = p.slot;
          return -3;
        }
      }
    }
    let j = 0;
    for (; j < SAMPLES; j++) {
      const x = sampleAt(lo, j);
      const y = sampleAt(hi, j);
      if (x !== x || y !== y) continue;
      crossRef = j;
      if (x > y + CROSS_EPS) return -2;
      break;
    }
    for (j++; j < SAMPLES;) {
      const b = (j / BLOCK) | 0;
      const end = (b + 1) * BLOCK;
      const ol = blockOf(lo, b);
      const oh = blockOf(hi, b);
      if (blk[ol + 1] <= blk[oh] + CROSS_EPS) {
        j = end;
        continue;
      }
      for (; j < end; j++) {
        const x = sampleAt(lo, j);
        const y = sampleAt(hi, j);
        if (x !== x || y !== y) continue;
        if (x > y + CROSS_EPS) return j;
      }
    }
    return -1;
  };

  const enforce =
    ordered && enforceCrossings && n >= 2 && parts.some((p) => p.kind !== PartKind.Fixed);
  const unresolved = new Set<number>();
  if (enforce) {
    const isMover = (p: Part): boolean => p.kind !== PartKind.Fixed;
    /**
     * Scales down the carried velocity of the movers among (lo, up) until they stop crossing
     * (§7.2: "the overshoot clamp is tightened to the gap"). Both curves are affine in the shared
     * scale s (pitch = base + s·m₀·H after the move starts, unchanged before), so the largest s
     * that keeps every sample in order is found from the curves at s = 0 and s = 1, then checked.
     */
    const tighten = (lo: Part, up: Part): boolean => {
      const ms = [lo, up].filter((p) => p.move !== null);
      if (ms.length === 0) return false;
      const saved = ms.map((p) => p.crossScale);
      const set = (s: number): void => {
        for (const p of ms) p.crossScale = s;
        sync();
      };
      set(0);
      if (crossing(lo, up) !== -1) {
        ms.forEach((p, k) => (p.crossScale = saved[k]));
        sync();
        return false;
      }
      // Scales only ever decrease, so tightening one pair cannot undo another.
      const cap = saved.reduce((m, x) => (x < m ? x : m), 1);
      const a0 = sample(lo).slice();
      const b0 = sample(up).slice();
      set(cap);
      const a1 = sample(lo);
      const b1 = sample(up);
      let best = 1;
      for (let j = 0; j < SAMPLES; j++) {
        const d0 = a0[j] - b0[j];
        const slope = a1[j] - b1[j] - d0;
        if (d0 !== d0 || slope !== slope || slope <= 0) continue;
        const sj = (CROSS_EPS * 0.5 - d0) / slope;
        if (sj < best) best = sj;
      }
      let s = best > 0 ? cap * best * (1 - 1e-9) : 0;
      set(s);
      // Rounding can leave a sliver: halve until the samples agree (s = 0 is known to fit).
      for (let k = 0; k < 8 && s > 0 && crossing(lo, up) !== -1; k++) {
        s = k < 7 ? s / 2 : 0;
        set(s);
      }
      return true;
    };

    /**
     * A pair that crosses before its timing group starts moving crosses in glides left over from
     * an earlier moment (an exempt `free` or mirroring move, or a merge's carried motion): equal
     * timing and a smaller m₀ cannot reach that. The group then starts at the last sample where
     * the pair is still in order, interrupting those glides before they meet; the re-check clears
     * it or tightens m₀, and at scale 0 equal timing and ease keep in-order lines apart (§7.2).
     * Starts only move earlier (never before T), so this terminates.
     */
    const pullBack = (i: number, at: number): boolean => {
      const t = times[at - 1];
      const s = startOf(i);
      if (!(s > t) || parts[i].deferT >= s) return false;
      const r = find(i);
      gLink[r] = -1;
      gStart[r] = t;
      return true;
    };

    // Each pass resolves every crossing it finds among pairs whose curves it has not changed yet.
    const maxPasses = 3 * n + 8;
    for (let pass = 0; pass < maxPasses; pass++) {
      let acted = false;
      touched.fill(0);
      for (let k = 0; k + 1 < n; k++) {
        const li = order[k];
        const hi = order[k + 1];
        if (touched[li] || touched[hi]) continue;
        const lo = parts[li];
        const up = parts[hi];
        if (!isMover(lo) && !isMover(up)) continue;
        const key = li * n + hi;
        if (unresolved.has(key)) continue;
        // A pair found clear stays clear until one of its curves changes.
        if (clearAt[k] === ver[li] + ver[hi] * 65536 + 1) continue;
        const at = crossing(lo, up);
        if (at === -1) {
          clearAt[k] = ver[li] + ver[hi] * 65536 + 1;
          continue;
        }
        if (at === -2 || at === -3) {
          // Out of order at a newborn's birth, or where both first sound with a newborn born
          // there: this moment's doing (M4.5-17). The newborn takes the other's timing, so it
          // forks when the other departs and glides like it (siblings of one parent then fork
          // together); a voice still gliding from an earlier moment is re-timed with it instead.
          const nb = at === -3 ? crossBirth : lateBirth(li, hi);
          const other = nb === li ? hi : li;
          const o = parts[other];
          if (nb >= 0 && o.kind === PartKind.Fixed) {
            if (projector.get(o.voice).lastGlideEnd() > T) {
              retime(other);
              adopt(other, nb);
              invalidate(o.voice);
              acted = true;
              sync();
              touched[li] = 1;
              touched[hi] = 1;
              continue;
            }
          } else if (nb >= 0 && find(nb) !== find(other)) {
            adopt(nb, other);
            acted = true;
            sync();
            touched[li] = 1;
            touched[hi] = 1;
            continue;
          }
          // Born in step with it, the newborn still swaps with it right after its birth: their
          // carried velocities differ (m₀ = v·d − Δ·e′(0) cancels a steep ease's start by its
          // own interval). Equal timing and m₀ = 0 keep them in order (tighten checks that).
          if (nb >= 0 && tighten(lo, up)) {
            acted = true;
            touched[li] = 1;
            touched[hi] = 1;
            continue;
          }
          unresolved.add(key); // already out of order when the moment starts: not its doing
          continue;
        }
        const c = { at, ref: crossRef };
        acted = true;
        const dLo = sampleAt(lo, c.at) - sampleAt(lo, c.ref);
        const dHi = sampleAt(up, c.ref) - sampleAt(up, c.at);
        const [a, ai, b, bi] = dLo >= dHi ? [lo, li, up, hi] : [up, hi, lo, li];
        if (isMover(a) && isMover(b)) {
          if (find(ai) === find(bi)) {
            if (!pullBack(ai, at) && !tighten(lo, up)) unresolved.add(key);
          } else {
            adopt(ai, bi);
          }
        } else {
          const fixedI = isMover(a) ? bi : ai;
          const fixed = parts[fixedI];
          if (projector.get(fixed.voice).lastGlideEnd() > T) {
            // Re-time the voice still gliding from an earlier moment with this group.
            retime(fixedI);
            if (fixedI === ai) adopt(ai, bi);
            else adopt(bi, ai);
            invalidate(fixed.voice);
          } else if (!pullBack(isMover(a) ? ai : bi, at) && !tighten(lo, up)) {
            unresolved.add(key);
          }
        }
        sync();
        touched[li] = 1;
        touched[hi] = 1;
      }
      if (!acted) break;
    }
    // Report pairs still crossing (not those that started out of order).
    let left = 0;
    for (let k = 0; k + 1 < n; k++) {
      const lo = parts[order[k]];
      const up = parts[order[k + 1]];
      if (!isMover(lo) && !isMover(up)) continue;
      if (clearAt[k] === ver[order[k]] + ver[order[k + 1]] * 65536 + 1) continue; // known clear
      const c = crossing(lo, up);
      if (c >= 0 || c === -3) left++;
    }
    if (left > 0) {
      host.diag(
        'info',
        'crossing-unresolved',
        `${left} pair(s) of voices still cross mid-glide after timing merges.`,
      );
    }
  }

  /** Turns a fixed part (a voice still gliding from an earlier moment) into a move to its own
   * destination, so it can take a group's timing. */
  function retime(i: number): void {
    const p = parts[i];
    p.kind = PartKind.Move;
    p.limits = limitsOf(i);
    p.move = makeMove(p, i);
    tentative.set(p.voice, { birth: null, moves: [p.move] });
  }

  /**
   * Of a pair out of order at its first common sample (crossRef): a newborn of this moment born
   * since the previous sample (the later-born if both are); else −1.
   */
  function lateBirth(li: number, hi: number): number {
    const t = times[crossRef];
    const tPrev = crossRef > 0 ? times[crossRef - 1] : -Infinity;
    const bornHere = (i: number): number => {
      const b = parts[i].kind === PartKind.Birth ? parts[i].birth : null;
      return b && b.t > tPrev && b.t <= t ? b.t : -Infinity;
    };
    const bl = bornHere(li);
    const bh = bornHere(hi);
    if (bl === -Infinity && bh === -Infinity) return -1;
    return bh > bl ? hi : li;
  }

  function adopt(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    gStart[rb] = gLink[rb] >= 0 ? startOf(gLink[rb]) : gStart[rb];
    gLink[rb] = -1;
    uf[ra] = rb;
  }

  function limitsOf(i: number): OvershootLimits {
    const k = order.indexOf(i);
    const p = parts[i];
    let up = MAX_OVERSHOOT;
    let down = MAX_OVERSHOOT;
    if (k + 1 < n) {
      const q = parts[order[k + 1]];
      up = Math.min(up, Math.abs(q.preDest - p.preDest), Math.abs(q.to - p.to));
    }
    if (k > 0) {
      const q = parts[order[k - 1]];
      down = Math.min(down, Math.abs(q.preDest - p.preDest), Math.abs(q.to - p.to));
    }
    return { up, down };
  }

  // 5. Moves through untargeted voices (§7.2 scope): info only. Lines of another part may cross
  // freely (revision 9).
  if (ordered && enforceCrossings && subset) {
    const inPlan = new Set(parts.map((p) => p.voice));
    const ownParts = new Set(parts.map((p) => voices[p.voice].part));
    const others: number[] = [];
    for (let v = 0; v < voices.length; v++) {
      if (inPlan.has(v)) continue;
      const run = voices[v];
      if ((run.sounding || run.pendingBirth) && ownParts.has(run.part)) others.push(v);
    }
    if (others.length > 0) {
      const crossed = new Set<string>();
      const oBounds = new Map<number, [Pitch, Pitch]>();
      const oSamples = new Map<number, Float64Array>();
      for (const p of parts) {
        if (!p.move) continue;
        const pb = boundsOf(p);
        let a: Float64Array | null = null;
        for (const o of others) {
          let ob = oBounds.get(o);
          if (!ob) {
            ob = projector.get(o).bounds(T, we);
            oBounds.set(o, ob);
          }
          if (pb[1] < ob[0] - CROSS_EPS || pb[0] > ob[1] + CROSS_EPS) continue; // disjoint
          let y = oSamples.get(o);
          if (!y) {
            y = new Float64Array(SAMPLES);
            const proj = projector.get(o);
            for (let j = 0; j < SAMPLES; j++) y[j] = proj.pitchAt(times[j]);
            oSamples.set(o, y);
          }
          a ??= sample(p);
          let sign = 0;
          for (let j = 0; j < SAMPLES; j++) {
            const x = a[j];
            const z = y[j];
            if (x !== x || z !== z) continue;
            const sg = x > z + CROSS_EPS ? 1 : x < z - CROSS_EPS ? -1 : 0;
            if (sg === 0) continue;
            if (sign === 0) sign = sg;
            else if (sg !== sign) {
              crossed.add(`${voices[p.voice].id}/${voices[o].id}`);
              break;
            }
          }
        }
      }
      if (crossed.size > 0) {
        host.diag(
          'info',
          'crossing-untargeted',
          `Moves cross voices outside the target: ${[...crossed].join(', ')}.`,
        );
      }
    }
  }

  // Results.
  const births: Birth[] = [];
  const moves: Move[] = [];
  const traceLimits: PlanTrace['limits'] = [];
  for (const p of parts) {
    if (!p.move) continue;
    if (p.birth) births.push(p.birth);
    moves.push(p.move);
    traceLimits.push({
      voice: p.voice,
      up: p.limits.up,
      down: p.limits.down,
      crossScale: p.crossScale,
    });
  }
  return {
    births,
    moves,
    trace: {
      order: ordered ? order.map((i) => parts[i].voice) : [],
      movers: parts.filter((p) => p.move).map((p) => p.voice),
      window: [T, we],
      ordered,
      limits: traceLimits,
    },
  };
}
