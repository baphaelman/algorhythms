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

import { evalSegment, evalSegmentVelocity } from '../segment';
import { buildMoveSegment, type OvershootLimits, type StartState } from '../interrupt';
import type { EaseRef, Life, Pitch, Seconds, Segment, VoiceDef } from '../types';

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
  /** A death glide (merge): never cancelled; the life closes `fade` seconds after it ends. */
  death?: { fade: Seconds };
  cancelled: boolean;
  /** Index of the moment that scheduled it, for diagnostics and spans. */
  momentIndex: number;
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

  /** Opens a life at t: an open hold at p, with the instantaneous motion of the birth. */
  openAt(t: Seconds, start: StartState): void {
    this.tail = { t0: t, t1: t, p0: start.p, p1: start.p, ease: HOLD_EASE };
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
      return { p: evalSegment(s, t), v: evalSegmentVelocity(s, t), mid: true };
    }
    return { p: t < s.t1 ? evalSegment(s, t) : s.p1, v: 0, mid: false };
  }

  /** Pitch at t ≥ tail.t0 (the tail's value; after a glide ends, its target). */
  pitchAt(t: Seconds): Pitch {
    const s = this.tail!;
    if (this.open) return s.p0;
    return evalSegment(s, t);
  }

  /** The pitch the tail is heading to (its target, or the hold pitch). */
  get heading(): Pitch {
    return this.tail ? this.tail.p1 : NaN;
  }

  /** True while a glide is in progress at t. */
  glidingAt(t: Seconds): boolean {
    const s = this.tail;
    return !!s && !this.open && t < s.t1 && isGlide(s);
  }

  /** Finishes the tail at t: holds end there, running glides are cut, ended glides get a hold. */
  private finishAt(t: Seconds, pitchAtT: Pitch): void {
    const s = this.tail!;
    if (this.open) {
      s.t1 = t;
      if (t > s.t0) this.out.push(s);
    } else if (t < s.t1) {
      if (t > s.t0) {
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
   * Starts a move at t0 (§7.1 move-start): reads the actual pitch and velocity, applies the
   * interruption rule if mid-glide (§7.5), and makes the new segment the tail. `range` adds the
   * room left to the voice's range to the overshoot limits.
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
  ): Segment {
    const st = this.stateAt(t0)!;
    const hi = st.p > to ? st.p : to;
    const lo = st.p < to ? st.p : to;
    const roomUp = range[1] - hi;
    const roomDown = lo - range[0];
    const lim: OvershootLimits = {
      up: limits.up < roomUp ? limits.up : roomUp > 0 ? roomUp : 0,
      down: limits.down < roomDown ? limits.down : roomDown > 0 ? roomDown : 0,
    };
    const seg = buildMoveSegment(st, t0, dur, to, ease, lim, crossScale, momentId);
    this.finishAt(t0, st.p);
    this.tail = seg;
    this.open = false;
    return seg;
  }

  /** Ends the life at t: the tail is finished there and the voice falls silent. */
  close(t: Seconds): void {
    if (!this.tail) return;
    const s = this.tail;
    const p = this.open ? s.p0 : t < s.t1 ? evalSegment(s, t) : s.p1;
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
  /** Moves scheduled but not started, in start order. */
  pending: Move[] = [];
  /** A birth not yet happened (never cancelled). */
  pendingBirth: Birth | null = null;
  /** The open life, if sounding. */
  life: Life | null = null;
  /** Level timeline. */
  readonly level: { t: Seconds; gain: number; over: Seconds }[] = [];

  constructor(
    readonly index: number,
    readonly def: VoiceDef,
    readonly range: readonly [Pitch, Pitch],
    /** hash32(def.id), for keyed draws. */
    readonly hash: number,
  ) {
    this.frontier = new Frontier(this.segs);
  }

  get id(): string {
    return this.def.id;
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
