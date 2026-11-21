/**
 * Pure helpers for the lane rows (PLAN.md §11.2, §11.3): what each lane item shows, grid
 * snapping, keyboard nudges, span-end drags, sub-row stacking and the level curve. No DOM, no store.
 */

import { glides, landing, momentGlide } from '../../core/compiler/glide';
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
import { cycleShare, patternSvg } from './pulse';
import { tuneEnd, tuneEndDrag } from './tune';

/** Nudge step without a grid, seconds. */
export const NUDGE_NO_GRID: Seconds = 0.1;

/** What dragging a lane item's span end changes. */
export type EndEdit =
  /** `glide.length` (Shift: `glide.stagger`). */
  | 'glide'
  /** A walk's or a pulse's `until`. */
  | 'until'
  /** A tune's last note length. */
  | 'notes'
  /** A level ramp's `over`. */
  | 'over'
  /** A timbre change's `fade` (M6). */
  | 'fade'
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
  /**
   * "Land at the marker" (`glide.land`, revision 9): the voices arrive at `at` and the bar ends
   * there (`start` is the lead-in); its drag handle is on the bar's start.
   */
  land: boolean;
  /** What the bar draws inside it: a pulse's accent cycle, a tune's notes (R9-7). */
  art?: LaneArt;
}

/**
 * Drawing inside a region bar, in shares (%) of the bar so it follows the bar's width: a pulse's
 * pattern cycle (an SVG mask, repeated every `share` %), or a tune's notes as dashes placed by time
 * (`left`, `width`) and pitch (`top`, 0 = the highest note).
 */
export type LaneArt =
  | { kind: 'pulse'; svg: string; share: number }
  | { kind: 'tune'; notes: { left: number; width: number; top: number }[] };

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
  if (type === 'walk' || type === 'pulse') return 'until';
  if (type === 'tune') return 'notes';
  if (type === 'timbre') return 'fade';
  return type === 'level' ? 'over' : type === 'key' ? 'none' : 'glide';
}

/** The moment's glide with the piece defaults filled in. */
export function effectiveGlide(m: Moment, defaults: Glide): Glide {
  return { ...defaults, ...m.glide };
}

/**
 * True when moment `m` lands at its marker (`glide.land`, effective, on a type it applies to). A
 * pulse moves no pitch and a tune's bar is its region (land applies per note), so neither does.
 */
export function landsAtMarker(m: Pick<Moment, 'type' | 'glide'>, defaults: Glide): boolean {
  if (m.type === 'pulse' || m.type === 'tune') return false;
  return glides(m) && effectiveGlide(m as Moment, defaults).land === true;
}

/**
 * A span estimate from the piece alone (for moments the compiled score has no span for). A moment
 * that lands at its marker (revision 9) ends at `at` and starts at the compiler's lead-in
 * (`landing`: `at` − length − stagger, clamped at 0).
 */
export function estimateSpan(m: Moment, defaults: Glide): [Seconds, Seconds] {
  if (m.type === 'walk' || m.type === 'pulse') return [m.at, Math.max(m.at, m.until)];
  if (m.type === 'tune') {
    // Its notes' span; with land the first note's glide leads in before `at`.
    const g = momentGlide(defaults, m);
    const start = g.land === true ? landing(m.at, g).start : m.at;
    return [start, Math.max(m.at, tuneEnd(m))];
  }
  if (m.type === 'level') return [m.at, m.at + Math.max(0, m.over)];
  if (m.type === 'timbre') return [m.at, m.at + Math.max(0, m.fade)];
  if (m.type === 'key') return [m.at, m.at];
  const g = effectiveGlide(m, defaults);
  if (g.land === true && glides(m)) {
    return [
      landing(m.at, { ...g, length: Math.max(0, g.length), stagger: Math.max(0, g.stagger) }).start,
      m.at,
    ];
  }
  return [m.at, m.at + Math.max(0, g.stagger) + Math.max(0, g.length)];
}

/**
 * A lane item's span while its end handle is dragged by `raw` seconds (the pointer's offset from
 * where it grabbed): the bar's far edge follows the pointer. A moment that lands at its marker
 * keeps its end at `at`, and the start follows; otherwise the end follows. Never negative length.
 */
export function endDragSpan(
  item: Pick<LaneItem, 'start' | 'end' | 'at' | 'land'>,
  raw: Seconds,
): { start: Seconds; end: Seconds } {
  if (item.land) return { start: Math.min(item.end, item.start + raw), end: item.end };
  return { start: item.start, end: Math.max(item.start, item.end + raw) };
}

/** The glide-length delta (s) of an end drag by `raw` seconds: a landing bar grows to the left. */
export function endDragDelta(item: Pick<LaneItem, 'land'>, raw: Seconds): Seconds {
  return item.land ? -raw : raw;
}

/**
 * A moment's name on the lane: its label, else chord name, `level 55%`, key, "Shift" (a note
 * moment with several changes), a timbre change's preset, or type.
 */
export function momentText(m: Moment, chordName?: string): string {
  const label = m.label?.trim();
  if (label) return label;
  if (m.type === 'chord' && chordName) return chordName;
  if (m.type === 'level') return `level ${Math.round(m.gain * 100)}%`;
  if (m.type === 'key') return keyName(m.key);
  if (m.type === 'timbre' && typeof m.preset === 'string' && m.preset !== '') return m.preset;
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
      land: landsAtMarker(m, defaults),
      art: laneArt(m, start, end),
    };
  });
}

/** A pulse's or tune's bar drawing over its bar [start, end] (see `LaneArt`); else undefined. */
export function laneArt(m: Moment, start: Seconds, end: Seconds): LaneArt | undefined {
  const len = end - start;
  if (!(len > 1e-6)) return undefined;
  if (m.type === 'pulse') {
    if (!(m.step > 0) || m.pattern.length === 0) return undefined;
    return {
      kind: 'pulse',
      svg: patternSvg(m.pattern),
      share: cycleShare(m.step, m.pattern.length, len),
    };
  }
  if (m.type === 'tune') {
    const ps = m.notes.map((n) => n.pitch).filter((p) => Number.isFinite(p));
    if (ps.length === 0) return undefined;
    const hi = Math.max(...ps);
    const range = Math.max(1, hi - Math.min(...ps));
    const notes: { left: number; width: number; top: number }[] = [];
    let t = m.at;
    for (const n of m.notes) {
      const l = Math.max(0, n.len);
      if (Number.isFinite(n.pitch)) {
        notes.push({
          left: ((t - start) / len) * 100,
          width: (l / len) * 100,
          top: ((hi - n.pitch) / range) * 100,
        });
      }
      t += l;
    }
    return { kind: 'tune', notes };
  }
  return undefined;
}

/**
 * The patch for dragging moment `m`'s span end by `dt` seconds: the glide length (or the stagger
 * when `stagger`), a walk's or pulse's `until`, a tune's last note length, a level ramp's `over`
 * or a timbre change's `fade`, each kept ≥ 0 (a walk or pulse ends at least one tick or step
 * after it starts). Null when nothing changes.
 */
export function endDragPatch(
  m: Moment,
  defaults: Glide,
  dt: Seconds,
  stagger: boolean,
): MomentPatch | null {
  if (m.type === 'key') return null;
  if (m.type === 'walk' || m.type === 'pulse') {
    const tick = m.type === 'walk' ? m.grid : m.step;
    const until = roundMs(Math.max(m.at + Math.max(1e-3, tick), m.until + dt));
    return until === m.until ? null : { until };
  }
  if (m.type === 'tune') {
    const notes = tuneEndDrag(m, dt);
    return notes ? { notes } : null;
  }
  if (m.type === 'level') {
    const over = roundMs(Math.max(0, m.over + dt));
    return over === m.over ? null : { over };
  }
  if (m.type === 'timbre') {
    const fade = roundMs(Math.max(0, m.fade + dt));
    return fade === m.fade ? null : { fade };
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

/**
 * The lane area's maximum height (px) in a timeline `columnH` tall, so the score keeps at least
 * `scoreShare` of it: what is left after that share, the ruler and the gap above the lanes.
 * Never below `floor`.
 */
export function laneMaxPx(
  columnH: number,
  rulerH: number,
  gap: number,
  scoreShare = 0.55,
  floor = 60,
): number {
  if (!(columnH > 0)) return floor;
  return Math.max(floor, Math.floor(columnH * (1 - scoreShare) - rulerH - gap));
}

/** The divider's limits: the score keeps at least this share of the timeline… */
export const SPLIT_MIN_SCORE = 0.25;
/** …and the lanes at least one row (px: the Key row and one Moments sub-row). */
export const SPLIT_MIN_LANE = 44;

/**
 * The lane area's height (px) for a divider set to `share` of the timeline (null: the default,
 * `laneMaxPx`), clamped so the score keeps SPLIT_MIN_SCORE and the lanes at least SPLIT_MIN_LANE
 * and no more than their content (`contentH`, when known).
 */
export function splitLanePx(
  share: number | null,
  columnH: number,
  rulerH: number,
  gap: number,
  contentH = Infinity,
): number {
  if (share === null || !Number.isFinite(share)) return laneMaxPx(columnH, rulerH, gap);
  return clampLanePx(share * columnH, columnH, rulerH, gap, contentH);
}

/** A lane height (px) clamped to the divider's limits (see `splitLanePx`). */
export function clampLanePx(
  px: number,
  columnH: number,
  rulerH: number,
  gap: number,
  contentH = Infinity,
): number {
  const max = Math.min(contentH, Math.floor(columnH * (1 - SPLIT_MIN_SCORE) - rulerH - gap));
  const min = Math.min(SPLIT_MIN_LANE, Math.max(0, contentH));
  return Math.round(Math.max(min, Math.min(max, px)));
}

/**
 * The scrollTop that brings [top, top + h] into a scroller `viewH` tall now at `scrollTop`, with
 * `margin` px to spare; unchanged when it is already in view.
 */
export function revealScroll(
  top: number,
  h: number,
  scrollTop: number,
  viewH: number,
  margin = 4,
): number {
  if (top < scrollTop) return Math.max(0, top - margin);
  if (top + h > scrollTop + viewH) {
    return Math.max(0, Math.min(top - margin, top + h + margin - viewH));
  }
  return scrollTop;
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
 * bar sit on the same sub-row index in the Moments and Transitions rows. `box` gives each item's
 * pixel interval (compact rows pass `compactBoxPx`).
 */
export function stackRows(
  items: readonly LaneItem[],
  pps: number,
  box: (item: LaneItem, pps: number) => [number, number] = itemBoxPx,
): Stack {
  const boxes = items.map((it) => box(it, pps));
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

/**
 * Which lane row a moment sits on (PLAN §11.3 "Dense lanes", §11.2 Effects): `level` moments on
 * the Level row (marker on the envelope), `pin` moments on the Pins row, `timbre` changes on the
 * Effects row (M6), the rest on Moments and Transitions.
 */
export type LaneRow = 'main' | 'pins' | 'level' | 'effects';

export function laneRowOf(type: MomentType): LaneRow {
  if (type === 'timbre') return 'effects';
  return type === 'level' ? 'level' : type === 'pin' ? 'pins' : 'main';
}

/** Half a marker's width (px) on the Pins and Level rows. */
export const SMALL_MARKER_HALF = 5;

/** A pin's box on the Pins row: its span (stacking only when spans overlap). */
export function pinBoxPx(item: LaneItem, pps: number): [number, number] {
  const left = Math.min(item.start, item.at) * pps;
  return [left, Math.max(item.end * pps, item.at * pps + 1)];
}

/** A level marker's box on the Level row: the marker alone (its ramp is the envelope). */
export function levelBoxPx(item: LaneItem, pps: number): [number, number] {
  const x = item.at * pps;
  return [x - SMALL_MARKER_HALF - 1, x + SMALL_MARKER_HALF + 1];
}

/** Lane row and sub-row per item (input order) and each lane row's sub-row count. */
export interface LaneLayout {
  lane: LaneRow[];
  rows: number[];
  /** Sub-rows used per lane row (0 when it has no items). */
  count: Record<LaneRow, number>;
}

const BOX: Record<LaneRow, (item: LaneItem, pps: number) => [number, number]> = {
  main: itemBoxPx,
  pins: pinBoxPx,
  level: levelBoxPx,
  effects: itemBoxPx,
};

const LANE_ROWS: readonly LaneRow[] = ['main', 'pins', 'level', 'effects'];

/**
 * Splits items by lane row and stacks each: Moments/Transitions and Effects by marker, label and
 * span (revision 7), Pins by span overlap, Level by marker collision.
 */
export function laneLayout(items: readonly LaneItem[], pps: number): LaneLayout {
  const lane = items.map((it) => laneRowOf(it.type));
  const rows = new Array<number>(items.length).fill(0);
  const count: Record<LaneRow, number> = { main: 0, pins: 0, level: 0, effects: 0 };
  for (const r of LANE_ROWS) {
    const idx = items.map((_, i) => i).filter((i) => lane[i] === r);
    const st = stackRows(
      idx.map((i) => items[i]),
      pps,
      BOX[r],
    );
    idx.forEach((i, k) => (rows[i] = st.rows[k]));
    count[r] = st.count;
  }
  return { lane, rows, count };
}

/**
 * The level curve's value at `t` (after a step at `t`): linear between points, held past either
 * end; 1 for an empty curve.
 */
export function curveAt(curve: readonly LevelPoint[], t: Seconds): number {
  if (curve.length === 0) return 1;
  let i = -1;
  for (let k = 0; k < curve.length && curve[k].t <= t; k++) i = k;
  if (i < 0) return curve[0].v;
  const a = curve[i];
  const b = curve[i + 1];
  if (!b || b.t <= a.t) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
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
