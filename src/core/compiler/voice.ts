/**
 * Per-voice simulation state (PLAN.md §7.1 "Voice state").
 *
 * A voice's emitted path is a list of finished segments plus a *tail*: the segment in progress,
 * or an open hold whose end is not known yet. Starting a move finishes the tail (cutting a glide
 * that is still running, §7.5 step 1) and makes the move's segment the new tail.
 *
 * The same `Frontier` code runs the real simulation and the look-ahead projections the planner
 * uses for crossing checks, so a prediction equals what later happens unless a later event
 * intervenes.
 */

import { partOf } from '../parts';
import { evalSegment, evalSegmentVelocity } from '../segment';
import {
  carriedVelocity,
  segmentFromCarried,
  type CarriedVelocity,
  type OvershootLimits,
  type StartState,
} from '../interrupt';
import type {
  EaseRef,
  Life,
  Pitch,
  PulseRecord,
  Seconds,
  Segment,
  StackChange,
  VoiceDef,
  WeightChange,
} from '../types';

/** Local aliases for the hot paths: under Vitest's module runner an imported binding is a getter. */
const segAt = evalSegment;
const segVelocity = evalSegmentVelocity;
const carryOf = carriedVelocity;
const fromCarried = segmentFromCarried;

/** Ease stored on hold segments (p0 = p1, so it never matters; linear is cheapest to evaluate). */
export const HOLD_EASE: EaseRef = 'linear';

/** True when a segment changes pitch (a glide), false for a hold. */
export function isGlide(s: Segment): boolean {
  return s.p0 !== (s.curve ? s.curve.p1 : s.p1) || (s.m0 ?? 0) !== 0;
}

/** A move scheduled by a moment or walk (§7.1). */
export interface Move {
  voice: number;
  /** Start time (already deferred to the voice's birth if it is born later). */
  t0: Seconds;
  dur: Seconds;
  to: Pitch;
  ease: EaseRef;
  momentId: string;
  /** Overshoot limits (§7.5), before the range room is applied. */
  limits: OvershootLimits;
  /** Extra m₀ scale from crossing enforcement (§7.2); 1 normally. */
  crossScale: number;
  /**
   * A death glide (merge): never cancelled; the life closes `fade` seconds after it ends. `into`:
   * the survivor it merges into (−1: none), whose later moves it follows (§7.4, M4.5-17).
   */
  death?: { fade: Seconds; into: number };
  cancelled: boolean;
  /** Index of the moment that scheduled it, for diagnostics and spans. */
  momentIndex: number;
  /** Cache of the last segment built for this move (projections rebuild it often). */
  memo?: SegmentMemo;
}

/** Inputs and output of one carried-velocity computation (see Frontier.start). */
export interface SegmentMemo {
  p: Pitch;
  v: number;
  mid: boolean;
  dur: Seconds;
  to: Pitch;
  up: number;
  down: number;
  carried: CarriedVelocity;
}

/** A birth (§7.4): never cancelled. */
export interface Birth {
  voice: number;
  /** Audible onset; the start of the fade-in. */
  t: Seconds;
  /** Pool index of the parent, or −1: then the newborn appears at `pitch`. */
  parent: number;
  /** Start pitch when there is no parent. */
  pitch: Pitch;
  fadeIn: Seconds;
  momentId: string;
  /** Weight of the newborn (revision 8); 1 if absent. */
  weight?: number;
  /**
   * A fork of a weighted line (revision 8): the parent hands `share` of its weight to the newborn,
   * ramping down over the newborn's fade-in.
   */
  fork?: number;
  /** When the fork was decided (its moment's time): a parent born later never had the share. */
  forkAt?: Seconds;
}

/**
 * The growing end of a voice's path. `out` receives finished segments in order.
 */
export class Frontier {
  /** The segment in progress, or the open hold; null while the voice is silent. */
  tail: Segment | null = null;
  /** The tail is an open hold whose t1 is provisional. */
  open = false;
  /** Instantaneous state at the life's first instant (a newborn inherits its parent's motion). */
  bornT = NaN;
  bornV = 0;
  bornMid = false;

  constructor(public out: Segment[]) {}

  /** Copy for projections: the tail is cloned, finished segments go to `out`. */
  clone(out: Segment[]): Frontier {
    const f = new Frontier(out);
    f.tail = this.tail ? { ...this.tail } : null;
    f.open = this.open;
    f.bornT = this.bornT;
    f.bornV = this.bornV;
    f.bornMid = this.bornMid;
    return f;
  }

  get alive(): boolean {
    return this.tail !== null;
  }

  /**
   * Opens a life at t: an open hold at p, with the instantaneous motion of the birth. `momentId`:
   * an establishing moment's voice (M4.5-27) holds its note as that moment's segment.
   */
  openAt(t: Seconds, start: StartState, momentId?: string): void {
    this.tail = { t0: t, t1: t, p0: start.p, p1: start.p, ease: HOLD_EASE };
    if (momentId !== undefined) this.tail.momentId = momentId;
    this.open = true;
    this.bornT = t;
    this.bornV = start.v;
    this.bornMid = start.mid;
  }

  /**
   * Pitch, velocity and mid-glide flag at t (t ≥ tail.t0), from the tail alone (left limit: a move
   * starting exactly at t has not been applied yet). Null when silent.
   */
  stateAt(t: Seconds): StartState | null {
    const s = this.tail;
    if (!s) return null;
    if (this.open) {
      if (t === this.bornT && s.t0 === t) return { p: s.p0, v: this.bornV, mid: this.bornMid };
      return { p: s.p0, v: 0, mid: false };
    }
    if (t < s.t1 && isGlide(s)) {
      return { p: segAt(s, t), v: segVelocity(s, t), mid: true };
    }
    return { p: t < s.t1 ? segAt(s, t) : s.p1, v: 0, mid: false };
  }

  /** Pitch at t ≥ tail.t0 (the tail's value; after a glide ends, its target). */
  pitchAt(t: Seconds): Pitch {
    const s = this.tail!;
    if (this.open) return s.p0;
    return segAt(s, t);
  }

  /** The pitch the tail is heading to (its target, or the hold pitch). */
  get heading(): Pitch {
    return this.tail ? this.tail.p1 : NaN;
  }

  /**
   * True while a move is in progress at t: a glide, or a fixed-length move that keeps the pitch
   * (a parentless newborn's arrival, a merge's dying hold). Walks wait for it to end (§7.1).
   */
  busyAt(t: Seconds): boolean {
    const s = this.tail;
    return !!s && !this.open && t < s.t1;
  }

  /** Finishes the tail at t: holds end there, running glides are cut, ended glides get a hold. */
  private finishAt(t: Seconds, pitchAtT: Pitch): void {
    const s = this.tail!;
    if (this.open) {
      s.t1 = t;
      if (t > s.t0) this.out.push(s);
    } else if (t < s.t1) {
      if (t > s.t0 && !isGlide(s)) {
        s.t1 = t; // a constant segment truncates exactly; it is not an interrupted glide
        this.out.push(s);
      } else if (t > s.t0) {
        s.curve = { t1: s.t1, p1: s.p1 };
        s.t1 = t;
        s.p1 = pitchAtT;
        this.out.push(s);
      }
    } else {
      this.out.push(s);
      if (t > s.t1) this.out.push({ t0: s.t1, t1: t, p0: s.p1, p1: s.p1, ease: HOLD_EASE });
    }
  }

  /**
   * The segment a move starting at t0 would get, without changing the frontier: reads the actual
   * pitch and velocity, applies the interruption rule if mid-glide (§7.5), with the overshoot
   * limits narrowed by the room left to the voice's range (§7.8).
   */
  prepare(
    t0: Seconds,
    dur: Seconds,
    to: Pitch,
    ease: EaseRef,
    limits: OvershootLimits,
    crossScale: number,
    range: readonly [Pitch, Pitch],
    momentId: string,
    holder?: { memo?: SegmentMemo },
  ): Segment {
    const st = this.stateAt(t0)!;
    const hi = st.p > to ? st.p : to;
    const lo = st.p < to ? st.p : to;
    const roomUp = range[1] - hi;
    const roomDown = lo - range[0];
    const up = limits.up < roomUp ? limits.up : roomUp > 0 ? roomUp : 0;
    const down = limits.down < roomDown ? limits.down : roomDown > 0 ? roomDown : 0;
    // The clamp (64-point bisection) depends only on these inputs; projections rebuild the same
    // move many times while the planner adjusts timings and scales, so it is cached per move.
    const k = holder?.memo;
    let carried: CarriedVelocity;
    if (
      k &&
      k.p === st.p &&
      k.v === st.v &&
      k.mid === st.mid &&
      k.dur === dur &&
      k.to === to &&
      k.up === up &&
      k.down === down
    ) {
      carried = k.carried;
    } else {
      carried = carryOf(st, dur, to, ease, { up, down });
      if (holder) holder.memo = { p: st.p, v: st.v, mid: st.mid, dur, to, up, down, carried };
    }
    return fromCarried(st.p, t0, dur, to, ease, carried, crossScale, momentId);
  }

  /**
   * Starts a move at t0 (§7.1 move-start): the `prepare`d segment becomes the tail, and the old
   * tail is finished (a running glide is cut, §7.5 step 1).
   */
  start(
    t0: Seconds,
    dur: Seconds,
    to: Pitch,
    ease: EaseRef,
    limits: OvershootLimits,
    crossScale: number,
    range: readonly [Pitch, Pitch],
    momentId: string,
    holder?: { memo?: SegmentMemo },
  ): Segment {
    const seg = this.prepare(t0, dur, to, ease, limits, crossScale, range, momentId, holder);
    this.finishAt(t0, seg.p0);
    this.tail = seg;
    this.open = false;
    return seg;
  }

  /** Ends the life at t: the tail is finished there and the voice falls silent. */
  close(t: Seconds): void {
    if (!this.tail) return;
    const s = this.tail;
    const p = this.open ? s.p0 : t < s.t1 ? segAt(s, t) : s.p1;
    this.finishAt(t, p);
    this.tail = null;
    this.open = false;
  }
}

/** Status of a pool voice for targeting (§7.1, §7.4). */
export const enum Status {
  /** Never born, or dead: may be born by a split once `diedAt` ≤ t. */
  Dormant = 0,
  /** Targetable (from the event time of the moment that births it). */
  Active = 1,
  /** Chosen to die by a merge: still sounding until its fade ends, never targetable. */
  Dying = 2,
}

/** Everything the compiler tracks for one pool voice. */
export class VoiceRun {
  readonly segs: Segment[] = [];
  readonly lives: Life[] = [];
  readonly frontier: Frontier;
  status: Status = Status.Dormant;
  /** End of the last life's fade-out (−∞ if never alive, +∞ while dying with a pending glide). */
  diedAt = -Infinity;
  /** While dying: the voice it merges into and follows (−1: none), and its fade length. */
  into = -1;
  deathFade = 0;
  /** Revision 8: its weight already passed to the line it merges into. */
  handed = false;
  /** Moves scheduled but not started, in start order. */
  pending: Move[] = [];
  /** A birth not yet happened (never cancelled). */
  pendingBirth: Birth | null = null;
  /** The open life, if sounding. */
  life: Life | null = null;
  /** Level timeline. */
  readonly level: { t: Seconds; gain: number; over: Seconds }[] = [];
  /**
   * Distinct notes (revision 8): logical voices this line stands for (merged lines add up), and
   * its committed weight (loudness: power of `weight` lines). Moments see `count` stacked voices.
   */
  count = 1;
  weight = 1;
  /** Pool voices merged into this line, preferred when it splits again. */
  members: number[] = [];
  /** Weight timeline (absolute targets, pushed at the simulation time). */
  readonly weights: WeightChange[] = [];
  /** `count` timeline (pushed at the simulation time; `setCount`). */
  readonly counts: StackChange[] = [];
  /** Pulse records (revision 9), pushed at the simulation time, so sorted; never mutated. */
  readonly pulse: PulseRecord[] = [];
  /** Moment index of the pulse driving this voice, or −1 (compile.ts `onPulseTick`). */
  pulseOwner = -1;
  /** Revision 9: the end of the latest tune playing on this line; walks leave it alone until then. */
  tuneUntil = -Infinity;

  constructor(
    readonly index: number,
    readonly def: VoiceDef,
    readonly range: readonly [Pitch, Pitch],
    /** hash32(def.id), for keyed draws. */
    readonly hash: number,
  ) {
    this.frontier = new Frontier(this.segs);
    this.part = partOf(def);
  }

  /** Revision 9: its part ('' = the default group); lines merge only within a part. */
  readonly part: string;

  get id(): string {
    return this.def.id;
  }

  /** The weight the timeline is heading to (1 before its first entry). */
  get lastWeight(): number {
    const w = this.weights;
    return w.length > 0 ? w[w.length - 1].w : 1;
  }

  /** Sets `count` from t on (the current simulation time), recording it in `counts`. */
  setCount(t: Seconds, n: number): void {
    this.count = n;
    const c = this.counts;
    const last = c[c.length - 1];
    if ((last ? last.n : 1) === n) return;
    // Replace, never mutate (as rampWeight).
    if (last && last.t === t) c[c.length - 1] = { t, n };
    else c.push({ t, n });
  }

  /**
   * Appends a weight change at t (the current simulation time) to `w`, unless already there. A
   * crossfade (`cross`) follows core/ease `crossfade`; a merge's starts `lead` before t.
   */
  rampWeight(t: Seconds, w: number, over: Seconds, lead = 0, cross = false): void {
    if (w === this.lastWeight) return;
    const last = this.weights[this.weights.length - 1];
    const c: WeightChange = { t, w, over };
    if (lead > 0) c.lead = lead;
    if (cross) c.cross = true;
    // Replace, never mutate: incremental compiles share entries with earlier scores.
    if (
      last &&
      last.t === t &&
      last.over === over &&
      (last.lead ?? 0) === lead &&
      (last.cross === true) === cross
    )
      this.weights[this.weights.length - 1] = c;
    else this.weights.push(c);
  }

  /** Sounding (life open) at the current simulation time. */
  get sounding(): boolean {
    return this.frontier.alive;
  }

  /**
   * Committed destination (§7.1): the target of the last scheduled move, else the tail's
   * heading. For a newborn whose birth has not happened and whose moves were cancelled, the
   * caller supplies the predicted birth pitch.
   */
  dest(birthPitch: (b: Birth) => Pitch): Pitch {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const m = this.pending[i];
      if (!m.cancelled) return m.to;
    }
    if (this.frontier.alive) return this.frontier.heading;
    if (this.pendingBirth) return birthPitch(this.pendingBirth);
    return NaN;
  }

  /** Drops cancelled moves from the pending list. */
  prunePending(): void {
    if (this.pending.some((m) => m.cancelled))
      this.pending = this.pending.filter((m) => !m.cancelled);
  }

  /** Cancels every pending move except death glides (§7.1: deaths are never cancelled). */
  cancelPending(): void {
    for (const m of this.pending) if (!m.death) m.cancelled = true;
    this.prunePending();
  }
}
