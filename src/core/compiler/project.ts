/**
 * Look-ahead projections (PLAN.md §7.2 crossing checks).
 *
 * At a moment's time the planner must know how each voice will actually move: its glide in
 * progress, the interruption (§7.5) when its new move starts, births from a parent's pitch. A
 * projection replays a voice's scheduled births and moves on a *copy* of its frontier, with the
 * same code the simulation runs later, so it predicts the real output exactly unless a later event
 * intervenes.
 */

import { EaseCode, easeCodeOf, easeRaw } from '../ease';
import { evalSegment, evalSegmentVelocity, segmentPitch } from '../segment';
import type { StartState } from '../interrupt';
import type { Pitch, Seconds, Segment } from '../types';
import { isGlide, type Birth, type Move, type VoiceRun } from './voice';

/** Doubles per flattened record: t0 t1 p0 p1 code x1 y1 x2 y2 m0 curveT1 curveP1. */
const REC = 12;
/** max H(x) = 4/27. */
const H_MAX = 4 / 27;
/** Local alias for the hot path: under Vitest's module runner an imported binding is a getter. */
const segPitch = segmentPitch;
const easeAt = easeRaw;
const codeOf = easeCodeOf;
const BEZIER = EaseCode.Bezier;
/** Padding of `boundsIn` against rounding (the samples are sums of a few doubles near 100). */
const BOUND_PAD = 1e-10;

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
  /** When the life open at (or born in) the projection began, and its instantaneous motion. */
  bornT = NaN;
  bornV = 0;
  bornMid = false;
  bornState: StartState | null = null;
  private cursor = 0;
  /** Segments and tail as scalar records (REC doubles each), built on first use. */
  private rec: number[] | null = null;
  private nrec = 0;

  /** Records start in time order, so `pitchAt` does not depend on the order of its calls. */
  private sorted = true;

  /** Flattens segs + tail for fast, monomorphic evaluation (an open hold runs to +∞). */
  private records(): number[] {
    const segs = this.segs;
    const ns = segs.length;
    const n = this.tail ? ns + 1 : ns;
    // A plain array, written in index order (packed): a small typed array costs an off-heap
    // allocation, and projections are rebuilt thousands of times per compile.
    const r: number[] = [];
    let sorted = true;
    for (let i = 0; i < n; i++) {
      const g = i < ns ? segs[i] : this.tail!;
      const o = i * REC;
      const e = g.ease;
      const open = g === this.tail && this.open;
      r[o] = g.t0;
      if (i > 0 && !(g.t0 >= r[o - REC])) sorted = false;
      r[o + 1] = open ? Infinity : g.t1;
      r[o + 2] = g.p0;
      r[o + 3] = open ? g.p0 : g.p1;
      r[o + 4] = codeOf(e);
      const bz = typeof e === 'object';
      r[o + 5] = bz ? e.x1 : 0;
      r[o + 6] = bz ? e.y1 : 0;
      r[o + 7] = bz ? e.x2 : 1;
      r[o + 8] = bz ? e.y2 : 1;
      r[o + 9] = g.m0 ?? 0;
      r[o + 10] = open ? Infinity : g.curve ? g.curve.t1 : g.t1;
      r[o + 11] = open ? g.p0 : g.curve ? g.curve.p1 : g.p1;
    }
    this.rec = r;
    this.nrec = n;
    this.sorted = sorted;
    return r;
  }

  /** True when `pitchAt` may be called in any order (its records start in time order). */
  get anyOrder(): boolean {
    if (!this.rec) this.records();
    return this.sorted;
  }

  /** Pitch at t, NaN while silent. Fastest when called with increasing t. */
  pitchAt(t: Seconds): Pitch {
    if (t < this.startT || t >= this.closeT) return NaN;
    const r = this.rec ?? this.records();
    const n = this.nrec;
    if (n === 0 || t < r[0]) return NaN;
    let i = this.cursor < n ? this.cursor : n - 1;
    if (r[i * REC] > t) i = 0;
    while (i + 1 < n && r[(i + 1) * REC] <= t) i++;
    this.cursor = i;
    const o = i * REC;
    return segPitch(
      r[o],
      r[o + 1],
      r[o + 2],
      r[o + 3],
      r[o + 4] as EaseCode,
      r[o + 5],
      r[o + 6],
      r[o + 7],
      r[o + 8],
      r[o + 9],
      t,
      r[o + 10],
      r[o + 11],
    );
  }

  /**
   * Exact bounds [lo, hi] of the pitch over [a, b]: each segment stays within
   * p₀ + (P₁ − p₀)·[e_min, e_max] + m₀·[0, 4/27] (a bézier's y lies in its control hull).
   */
  bounds(a: Seconds, b: Seconds): [Pitch, Pitch] {
    const r = this.rec ?? this.records();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this.nrec; i++) {
      const o = i * REC;
      if (r[o + 1] < a || r[o] > b) continue;
      const p0 = r[o + 2];
      const d = r[o + 11] - p0;
      let eMin = 0;
      let eMax = 1;
      if (r[o + 4] === BEZIER) {
        eMin = Math.min(0, r[o + 6], r[o + 8]);
        eMax = Math.max(1, r[o + 6], r[o + 8]);
      }
      let x = p0 + d * eMin;
      let y = p0 + d * eMax;
      if (x > y) [x, y] = [y, x];
      const m = r[o + 9] * H_MAX;
      if (m > 0) y += m;
      else x += m;
      if (x < lo) lo = x;
      if (y > hi) hi = y;
    }
    // After the last record ends, `pitchAt` holds its end pitch (a glide that already finished,
    // with no hold record yet). That hold is part of the path over [a, b] too: without it, a voice
    // resting on an ended glide had empty bounds and the crossing check pruned it as "cannot cross".
    const last = (this.nrec - 1) * REC;
    if (last >= 0 && r[last + 1] < b) {
      const p = r[last + 3];
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return [lo, hi];
  }

  /**
   * Bounds on every non-NaN `pitchAt(t)` for t in [a, b], written to out[k] (low) and out[k + 1]
   * (high). Tighter than `bounds`: each record is clipped to where `pitchAt` uses it, and a named
   * ease (monotone) is evaluated at the clip ends; padded by BOUND_PAD against rounding. Requires
   * `anyOrder`. NaN data gives NaN bounds, which prune nothing.
   */
  boundsIn(a: Seconds, b: Seconds, out: Float64Array, k: number): void {
    const r = this.rec ?? this.records();
    const n = this.nrec;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * REC;
      const s = r[o];
      const e = i + 1 < n ? r[o + REC] : Infinity; // pitchAt uses record i on [s, e)
      if (!(e > s) || s > b || e < a) continue;
      const ta = s > a ? s : a;
      const tb = e < b ? e : b;
      const t1 = r[o + 1];
      const p1 = r[o + 3];
      if (tb >= t1) {
        if (p1 < lo) lo = p1;
        if (p1 > hi) hi = p1;
      }
      if (!(ta < t1)) continue;
      // Glide part, t in [ta, min(tb, t1)): x = (t − t0)/(curveT1 − t0) runs over [xa, xb].
      const p0 = r[o + 2];
      const span = r[o + 10] - s;
      let xa = (ta - s) / span;
      let xb = ((tb < t1 ? tb : t1) - s) / span;
      if (!(xa < 1)) xa = 1;
      if (!(xb < 1)) {
        xb = 1;
        if (p1 < lo) lo = p1;
        if (p1 > hi) hi = p1;
      }
      const code = r[o + 4] as EaseCode;
      const d = r[o + 11] - p0;
      let ea: number;
      let eb: number;
      if (code === BEZIER) {
        ea = Math.min(0, r[o + 6], r[o + 8]); // the control hull
        eb = Math.max(1, r[o + 6], r[o + 8]);
      } else {
        ea = easeAt(code, xa, 0, 0, 1, 1);
        eb = easeAt(code, xb, 0, 0, 1, 1);
      }
      let x = p0 + d * ea;
      let y = p0 + d * eb;
      if (x > y) [x, y] = [y, x];
      const m0 = r[o + 9];
      if (m0 !== 0) {
        const oa = 1 - xa;
        const ob = 1 - xb;
        const ha = xa * oa * oa;
        const hb = xb * ob * ob;
        const hMin = ha < hb ? ha : hb;
        const hMax = xa <= 1 / 3 && xb >= 1 / 3 ? H_MAX : ha > hb ? ha : hb;
        if (m0 > 0) {
          x += m0 * hMin;
          y += m0 * hMax;
        } else {
          x += m0 * hMax;
          y += m0 * hMin;
        }
      }
      if (x < lo) lo = x;
      if (y > hi) hi = y;
    }
    out[k] = lo - BOUND_PAD;
    out[k + 1] = hi + BOUND_PAD;
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
    if (!s) {
      // The life begins exactly at t: the state is its first instant (Frontier.stateAt).
      if (t !== this.bornT) return null;
      if (this.bornState) return this.bornState;
      const first = this.segs.length > 0 ? this.segs[0] : this.tail;
      return first && first.t0 === t ? { p: first.p0, v: this.bornV, mid: this.bornMid } : null;
    }
    if (isTail && this.open) return { p: s.p0, v: 0, mid: false };
    // A glide cut at exactly t (by a move at t) is still running in the left limit.
    const runsTo = s.curve ? s.curve.t1 : s.t1;
    if (t <= s.t1 && t < runsTo && isGlide(s)) {
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

  /**
   * The state newborn `b` starts from: its parent's just before the birth. A parent not born yet
   * (a newborn of an earlier moment, revision 8 forks) is still where its own parent is, so the
   * newborn starts there.
   */
  birthState(b: Birth): StartState | null {
    let p = b.parent;
    for (let k = 0; p >= 0 && k <= this.voices.length; k++) {
      const st = this.get(p).stateBefore(b.t);
      if (st) return st;
      const pb = this.extra(p)?.birth ?? this.voices[p].pendingBirth;
      if (!pb || !(pb.t >= b.t)) return null;
      p = pb.parent;
    }
    return null;
  }

  private build(v: number): Projection {
    const run = this.voices[v];
    const proj = new Projection();
    if (this.depth > 40) return proj; // pathological parent chains: treat as silent
    const ext = this.extra(v);
    const fr = run.frontier;
    // Fast path for the common case, a sounding voice whose only scheduled move is the planned
    // one: before the new move starts, the uncut tail evaluates exactly like the cut one, so the
    // path is [tail, new segment] (shared read-only), with no copy of the frontier.
    if (
      fr.alive &&
      !run.pendingBirth &&
      run.pending.length === 0 &&
      (!ext || (!ext.birth && ext.moves.length <= 1 && !ext.moves[0]?.death))
    ) {
      proj.bornT = fr.bornT;
      proj.bornV = fr.bornV;
      proj.bornMid = fr.bornMid;
      const m = ext?.moves[0];
      if (!m) {
        proj.tail = fr.tail;
        proj.open = fr.open;
        return proj;
      }
      const seg = fr.prepare(
        m.t0,
        m.dur,
        m.to,
        m.ease,
        m.limits,
        m.crossScale,
        run.range,
        m.momentId,
        m,
      );
      proj.segs = [fr.tail!];
      proj.tail = seg;
      proj.open = false;
      return proj;
    }
    const out: Segment[] = [];
    const f = fr.clone(out);
    let birth = ext?.birth ?? run.pendingBirth;
    // A newborn of an earlier moment given a later move by this one is born when that move
    // departs (compile.ts applyPointMoment), not left waiting on its parent's pitch.
    if (!ext?.birth && birth && ext) {
      const first = ext.moves.find((m) => !m.death);
      if (first && first.t0 > birth.t) birth = { ...birth, t: first.t0 };
    }
    const moves: Move[] = [];
    for (const m of run.pending) if (!m.cancelled) moves.push(m);
    if (ext) for (const m of ext.moves) moves.push(m);
    moves.sort((a, b) => a.t0 - b.t0);
    if (!f.alive) proj.startT = birth ? birth.t : Infinity;
    else {
      proj.bornT = f.bornT;
      proj.bornV = f.bornV;
      proj.bornMid = f.bornMid;
    }
    let bi = birth && !f.alive ? 0 : 1; // the birth precedes moves at equal times
    let mi = 0;
    while (bi === 0 || mi < moves.length) {
      if (bi === 0 && (mi >= moves.length || birth!.t <= moves[mi].t0)) {
        const b = birth!;
        bi = 1;
        let ps: StartState | null = null;
        if (b.parent >= 0) {
          this.depth++;
          ps = this.birthState(b);
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
      const seg = f.start(
        m.t0,
        m.dur,
        m.to,
        m.ease,
        m.limits,
        m.crossScale,
        run.range,
        m.momentId,
        m,
      );
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
