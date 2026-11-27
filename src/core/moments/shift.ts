/**
 * `shift` (§6.2): transposes the targeted voices by semitones, or by scale steps in the key in
 * effect (off-scale pitches snap first, §7.8). Order-preserving, so `ordered`.
 *
 * M13 shift sequence (`seq`): the block planes through a typed list of shifts, written once like a
 * tune. The compiler expands it into one shift moment per step (`shiftSteps`, via
 * ./progression `expandProgressions`), in its place in the moment array, so each step behaves
 * exactly as a hand-written shift with the same unit, target and glide (stagger, land). The steps
 * keep the moment's id and get an explicit seed each (`shiftStepSeed`).
 */

import { hash32, momentSeed } from '../rng';
import { stepByScale } from '../scales';
import type { Piece, Seconds, ShiftMoment } from '../types';
import { movesTo, type MomentEnv, type MomentPlan } from './types';

export function shiftMoment(m: ShiftMoment, env: MomentEnv): MomentPlan | null {
  const vs = env.targeted;
  if (vs.length === 0) {
    env.diag('info', 'no-targets', 'The shift targets no active voice.');
    return null;
  }
  if (!Number.isFinite(m.by)) {
    env.diag('error', 'invalid-moment', 'The shift amount is not a number.');
    return null;
  }
  const targets = vs.map((v) => {
    const d = env.dest(v);
    return m.unit === 'scaleSteps' ? stepByScale(d, m.by, env.key) : d + m.by;
  });
  return { ordered: true, intents: movesTo(vs, targets) };
}

/** True when `m` is a shift sequence (a non-empty `seq`). */
export function hasShiftSeq(m: Pick<ShiftMoment, 'seq'>): boolean {
  return Array.isArray(m.seq) && m.seq.length > 0;
}

/** Why a shift sequence can't run (`shift-invalid`), or null (also for no sequence). */
export function shiftSeqProblem(m: Pick<ShiftMoment, 'seq'>): string | null {
  if (m.seq === undefined) return null;
  if (!Array.isArray(m.seq)) return 'A shift sequence needs a list of steps.';
  for (let k = 0; k < m.seq.length; k++) {
    const s = m.seq[k];
    if (!s || typeof s !== 'object' || !(typeof s.by === 'number' && Number.isFinite(s.by)))
      return `Step ${k + 1} of the shift sequence needs a numeric amount.`;
    if (!(typeof s.len === 'number' && Number.isFinite(s.len) && s.len > 0))
      return `Step ${k + 1} of the shift sequence needs a length > 0.`;
  }
  return null;
}

/** Step starts: at, then at + the lengths before each step; the last entry is the end. */
export function shiftSeqStarts(m: Pick<ShiftMoment, 'at' | 'seq'>): Seconds[] {
  const out: Seconds[] = [m.at];
  let t = m.at;
  for (const s of m.seq ?? []) out.push((t += s.len));
  return out;
}

/** The sequence's end: `at` + every step's length (`at` without one). */
export function shiftSeqEnd(m: Pick<ShiftMoment, 'at' | 'seq'>): Seconds {
  let t = m.at;
  for (const s of m.seq ?? []) t += s.len;
  return t;
}

/** The seed of step k, from the moment's own seed (§7.7). */
export function shiftStepSeed(momentSeedValue: number, k: number): number {
  return hash32(momentSeedValue, `step${k}`);
}

/**
 * The shift moments sequence `m` stands for: step k at its start, by its amount, with the moment's
 * unit, target and glide and seed `shiftStepSeed`, without `seq`. Ids stay `m.id`. Muted,
 * invalid or no sequence: none.
 */
export function shiftSteps(m: ShiftMoment, pieceSeed: Piece['seed']): ShiftMoment[] {
  if (m.muted || !hasShiftSeq(m) || shiftSeqProblem(m) !== null) return [];
  const seed = momentSeed(pieceSeed, m.id, m.seed);
  const starts = shiftSeqStarts(m);
  return m.seq!.map((s, k) => {
    const out: ShiftMoment = {
      id: m.id,
      type: 'shift',
      at: starts[k],
      by: s.by,
      unit: m.unit,
      seed: shiftStepSeed(seed, k),
    };
    if (m.target !== undefined) out.target = m.target;
    if (m.glide !== undefined) out.glide = m.glide;
    return out;
  });
}

/** A step's amount as written: "+2", "−1", "0" (U+2212 minus). */
export function shiftAmountText(by: number): string {
  return by > 0 ? `+${by}` : by < 0 ? `−${-by}` : '0';
}
