/**
 * Pure helpers for the lane rows (PLAN.md §11.2, §11.3): what each lane item shows, grid
 * snapping, keyboard nudges, span-end drags, sub-row stacking and the level curve. No DOM, no store.
 */

import { isEstablishing } from '../../core/moments/establish';
import { noteChanges } from '../../core/moments/note';
import type {
  CompiledScore,
  CompiledVoice,
  Glide,
  HarmonyChange,
  Moment,
  MomentId,
  MomentSpan,
  MomentType,
  Piece,
  Seconds,
} from '../../core/types';
import { keyName } from '../../render/draw';
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
  /** `label`, else the chord name, `level 55%`, the key name, or the type (§11.2). */
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
 * A moment's name on the Moments row: its label, else chord name, `level 55%`, key, "Shift" (a
 * note moment with several changes), or type.
 */
export function momentText(m: Moment, chordName?: string): string {
  const label = m.label?.trim();
  if (label) return label;
  if (m.type === 'chord' && chordName) return chordName;
  if (m.type === 'level') return `level ${Math.round(m.gain * 100)}%`;
  if (m.type === 'key') return keyName(m.key);
  // Grouped note changes (§11.3 revision 7): several at once read as one "Shift".
  if (m.type === 'note' && noteChanges(m).length > 1) return 'Shift';
  return m.type;
}

/**
 * Ids of the moments that brought notes in from silence (M4.5-27): a voice's life starts at the
 * moment's time on a segment the moment produced. Such a moment has no glide.
 */
export function establishedIds(
  voices: readonly Pick<CompiledVoice, 'lives' | 'segments'>[],
): Set<MomentId> {
  const out = new Set<MomentId>();
  for (const v of voices) {
    for (const seg of v.segments) {
      if (seg.momentId === undefined || out.has(seg.momentId)) continue;
      if (v.lives.some((l) => l.born === seg.t0)) out.add(seg.momentId);
    }
  }
  return out;
}

/**
 * Lane items in piece order. Spans come from the compiled score when it has one for the moment
 * and the moment has not moved since (`compiledAt` maps ids to the times the score was built
 * with) and the span is not empty (a moment that moves nothing still shows its intended glide);
 * otherwise they are estimated from the glide. A chord or unison that establishes notes from
 * silence (`voices`, the compiled lines, show it) is a point: its box is its label alone.
 * `harmony` (the compiled timeline) names chords.
 */
export function laneItems(
  piece: Piece,
  spans: readonly MomentSpan[],
  compiledAt?: ReadonlyMap<MomentId, Seconds>,
  harmony?: readonly HarmonyChange[],
  voices?: readonly Pick<CompiledVoice, 'lives' | 'segments'>[],
): LaneItem[] {
  const byId = new Map<MomentId, MomentSpan>();
  for (const s of spans) byId.set(s.id, s);
  const chordName = new Map<MomentId, string>();
  for (const h of harmony ?? []) chordName.set(h.momentId, h.label);
  const established = voices ? establishedIds(voices) : new Set<MomentId>();
  const defaults = piece.defaults.glide;
  return piece.moments.map((m) => {
    const s = byId.get(m.id);
    const stale = compiledAt !== undefined && compiledAt.get(m.id) !== m.at;
    let start: Seconds;
    let end: Seconds;
    if (s && s.end > s.start && !stale && !m.muted) {
      start = Math.min(s.start, m.at);
      end = Math.max(s.end, m.at);
    } else if (s && !stale && !m.muted && isEstablishing(m) && established.has(m.id)) {
      start = end = m.at;
    } else {
      [start, end] = estimateSpan(m, defaults);
    }
    return {
      id: m.id,
      type: m.type,
      text: momentText(m, chordName.get(m.id)),
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

/** Pixel extent a moment needs on the Moments row: marker plus label. */
export function itemExtentPx(item: LaneItem): number {
  return 14 + item.text.length * 6.5 + 6;
}

/** The pixel interval an item occupies on its sub-row: marker and label, and its span. */
export function itemBoxPx(item: LaneItem, pps: number): [number, number] {
  const left = Math.min(item.start, item.at) * pps;
  const right = Math.max(item.at * pps + itemExtentPx(item), item.end * pps + 4);
  return [left, right];
}

/** Sub-row per item (input order) and the number of sub-rows used. */
export interface Stack {
  rows: number[];
  count: number;
}

/**
 * Lane stacking (revision 7): greedy interval packing in pixel space. Items, ordered by their
 * left edge (ties keep input order), each go on the first sub-row whose last item ends at or
 * before their left edge, else on a new sub-row. The box is the marker and label plus the span,
 * so overlapping spans (and labels) never share a sub-row. A moment's marker and its transition
 * bar sit on the same sub-row index in the Moments and Transitions rows.
 */
export function stackRows(items: readonly LaneItem[], pps: number): Stack {
  const boxes = items.map((it) => itemBoxPx(it, pps));
  const order = items.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0] || a - b);
  const ends: number[] = [];
  const rows = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const [l, r] = boxes[i];
    let row = ends.findIndex((e) => e <= l);
    if (row < 0) {
      row = ends.length;
      ends.push(r);
    } else {
      ends[row] = r;
    }
    rows[i] = row;
  }
  return { rows, count: ends.length };
}

/** One point of the level curve: time and mean level. */
export interface LevelPoint {
  t: Seconds;
  v: number;
}

/**
 * A voice's level at `t` (its limit from the left when `left`) from its timeline: linear ramps in
 * amplitude, 1 before the first change.
 */
function levelOf(
  changes: CompiledScore['voices'][number]['level'],
  t: Seconds,
  left: boolean,
): number {
  const before = (x: Seconds): boolean => (left ? x < t : x <= t);
  // v: the level at the start of change i (each ramp starts from the level in effect then).
  let v = 1;
  for (let i = 0; i < changes.length && before(changes[i].t); i++) {
    const c = changes[i];
    const next = changes[i + 1];
    const e = next && before(next.t) ? next.t : t;
    const u = c.over > 0 ? (e - c.t) / c.over : 1;
    v += (c.gain - v) * Math.min(1, u);
  }
  return v;
}

/**
 * The Level row (§11.2): the mean level of the voices alive at each time, from the compiled
 * `level` timelines, as a polyline (exact: between breakpoints every term is linear). 0 where no
 * voice sounds. Steps appear as two points at the same time.
 */
export function levelCurve(score: Pick<CompiledScore, 'voices' | 'duration'>): LevelPoint[] {
  const D = score.duration;
  const times = new Set<number>([0, D]);
  for (const v of score.voices) {
    for (const l of v.lives) {
      times.add(l.born);
      if (l.died !== undefined) times.add(l.died);
    }
    for (const c of v.level) {
      times.add(c.t);
      times.add(c.t + Math.max(0, c.over));
    }
  }
  const ts = [...times].filter((t) => t >= 0 && t <= D).sort((a, b) => a - b);
  const mean = (t: Seconds, left: boolean): number => {
    let sum = 0;
    let n = 0;
    for (const v of score.voices) {
      const alive = v.lives.some((l) =>
        left ? l.born < t && t <= (l.died ?? Infinity) : l.born <= t && t < (l.died ?? Infinity),
      );
      if (!alive) continue;
      sum += levelOf(v.level, t, left);
      n++;
    }
    return n > 0 ? sum / n : 0;
  };
  const out: LevelPoint[] = [];
  for (const t of ts) {
    const before = mean(t, true);
    const at = mean(t, false);
    if (out.length > 0 && Math.abs(before - at) > 1e-9) out.push({ t, v: before });
    out.push({ t, v: at });
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
