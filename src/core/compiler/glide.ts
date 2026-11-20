/**
 * Glide merging and timing draws (PLAN.md §5 `Glide`, §7.1 step 1, §7.7).
 *
 * Start offsets are stratified: the n affected voices are ranked by `order`, and the voice of
 * rank r starts at stagger·(r + u)/n with u a keyed draw (Purpose.Stagger). So `low-first` really
 * starts low voices first, and `random` (ranks by a Purpose.Order draw) spreads starts evenly
 * instead of clumping. A single voice starts on time: a spread across one voice is empty.
 *
 * Durations are length·(1 + jitter·(2u − 1)) with u a Purpose.Jitter draw, never below MIN_GLIDE.
 */

import { Purpose, randHashed } from '../rng';
import type { EaseRef, Glide, GlideOrder, Seconds } from '../types';

/** Shortest glide; a 0-length glide would be a jump and break C⁰ continuity. */
export const MIN_GLIDE: Seconds = 0.01;

const ORDERS: readonly GlideOrder[] = [
  'random',
  'low-first',
  'high-first',
  'center-out',
  'outside-in',
];

function validEase(e: unknown): e is EaseRef {
  if (typeof e === 'string') {
    return (
      e === 'smootherstep' || e === 'smoothstep' || e === 'cosine' || e === 'linear' || e === 'expo'
    );
  }
  if (!e || typeof e !== 'object') return false;
  const b = e as { kind?: unknown; x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown };
  return (
    b.kind === 'bezier' &&
    typeof b.x1 === 'number' &&
    typeof b.x2 === 'number' &&
    typeof b.y1 === 'number' &&
    typeof b.y2 === 'number' &&
    b.x1 >= 0 &&
    b.x1 <= 1 &&
    b.x2 >= 0 &&
    b.x2 <= 1 &&
    Number.isFinite(b.y1) &&
    Number.isFinite(b.y2)
  );
}

/** A usable glide: fields out of range fall back to `fallback`'s (or are clamped). */
export function sanitizeGlide(g: Partial<Glide> | undefined, fallback: Glide): Glide {
  const out: Glide = { ...fallback };
  if (!g) return out;
  if (typeof g.length === 'number' && Number.isFinite(g.length) && g.length > 0) {
    out.length = g.length;
  }
  if (typeof g.jitter === 'number' && Number.isFinite(g.jitter)) {
    out.jitter = g.jitter < 0 ? 0 : g.jitter > 1 ? 1 : g.jitter;
  }
  if (typeof g.stagger === 'number' && Number.isFinite(g.stagger)) {
    out.stagger = g.stagger < 0 ? 0 : g.stagger;
  }
  if (g.order !== undefined && ORDERS.includes(g.order)) out.order = g.order;
  if (g.ease !== undefined && validEase(g.ease)) out.ease = g.ease;
  return out;
}

/** §7.1 step 1: a moment's glide merged over the piece defaults. */
export function mergeGlide(defaults: Glide, own: Partial<Glide> | undefined): Glide {
  return sanitizeGlide(own, defaults);
}

/** A voice taking part in a moment's timing draw. */
export interface TimedVoice {
  /** hash32 of the voice id. */
  hash: number;
  /** Pool index (tie-break). */
  index: number;
}

/**
 * Start offsets (seconds after the moment) and durations for `voices`, which must be sorted by
 * committed destination (ties: pool index).
 */
export function drawTimings(
  voices: readonly TimedVoice[],
  glide: Glide,
  seed: number,
): { offset: Seconds; dur: Seconds }[] {
  const n = voices.length;
  const rank = new Array<number>(n);
  const idx = voices.map((_, i) => i);
  const mid = (n - 1) / 2;
  switch (glide.order) {
    case 'low-first':
      idx.forEach((i) => (rank[i] = i));
      break;
    case 'high-first':
      idx.forEach((i) => (rank[i] = n - 1 - i));
      break;
    case 'center-out':
      idx
        .slice()
        .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
        .forEach((i, r) => (rank[i] = r));
      break;
    case 'outside-in':
      idx
        .slice()
        .sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid) || a - b)
        .forEach((i, r) => (rank[i] = r));
      break;
    default: {
      const u = voices.map((v) => randHashed(seed, v.hash, 0, Purpose.Order));
      idx
        .slice()
        .sort((a, b) => u[a] - u[b] || voices[a].index - voices[b].index)
        .forEach((i, r) => (rank[i] = r));
    }
  }
  return voices.map((v, i) => ({
    offset:
      n >= 2 ? (glide.stagger * (rank[i] + randHashed(seed, v.hash, 0, Purpose.Stagger))) / n : 0,
    dur: glideDuration(glide, seed, v.hash),
  }));
}

/** A voice's jittered glide length (§5 `jitter`). */
export function glideDuration(glide: Glide, seed: number, hash: number): Seconds {
  const u = randHashed(seed, hash, 0, Purpose.Jitter);
  const d = glide.length * (1 + glide.jitter * (2 * u - 1));
  return d > MIN_GLIDE ? d : MIN_GLIDE;
}

/** Fade-in of a newborn: max(0.5 s, glide length / 2) (§7.4). */
export function birthFadeIn(glide: Glide): Seconds {
  return glide.length / 2 > 0.5 ? glide.length / 2 : 0.5;
}
