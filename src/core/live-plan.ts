/**
 * Live moves planned by the compiler's rules (PLAN.md §7.2, §7.4, §7.5, §9; §15 M7 "a recorded
 * take plays back with pitch paths matching the live ones"). A port of compiler/plan.ts
 * `planMoment` and compiler/lines.ts `collapse` onto the live voices, so a take compiled as
 * moments plays the paths live mode played:
 * - voices on one path (same pitch, velocity and destination) are one line, as the compiler's
 *   stacked lines; a line keeps the target group nearest where it was heading (ties: lower) and the
 *   other groups fork off it (births: silent for the crossing check until they depart, starting from
 *   the line's state there);
 * - timings: `drawTimings` over the movers (preDest, target, voice), every move ending together;
 * - overshoot limits L = min(1, gap to the pitch-order neighbours), narrowed by the range room;
 * - under `ordered`, the §7.2 crossing loop over every line, holding or still gliding from an
 *   earlier change: an overtaker adopts the overtaken's timing (union-find), a line still gliding
 *   that gets overtaken is re-timed with the group (a move to its own destination), a crossing
 *   before the group starts pulls its start back, and m₀ is tightened (`crossScale`) where equal
 *   timing cannot help;
 * - carried velocity is computed from each line's projected state at its own start.
 * Main thread only (allocates).
 */

import { CHECK_SAMPLES, FREE_LIMITS, MAX_OVERSHOOT, type OvershootLimits } from './interrupt';
import { carriedVelocity, segmentFromCarried, type StartState } from './interrupt';
import { easeCodeOf, bezierOf, easeSlope0 } from './ease';
import { SAME_TIME } from './compiler/compile';
import { drawTimings, MIN_GLIDE, sharedEnd } from './compiler/glide';
import { hash32 } from './rng';
import { evalSegment, evalSegmentVelocity } from './segment';
import type { EaseRef, Glide, Pitch, Seconds, Segment } from './types';

/** Order reversals up to this are touching, not crossing (compiler/plan.ts CROSS_EPS). */
const CROSS_EPS = 1e-9;
const SAMPLES = CHECK_SAMPLES;
/** A cancellation's hold starts this long after the glide in force ends (s), keeping its strike. */
const CANCEL_AFTER = 0.001;
/** Resting pitches this close are one note (compile.ts SAME_PITCH). */
const SAME_PITCH = 1e-6;
/** Voices this close share a path (one line). */
const SAME = 1e-9;

/** What the planner reads of one live voice (decision time 0). */
export interface PlanVoice {
  index: number;
  id: string;
  range: readonly [Pitch, Pitch];
  /** Committed destination. */
  dest: Pitch;
  pitch: Pitch;
  velocity: number;
  /** The segment in force now, times from the decision. */
  seg: Segment;
  /** The line it is on (the pool index standing for it). */
  line: number;
  /** It has moves posted that have not started (cancelled by this change unless it moves). */
  pending?: boolean;
}

/** One planned move of a live voice (core/live.ts LiveMove without the strike share). */
export interface PlannedMove {
  voice: number;
  delay: Seconds;
  dur: Seconds;
  p1: Pitch;
  /** Scale on the raw carried-velocity term at the move's start (the worklet re-derives it). */
  scale: number;
  /** Index of the part it belongs to (moves of one part share a strike); −1: a cancellation. */
  part: number;
  /** Order of application within one voice (a fork first follows its parent's move). */
  order: number;
  /** The line the voice is on after it (pool index). */
  line: number;
}

const enum Kind {
  Fixed = 0,
  Move = 1,
  Birth = 2,
}

interface Part {
  kind: Kind;
  /** The voice standing for it (pool index): the line's, or the fork's carrier. */
  voice: number;
  hash: number;
  range: readonly [Pitch, Pitch];
  /** Live voices on it. */
  voices: number[];
  to: Pitch;
  preDest: Pitch;
  /** Births: the parent part. */
  parent: number;
  /** The in-force segment (lines; a birth's parent's). */
  seg: Segment;
  limits: OvershootLimits;
  crossScale: number;
  moving: boolean;
  t0: Seconds;
  dur: Seconds;
  /** Projection cache (cleared when the part changes). */
  move: Segment | null;
  start: StartState | null;
  samples: Float64Array | null;
}

/** A glide (pitch changes) as opposed to a hold. */
function glides(s: Segment): boolean {
  return s.p0 !== (s.curve ? s.curve.p1 : s.p1) || (s.m0 ?? 0) !== 0;
}

/** Frontier.stateAt on segment s at t (compiler/voice.ts). */
function stateOf(s: Segment, t: Seconds): StartState {
  if (t < s.t1 && glides(s))
    return { p: evalSegment(s, t), v: evalSegmentVelocity(s, t), mid: true };
  return { p: t < s.t1 ? evalSegment(s, t) : s.p1, v: 0, mid: false };
}

/**
 * Plans the moves taking `voices` to `targets` (same order). `ordered`: the crossing guarantee
 * and neighbour limits apply.
 */
export function planLive(
  voices: readonly PlanVoice[],
  targets: readonly Pitch[],
  glide: Glide,
  ease: EaseRef,
  ordered: boolean,
  seed: number,
): PlannedMove[] {
  // Lines: voices on one path.
  const lines: number[][] = [];
  const byIndex = [...voices.keys()].sort((a, b) => voices[a].index - voices[b].index);
  for (const k of byIndex) {
    const v = voices[k];
    const line = lines.find((l) => {
      const u = voices[l[0]];
      return (
        u.dest === v.dest &&
        Math.abs(u.pitch - v.pitch) <= SAME &&
        Math.abs(u.velocity - v.velocity) <= SAME
      );
    });
    if (line) line.push(k);
    else lines.push([k]);
  }
  const parts: Part[] = [];
  const mk = (kind: Kind, k: number, members: number[], to: Pitch, preDest: Pitch): Part => {
    const v = voices[k];
    const p: Part = {
      kind,
      voice: v.index,
      hash: hash32(v.id),
      range: v.range,
      voices: members.map((m) => voices[m].index),
      to,
      preDest,
      parent: -1,
      seg: v.seg,
      limits: FREE_LIMITS,
      crossScale: 1,
      moving: kind !== Kind.Fixed,
      t0: 0,
      dur: 0,
      move: null,
      start: null,
      samples: null,
    };
    parts.push(p);
    return p;
  };
  const key = (p: Pitch): number => Math.round(p * 1e6);
  const births: { line: number; k: number; members: number[]; to: Pitch }[] = [];
  for (const line of lines) {
    const d0 = voices[line[0]].dest;
    const groups: { to: Pitch; n: number }[] = [];
    for (const k of line) {
      const to = targets[k];
      const g = groups.find((x) => key(x.to) === key(to));
      if (g) g.n++;
      else groups.push({ to, n: 1 });
    }
    groups.sort((g, h) => g.to - h.to);
    const primary = groups.reduce((a, g) => {
      const da = Math.abs(a.to - d0);
      const dg = Math.abs(g.to - d0);
      return dg < da || (dg === da && g.to < a.to) ? g : a;
    });
    // The line keeps its own voice; the forks, low to high, take its other voices low to high
    // (a carrier whose range holds the target first), then the line's members, then each fork's.
    // The line stands for its voices as before; lines that met on this note since are one, the
    // one holding longest (ties: lower index) standing for it, as compile.ts `onJoin` keeps.
    const since = (k: number): Seconds =>
      glides(voices[k].seg) ? voices[k].seg.t1 : voices[k].seg.t0;
    const reps = line.filter((k) => voices[k].line === voices[k].index);
    const rep =
      reps.length === 0
        ? line[0]
        : reps.reduce((a, k) =>
            since(k) < since(a) - SAME_TIME ||
            (Math.abs(since(k) - since(a)) <= SAME_TIME && voices[k].index < voices[a].index)
              ? k
              : a,
          );
    const spare = line.filter((k) => k !== rep);
    const forks = groups.filter((g) => g !== primary);
    const carriers = forks.map((g) => {
      let j = spare.findIndex((k) => voices[k].range[0] <= g.to && g.to <= voices[k].range[1]);
      if (j < 0) j = 0;
      return spare.splice(j, 1)[0];
    });
    const own = [rep, ...spare.splice(0, primary.n - 1)];
    const moves = primary.to !== d0;
    if (moves || ordered) mk(moves ? Kind.Move : Kind.Fixed, rep, own, primary.to, d0);
    const li = parts.length - 1;
    forks.forEach((g, j) => {
      births.push({
        line: moves || ordered ? li : -1,
        k: carriers[j],
        members: [carriers[j], ...spare.splice(0, g.n - 1)],
        to: g.to,
      });
    });
    if (!(moves || ordered)) {
      // Free assignment, line staying: its forks still need the line's path.
      const p = mk(Kind.Fixed, rep, own, primary.to, d0);
      p.moving = false;
      for (const b of births) if (b.line === -1) b.line = parts.length - 1;
    }
  }
  for (const b of births) {
    const parent = parts[b.line];
    const p = mk(Kind.Birth, b.k, b.members, b.to, parent.preDest);
    p.parent = b.line;
    p.seg = parent.seg;
  }
  const n = parts.length;
  // A part made only to carry a free fork's parent path takes no part in the order.
  const inOrder = (i: number): boolean => ordered || parts[i].kind !== Kind.Fixed;

  // Timings.
  const movers = parts
    .map((_, i) => i)
    .filter((i) => parts[i].kind !== Kind.Fixed)
    .sort(
      (a, b) =>
        parts[a].preDest - parts[b].preDest ||
        parts[a].to - parts[b].to ||
        parts[a].voice - parts[b].voice,
    );
  const drawn = drawTimings(
    movers.map((i) => ({ hash: parts[i].hash, index: parts[i].voice })),
    glide,
    seed,
  );
  const uf = parts.map((_, i) => i);
  const gStart = parts.map(() => 0);
  const gLink = parts.map(() => -1);
  movers.forEach((i, r) => (gStart[i] = drawn[r].offset));
  const find = (i: number): number => {
    while (uf[i] !== i) {
      uf[i] = uf[uf[i]];
      i = uf[i];
    }
    return i;
  };
  const startOf = (i: number): Seconds => {
    const r = find(i);
    return gLink[r] >= 0 ? startOf(gLink[r]) : gStart[r];
  };
  let lastStart = 0;
  for (const i of movers) lastStart = Math.max(lastStart, startOf(i));
  const endT = sharedEnd(lastStart, glide, seed);
  const durOf = (i: number): Seconds => Math.max(MIN_GLIDE, endT - startOf(i));

  // Overshoot limits.
  const order = parts.map((_, i) => i).filter(inOrder);
  const m = order.length;
  if (ordered) {
    order.sort(
      (a, b) =>
        parts[a].to - parts[b].to ||
        parts[a].preDest - parts[b].preDest ||
        parts[a].voice - parts[b].voice,
    );
  }
  const limitsOf = (i: number): OvershootLimits => {
    const k = order.indexOf(i);
    const p = parts[i];
    let up = MAX_OVERSHOOT;
    let down = MAX_OVERSHOOT;
    if (k + 1 < m) {
      const q = parts[order[k + 1]];
      up = Math.min(up, Math.abs(q.preDest - p.preDest), Math.abs(q.to - p.to));
    }
    if (k > 0) {
      const q = parts[order[k - 1]];
      down = Math.min(down, Math.abs(q.preDest - p.preDest), Math.abs(q.to - p.to));
    }
    return { up, down };
  };
  if (ordered)
    for (const i of order) if (parts[i].kind !== Kind.Fixed) parts[i].limits = limitsOf(i);

  // Projections.
  const touched = new Uint8Array(n);
  const clear = (i: number): void => {
    const p = parts[i];
    p.move = null;
    p.start = null;
    p.samples = null;
    touched[i] = 1; // as plan.ts `invalidate`: skipped for the rest of the pass
    for (let j = 0; j < n; j++) if (parts[j].parent === i) clear(j);
  };
  const sync = (): void => {
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      if (!p.moving) continue;
      const s = startOf(i);
      const d = durOf(i);
      if (s !== p.t0 || d !== p.dur) {
        p.t0 = s;
        p.dur = d;
        clear(i);
      }
    }
  };
  for (let i = 0; i < n; i++) {
    if (!parts[i].moving) continue;
    parts[i].t0 = startOf(i);
    parts[i].dur = durOf(i);
  }
  /** State just before t (the left limit) of part i: its path up to t. */
  const stateBefore = (i: number, t: Seconds): StartState => {
    const p = parts[i];
    if (p.kind === Kind.Birth) {
      const mv = moveOf(i);
      return stateOf(mv, t);
    }
    if (p.moving && p.t0 < t) return stateOf(moveOf(i), t);
    return stateOf(p.seg, t);
  };
  const startState = (i: number): StartState => {
    const p = parts[i];
    if (p.start) return p.start;
    p.start = p.kind === Kind.Birth ? stateBefore(p.parent, p.t0) : stateOf(p.seg, p.t0);
    return p.start;
  };
  function moveOf(i: number): Segment {
    const p = parts[i];
    if (p.move) return p.move;
    const st = startState(i);
    const hi = st.p > p.to ? st.p : p.to;
    const lo = st.p < p.to ? st.p : p.to;
    const roomUp = p.range[1] - hi;
    const roomDown = lo - p.range[0];
    const up = p.limits.up < roomUp ? p.limits.up : roomUp > 0 ? roomUp : 0;
    const down = p.limits.down < roomDown ? p.limits.down : roomDown > 0 ? roomDown : 0;
    const carried = carriedVelocity(st, p.dur, p.to, ease, { up, down });
    p.move = segmentFromCarried(st.p, p.t0, p.dur, p.to, ease, carried, p.crossScale);
    return p.move;
  }
  const pitchAt = (i: number, t: Seconds): Pitch => {
    const p = parts[i];
    if (p.kind === Kind.Birth) return t < p.t0 ? NaN : evalSegment(moveOf(i), t);
    if (p.moving && t >= p.t0) return evalSegment(moveOf(i), t);
    return evalSegment(p.seg, t);
  };

  let we = 0;
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const e = p.moving ? p.t0 + p.dur : glides(p.seg) ? p.seg.t1 : 0;
    if (e > we) we = e;
  }
  const times = new Float64Array(SAMPLES);
  for (let j = 0; j < SAMPLES; j++) times[j] = (we * j) / (SAMPLES - 1);
  const sample = (i: number): Float64Array => {
    const p = parts[i];
    if (p.samples) return p.samples;
    const out = new Float64Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j++) out[j] = pitchAt(i, times[j]);
    p.samples = out;
    return out;
  };

  if (ordered && m >= 2 && parts.some((p) => p.moving)) {
    enforce();
  }

  function enforce(): void {
    let crossRef = 0;
    let crossBirth = -1;
    const crossing = (li: number, hi: number): number => {
      const a = sample(li);
      const b = sample(hi);
      for (const i of [li, hi]) {
        const p = parts[i];
        if (p.kind !== Kind.Birth) continue;
        const x = pitchAt(li, p.t0);
        const y = pitchAt(hi, p.t0);
        if (x > y + CROSS_EPS) {
          crossBirth = i;
          return -3;
        }
      }
      let j = 0;
      for (; j < SAMPLES; j++) {
        const x = a[j];
        const y = b[j];
        if (x !== x || y !== y) continue;
        crossRef = j;
        if (x > y + CROSS_EPS) return -2;
        break;
      }
      for (j++; j < SAMPLES; j++) {
        const x = a[j];
        const y = b[j];
        if (x !== x || y !== y) continue;
        if (x > y + CROSS_EPS) return j;
      }
      return -1;
    };
    const adopt = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      gStart[rb] = gLink[rb] >= 0 ? startOf(gLink[rb]) : gStart[rb];
      gLink[rb] = -1;
      uf[ra] = rb;
    };
    const retime = (i: number): void => {
      const p = parts[i];
      p.kind = Kind.Move;
      p.moving = true;
      p.limits = limitsOf(i);
      p.t0 = startOf(i);
      p.dur = durOf(i);
      clear(i);
    };
    const setScale = (ps: Part[], s: number): void => {
      for (const p of ps) {
        p.crossScale = s;
        clear(parts.indexOf(p));
      }
      sync();
    };
    const tighten = (lo: number, up: number): boolean => {
      const ms = [parts[lo], parts[up]].filter((p) => p.moving);
      if (ms.length === 0) return false;
      const saved = ms.map((p) => p.crossScale);
      setScale(ms, 0);
      if (crossing(lo, up) !== -1) {
        ms.forEach((p, k) => {
          p.crossScale = saved[k];
          clear(parts.indexOf(p));
        });
        sync();
        return false;
      }
      const cap = saved.reduce((x, y) => (y < x ? y : x), 1);
      const a0 = sample(lo).slice();
      const b0 = sample(up).slice();
      setScale(ms, cap);
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
      setScale(ms, s);
      for (let k = 0; k < 8 && s > 0 && crossing(lo, up) !== -1; k++) {
        s = k < 7 ? s / 2 : 0;
        setScale(ms, s);
      }
      return true;
    };
    const pullBack = (i: number, at: number): boolean => {
      const t = times[at - 1];
      const s = startOf(i);
      if (!(s > t)) return false;
      const r = find(i);
      gLink[r] = -1;
      gStart[r] = t;
      return true;
    };
    const lateBirth = (li: number, hi: number): number => {
      const t = times[crossRef];
      const tPrev = crossRef > 0 ? times[crossRef - 1] : -Infinity;
      const bornHere = (i: number): number => {
        const p = parts[i];
        return p.kind === Kind.Birth && p.t0 > tPrev && p.t0 <= t ? p.t0 : -Infinity;
      };
      const bl = bornHere(li);
      const bh = bornHere(hi);
      if (bl === -Infinity && bh === -Infinity) return -1;
      return bh > bl ? hi : li;
    };
    // Pairs: adjacent in `order`, then across lines not born at 0.
    const pairLo: number[] = [];
    const pairHi: number[] = [];
    for (let k = 0; k + 1 < m; k++) {
      pairLo.push(k);
      pairHi.push(k + 1);
    }
    const unborn = (i: number): boolean => parts[i].kind === Kind.Birth;
    for (let k = 0; k + 2 < m; k++) {
      for (let q = k + 1; q + 1 < m && unborn(order[q]); q++) {
        pairLo.push(k);
        pairHi.push(q + 1);
      }
    }
    const unresolved = new Set<number>();
    const maxPasses = 3 * m + 8;
    for (let pass = 0; pass < maxPasses; pass++) {
      let acted = false;
      touched.fill(0);
      for (let k = 0; k < pairLo.length; k++) {
        const li = order[pairLo[k]];
        const hi = order[pairHi[k]];
        if (touched[li] || touched[hi]) continue;
        const lo = parts[li];
        const up = parts[hi];
        if (!lo.moving && !up.moving) continue;
        const pk = li * n + hi;
        if (unresolved.has(pk)) continue;
        const at = crossing(li, hi);
        if (at === -1) continue;
        const mark = (): void => {
          touched[li] = 1;
          touched[hi] = 1;
        };
        if (at === -2 || at === -3) {
          const nb = at === -3 ? crossBirth : lateBirth(li, hi);
          const other = nb === li ? hi : li;
          const o = parts[other];
          if (nb >= 0 && o.kind === Kind.Fixed) {
            if (glides(o.seg) && o.seg.t1 > 0) {
              retime(other);
              adopt(other, nb);
              acted = true;
              sync();
              mark();
              continue;
            }
          } else if (nb >= 0 && find(nb) !== find(other)) {
            adopt(nb, other);
            acted = true;
            sync();
            mark();
            continue;
          }
          if (nb >= 0 && tighten(li, hi)) {
            acted = true;
            mark();
            continue;
          }
          unresolved.add(pk);
          continue;
        }
        acted = true;
        const sl = sample(li);
        const sh = sample(hi);
        const dLo = sl[at] - sl[crossRef];
        const dHi = sh[crossRef] - sh[at];
        const [ai, bi] = dLo >= dHi ? [li, hi] : [hi, li];
        if (parts[ai].moving && parts[bi].moving) {
          if (find(ai) === find(bi)) {
            if (!pullBack(ai, at) && !tighten(li, hi)) unresolved.add(pk);
          } else adopt(ai, bi);
        } else {
          const fixedI = parts[ai].moving ? bi : ai;
          const fixed = parts[fixedI];
          if (glides(fixed.seg) && fixed.seg.t1 > 0) {
            retime(fixedI);
            if (fixedI === ai) adopt(ai, bi);
            else adopt(bi, ai);
          } else if (!pullBack(parts[ai].moving ? ai : bi, at) && !tighten(li, hi)) {
            unresolved.add(pk);
          }
        }
        sync();
        mark();
      }
      if (!acted) break;
    }
  }

  // Moves: a fork first follows its parent's move when that starts before it departs.
  const s0 = easeSlope0(easeCodeOf(ease), bezierOf(ease));
  const scaleOf = (i: number): number => {
    const st = startState(i);
    const seg = moveOf(i);
    const p = parts[i];
    const raw = st.mid ? st.v * p.dur - (Number.isFinite(s0) ? (p.to - st.p) * s0 : 0) : 0;
    const m0 = seg.m0 ?? 0;
    return raw === 0 || m0 === 0 ? (raw === 0 ? 1 : 0) : m0 / raw;
  };
  // Joins (compile.ts `onJoin`): a line arriving, before its move starts, on the note another line
  // holds, both bound for one destination, merges into the one holding longest (ties: lower
  // index) and drops its move: its voices follow that line's.
  const follow = parts.map((_, i) => i);
  const sinceOf = (q: Part): Seconds => (glides(q.seg) ? q.seg.t1 : q.seg.t0);
  const byArrival = parts
    .map((_, i) => i)
    .filter((i) => parts[i].kind === Kind.Move && glides(parts[i].seg) && parts[i].seg.t1 > 0)
    .sort((a, b) => parts[a].seg.t1 - parts[b].seg.t1);
  for (const i of byArrival) {
    const p = parts[i];
    const ta = p.seg.t1;
    if (!(p.t0 > ta) || follow[i] !== i) continue;
    let s = i;
    for (let j = 0; j < n; j++) {
      const q = parts[j];
      if (j === i || q.kind !== Kind.Move || follow[j] !== j) continue;
      if (Math.abs(q.to - p.to) > SAME_PITCH || !(q.t0 > ta)) continue;
      if (glides(q.seg) && q.seg.t1 > ta) continue; // still gliding there
      if (Math.abs(q.seg.p1 - p.seg.p1) > SAME_PITCH) continue;
      const a = sinceOf(parts[s]);
      const b = sinceOf(q);
      if (b < a - SAME_TIME || (Math.abs(b - a) <= SAME_TIME && q.voice < parts[s].voice)) s = j;
    }
    if (s !== i) follow[i] = s;
  }

  const out: PlannedMove[] = [];
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    if (!p.moving) continue;
    if (follow[i] !== i) {
      // Holds until it arrives, then follows the line it joined.
      const q = parts[follow[i]];
      const qs = scaleOf(follow[i]);
      for (const v of p.voices) {
        out.push({
          voice: v,
          delay: q.t0,
          dur: q.dur,
          p1: q.to,
          scale: qs,
          part: follow[i],
          order: 0,
          line: q.voice,
        });
      }
      continue;
    }
    const scale = scaleOf(i);
    let order = 0;
    if (p.kind === Kind.Birth) {
      const q = parts[p.parent];
      if (q.moving && q.t0 < p.t0) {
        const qs = scaleOf(p.parent);
        for (const v of p.voices) {
          out.push({
            voice: v,
            delay: q.t0,
            dur: q.dur,
            p1: q.to,
            scale: qs,
            part: p.parent,
            order: 0,
            line: q.voice,
          });
        }
        order = 1;
      }
    }
    for (const v of p.voices) {
      out.push({
        voice: v,
        delay: p.t0,
        dur: p.dur,
        p1: p.to,
        scale,
        part: i,
        order,
        line: p.voice,
      });
    }
  }
  // Voices that do not move but had moves pending: those are cancelled (the compiler cancels every
  // targeted line's pending moves), by a hold from the end of the glide in force.
  const moved = new Set(out.map((x) => x.voice));
  for (const v of voices) {
    if (!v.pending || moved.has(v.index)) continue;
    out.push({
      voice: v.index,
      delay: glides(v.seg) && v.seg.t1 > 0 ? v.seg.t1 + CANCEL_AFTER : 0,
      dur: MIN_GLIDE,
      p1: v.seg.p1,
      scale: 0,
      part: -1,
      order: 0,
      line: v.line,
    });
  }
  return out;
}
