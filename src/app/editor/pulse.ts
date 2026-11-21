/**
 * Pulse editing (PLAN.md §6.2 `pulse`, §11.3; R9-7): beat values for `step` when the piece has a
 * tempo, the accent pattern's cells, and the lane's drawing of one pattern cycle. Pure.
 */

import type { PulseMode, Seconds } from '../../core/types';

/** Longest pattern the editor builds. */
export const MAX_PATTERN = 32;
/** Accent a new step gets. */
export const NEW_ACCENT = 0.5;

/** Step values in beats (a beat is a quarter note), offered as chips with a tempo (§6.2). */
export const BEAT_VALUES: readonly (readonly [beats: number, label: string])[] = [
  [1, '1/4'],
  [0.75, '1/8.'],
  [0.5, '1/8'],
  [1 / 3, '1/8 trip.'],
  [0.25, '1/16'],
];

export const PULSE_MODES: readonly (readonly [PulseMode, string])[] = [
  ['together', 'Together'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['updown', 'Up-down'],
  ['random', 'Random'],
];

/** The beat value `step` matches at `beat` seconds a beat, or null. */
export function beatValueOf(step: Seconds, beat: Seconds | null): number | null {
  if (!beat) return null;
  for (const [b] of BEAT_VALUES) if (Math.abs(b * beat - step) < 1e-6) return b;
  return null;
}

/** Seconds for `beats` at `beat` seconds a beat, to 1 µs. */
export function beatSeconds(beats: number, beat: Seconds): Seconds {
  return Math.round(beats * beat * 1e6) / 1e6;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Accent rounded to 0.05, clamped to 0..1. */
export function roundAccent(v: number): number {
  return Math.round(clamp01(v) * 20) / 20;
}

/** `pattern` with step i set to `v` (rounded, 0..1); null if unchanged or out of range. */
export function setAccent(pattern: readonly number[], i: number, v: number): number[] | null {
  if (i < 0 || i >= pattern.length || !Number.isFinite(v)) return null;
  const a = roundAccent(v);
  return a === pattern[i] ? null : pattern.map((x, j) => (j === i ? a : x));
}

/** The accent for a press at `y` px down a cell `h` px tall: the top is 1, the bottom 0. */
export function accentAtY(y: number, h: number): number {
  return h > 0 ? roundAccent(1 - y / h) : 0;
}

/** `pattern` with one more step (NEW_ACCENT); null at MAX_PATTERN. */
export function addStep(pattern: readonly number[]): number[] | null {
  return pattern.length >= MAX_PATTERN ? null : [...pattern, NEW_ACCENT];
}

/** `pattern` without its last step; null if one step is left (a pattern is never empty). */
export function removeStep(pattern: readonly number[]): number[] | null {
  return pattern.length <= 1 ? null : pattern.slice(0, -1);
}

/**
 * One pattern cycle as an SVG (a lane bar's mask): a bar per step, its height the accent (rests
 * empty), each `w` units wide with a gap. The lane repeats it every cycle.
 */
export function patternSvg(pattern: readonly number[]): string {
  const n = Math.max(1, pattern.length);
  const w = 10;
  const h = 12;
  const rects = pattern
    .map((a, i) => {
      const v = clamp01(Number.isFinite(a) ? a : 0);
      if (v <= 0) return '';
      const bh = Math.max(1, v * h);
      return `<rect x="${i * w}" y="${(h - bh).toFixed(2)}" width="${w - 2}" height="${bh.toFixed(2)}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n * w} ${h}" preserveAspectRatio="none">${rects}</svg>`;
}

/**
 * The mask size of one cycle as a share (%) of the region: cycle length / region length (over
 * 100 when the region ends inside the first cycle).
 */
export function cycleShare(step: Seconds, patternLength: number, region: Seconds): number {
  if (!(region > 0) || !(step > 0)) return 100;
  return ((step * Math.max(1, patternLength)) / region) * 100;
}
