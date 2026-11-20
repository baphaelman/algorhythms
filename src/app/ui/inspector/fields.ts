/**
 * Pure helpers for the inspector (PLAN.md §11.3): parsing and formatting of field text, the key
 * in effect at a time, chord feedback, degree-picker cells and the easing-curve preview path.
 */

import { parseChord } from '../../../core/chords';
import { bezierOf, ease, easeCodeOf } from '../../../core/ease';
import {
  FLAT_NAMES,
  SHARP_NAMES,
  noteName,
  parsePitchClass,
  pitchOfDegreeIndex,
  scaleIntervals,
} from '../../../core/scales';
import { segmentAt } from '../../../core/query';
import type {
  CompiledScore,
  EaseRef,
  Key,
  MomentId,
  Pitch,
  Seconds,
  Segment,
} from '../../../core/types';

/** Shortest decimal text for `x`, at most `digits` decimals ("3", "0.25", "-1.5"). */
export function formatNum(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return '';
  const s = x.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Parses a number; null if it isn't one or lies outside [min, max]. */
export function parseNum(text: string, min = -Infinity, max = Infinity): number | null {
  const t = text.trim().replace(',', '.').replace(/^−/, '-');
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** "m:ss.s", e.g. 42.31 → "0:42.3". */
export function formatTime(t: Seconds): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/**
 * Parses a pitch: a MIDI number ("60", "61.5") or a note name with octave ("C4", "F#3", "Bb2",
 * "C4+25" for cents). Null if invalid or outside 0..127.
 */
export function parsePitch(text: string): Pitch | null {
  const t = text.trim();
  const n = parseNum(t, 0, 127);
  if (n !== null) return n;
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)([+-]\d+(?:\.\d+)?)?$/.exec(t);
  if (!m) return null;
  const letter = parsePitchClass(m[1]);
  if (letter === null) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const p = letter + acc + 12 * (Number(m[3]) + 1) + (m[4] ? Number(m[4]) / 100 : 0);
  return p >= 0 && p <= 127 ? p : null;
}

/** A pitch as a note name when it is a whole semitone ("C4"), else its number ("60.5"). */
export function formatPitch(p: Pitch): string {
  return Number.isInteger(p) ? noteName(p) : formatNum(p, 2);
}

/** Parses a whitespace/comma-separated pitch list; null if any item is invalid or it is empty. */
export function parsePitchList(text: string): Pitch[] | null {
  const items = text.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return null;
  const out: Pitch[] = [];
  for (const it of items) {
    const p = parsePitch(it);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

export function formatPitchList(ps: readonly Pitch[]): string {
  return ps.map(formatPitch).join(' ');
}

/** Parses a list of integers ("-2, -1, 1 2"); null if empty or any item is not an integer. */
export function parseIntList(text: string): number[] | null {
  const items = text.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return null;
  const out: number[] = [];
  for (const it of items) {
    const v = parseNum(it);
    if (v === null || !Number.isInteger(v)) return null;
    out.push(v);
  }
  return out;
}

export function formatIntList(xs: readonly number[]): string {
  return xs.join(' ');
}

/** The key in effect at `t` (from the compiled key timeline), or `fallback`. */
export function keyAt(score: Pick<CompiledScore, 'keys'>, t: Seconds, fallback: Key): Key {
  let k = fallback;
  for (const c of score.keys) {
    if (c.t <= t) k = c.key;
    else break;
  }
  return k;
}

/** Whether to spell notes in `key` with flats. */
export function prefersFlats(key: Key): boolean {
  return key.tonic.includes('b') || key.tonic === 'F';
}

/** Live feedback for a chord-symbol field: the spelled pitch classes, or the parse error. */
export function chordFeedback(
  symbol: string,
  key: Key,
): { ok: true; text: string } | { ok: false; text: string } {
  const r = parseChord(symbol, key);
  if (!r.ok) return { ok: false, text: r.error };
  const names = prefersFlats(key) ? FLAT_NAMES : SHARP_NAMES;
  return { ok: true, text: r.pcs.map((pc) => names[pc]).join(' ') };
}

/** One cell of the degree picker. */
export interface DegreeCell {
  /** 0-based degree index (the stored value). */
  degree: number;
  /** 1-based display number. */
  label: string;
  /** Note name of the degree, relative to the tonic at octave 4. */
  note: string;
}

/**
 * Degree-picker cells: two octaves of the key's scale, widened to include every degree in
 * `selected` (degrees may be negative or exceed the scale length).
 */
export function degreeCells(key: Key, selected: readonly number[]): DegreeCell[] {
  const n = scaleIntervals(key.scale).length;
  let lo = 0;
  let hi = 2 * n - 1;
  for (const d of selected) {
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const flats = prefersFlats(key);
  const out: DegreeCell[] = [];
  for (let d = lo; d <= hi; d++) {
    const p = pitchOfDegreeIndex(d, key) + 60;
    out.push({ degree: d, label: String(d + 1), note: noteName(p, flats).replace(/-?\d+$/, '') });
  }
  return out;
}

/** Toggles `d` in a degree list, keeping it sorted. */
export function toggleDegree(degrees: readonly number[], d: number): number[] {
  return degrees.includes(d)
    ? degrees.filter((x) => x !== d)
    : [...degrees, d].sort((a, b) => a - b);
}

/**
 * An SVG path (in a w × h box, y down) of the easing curve, sampled at n + 1 points. Bézier
 * overshoot is kept inside the box by mapping the curve's own y range (at least [0, 1]).
 */
export function easePath(ref: EaseRef, w: number, h: number, n = 48): string {
  const code = easeCodeOf(ref);
  const bz = bezierOf(ref);
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) ys.push(ease(code, i / n, bz));
  const lo = Math.min(0, ...ys);
  const hi = Math.max(1, ...ys);
  const span = hi - lo;
  return ys
    .map(
      (y, i) =>
        `${i === 0 ? 'M' : 'L'}${formatNum((i / n) * w, 2)} ${formatNum(h - ((y - lo) / span) * h, 2)}`,
    )
    .join(' ');
}

/**
 * The notes sounding once a moment lands, low to high: each voice's destination from the moment's
 * own segments, else (a voice it held still, or didn't target) the destination of the segment
 * sounding at the end of the moment's span. Empty if the moment has no span.
 */
export function liveNotes(
  score: Pick<CompiledScore, 'voices' | 'momentSpans'>,
  momentId: MomentId,
): Pitch[] {
  const span = score.momentSpans.find((s) => s.id === momentId);
  if (!span) return [];
  const dest = (s: Segment): Pitch => (s.curve ? s.curve.p1 : s.p1);
  const out: Pitch[] = [];
  for (const v of score.voices) {
    let p: Pitch | null = null;
    for (const s of v.segments) if (s.momentId === momentId) p = dest(s);
    if (p === null) {
      const s = segmentAt(v, span.end);
      if (s) p = dest(s);
    }
    if (p !== null) out.push(p);
  }
  return out.sort((a, b) => a - b);
}
