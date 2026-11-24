/**
 * Melodies that fit the chords (PLAN.md §6.4, M10b-5). Pure and seeded (`rand`, Purpose.Melody).
 *
 * Rhythm: bars of quarters and eighths (a dotted quarter or a half now and then, always starting
 * on an even beat, so every strong beat has an onset); phrases of 4 bars (2 when the bar count
 * isn't a multiple of 4) in the form A B A cadence (A cadence for 2 bars). A phrase ends on a
 * long note.
 * Pitch: notes on strong beats (the downbeat, and the middle beat in an even meter) are tones of
 * the chord sounding there, chosen along an arch over the phrase; the notes between them walk by
 * scale steps (a detour, or one third, when there are more notes than steps). A phrase's last
 * note is the root, third or fifth of its chord; the melody's last note prefers the tonic, then
 * the root. Everything stays inside `register`.
 */

import { clamp, mod } from './math';
import { Purpose, rand } from './rng';
import { pitchClassOf, pitchesWithPcs, scalePcs } from './scales';
import { keyAt } from './query';
import type {
  CompiledScore,
  HarmonyChange,
  Key,
  KeyChange,
  Pitch,
  Seconds,
  TunePitchNote,
} from './types';

/** A chord the melody fits: in effect from `t` until the next one. */
export interface MelodyChord {
  t: Seconds;
  pcs: readonly number[];
  bass: number;
}

export interface MelodyInput {
  seed: number;
  from: Seconds;
  to: Seconds;
  /** Sorted by t; the first one also covers any time before it. Empty: the key's tonic triad. */
  chords: readonly MelodyChord[];
  /** Key timeline, sorted; the first entry covers any time before it. */
  keys: readonly KeyChange[];
  /** Seconds per beat. */
  beat: Seconds;
  /** Beats per bar. */
  meter: number;
  /** The singable range [low, high] the notes stay in. */
  register: readonly [Pitch, Pitch];
  /** The line's pitch before the melody, if any: the first note starts near it. */
  start?: Pitch;
  /** An unhurried tune: mostly quarters and halves, fewer eighths (M12 listening notes). */
  slow?: boolean;
}

/** A note before its pitch is chosen. */
interface Slot {
  /** Onset from `from`, in eighths. */
  u: number;
  len: number;
  phrase: number;
  /** Position in the phrase, 0..1. */
  x: number;
  strong: boolean;
  end: boolean;
}

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

/** Beat cells in eighths: quarter, two eighths, dotted quarter + eighth, half. */
const CELLS: readonly (readonly number[])[] = [[2], [1, 1], [3, 1], [4]];
const CELL_W = [0.45, 0.37, 0.11, 0.07];
const SLOW_CELL_W = [0.5, 0.08, 0.12, 0.3];

/** A body bar of `m` beats in eighths. Two-beat cells start on even beats only. */
function bodyBar(m: number, draw: () => number, slow = false): number[] {
  const out: number[] = [];
  const w = slow ? SLOW_CELL_W : CELL_W;
  for (let b = 0; b < m;) {
    const two = b % 2 === 0 && m - b >= 2;
    const c = pick(two ? w : w.slice(0, 2), draw());
    out.push(...CELLS[c]);
    b += c >= 2 ? 2 : 1;
  }
  return out;
}

/**
 * A cadence bar: the first half moving, then a long note to the bar's end (or, when `whole`, now
 * and then the whole bar).
 */
function cadenceBar(m: number, draw: () => number, whole: boolean, slow = false): number[] {
  if (m <= 2 || (whole && draw() < (slow ? 0.5 : 0.25))) return [2 * m];
  const h = m >= 4 ? 2 * Math.floor(m / 4) : 1;
  return [...bodyBar(h, draw, slow), 2 * (m - h)];
}

/** Phrase lengths in bars for `bars` bars. */
function phrasesOf(bars: number): number[] {
  if (bars <= 0) return [];
  if (bars % 4 === 0) return Array<number>(bars / 4).fill(4);
  const out = Array<number>(Math.floor(bars / 2)).fill(2);
  if (bars % 2) out.push(1);
  return out;
}

/** The rhythm as slots, filling `units` eighths; the last slot takes any remainder. */
function rhythm(units: number, m: number, draw: () => number, slow = false): Slot[] {
  const perBar = 2 * m;
  const bars = Math.floor(units / perBar);
  const slots: Slot[] = [];
  const strongAt = (u: number): boolean =>
    u % perBar === 0 || (m >= 4 && m % 2 === 0 && u % perBar === m);
  const push = (cells: readonly number[], u0: number, phrase: number, p0: number, plen: number) => {
    let u = u0;
    for (const len of cells) {
      slots.push({ u, len, phrase, x: (u - p0) / plen, strong: strongAt(u), end: false });
      u += len;
    }
  };
  if (bars === 0) {
    // Shorter than a bar: quarters, the last note taking the rest.
    const cells: number[] = [];
    for (let u = 0; u + 2 < units; u += 2) cells.push(2);
    cells.push(units - 2 * cells.length);
    push(
      cells.filter((c) => c > 0),
      0,
      0,
      0,
      Math.max(1, units),
    );
  } else {
    let bar = 0;
    let motif: number[] | null = null;
    phrasesOf(bars).forEach((len, phrase) => {
      // Phrase 2 on: the same A half the time (a motif), else a new one.
      const a: number[] = motif && draw() < 0.5 ? motif : bodyBar(m, draw, slow);
      motif = a;
      const b = bodyBar(m, draw, slow);
      const form = len === 4 ? [a, b, a] : len === 2 ? [a] : len === 3 ? [a, b] : [];
      const p0 = bar * perBar;
      const plen = len * perBar;
      for (const cells of form) push(cells, bar++ * perBar, phrase, p0, plen);
      push(cadenceBar(m, draw, len > 1, slow), bar++ * perBar, phrase, p0, plen);
      slots[slots.length - 1].end = true;
    });
    const last = slots[slots.length - 1];
    last.len += units - bars * perBar;
  }
  if (slots.length > 0) slots[slots.length - 1].end = true;
  return slots;
}

/** Root, third and fifth of a chord (pitch classes), from its tones and bass. */
export function chordFrame(
  pcs: readonly number[],
  bass: number,
): { root: number; stable: number[] } {
  const has = (pc: number): boolean => pcs.includes(mod(pc, 12));
  const order = [bass, ...pcs.filter((pc) => pc !== bass)];
  let root = order.find((r) => has(r + 7) && (has(r + 3) || has(r + 4)));
  root ??= order.find((r) => has(r + 3) || has(r + 4)) ?? bass;
  const third = [4, 3].map((i) => mod(root + i, 12)).find(has);
  const fifth = [7, 6, 8].map((i) => mod(root + i, 12)).find(has);
  const stable = [root, third, fifth].filter((pc): pc is number => pc !== undefined);
  return { root, stable };
}

/** The chord in effect at `t` (1 ms early counts: chord times are rounded). */
function chordIn(chords: readonly MelodyChord[], key: Key, t: Seconds): MelodyChord {
  let c: MelodyChord | undefined = chords[0];
  for (const x of chords) {
    if (x.t <= t + 1e-3) c = x;
    else break;
  }
  if (c && c.pcs.length > 0) return c;
  const s = scalePcs(key);
  const tonic = pitchClassOf(key.tonic);
  const i = s.indexOf(tonic);
  return { t, bass: tonic, pcs: [tonic, s[(i + 2) % s.length], s[(i + 4) % s.length]] };
}

function keyIn(keys: readonly KeyChange[], t: Seconds): Key {
  let k = keys[0].key;
  for (const e of keys) {
    if (e.t <= t + 1e-3) k = e.key;
    else break;
  }
  return k;
}

/** The scale under a chord: its chromatic tones replace the scale tones a semitone away. */
function localPcs(key: Key, chord: readonly number[]): number[] {
  const set = new Set(scalePcs(key));
  for (const pc of chord) {
    if (set.has(pc)) continue;
    for (const n of [pc - 1, pc + 1]) if (!chord.includes(mod(n, 12))) set.delete(mod(n, 12));
    set.add(pc);
  }
  return [...set];
}

/** The melody's notes; their lengths sum to `to − from`. [] when the span is empty. */
export function fitMelody(input: MelodyInput): TunePitchNote[] {
  const { seed, from, chords, keys } = input;
  const total = roundUs(input.to - from);
  if (!(total > 0) || keys.length === 0) return [];
  const beat = input.beat > 0 ? input.beat : 0.75;
  const m = Math.max(1, Math.round(input.meter > 0 ? input.meter : 4));
  const eighth = beat / 2;
  let k = 0;
  const draw = (): number => rand(seed, '', k++, Purpose.Melody);
  const units = Math.max(1, Math.floor(total / eighth + 1e-4));
  const slots = rhythm(units, m, draw, input.slow === true);
  const n = slots.length;
  const lo = Math.round(Math.min(input.register[0], input.register[1]));
  const hi = Math.max(lo + 7, Math.round(Math.max(input.register[0], input.register[1])));
  const timeOf = (s: Slot): Seconds => from + s.u * eighth;

  // Each phrase's arch: its peak's place and height.
  const phrases = slots.reduce((a, s) => Math.max(a, s.phrase + 1), 0);
  const peaks = Array.from({ length: phrases }, () => ({
    at: 0.4 + 0.25 * draw(),
    height: 0.55 + 0.35 * draw(),
  }));
  const arch = (s: Slot): number => {
    const { at, height } = peaks[s.phrase];
    const d = s.x < at ? (at - s.x) / at : (s.x - at) / (1 - at);
    return 0.15 + height * (1 - d);
  };

  // Anchors: the first note, strong-beat notes and phrase ends, on chord tones.
  const pitch: Pitch[] = new Array<Pitch>(n).fill(NaN);
  const anchors: number[] = [];
  let prev: Pitch | null = input.start ?? null;
  let prevI = -1;
  for (let i = 0; i < n; i++) {
    const s = slots[i];
    if (!(i === 0 || s.strong || s.end)) continue;
    const t = timeOf(s);
    const key = keyIn(keys, t);
    const chord = chordIn(chords, key, t);
    const frame = chordFrame(chord.pcs, chord.bass);
    const last = i === n - 1;
    const pool = s.end ? frame.stable : chord.pcs.map((pc) => mod(Math.round(pc), 12));
    let cands = pitchesWithPcs(pool, lo, hi);
    if (cands.length === 0) cands = pitchesWithPcs(pool, lo - 12, hi + 12);
    const target = lo + (hi - lo) * (s.end ? 0.1 + 0.15 * draw() : arch(s));
    const between = i - prevI;
    const jitter = draw();
    let best = cands[0];
    let cost = Infinity;
    cands.forEach((p, j) => {
      let c = Math.abs(p - target) * 0.5;
      if (prev !== null) {
        const d = Math.abs(p - prev);
        // Reachable by steps from the anchor before, no big leaps, not the same note again.
        c += Math.max(0, d - 2 * between) * 0.8 + (d > 7 ? 3 : 0) + (d === 0 ? 1.5 : 0);
      }
      if (s.end) {
        const pc = mod(p, 12);
        const tonic = pitchClassOf(key.tonic);
        if (last) c += pc === tonic ? 0 : pc === frame.root ? 0.5 : 4;
        else c += pc === frame.root ? 0 : pc === frame.stable[1] ? 0.6 : 1;
      }
      c += 1.2 * mod(jitter + j * 0.381966, 1);
      if (c < cost) {
        cost = c;
        best = p;
      }
    });
    pitch[i] = best;
    anchors.push(i);
    prev = best;
    prevI = i;
  }

  // Between anchors: scale steps (in the local scale of the chord at the later anchor).
  for (let a = 0; a + 1 < anchors.length; a++) {
    const i = anchors[a];
    const j = anchors[a + 1];
    const gap = j - i - 1;
    if (gap <= 0) continue;
    const t = timeOf(slots[i + 1]);
    const key = keyIn(keys, t);
    const chord = chordIn(chords, key, t);
    const ladder = pitchesWithPcs(
      localPcs(key, [...chord.pcs.map((pc) => mod(Math.round(pc), 12))]),
      lo - 4,
      hi + 4,
    );
    const idx = (p: Pitch): number => {
      let best = 0;
      for (let q = 0; q < ladder.length; q++) {
        if (Math.abs(ladder[q] - p) < Math.abs(ladder[best] - p)) best = q;
      }
      return best;
    };
    const ia = idx(pitch[i]);
    const ib = idx(pitch[j]);
    const d = ib - ia;
    const moves = gap + 1;
    const path: number[] = [];
    if (Math.abs(d) >= moves) {
      for (let q = 1; q <= gap; q++) path.push(ia + Math.round((d * q) / moves));
    } else {
      // A detour (out up to 3 steps and back); an odd count takes one third on the way back,
      // and moves to spare become neighbour notes first.
      const rising = slots[i].x < peaks[slots[i].phrase].at;
      const dir = d !== 0 ? -Math.sign(d) : rising !== draw() < 0.25 ? 1 : -1;
      const excess = moves - Math.abs(d);
      const out = Math.min(3, Math.ceil(excess / 2));
      let third = excess % 2 === 1;
      let spare = moves - (2 * out + Math.abs(d) - (third ? 1 : 0));
      // Overshooting the target instead of backing away, now and then.
      const over = d !== 0 && out >= 2 && draw() < 0.4;
      const peak = over ? ib - dir * out : ia + dir * out;
      const toward = Math.sign(peak - ia);
      let cur = ia;
      while (spare >= 2) {
        path.push(cur - toward, cur);
        spare -= 2;
      }
      if (spare === 1) path.push(cur);
      while (cur !== peak) path.push((cur += toward));
      while (cur !== ib) {
        const size = third && Math.abs(ib - cur) >= 2 ? 2 : 1;
        if (size === 2) third = false;
        path.push((cur += Math.sign(ib - cur) * size));
      }
      path.length = Math.min(path.length, gap);
      while (path.length < gap) path.push(path.at(-1) ?? ia);
    }
    for (let q = 0; q < gap; q++) pitch[i + 1 + q] = ladder[clamp(path[q], 0, ladder.length - 1)];
  }

  const out: TunePitchNote[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? roundUs(total - sum) : roundUs(slots[i].len * eighth);
    sum += len;
    out.push({ pitch: clamp(pitch[i], 0, 127), len });
  }
  return out;
}

/**
 * The harmony a melody over [from, to) fits, from a compiled score: its chord entries (entries
 * named from tunes are melody notes, not harmony, and are skipped) and its keys. `marker` maps an
 * entry to the time its chord counts from (a land chord's marker, not its lead-in); default `t`.
 */
export function melodyHarmony(
  score: CompiledScore,
  from: Seconds,
  to: Seconds,
  marker: (h: HarmonyChange) => Seconds = (h) => h.t,
): { chords: MelodyChord[]; keys: KeyChange[] } {
  const all: MelodyChord[] = [];
  for (const h of score.harmony ?? []) {
    if (h.from === 'tunes' || h.pcs.length === 0) continue;
    const t = Math.max(h.t, marker(h));
    // Later entries win from their time on; an entry moved past a later one is dropped.
    while (all.length > 0 && all[all.length - 1].t >= t - 1e-9) all.pop();
    all.push({ t, pcs: h.pcs, bass: h.bass });
  }
  let before: MelodyChord | null = null;
  const chords: MelodyChord[] = [];
  for (const c of all) {
    if (c.t <= from + 1e-6) before = c;
    else if (c.t < to - 1e-6) chords.push(c);
  }
  if (before) chords.unshift({ ...before, t: from });
  const keys = score.keys.filter((e) => e.t > from + 1e-6 && e.t < to - 1e-6);
  keys.unshift({ t: from, key: keyAt(score, from) });
  return { chords, keys };
}
