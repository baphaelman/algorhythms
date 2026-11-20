/**
 * Pure helpers for the moment lane (PLAN.md §11.3): what each lane item shows, grid snapping,
 * keyboard nudges, span-end drags and row packing. No DOM, no store.
 */

import type {
  Glide,
  Moment,
  MomentId,
  MomentSpan,
  MomentType,
  Piece,
  Seconds,
} from '../../core/types';
import type { MomentPatch } from './ops';

/** Nudge step without a grid, seconds. */
export const NUDGE_NO_GRID: Seconds = 0.1;

/** What dragging a lane item's span end changes. */
export type EndEdit =
  /** `glide.length` (Shift: `glide.stagger`). */
  | 'glide'
  /** A walk's `until`. */
  | 'until'
  /** A level ramp's `over`. */
  | 'over'
  /** Nothing (key changes have no span). */
  | 'none';

/** One item on the lane. */
export interface LaneItem {
  id: MomentId;
  type: MomentType;
  /** `label`, else the type. */
  text: string;
  at: Seconds;
  /** Span start and end (seconds); equal to `at` for a point. */
  start: Seconds;
  end: Seconds;
  muted: boolean;
  endEdit: EndEdit;
}

/** Grid step in seconds for a BPM grid, or null when there is none. */
export function gridStep(bpm: number | undefined): Seconds | null {
  return bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null;
}

/** `t` rounded to the nearest grid line (unchanged without a grid). Never below 0. */
export function snapTime(t: Seconds, step: Seconds | null): Seconds {
  const v = step ? Math.round(t / step) * step : t;
  return Math.max(0, roundMs(v));
}

/** Rounds to 1e-6 s so snapped values print cleanly. */
function roundMs(t: Seconds): Seconds {
  return Math.round(t * 1e6) / 1e6;
}

/**
 * The offset to apply to a dragged moment at `at` for a raw pointer offset `rawDt`: the moment
 * lands on the grid when `snap` is on and a grid exists, and never before 0.
 */
export function dragDt(at: Seconds, rawDt: Seconds, step: Seconds | null, snap: boolean): Seconds {
  const target = snap ? snapTime(at + rawDt, step) : Math.max(0, at + rawDt);
  return roundMs(target - at);
}

/**
 * The offset of one keyboard nudge from `at` in direction `dir` (±1): to the next grid line in
 * that direction (one full step when already on one), or 0.1 s without a grid. Never before 0.
 */
export function nudgeDt(at: Seconds, dir: 1 | -1, step: Seconds | null): Seconds {
  let target: Seconds;
  if (step) {
    const k = at / step;
    const onGrid = Math.abs(k - Math.round(k)) < 1e-6;
    const base = onGrid ? Math.round(k) : dir > 0 ? Math.floor(k) : Math.ceil(k);
    target = (base + dir) * step;
  } else {
    target = at + dir * NUDGE_NO_GRID;
  }
  return roundMs(Math.max(0, target) - at);
}

/** What a span-end drag edits for this moment type. */
export function endEditOf(type: MomentType): EndEdit {
  return type === 'walk' ? 'until' : type === 'level' ? 'over' : type === 'key' ? 'none' : 'glide';
}

/** The moment's glide with the piece defaults filled in. */
export function effectiveGlide(m: Moment, defaults: Glide): Glide {
  return { ...defaults, ...m.glide };
}

/** A span estimate from the piece alone (for moments the compiled score has no span for). */
export function estimateSpan(m: Moment, defaults: Glide): [Seconds, Seconds] {
  if (m.type === 'walk') return [m.at, Math.max(m.at, m.until)];
  if (m.type === 'level') return [m.at, m.at + Math.max(0, m.over)];
  if (m.type === 'key') return [m.at, m.at];
  const g = effectiveGlide(m, defaults);
  return [m.at, m.at + Math.max(0, g.stagger) + Math.max(0, g.length)];
}

/**
 * Lane items in piece order. Spans come from the compiled score when it has one for the moment
 * and the moment has not moved since (`compiledAt` maps ids to the times the score was built
 * with) and the span is not empty (a moment that moves nothing still shows its intended glide);
 * otherwise they are estimated from the glide.
 */
export function laneItems(
  piece: Piece,
  spans: readonly MomentSpan[],
  compiledAt?: ReadonlyMap<MomentId, Seconds>,
): LaneItem[] {
  const byId = new Map<MomentId, MomentSpan>();
  for (const s of spans) byId.set(s.id, s);
  const defaults = piece.defaults.glide;
  return piece.moments.map((m) => {
    const s = byId.get(m.id);
    const stale = compiledAt !== undefined && compiledAt.get(m.id) !== m.at;
    let start: Seconds;
    let end: Seconds;
    if (s && s.end > s.start && !stale && !m.muted) {
      start = Math.min(s.start, m.at);
      end = Math.max(s.end, m.at);
    } else {
      [start, end] = estimateSpan(m, defaults);
    }
    return {
      id: m.id,
      type: m.type,
      text: m.label?.trim() || m.type,
      at: m.at,
      start,
      end,
      muted: !!m.muted,
      endEdit: endEditOf(m.type),
    };
  });
}

/**
 * The patch for dragging moment `m`'s span end by `dt` seconds: the glide length (or the stagger
 * when `stagger`), a walk's `until`, or a level ramp's `over`, each kept ≥ 0 (a walk ends at least
 * one tick after it starts). Null when nothing changes.
 */
export function endDragPatch(
  m: Moment,
  defaults: Glide,
  dt: Seconds,
  stagger: boolean,
): MomentPatch | null {
  if (m.type === 'key') return null;
  if (m.type === 'walk') {
    const until = roundMs(Math.max(m.at + Math.max(1e-3, m.grid), m.until + dt));
    return until === m.until ? null : { until };
  }
  if (m.type === 'level') {
    const over = roundMs(Math.max(0, m.over + dt));
    return over === m.over ? null : { over };
  }
  const g = effectiveGlide(m, defaults);
  const key = stagger ? 'stagger' : 'length';
  const v = roundMs(Math.max(0, g[key] + dt));
  if (v === g[key]) return null;
  return { glide: { ...m.glide, [key]: v } };
}

/** Pixel extent an item needs on its row: its bar or its label, whichever is longer. */
export function itemExtentPx(item: LaneItem, pps: number): number {
  const label = 14 + item.text.length * 6.5;
  return Math.max(label, (item.end - item.at) * pps) + 6;
}

/**
 * Greedy row packing in pixel space: each item (in time order) goes on the first row whose last
 * item ends before it starts; when all `rows` are taken, on the row that frees up first.
 * Returns the row index per item, in input order.
 */
export function packRows(items: readonly LaneItem[], pps: number, rows: number): number[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].at - items[b].at || a - b);
  const ends = new Array<number>(Math.max(1, rows)).fill(-Infinity);
  const out = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const x = items[i].at * pps;
    let r = ends.findIndex((e) => e <= x);
    if (r < 0) r = ends.indexOf(Math.min(...ends));
    out[i] = r;
    ends[r] = x + itemExtentPx(items[i], pps);
  }
  return out;
}

/** Format of a time for announcements: seconds with up to 2 decimals. */
/**
 * Seconds to pan the view so a point `x` px from the lane's left edge sits at least `margin` px
 * inside [0, width] (for a focused off-screen item); 0 if it already does.
 */
export function revealPan(x: number, width: number, pps: number, margin: number): Seconds {
  if (!(pps > 0) || !(width > 0)) return 0;
  const m = Math.min(margin, width / 2);
  if (x < m) return (x - m) / pps;
  if (x > width - m) return (x - (width - m)) / pps;
  return 0;
}

export function spokenTime(t: Seconds): string {
  return `${Number(t.toFixed(2))} s`;
}
