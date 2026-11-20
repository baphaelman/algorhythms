/**
 * Look-ahead projections (PLAN.md §7.2 crossing checks).
 *
 * At a moment's time the planner must know how each voice will actually move: its glide in
 * progress, the interruption (§7.5) when its new move starts, births from a parent's pitch. A
 * projection replays a voice's scheduled births and moves on a *copy* of its frontier, with the
 * same code the simulation runs later, so it predicts the real output exactly unless a later event
 * intervenes.
 */

import { evalSegment, evalSegmentVelocity } from '../segment';
import type { StartState } from '../interrupt';
import type { Pitch, Seconds, Segment } from '../types';
import { isGlide, type Birth, type Move, type VoiceRun } from './voice';

/** Extra scheduled events for a voice (the moment being planned). */
export interface Tentative {
  birth: Birth | null;
  moves: Move[];
}

/** A voice's predicted path from the planning time on. */
export class Projection {
  /** Finished segments, in order (the first may start before the planning time). */
  segs: Segment[] = [];
  tail: Segment | null = null;
  open = false;
  /** Silent before this time (a pending birth). */
  startT = -Infinity;
  /** Silent from this time on (a death's end). */
  closeT = Infinity;
  bornT = NaN;
  bornState: StartState | null = null;
  private cursor = 0;

  /** Pitch at t, NaN while silent. Fastest when called with increasing t. */
  pitchAt(t: Seconds): Pitch {
    if (t < this.startT || t >= this.closeT) return NaN;
    const tail = this.tail;
    if (tail && t >= tail.t0) return this.open ? tail.p0 : evalSegment(tail, t);
    const segs = this.segs;
    if (segs.length === 0 || t < segs[0].t0) return NaN;
    let i = this.cursor < segs.length ? this.cursor : segs.length - 1;
    if (segs[i].t0 > t) i = 0;
    while (i + 1 < segs.length && segs[i + 1].t0 <= t) i++;
    this.cursor = i;
    return evalSegment(segs[i], t);
  }

  /** Left-limit state at t (what a birth at t reads from its parent); null while silent. */
  stateBefore(t: Seconds): StartState | null {
    if (t >= this.closeT) return null;
    let s: Segment | null = null;
    let isTail = false;
    if (this.tail && this.tail.t0 < t) {
      s = this.tail;
      isTail = true;
    } else {
      for (let i = this.segs.length - 1; i >= 0; i--) {
        if (this.segs[i].t0 < t) {
          s = this.segs[i];
          break;
        }
      }
    }
    if (!s) return t === this.bornT && this.bornState ? this.bornState : null;
    if (isTail && this.open) return { p: s.p0, v: 0, mid: false };
    if (t < s.t1 && isGlide(s)) {
      return { p: evalSegment(s, t), v: evalSegmentVelocity(s, t), mid: true };
    }
    return { p: t <= s.t1 ? evalSegment(s, t) : s.p1, v: 0, mid: false };
  }

  /** The latest time this projection changes pitch (end of its last glide), or −∞. */
  lastGlideEnd(): Seconds {
    if (this.tail && !this.open && isGlide(this.tail)) return this.tail.t1;
    for (let i = this.segs.length - 1; i >= 0; i--)
      if (isGlide(this.segs[i])) return this.segs[i].t1;
    return -Infinity;
  }
}

/** Builds and caches projections for one planning step. */
export class Projector {
  private cache = new Map<number, Projection>();
  private depth = 0;

  constructor(
    private readonly voices: readonly VoiceRun[],
    private readonly extra: (v: number) => Tentative | undefined,
  ) {}

  /** Forget cached projections (after a tentative schedule changed). */
  invalidate(v?: number): void {
    if (v === undefined) this.cache.clear();
    else this.cache.delete(v);
  }

  get(v: number): Projection {
    let p = this.cache.get(v);
    if (!p) {
      p = this.build(v);
      this.cache.set(v, p);
    }
    return p;
  }

  private build(v: number): Projection {
    const run = this.voices[v];
    const proj = new Projection();
    if (this.depth > 40) return proj; // pathological parent chains: treat as silent
    const out: Segment[] = [];
    const f = run.frontier.clone(out);
    const ext = this.extra(v);
    const birth = ext?.birth ?? run.pendingBirth;
    const moves: Move[] = [];
    for (const m of run.pending) if (!m.cancelled) moves.push(m);
    if (ext) for (const m of ext.moves) moves.push(m);
    moves.sort((a, b) => a.t0 - b.t0);
    if (!f.alive) proj.startT = birth ? birth.t : Infinity;
    let bi = birth && !f.alive ? 0 : 1; // the birth precedes moves at equal times
    let mi = 0;
    while (bi === 0 || mi < moves.length) {
      if (bi === 0 && (mi >= moves.length || birth!.t <= moves[mi].t0)) {
        const b = birth!;
        bi = 1;
        let ps: StartState | null = null;
        if (b.parent >= 0) {
          this.depth++;
          ps = this.get(b.parent).stateBefore(b.t);
          this.depth--;
        }
        const st = ps ?? { p: b.pitch, v: 0, mid: false };
        f.openAt(b.t, st);
        proj.bornT = b.t;
        proj.bornState = st;
        continue;
      }
      const m = moves[mi++];
      if (!f.alive) continue;
      const seg = f.start(m.t0, m.dur, m.to, m.ease, m.limits, m.crossScale, run.range, m.momentId);
      if (m.death) {
        proj.closeT = seg.t1 + m.death.fade;
        f.close(proj.closeT);
        break;
      }
    }
    proj.segs = out;
    proj.tail = f.tail;
    proj.open = f.open;
    return proj;
  }
}
