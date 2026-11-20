/**
 * Planning a point moment's moves (PLAN.md §7.1 step 3 "moment", §7.2, §7.4, §7.5).
 *
 * Given the intents a moment function returned, the planner:
 * 1. folds targets into ranges (§7.8);
 * 2. draws start offsets and durations (stagger, order, jitter; §5, §7.7); a newborn starts at its
 *    parent's departure, or at a seeded birth stagger if the parent does not move (§7.4);
 * 3. under `ordered`, sets each mover's overshoot limit L = min(1 semitone, gap to its neighbour)
 *    (§7.5) and enforces the crossing guarantee (§7.2): every adjacent pair of targeted voices is
 *    sampled at 64 points over the moment's window; if a pair crosses, the overtaking voice adopts
 *    the overtaken voice's start time and duration (timing groups merge, union-find), repeated
 *    until no pair crosses. A voice still gliding from an earlier moment that gets overtaken is
 *    re-timed with the group (it gets a move to its own destination). Where equal timing cannot
 *    remove a crossing caused by carried velocity, m₀ is tightened by bisection (`crossScale`);
 *    whatever is left is reported (`crossing-unresolved`);
 * 4. for subset selectors, reports moves through untargeted voices (`crossing-untargeted`).
 *
 * All curves are read from projections (project.ts), which run the simulation's own code.
 */

import { Purpose, randHashed } from '../rng';
import { CHECK_SAMPLES, FREE_LIMITS, MAX_OVERSHOOT, type OvershootLimits } from '../interrupt';
import type { DiagnosticLevel, Glide, Pitch, Seconds } from '../types';
import { IntentKind, type MomentPlan } from '../moments/types';
import { birthFadeIn, drawTimings, glideDuration } from './glide';
import { Projector, type Tentative } from './project';
import { foldIntoRange } from './range';
import type { Birth, Move, VoiceRun } from './voice';

/** Order reversals smaller than this are touching, not crossing (semitones). */
export const CROSS_EPS = 1e-9;

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
  /** The voice is not born yet: its move cannot start before this time. */
  deferT: Seconds;
  limits: OvershootLimits;
  crossScale: number;
  move: Move | null;
  birth: Birth | null;
  samples: Float64Array;
  sampled: boolean;
}

/** What the planner needs from the compiler. */
export interface PlanHost {
  readonly voices: readonly VoiceRun[];
  readonly t: Seconds;
  readonly momentId: string;
  readonly momentIndex: number;
  readonly glide: Glide;
  readonly seed: number;
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

  // 1. Ranges (§7.8).
  let folded = 0;
  let clamped = 0;
  for (const it of plan.intents) {
    const r = voices[it.voice].range;
    const f = foldIntoRange(it.to, r[0], r[1]);
    if (f.folded) folded++;
    if (f.clampedToRange) clamped++;
    it.to = f.p;
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
      deferT: run.pendingBirth ? run.pendingBirth.t : -Infinity,
      limits: FREE_LIMITS,
      crossScale: 1,
      move: null,
      birth: null,
      samples: new Float64Array(CHECK_SAMPLES),
      sampled: false,
    };
    partOf.set(voice, parts.length);
    parts.push(p);
    return p;
  };
  for (const it of plan.intents) {
    if (it.kind === IntentKind.Birth) continue;
    const d = host.dest(it.voice);
    if (it.kind === IntentKind.Death) {
      mk(it.voice, PartKind.Death, it.to, d).fade = it.fade ?? 0;
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
    p.deferT = -Infinity;
  }
  const n = parts.length;

  // 3. Timings (§5, §7.4, §7.7): stratified offsets for movers, linked starts for newborns.
  const movers = parts
    .map((_, i) => i)
    .filter((i) => parts[i].kind === PartKind.Move || parts[i].kind === PartKind.Death)
    .sort((a, b) => parts[a].preDest - parts[b].preDest || parts[a].voice - parts[b].voice);
  const drawn = drawTimings(
    movers.map((i) => ({ hash: voices[parts[i].voice].hash, index: parts[i].voice })),
    glide,
    seed,
  );
  const uf = new Int32Array(n);
  const gStart = new Float64Array(n);
  const gDur = new Float64Array(n);
  const gLink = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) uf[i] = i;
  movers.forEach((i, r) => {
    gStart[i] = T + drawn[r].offset;
    gDur[i] = drawn[r].dur;
  });
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    if (p.kind !== PartKind.Birth) continue;
    const hash = voices[p.voice].hash;
    gDur[i] = glideDuration(glide, seed, hash);
    const pp = p.parent >= 0 ? partOf.get(p.parent) : undefined;
    if (
      pp !== undefined &&
      (parts[pp].kind === PartKind.Move || parts[pp].kind === PartKind.Death)
    ) {
      gLink[i] = pp;
    } else {
      gStart[i] = T + glide.stagger * randHashed(seed, hash, 0, Purpose.Birth);
    }
  }
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
  const durOf = (i: number): Seconds => gDur[find(i)];

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
    death: p.kind === PartKind.Death ? { fade: p.fade } : undefined,
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

  /** Re-applies group timings to the tentative records; invalidates what changed. */
  const sync = (): void => {
    let any = false;
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
        any = true;
      }
    }
    if (any) {
      projector.invalidate();
      for (const p of parts) p.sampled = false;
    }
  };

  // Window: the moment's time to the latest end of anything moving.
  let we = T;
  const window = (): void => {
    we = T;
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      const e = p.move ? p.move.t0 + p.move.dur : projector.get(p.voice).lastGlideEnd();
      if (e > we) we = e;
    }
  };
  const times = new Float64Array(CHECK_SAMPLES);
  const setTimes = (): void => {
    for (let j = 0; j < CHECK_SAMPLES; j++) times[j] = T + ((we - T) * j) / (CHECK_SAMPLES - 1);
  };
  const sample = (p: Part): Float64Array => {
    if (!p.sampled) {
      const proj = projector.get(p.voice);
      for (let j = 0; j < CHECK_SAMPLES; j++) p.samples[j] = proj.pitchAt(times[j]);
      p.sampled = true;
    }
    return p.samples;
  };

  /** First sample where lo is above hi; −1 if none; −2 if they start out of order. */
  const crossing = (lo: Part, hi: Part): { at: number; ref: number } => {
    const a = sample(lo);
    const b = sample(hi);
    let ref = -1;
    for (let j = 0; j < CHECK_SAMPLES; j++) {
      const x = a[j];
      const y = b[j];
      if (x !== x || y !== y) continue;
      if (ref < 0) {
        ref = j;
        if (x > y + CROSS_EPS) return { at: -2, ref };
        continue;
      }
      if (x > y + CROSS_EPS) return { at: j, ref };
    }
    return { at: -1, ref };
  };

  const enforce = ordered && n >= 2 && parts.some((p) => p.kind !== PartKind.Fixed);
  const unresolved = new Set<number>();
  if (enforce) {
    window();
    setTimes();
    const isMover = (p: Part): boolean => p.kind !== PartKind.Fixed;
    /** Scales down the carried velocity of the movers among (lo, up) until they stop crossing. */
    const tighten = (lo: Part, up: Part): boolean => {
      const ms = [lo, up].filter((p) => p.move !== null);
      if (ms.length === 0) return false;
      const saved = ms.map((p) => p.crossScale);
      const check = (s: number): boolean => {
        for (const p of ms) p.crossScale = s;
        sync();
        return crossing(lo, up).at === -1;
      };
      if (!check(0)) {
        ms.forEach((p, k) => (p.crossScale = saved[k]));
        sync();
        return false;
      }
      let ok = 0;
      let bad = saved.reduce((m, s) => (s < m ? s : m), 1);
      for (let k = 0; k < 16; k++) {
        const mid = (ok + bad) / 2;
        if (check(mid)) ok = mid;
        else bad = mid;
      }
      check(ok);
      return true;
    };

    const maxPasses = 3 * n + 8;
    for (let pass = 0; pass < maxPasses; pass++) {
      let acted = false;
      for (let k = 0; k + 1 < n && !acted; k++) {
        const li = order[k];
        const hi = order[k + 1];
        const lo = parts[li];
        const up = parts[hi];
        if (!isMover(lo) && !isMover(up)) continue;
        const key = li * n + hi;
        if (unresolved.has(key)) continue;
        const c = crossing(lo, up);
        if (c.at === -1) continue;
        if (c.at === -2) {
          unresolved.add(key); // already out of order when the moment starts: not its doing
          continue;
        }
        acted = true;
        const dLo = lo.samples[c.at] - lo.samples[c.ref];
        const dHi = up.samples[c.ref] - up.samples[c.at];
        const [a, ai, b, bi] = dLo >= dHi ? [lo, li, up, hi] : [up, hi, lo, li];
        if (isMover(a) && isMover(b)) {
          if (find(ai) === find(bi)) {
            if (!tighten(lo, up)) unresolved.add(key);
          } else {
            adopt(ai, bi);
          }
        } else {
          const fixedI = isMover(a) ? bi : ai;
          const fixed = parts[fixedI];
          if (projector.get(fixed.voice).lastGlideEnd() > T) {
            // Re-time the voice still gliding from an earlier moment with this group.
            fixed.kind = PartKind.Move;
            fixed.limits = limitsOf(fixedI);
            fixed.move = makeMove(fixed, fixedI);
            tentative.set(fixed.voice, { birth: null, moves: [fixed.move] });
            if (fixedI === ai) adopt(ai, bi);
            else adopt(bi, ai);
          } else if (!tighten(lo, up)) {
            unresolved.add(key);
          }
        }
        sync();
        window();
        setTimes();
        for (const p of parts) p.sampled = false;
      }
      if (!acted) break;
    }
    // Report pairs still crossing (not those that started out of order).
    let left = 0;
    for (let k = 0; k + 1 < n; k++) {
      const lo = parts[order[k]];
      const up = parts[order[k + 1]];
      if (!isMover(lo) && !isMover(up)) continue;
      if (crossing(lo, up).at >= 0) left++;
    }
    if (left > 0) {
      host.diag(
        'info',
        'crossing-unresolved',
        `${left} pair(s) of voices still cross mid-glide after timing merges.`,
      );
    }
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

  // 5. Moves through untargeted voices (§7.2 scope): info only.
  if (ordered && subset) {
    const inPlan = new Set(parts.map((p) => p.voice));
    const others: number[] = [];
    for (let v = 0; v < voices.length; v++) {
      if (inPlan.has(v)) continue;
      const run = voices[v];
      if (run.sounding || run.pendingBirth) others.push(v);
    }
    if (others.length > 0) {
      if (!enforce) {
        window();
        setTimes();
      }
      const crossed = new Set<string>();
      for (const p of parts) {
        if (!p.move) continue;
        const a = sample(p);
        for (const o of others) {
          const proj = projector.get(o);
          let sign = 0;
          for (let j = 0; j < CHECK_SAMPLES; j++) {
            const y = proj.pitchAt(times[j]);
            const x = a[j];
            if (x !== x || y !== y) continue;
            const s = x > y + CROSS_EPS ? 1 : x < y - CROSS_EPS ? -1 : 0;
            if (s === 0) continue;
            if (sign === 0) sign = s;
            else if (s !== sign) {
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
  if (!enforce) window();
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
