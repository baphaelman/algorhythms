/**
 * What the Wider/Closer and Upside down inspector shows before you commit (PLAN.md M13): the
 * chord a spread lands on (named as the cards and the Chords row name it, ./card-result.ts), the
 * axes a fold is offered about with the key and chord each lands in (core/fold.ts), when its lines
 * cross the axis, and the "Cross at one point" switch (stagger 0, jitter 0, one length).
 */

import { compile } from '../../core/compiler/compile';
import { targetsAt } from '../../core/effect';
import { foldAxes, foldedKey } from '../../core/fold';
import { spellPc } from '../../core/harmony';
import { mod } from '../../core/math';
import { evalSegment } from '../../core/segment';
import type {
  CompiledScore,
  Glide,
  Key,
  Moment,
  Piece,
  Pitch,
  Seconds,
  SpreadMoment,
} from '../../core/types';
import { formatNum } from '../ui/inspector/fields';
import { landingChord } from './card-result';
import type { MomentPatch } from './ops';

/** `piece` with moment `id` patched. */
function patched(piece: Piece, id: string, patch: Partial<SpreadMoment>): Piece {
  return {
    ...piece,
    moments: piece.moments.map((m) => (m.id === id ? ({ ...m, ...patch } as Moment) : m)),
  };
}

/** The chord spread `m` lands on with `patch` applied ('' when it doesn't compile). */
export function spreadLanding(piece: Piece, m: SpreadMoment, patch: Partial<SpreadMoment>): string {
  try {
    return landingChord(compile(patched(piece, m.id, patch)), m.id, m.at);
  } catch {
    return '';
  }
}

/** A pitch as a note name in `key` ("E♭4"); a pitch between semitones as its number. */
export function axisName(p: Pitch, key: Key): string {
  if (!Number.isInteger(p)) return formatNum(p, 2);
  return `${spellPc(mod(p, 12), key)}${Math.floor(p / 12) - 1}`;
}

export type FoldAxisId = 'middle' | 'keep' | 'lift';

export interface FoldOption {
  id: FoldAxisId;
  /** What the option writes. */
  patch: Pick<SpreadMoment, 'around' | 'snap'>;
  /** The axis pitch (the middle: the targeted lines' mean). */
  axis: Pitch;
  /** The key the fold lands in (null when off the key's notes, or width ≠ 1). */
  key: Key | null;
  /** The chord it lands on. */
  chord: string;
}

export interface FoldView {
  /** The key in effect where the fold decides. */
  key: Key;
  /** Destinations of the lines it folds, ascending (before it). */
  dests: Pitch[];
  /** Middle, then keep and lift when a fold keeps the key. */
  options: FoldOption[];
  /** The option `m` uses now, if any. */
  current: FoldAxisId | null;
}

/** The axis spread `m` turns about, from the destinations before it (the compiler's c). */
export function axisOf(m: SpreadMoment, dests: readonly Pitch[]): Pitch {
  if (typeof m.around === 'number') return m.around;
  const n = dests.length;
  if (n === 0) return NaN;
  if (m.around === 'median') {
    return n % 2 === 1 ? dests[(n - 1) / 2] : (dests[n / 2 - 1] + dests[n / 2]) / 2;
  }
  let s = 0;
  for (const d of dests) s += d;
  return s / n;
}

/**
 * The fold inspector's view of upside-down spread `m` (factor < 0) in `piece`, compiled as
 * `score`: the axes, each with the key and chord it lands in. Compiles the piece once without `m`
 * and once per axis that isn't the current one.
 */
export function foldView(piece: Piece, score: CompiledScore, m: SpreadMoment): FoldView | null {
  const without = { ...piece, moments: piece.moments.filter((x) => x.id !== m.id) };
  let before: CompiledScore;
  try {
    before = compile(without);
  } catch {
    return null;
  }
  const { dests, key } = targetsAt(without, before, m);
  if (dests.length === 0) return null;
  let mean = 0;
  for (const d of dests) mean += d;
  mean /= dests.length;
  const width = -m.factor;
  const keyFor = (axis: Pitch, snap: SpreadMoment['snap']): Key | null =>
    width !== 1 ? null : snap === 'scale' ? key : foldedKey(key, axis);
  const wants: { id: FoldAxisId; patch: FoldOption['patch']; axis: Pitch }[] = [
    { id: 'middle', patch: { around: 'mean', snap: m.snap }, axis: mean },
  ];
  const ax = foldAxes(key, mean);
  if (ax) {
    wants.push({ id: 'keep', patch: { around: ax.keep, snap: m.snap }, axis: ax.keep });
    // Lifting leaves the key in effect: snapping to it would pull the notes back.
    const snap = m.snap === 'scale' ? 'chromatic' : m.snap;
    wants.push({ id: 'lift', patch: { around: ax.lift, snap }, axis: ax.lift });
  }
  const isCurrent = (p: FoldOption['patch']): boolean => p.around === m.around && p.snap === m.snap;
  const current = wants.find((w) => w.patch.around === m.around)?.id ?? null;
  const options = wants.map((w): FoldOption => ({
    ...w,
    key: keyFor(w.axis, w.patch.snap),
    chord: isCurrent(w.patch) ? landingChord(score, m.id, m.at) : spreadLanding(piece, m, w.patch),
  }));
  return { key, dests, options, current };
}

/** When the lines of a fold cross its axis. */
export interface Crossing {
  axis: Pitch;
  /** First and last crossing times. */
  first: Seconds;
  last: Seconds;
  /** Lines that cross. */
  lines: number;
}

/** Within this, crossings count as one instant (s). */
export const ONE_POINT = 0.005;

/**
 * When the lines spread `m` moves (its segments in `score`) pass `axis`; null when none does.
 * Each segment is sampled, then the crossing found by bisection.
 */
export function crossingOf(score: CompiledScore, m: SpreadMoment, axis: Pitch): Crossing | null {
  if (!Number.isFinite(axis)) return null;
  let first = Infinity;
  let last = -Infinity;
  let lines = 0;
  for (const v of score.voices) {
    for (const s of v.segments) {
      if (s.momentId !== m.id || !(s.t1 > s.t0)) continue;
      const f = (t: Seconds): number => evalSegment(s, t) - axis;
      const f0 = f(s.t0);
      if (Math.abs(f0) < 1e-6) continue;
      const N = 64;
      let a = s.t0;
      let hit = NaN;
      for (let i = 1; i <= N; i++) {
        const b = s.t0 + ((s.t1 - s.t0) * i) / N;
        if (Math.sign(f(b)) !== Math.sign(f0)) {
          let lo = a;
          let hi = b;
          for (let k = 0; k < 40; k++) {
            const mid = (lo + hi) / 2;
            if (Math.sign(f(mid)) === Math.sign(f0)) lo = mid;
            else hi = mid;
          }
          hit = (lo + hi) / 2;
          break;
        }
        a = b;
      }
      if (hit !== hit) continue;
      lines++;
      first = Math.min(first, hit);
      last = Math.max(last, hit);
    }
  }
  return lines > 0 ? { axis, first, last, lines } : null;
}

/** True when every line of `m` starts together and glides one length (stagger 0, jitter 0). */
export function crossesAtOnePoint(m: Moment, defaults: Glide): boolean {
  const g = { ...defaults, ...m.glide };
  return g.stagger === 0 && g.jitter === 0 && !m.overrides?.some((o) => o.end !== undefined);
}

/**
 * The patch for "Cross at one point": on sets stagger and jitter to 0 and drops per-line
 * arrival times; off goes back to the piece's defaults (a 0.5 s stagger when those are 0 too).
 */
export function crossPatch(m: Moment, defaults: Glide, on: boolean): MomentPatch {
  const g: Partial<Glide> = { ...m.glide };
  if (on) {
    g.stagger = 0;
    g.jitter = 0;
    const overrides = m.overrides
      ?.map(({ end: _, ...o }) => o)
      .filter((o) => o.pitch !== undefined || o.weight !== undefined);
    return { glide: g, overrides: overrides?.length ? overrides : undefined } as MomentPatch;
  }
  delete g.stagger;
  delete g.jitter;
  if (!(defaults.stagger > 0 || defaults.jitter > 0)) g.stagger = 0.5;
  return { glide: Object.keys(g).length ? g : undefined } as MomentPatch;
}
