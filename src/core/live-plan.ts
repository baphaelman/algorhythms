/**
 * Live moves planned by the compiler's rules (PLAN.md §7.2, §7.4, §7.5, §9; §15 M7 "a recorded
 * take plays back with pitch paths matching the live ones"). A port of compiler/plan.ts
 * `planMoment` and compiler/lines.ts `collapse` onto the live voices, so a take compiled as
 * moments plays the paths live mode played:
 * - voices on one line id (dsp/live.ts LIVE_LINE) and one path are one line, as the compiler's
 *   stacked lines; lines that meet on a note stay apart unless they merge as `onJoin` merges
 *   them, which the moves record in the ids (LIVE_JOIN, holds); a line keeps the target group
 *   nearest where it was heading (ties: lower) and the other groups fork off it (births: silent
 *   for the crossing check until they depart, starting from the line's state there);
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
  /** Its part (absent: none); lines of different parts never merge. */
  part?: string;
  /** It has moves posted that have not started (cancelled by this change unless it moves). */
  pending?: boolean;
  /** A fork not departed yet: when it leaves and the line it forms (core/live.ts LiveVoiceView). */
  unborn?: { t: Seconds; line: number };
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
  /** A fork's departure: until it starts the voice is not a line of its own. */
  born: boolean;
  /** The line it is on from its arrival, when it merges there into another (−1: `line`). */
  join: number;
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
  /** Its voices' line id now (lines; births and unborn lines: `voice`). */
  line: number;
  /** Its part ('' = none). */
  group: string;
  hash: number;
  range: readonly [Pitch, Pitch];
  /** Live voices on it. */
  voices: number[];
  to: Pitch;
  preDest: Pitch;
  /** Births and unborn lines: the parent part (−1: an unborn line's parent is not in the plan). */
  parent: number;
  /**
   * Not born before this (plan.ts `deferT`): a line whose fork has not departed (compile.ts
   * `pendingBirth`), or a birth off one; −Infinity otherwise.
   */
  deferT: Seconds;
  /** An unborn line: the voice of the line it is still on. */
  parentVoice: number;
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
      // A fork not departed yet is its own line (with the voices of its fork), not its parent's.
      if (u.unborn || v.unborn) {
        return (
          u.unborn !== undefined &&
          v.unborn !== undefined &&
          u.unborn.line === v.unborn.line &&
          Math.abs(u.unborn.t - v.unborn.t) <= SAME_TIME
        );
      }
      // One line: one path and one line id (lines meeting on a note without merging stay apart).
      return (
        u.line === v.line &&
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
      line: kind === Kind.Birth || v.unborn ? v.index : v.line,
      group: v.part ?? '',
      hash: hash32(v.id),
      range: v.range,
      voices: members.map((m) => voices[m].index),
      to,
      preDest,
      parent: -1,
      deferT: -Infinity,
      parentVoice: -1,
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
    // one holding longest (ties: lower index) standing for it, as compile.ts `onJoin` keeps. An
    // unborn line: its fork's carrier.
    const since = (k: number): Seconds =>
      glides(voices[k].seg) ? voices[k].seg.t1 : voices[k].seg.t0;
    const ub = voices[line[0]].unborn;
    const reps = ub
      ? line.filter((k) => voices[k].index === ub.line)
      : line.filter((k) => voices[k].line === voices[k].index);
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
    if (moves || ordered) {
      const p = mk(moves ? Kind.Move : Kind.Fixed, rep, own, primary.to, d0);
      if (ub) {
        p.deferT = ub.t;
        p.parentVoice = voices[rep].line;
      }
    }
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
      if (ub) {
        p.deferT = ub.t;
        p.parentVoice = voices[rep].line;
      }
      for (const b of births) if (b.line === -1) b.line = parts.length - 1;
    }
  }
  for (const b of births) {
    const parent = parts[b.line];
    const p = mk(Kind.Birth, b.k, b.members, b.to, parent.preDest);
    p.parent = b.line;
    p.seg = parent.seg;
    p.deferT = parent.deferT; // a fork off a line not born yet waits for it (plan.ts)
  }
  const n = parts.length;
  /** A line whose fork has not departed (not a birth of this change). */
  const unbornLine = (i: number): boolean =>
    parts[i].kind !== Kind.Birth && parts[i].deferT > -Infinity;
  for (let i = 0; i < n; i++) {
    if (!unbornLine(i)) continue;
    const pv = parts[i].parentVoice;
    parts[i].parent = parts.findIndex(
      (q, j) => j !== i && q.kind !== Kind.Birth && q.voices.includes(pv),
    );
  }
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
    const s = gLink[r] >= 0 ? startOf(gLink[r]) : gStart[r];
    return s > parts[i].deferT ? s : parts[i].deferT;
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
  const clear = (i: number, depth = 0): void => {
    const p = parts[i];
    p.move = null;
    p.start = null;
    p.samples = null;
    touched[i] = 1; // as plan.ts `invalidate`: skipped for the rest of the pass
    if (depth < 40) for (let j = 0; j < n; j++) if (parts[j].parent === i) clear(j, depth + 1);
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
  /** An unborn line's birth: when its move departs, else when its fork was to (projector). */
  const bornT = (i: number): Seconds => (parts[i].moving ? parts[i].t0 : parts[i].deferT);
  /** The path an unborn line follows until its birth: its parent's. */
  const parentState = (i: number, t: Seconds, depth: number): StartState => {
    const p = parts[i];
    return p.parent >= 0 && depth < 40 ? stateBefore(p.parent, t, depth + 1) : stateOf(p.seg, t);
  };
  /** Where an unborn line left holding is born: its parent's pitch then. */
  const holdPitch = (i: number): Pitch => parentState(i, parts[i].deferT, 0).p;
  /** State just before t (the left limit) of part i: its path up to t. */
  const stateBefore = (i: number, t: Seconds, depth = 0): StartState => {
    const p = parts[i];
    if (unbornLine(i)) {
      if (t <= bornT(i)) return parentState(i, t, depth);
      if (p.moving) return stateOf(moveOf(i), t);
      return { p: holdPitch(i), v: 0, mid: false };
    }
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
    p.start =
      p.kind === Kind.Birth
        ? stateBefore(p.parent, p.t0)
        : unbornLine(i)
          ? parentState(i, p.t0, 0)
          : stateOf(p.seg, p.t0);
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
    if (unbornLine(i)) {
      if (t < bornT(i)) return NaN;
      return p.moving ? evalSegment(moveOf(i), t) : holdPitch(i);
    }
    if (p.moving && t >= p.t0) return evalSegment(moveOf(i), t);
    return evalSegment(p.seg, t);
  };

  let we = 0;
  let maxDur = 0;
  let maxDefer = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const e = p.moving ? p.t0 + p.dur : glides(p.seg) && !unbornLine(i) ? p.seg.t1 : 0;
    if (e > we) we = e;
    if (p.moving && p.dur > maxDur) maxDur = p.dur;
    if (p.deferT > maxDefer) maxDefer = p.deferT;
  }
  if (maxDefer + maxDur > we) we = maxDefer + maxDur;
  /** Still gliding from an earlier change (plan.ts `lastGlideEnd() > T`); unborn: not sounding. */
  const stillGliding = (i: number): boolean =>
    !unbornLine(i) && glides(parts[i].seg) && parts[i].seg.t1 > 0;
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
      if (!(s > t) || parts[i].deferT >= s) return false;
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
    const unborn = (i: number): boolean => parts[i].kind === Kind.Birth || parts[i].deferT > 0;
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
            if (stillGliding(other)) {
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
          if (stillGliding(fixedI)) {
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
  // Joins (compile.ts `onJoin`), run as the events after this change will run them: a line coming
  // to rest (its glide in force or its move arriving, its birth, or held by this change with
  // nothing pending) merges with every line resting on its note bound for the same destination
  // (nothing pending, or pending moves to one note). The one there first survives (ties: lower
  // index); the others drop their pending moves and follow it, and their voices take its line id.
  const sinceOf = (q: Part): Seconds => (glides(q.seg) ? q.seg.t1 : q.seg.t0);
  const arrive = (i: number): Seconds => parts[i].t0 + parts[i].dur;
  const bornAt = (i: number): Seconds =>
    parts[i].kind === Kind.Birth ? parts[i].t0 : unbornLine(i) ? bornT(i) : -Infinity;
  const holdingAt = (i: number, t: Seconds): boolean => {
    const p = parts[i];
    if (t < bornAt(i)) return false;
    if (p.moving && t >= p.t0) return t >= arrive(i) || !glides(moveOf(i));
    if (p.kind === Kind.Birth || (unbornLine(i) && p.moving)) return false;
    if (unbornLine(i)) return true;
    return !(glides(p.seg) && t < p.seg.t1);
  };
  const headingAt = (i: number, t: Seconds): Pitch => {
    const p = parts[i];
    if (p.moving && t >= p.t0) return p.to;
    return unbornLine(i) ? holdPitch(i) : p.seg.p1;
  };
  const destAt = (i: number, t: Seconds): Pitch =>
    parts[i].moving && t < parts[i].t0 ? parts[i].to : headingAt(i, t);
  const restingSince = (i: number, t: Seconds): Seconds => {
    const p = parts[i];
    if (p.moving && t >= p.t0) return glides(moveOf(i)) ? arrive(i) : p.t0;
    return unbornLine(i) ? p.deferT : sinceOf(p);
  };
  const events: { t: Seconds; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const born = p.kind === Kind.Birth || unbornLine(i);
    if (p.moving) events.push({ t: arrive(i), i });
    if (!born && glides(p.seg) && p.seg.t1 > 0 && (!p.moving || p.seg.t1 <= p.t0))
      events.push({ t: p.seg.t1, i });
    if (!p.moving && unbornLine(i)) events.push({ t: p.deferT, i });
    if (!p.moving && !born && holdingAt(i, 0)) events.push({ t: 0, i });
  }
  events.sort((a, b) => a.t - b.t || parts[a.i].voice - parts[b.i].voice);
  /** The line a part merged into (−1: none), when, and whether its own move was still to come. */
  const into = parts.map(() => -1);
  const diedAt = parts.map(() => Infinity);
  const dropped = parts.map(() => false);
  const members = parts.map((p) => [...p.voices]);
  const idChanges: { voice: number; t: Seconds; line: number; p: Pitch }[] = [];
  /** A part's line id at t (its voices' LIVE_LINE). */
  const lineOf = (i: number, t: Seconds): number => {
    const p = parts[i];
    return p.kind === Kind.Birth || unbornLine(i) || (p.moving && t >= p.t0) ? p.voice : p.line;
  };
  for (const e of events) {
    const a = e.i;
    const t = e.t;
    if (into[a] >= 0 || !holdingAt(a, t)) continue;
    const pa = headingAt(a, t);
    const da = destAt(a, t);
    const group = [a];
    for (let j = 0; j < n; j++) {
      if (j === a || into[j] >= 0 || parts[j].group !== parts[a].group) continue;
      if (!holdingAt(j, t)) continue;
      if (Math.abs(headingAt(j, t) - pa) > SAME_PITCH) continue;
      if (Math.abs(destAt(j, t) - da) <= SAME_PITCH) group.push(j);
    }
    if (group.length < 2) continue;
    let s = group[0];
    for (const j of group) {
      const x = restingSince(j, t);
      const y = restingSince(s, t);
      if (x < y - SAME_TIME || (Math.abs(x - y) <= SAME_TIME && parts[j].voice < parts[s].voice))
        s = j;
    }
    for (const d of group) {
      if (d === s) continue;
      into[d] = s;
      diedAt[d] = t;
      dropped[d] = parts[d].moving && parts[d].t0 > t;
      const id = lineOf(s, t);
      for (const v of members[d]) idChanges.push({ voice: v, t, line: id, p: pa });
      members[s].push(...members[d]);
    }
  }
  /** The line whose moves a merged part's voices follow: past those whose own moves were dropped. */
  const moveOwner = (i: number): number => {
    let s = into[i];
    for (let k = 0; k < n && dropped[s] && into[s] >= 0; k++) s = into[s];
    return s;
  };

  const out: PlannedMove[] = [];
  /** Part q's change of path before `until` (its move, or an unborn line's hold), or null. */
  const pathOf = (
    qi: number,
    until: Seconds,
    depth = 0,
  ): Omit<PlannedMove, 'voice' | 'order'> | null => {
    const q = parts[qi];
    if (dropped[qi] && depth < n)
      return diedAt[qi] < until ? pathOf(moveOwner(qi), until, depth + 1) : null;
    if (q.moving && q.t0 < until) {
      const scale = scaleOf(qi);
      return {
        delay: q.t0,
        dur: q.dur,
        p1: q.to,
        scale,
        part: qi,
        line: q.voice,
        born: false,
        join: -1,
      };
    }
    if (!q.moving && unbornLine(qi) && q.deferT < until) {
      const p1 = holdPitch(qi);
      return {
        delay: q.deferT,
        dur: MIN_GLIDE,
        p1,
        scale: 0,
        part: -1,
        line: q.voice,
        born: false,
        join: -1,
      };
    }
    return null;
  };
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const forms = p.kind === Kind.Birth || unbornLine(i);
    if (!p.moving && !unbornLine(i)) continue;
    if (dropped[i]) continue; // its voices follow the line it merged into (below)
    // A fork (a birth, or a line not born yet) follows its parent's path until it departs.
    const at = p.moving ? p.t0 : p.deferT;
    const before = forms && p.parent >= 0 ? pathOf(p.parent, at) : null;
    if (before) for (const v of p.voices) out.push({ voice: v, order: 0, ...before });
    // Its own move; an unborn line that stays is born holding its parent's pitch there.
    const own = p.moving
      ? { delay: p.t0, dur: p.dur, p1: p.to, scale: scaleOf(i), part: i }
      : { delay: p.deferT, dur: MIN_GLIDE, p1: holdPitch(i), scale: 0, part: -1 };
    for (const v of p.voices)
      out.push({ voice: v, order: 0, ...own, line: p.voice, born: forms, join: -1 });
  }
  // Merged lines' voices follow the moves the line they merged into makes after the merge.
  for (let i = 0; i < n; i++) {
    if (into[i] < 0) continue;
    const s = moveOwner(i);
    const q = parts[s];
    if (dropped[s] || !q.moving || !(q.t0 > diedAt[i])) continue;
    const qs = scaleOf(s);
    for (const v of parts[i].voices) {
      out.push({
        voice: v,
        delay: q.t0,
        dur: q.dur,
        p1: q.to,
        scale: qs,
        part: s,
        order: 0,
        line: q.voice,
        born: false,
        join: -1,
      });
    }
  }
  // Voices that do not move but had moves pending: those are cancelled (the compiler cancels every
  // targeted line's pending moves), by a hold from the end of the glide in force.
  const cancelAt = (v: PlanVoice): Seconds =>
    glides(v.seg) && v.seg.t1 > 0 ? v.seg.t1 + CANCEL_AFTER : 0;
  const hold = (voice: number, delay: Seconds, p1: Pitch, line: number): PlannedMove => ({
    voice,
    delay,
    dur: MIN_GLIDE,
    p1,
    scale: 0,
    part: -1,
    order: 0,
    line,
    born: false,
    join: -1,
  });
  const moved = new Set(out.map((x) => x.voice));
  for (const v of voices)
    if (v.pending && !moved.has(v.index)) out.push(hold(v.index, cancelAt(v), v.seg.p1, v.line));
  // Line ids after merges: on the record arriving there, else on a hold from then on.
  for (const c of idChanges) {
    const recs = out.filter((x) => x.voice === c.voice);
    const arriving = recs.find(
      (x) =>
        Math.abs(x.delay + x.dur - c.t) <= SAME_TIME ||
        (x.born && x.part < 0 && Math.abs(x.delay - c.t) <= SAME_TIME),
    );
    if (arriving) {
      arriving.join = c.line;
      continue;
    }
    // A hold from then on (as a cancellation's, after the glide arriving there).
    const at = c.t > 0 ? c.t + CANCEL_AFTER : 0;
    const h = recs.find((x) => x.part < 0 && !x.born && Math.abs(x.delay - at) <= SAME_TIME);
    if (h) h.line = c.line;
    else out.push(hold(c.voice, at, c.p, c.line));
  }
  // Application order within a voice: by start.
  const seen = new Map<number, number>();
  out.sort((x, y) => x.delay - y.delay);
  for (const x of out) {
    const k = seen.get(x.voice) ?? 0;
    x.order = k;
    seen.set(x.voice, k + 1);
  }
  return out;
}
