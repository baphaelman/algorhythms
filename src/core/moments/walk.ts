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
 * keeps the bass's constraints. The draws are the same as over the key. At the first tick after
 * the chord changes (`env.changed`, M13), an eligible voice that does not step and sits off the
 * new chord moves to its nearest chord tone between its neighbours, so no note is held across a
 * change against the chord.
 *
 * Draws are keyed by (walk seed, voice, tick index, purpose), so a voice's step at tick 12 depends
 * only on its own state (§7.7). All steps of a tick start at the tick with the same duration
 * (`walkStepGlide`) and ease, and idle voices carry no velocity, so two stepping voices whose start
 * and end are in order cannot cross mid-glide (§7.2's algebraic argument).
 *
 * M13 "Glide to next tick" (`glideToTick`): every step glides until the next tick, so a line that
 * steps on every tick draws a curve. The crossing argument still holds: a voice steps only when
 * idle, and a step's glide ends exactly at the next tick (`walkStepGlide` trims float rounding so
 * it never runs past it), so glides of different ticks never overlap. Glides that do overlap
 * started on one tick with one duration and one ease, so each line is (1 − e(u))·from + e(u)·to
 * for the same e(u) at every instant: two lines in order at the start and at the end stay in order
 * all the way.
 *
 * M13 "Step past a neighbour" (`stepPast`, semitones): a drawn step that does not land strictly
 * between its neighbours may land past one instead, if it ends at least `stepPast` beyond that
 * neighbour (and still strictly below the next line on, inside its range), and the neighbour is an
 * eligible line of this walk that does not step on this tick (one above is held for the tick; one
 * below must not have stepped). The two lines swap order: they cross once, mid-glide, by design;
 * every other pair is in order at the start and at the end, so by the argument above no other
 * pair crosses. The walk's bass (with `bass`) is never passed and never passes, so it stays the
 * lowest line. Order is pitch order, as everywhere (the next moment sees the swapped lines); the
 * view's "Keep lines in order" is about hand edits and does not apply.
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
  /** The chord differs from the previous tick's (re-snap held voices). */
  readonly changed?: boolean;
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
  // Copied: a step past a neighbour (stepPast) swaps two entries.
  const order = env.order.slice();
  const n = order.length;
  const d = order.map((v) => env.dest(v));
  const steps = w.steps && w.steps.length > 0 ? w.steps : DEFAULT_WALK_STEPS;
  const density = Number.isFinite(w.density) ? w.density : 0;
  const past =
    typeof w.stepPast === 'number' && Number.isFinite(w.stepPast) && w.stepPast > 0
      ? w.stepPast
      : 0;
  // stepPast: per position, the line there stepped this tick.
  const stepped: boolean[] | null = past > 0 ? new Array<boolean>(n).fill(false) : null;
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
    const picked = randHashed(env.seed, h, env.tick, Purpose.WalkPick) < density;
    if (!picked && !env.changed) continue;
    const below = i > 0 ? d[i - 1] : -Infinity;
    const above = i < n - 1 ? d[i + 1] : Infinity;
    const cur = d[i];
    const r = env.range(v);
    let to = NaN;
    if (picked && v === bassVoice && w.bass) {
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
    } else if (picked) {
      const s =
        steps[Math.floor(randHashed(env.seed, h, env.tick, Purpose.WalkStep) * steps.length)];
      const p = env.chord ? stepByChord(cur, s, env.chord) : stepByScale(cur, s, env.key);
      if (p > below && p < above && p >= r[0] && p <= r[1] && p !== cur) to = p;
      else if (past > 0 && v !== bassVoice && p >= r[0] && p <= r[1]) {
        // Past the neighbour above (it holds this tick) or below (it did not step).
        const up = p >= above + past && (i + 2 >= n || p < d[i + 2]);
        const down = p <= below - past && (i < 2 || p > d[i - 2]);
        const j = up ? i + 1 : down ? i - 1 : -1;
        const u = j >= 0 ? order[j] : -1;
        if (u >= 0 && u !== bassVoice && env.eligible(u) && !stepped![j]) {
          out.push({ voice: v, from: cur, to: p });
          order[i] = u;
          order[j] = v;
          d[i] = d[j];
          d[j] = p;
          stepped![j] = true;
          // Passed upward, the passed line holds for the tick: the next line to visit is above both.
          if (j > i) i++;
          continue;
        }
      }
    }
    if (!Number.isFinite(to) && env.changed && env.chord && !onChord(cur, env.chord)) {
      to = nearestChordTone(cur, env.chord, r, (q) => q > below && q < above);
    }
    if (Number.isFinite(to)) {
      d[i] = to;
      if (stepped) stepped[i] = true;
      out.push({ voice: v, from: cur, to });
    }
  }
  return out;
}

/**
 * How long a step at tick k glides: `stepGlide`, or with `glideToTick` (M13) until the next whole
 * tick, trimmed so that `at + k·grid` plus it never passes `at + (⌊k⌋ + 1)·grid` in floating point
 * (the line is idle again on that tick). The compiler raises it to its minimum glide.
 */
export function walkStepGlide(
  w: Pick<WalkMoment, 'at' | 'grid' | 'stepGlide' | 'glideToTick'>,
  k: number,
): Seconds {
  if (w.glideToTick !== true) return w.stepGlide;
  const t = w.at + k * w.grid;
  const next = w.at + (Math.floor(k + 1e-9) + 1) * w.grid;
  let dur = next - t;
  while (dur > 0 && t + dur > next) dur -= next * Number.EPSILON;
  return dur;
}

/** Pitches within this of an integer count as that integer (on a chord tone). */
const EPS = 1e-9;

const onChord = (p: Pitch, pcs: readonly number[]): boolean =>
  Math.abs(p - Math.round(p)) < EPS &&
  pcs.some((pc) => mod(Math.round(pc), 12) === mod(Math.round(p), 12));

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
