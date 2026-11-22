/**
 * Random tune melodies (owner, 2026-11-21: "tune should also make a random melody"). Pure and
 * seeded (counter-based `rand`, Purpose.TuneGen): the same input gives the same notes.
 *
 * Rhythm: a grid unit u (an eighth with a tempo, else 0.25 s) and cells of 4 units drawn from a
 * small palette and repeated in a form (A A B A, ...); the phrase ends on a long note. Lengths are
 * 1–4 units (1/8, 1/4, dotted 1/4, 1/2; or 0.25–1 s); the last note also takes any remainder, so
 * the lengths sum to `total`.
 * Pitch: scale degrees in `key`, starting at or near `start`, mostly steps, with an occasional
 * skip (a 3rd) or leap (a 4th or 5th) followed by a step back; an arch contour (rising, then
 * falling); inside a window of about an octave and a half around `start`, within `range`. The
 * last note is a chord tone (`endPcs` in the key, else the tonic or fifth) near the one before.
 */

import { clamp, mod } from './math';
import { Purpose, rand } from './rng';
import { degreesToPcs, pitchOfDegreeIndex, scaleDegreeIndex, scalePcs } from './scales';
import type { Key, Pitch, Seconds, TunePitchNote } from './types';

export interface TuneGenInput {
  seed: number;
  key: Key;
  /** The line's pitch as the tune starts. */
  start: Pitch;
  /** The line's range [low, high]. */
  range: readonly [Pitch, Pitch];
  /** Total length, seconds (the notes' lengths sum to it). */
  total: Seconds;
  /** Seconds per beat with a tempo, else null. */
  beat: Seconds | null;
  /** Pitch classes of the harmony at the tune's end, if known. */
  endPcs?: readonly number[];
}

/** Body cells (grid units, 4 per cell) and their weights. */
const CELLS: readonly (readonly number[])[] = [
  [2, 2],
  [1, 1, 2],
  [3, 1],
  [2, 1, 1],
  [4],
  [1, 1, 1, 1],
];
const CELL_W = [3, 2, 2, 1, 1, 1];
/** Forms: which palette cell each body cell uses, cycled. */
const FORMS: readonly (readonly number[])[] = [
  [0, 0, 1, 0],
  [0, 1, 0, 1],
  [0, 0, 1, 1],
  [0, 1, 0, 2],
];
/** Interval sizes in scale steps (repeat, step, 3rd, 4th, 5th) and their weights. */
const SIZE_W = [0.08, 0.62, 0.17, 0.09, 0.04];
/** Degrees either side of the start the melody may use. */
const HALF_WINDOW = 5;

const roundUs = (t: Seconds): Seconds => Math.round(t * 1e6) / 1e6;

/** Index drawn from weights `w` by u ∈ [0, 1). */
function pick(w: readonly number[], u: number): number {
  let sum = 0;
  for (const x of w) sum += x;
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i] / sum;
    if (u < acc) return i;
  }
  return w.length - 1;
}

/** The rhythm in grid units (the last entry is the final note). */
function rhythm(units: number, draw: (k: number) => number): number[] {
  if (units <= 0) return [];
  if (units < 4) return [units];
  const a = pick(CELL_W, draw(0));
  let b = pick(CELL_W, draw(1));
  if (b === a) b = (a + 1) % CELLS.length;
  let c = pick(CELL_W, draw(2));
  while (c === a || c === b) c = (c + 1) % CELLS.length;
  const palette = [a, b, c];
  const form = FORMS[Math.floor(draw(3) * FORMS.length)];
  const out: number[] = [];
  let rem = units;
  for (let i = 0; rem > 7; i++) {
    for (const x of CELLS[palette[form[i % form.length]]]) out.push(x);
    rem -= 4;
  }
  if (rem > 4) out.push(rem - 4);
  out.push(4);
  return out;
}

/** Lowest and highest scale degree inside [lo, hi], or null if none. */
function degreeRange(lo: Pitch, hi: Pitch, key: Key): [number, number] | null {
  let a = scaleDegreeIndex(lo, key);
  if (pitchOfDegreeIndex(a, key) < lo) a++;
  let b = scaleDegreeIndex(hi, key);
  if (pitchOfDegreeIndex(b, key) > hi) b--;
  return a <= b ? [a, b] : null;
}

/** A random melody for a tune; [] when `total` ≤ 0. */
export function randomTune(input: TuneGenInput): TunePitchNote[] {
  const { seed, key, beat } = input;
  const total = roundUs(Math.max(0, input.total));
  if (!(total > 0)) return [];
  const draw = (k: number): number => rand(seed, '', k, Purpose.TuneGen);
  const unit = beat && beat > 0 ? beat / 2 : 0.25;
  const cells = rhythm(Math.floor(total / unit + 1e-4), draw);
  const n = Math.max(1, cells.length);

  // The window: HALF_WINDOW degrees either side of the start, moved inside the range.
  const lo = Math.min(input.range[0], input.range[1]);
  const hi = Math.max(input.range[0], input.range[1]);
  const r = degreeRange(lo, hi, key) ?? degreeRange(0, 127, key)!;
  const s = clamp(scaleDegreeIndex(clamp(input.start, 0, 127), key), r[0], r[1]);
  let wLo = s - HALF_WINDOW;
  let wHi = s + HALF_WINDOW;
  if (wLo < r[0]) [wLo, wHi] = [r[0], Math.min(r[1], wHi + (r[0] - wLo))];
  if (wHi > r[1]) [wLo, wHi] = [Math.max(r[0], wLo - (wHi - r[1])), r[1]];

  // Draw keys: 0..3 the rhythm, then 8 + 4i + slot for note i.
  const at = (i: number, slot: number): number => draw(8 + 4 * i + slot);
  const deg: number[] = [];
  // At or near the line's pitch: the same, a step or a 3rd away.
  deg.push(clamp(s + [0, 1, -1, 2, -2][pick([3, 3, 2, 1, 1], at(0, 0))], wLo, wHi));
  let prev = 0;
  for (let i = 1; i < n - 1; i++) {
    const d = deg[i - 1];
    let size: number;
    let dir: number;
    if (Math.abs(prev) >= 3) {
      // After a leap, a step back.
      size = 1;
      dir = -Math.sign(prev);
    } else {
      size = pick(SIZE_W, at(i, 0));
      if (size === 0 && prev === 0) size = 1;
      // Arch: rising in the first half, falling in the second; pushed back from the edges.
      let up = i / (n - 1) < 0.5 ? 0.62 : 0.36;
      if (d - wLo <= 1) up = 0.85;
      if (wHi - d <= 1) up = 0.15;
      dir = at(i, 1) < up ? 1 : -1;
    }
    let next = d + dir * size;
    if (next < wLo || next > wHi) next = d - dir * size;
    if (next < wLo || next > wHi) next = d;
    deg.push(next);
    prev = next - d;
  }
  if (n > 1) {
    // The last note: a chord tone near the one before (a step or a 3rd preferred to a hold).
    const scale = scalePcs(key);
    let pcs = (input.endPcs ?? []).map((pc) => mod(Math.round(pc), 12));
    pcs = pcs.filter((pc) => scale.includes(pc));
    if (pcs.length === 0) pcs = degreesToPcs([0, 4], key);
    const d = deg[n - 2];
    let best = d;
    let cost = Infinity;
    for (let c = wLo; c <= wHi; c++) {
      if (!pcs.includes(mod(pitchOfDegreeIndex(c, key), 12))) continue;
      const dist = Math.abs(c - d);
      const k = dist === 0 ? 1.5 : dist;
      if (k < cost) {
        cost = k;
        best = c;
      }
    }
    deg.push(best);
  }

  const out: TunePitchNote[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const pitch = clamp(pitchOfDegreeIndex(deg[i], key), 0, 127);
    const len = i === n - 1 ? roundUs(total - sum) : roundUs((cells[i] ?? 0) * unit);
    sum += len;
    out.push({ pitch, len });
  }
  return out;
}
