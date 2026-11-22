/**
 * `walk` (§6.2, §7.1): a region of independent stepwise melodies, the prototype's algorithm.
 *
 * On each tick (at, at + grid, … while < until), every eligible voice (in the walk's target,
 * active, idle, and driven by this walk) steps with probability `density`, by a step drawn from
 * `steps` (scale steps in the key in effect). Voices are visited from low to high and a step is
 * taken only if it lands strictly between the neighbours' committed destinations (no crossing or
 * touching), inside the voice's range. With `bass`, the walk's lowest voice leaps instead, to a
 * scale tone between leap[0] and leap[1] semitones away that stays more than 2 semitones below the
 * next voice (as in the prototype).
 *
 * With `over: 'chord'` (revision 10) and a chord in effect (`env.chord`), a step counts chord tones
 * instead (`stepByChord`), and the bass's drawn leap target moves to the nearest chord tone that
 * keeps the bass's constraints. The draws are the same as over the key.
 *
 * Draws are keyed by (walk seed, voice, tick index, purpose), so a voice's step at tick 12 depends
 * only on its own state (§7.7). All steps of a tick start at the tick with the same duration
 * (`stepGlide`) and ease, and idle voices carry no velocity, so two stepping voices whose start
 * and end are in order cannot cross mid-glide (§7.2's algebraic argument).
 */

import { Purpose, randHashed } from '../rng';
import { mod } from '../math';
import { pitchesWithPcs, scalePcs, stepByScale } from '../scales';
import type { CompiledScore, Key, MomentId, Pitch, Seconds, WalkMoment, WalkNote } from '../types';

/** Default step set (§6.2). */
export const DEFAULT_WALK_STEPS: readonly number[] = [-2, -1, 1, 2];

/** The bass stays more than this many semitones below the next voice (the prototype's margin). */
export const BASS_MARGIN = 2;

export interface WalkEnv {
  readonly t: Seconds;
  /** Tick index (the `step` of the keyed draws). */
  readonly tick: number;
  readonly key: Key;
  /**
   * Pitch classes of the chord in effect at the tick when the walk steps over chords
   * (`over: 'chord'`); null to step over the key (also before any chord).
   */
  readonly chord: readonly number[] | null;
  readonly seed: number;
  /** Every active voice, sorted by committed destination (ties: pool index). */
  readonly order: readonly number[];
  dest(v: number): Pitch;
  /** In the walk's target at this tick. */
  inTarget(v: number): boolean;
  /** In the target, active, idle and driven by this walk (§7.1). */
  eligible(v: number): boolean;
  range(v: number): readonly [Pitch, Pitch];
  /** hash32 of the voice id. */
  hash(v: number): number;
}

export interface WalkStep {
  voice: number;
  /** Committed destination before the step. */
  from: Pitch;
  to: Pitch;
}

/** One tick of a walk: the steps to start now, in low-to-high order. */
export function walkTick(w: WalkMoment, env: WalkEnv): WalkStep[] {
  const order = env.order;
  const n = order.length;
  const d = order.map((v) => env.dest(v));
  const steps = w.steps && w.steps.length > 0 ? w.steps : DEFAULT_WALK_STEPS;
  const density = Number.isFinite(w.density) ? w.density : 0;
  let bassVoice = -1;
  if (w.bass) {
    for (const v of order) {
      if (env.inTarget(v)) {
        bassVoice = v;
        break;
      }
    }
  }
  const out: WalkStep[] = [];
  for (let i = 0; i < n; i++) {
    const v = order[i];
    if (!env.eligible(v)) continue;
    const h = env.hash(v);
    if (randHashed(env.seed, h, env.tick, Purpose.WalkPick) >= density) continue;
    const below = i > 0 ? d[i - 1] : -Infinity;
    const above = i < n - 1 ? d[i + 1] : Infinity;
    const cur = d[i];
    const r = env.range(v);
    let to = NaN;
    if (v === bassVoice && w.bass) {
      const a = Math.abs(w.bass.leap[0]);
      const b = Math.abs(w.bass.leap[1]);
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const cands = pitchesWithPcs(scalePcs(env.key), r[0], r[1]).filter((p) => {
        const dist = Math.abs(p - cur);
        return dist >= lo && dist <= hi && p > below && p < above - BASS_MARGIN && p !== cur;
      });
      if (cands.length > 0) {
        to = cands[Math.floor(randHashed(env.seed, h, env.tick, Purpose.BassLeap) * cands.length)];
        if (env.chord) {
          to = nearestChordTone(
            to,
            env.chord,
            r,
            (p) => p > below && p < above - BASS_MARGIN && p !== cur,
          );
        }
      }
    } else {
      const s =
        steps[Math.floor(randHashed(env.seed, h, env.tick, Purpose.WalkStep) * steps.length)];
      const p = env.chord ? stepByChord(cur, s, env.chord) : stepByScale(cur, s, env.key);
      if (p > below && p < above && p >= r[0] && p <= r[1] && p !== cur) to = p;
    }
    if (Number.isFinite(to)) {
      d[i] = to;
      out.push({ voice: v, from: cur, to });
    }
  }
  return out;
}

/** Pitches within this of an integer count as that integer (on a chord tone). */
const EPS = 1e-9;

/**
 * Moves `p` by `steps` chord tones (revision 10): +n is the n-th chord tone strictly above p, −n
 * the n-th strictly below, so a voice off the chord first steps to the nearest chord tone in the
 * step's direction. 0 goes to the nearest chord tone (ties down). Non-integer steps are rounded;
 * an empty chord leaves p.
 */
export function stepByChord(p: Pitch, steps: number, pcs: readonly number[]): Pitch {
  const set = new Set(pcs.map((pc) => mod(Math.round(pc), 12)));
  if (set.size === 0 || !Number.isFinite(p)) return p;
  const n = Math.round(steps);
  if (n === 0) return nearestChordTone(p, pcs, [-Infinity, Infinity], () => true);
  const dir = n > 0 ? 1 : -1;
  let x = n > 0 ? Math.floor(p + EPS) + 1 : Math.ceil(p - EPS) - 1;
  let left = Math.abs(n);
  for (;;) {
    if (set.has(mod(x, 12)) && --left === 0) return x;
    x += dir;
  }
}

/**
 * The chord tone nearest p within `range` that passes `ok` (ties: the lower one), or NaN if none
 * does within an octave and a half.
 */
export function nearestChordTone(
  p: Pitch,
  pcs: readonly number[],
  range: readonly [Pitch, Pitch],
  ok: (q: Pitch) => boolean,
): Pitch {
  const set = new Set(pcs.map((pc) => mod(Math.round(pc), 12)));
  let best = NaN;
  // Ascending with a strict comparison, so at equal distance the lower tone wins.
  for (let q = Math.floor(p) - 18; q <= Math.ceil(p) + 18; q++) {
    if (!set.has(mod(q, 12)) || q < range[0] || q > range[1] || !ok(q)) continue;
    if (Number.isNaN(best) || Math.abs(q - p) < Math.abs(best - p)) best = q;
  }
  return best;
}

/** Tick count of a walk region: ticks at at + k·grid while < until. */
export function walkTickTime(w: WalkMoment, k: number): Seconds {
  return w.at + k * w.grid;
}

/**
 * The `fixed` notes that reproduce what walk `momentId` does in `score` (§6.2, revision 5): every
 * step it took (or, for a frozen walk, every applied note), in tick order. Setting the walk's
 * `fixed` to this freezes it without changing its sound.
 */
export function freezeWalk(score: CompiledScore, momentId: MomentId): WalkNote[] {
  const out: WalkNote[] = [];
  for (const s of score.walkSteps) {
    if (s.momentId === momentId) out.push({ tick: s.tick, voice: s.voice, pitch: s.to });
  }
  // walkSteps is sorted by t, so by tick within one walk; keep it explicit for safety.
  return out.sort((a, b) => a.tick - b.tick);
}
