/**
 * Pure helpers for the lane rows (PLAN.md §11.2, §11.3): what each lane item shows, grid
 * snapping, keyboard nudges, span-end drags, sub-row stacking and the level curve. No DOM, no store.
 */

import { glides, landing, momentGlide } from '../../core/compiler/glide';
import { isEstablishing } from '../../core/moments/establish';
import { pulseCycleSteps } from '../../core/pulse';
import { noteChanges } from '../../core/moments/note';
import type {
  CompiledScore,
  CompiledVoice,
  Glide,
  HarmonyChange,
  Key,
  KeyChange,
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
import { progressionEnd, progressionStarts } from '../../core/moments/progression';
import { progressionChordNames, progressionEndDrag } from './progression';
import { ROW_ORDER, type Block, type RowName, type RowsView } from './rows';

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
  /** A progression's last chord length (revision 10). */
  | 'chords'
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
  | { kind: 'tune'; notes: { left: number; width: number; top: number }[] }
  | { kind: 'progression'; chords: { left: number; width: number; name: string }[] };

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
  if (type === 'progression') return 'chords';
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
  if (m.type === 'pulse' || m.type === 'tune' || m.type === 'progression') return false;
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
  if (m.type === 'progression') {
    // Its chords' span; with land the first chord's glide leads in before `at`.
    const g = momentGlide(defaults, m);
    const start = g.land === true ? landing(m.at, g).start : m.at;
    return [start, Math.max(m.at, progressionEnd(m))];
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
 * with) and the span is not empty (a moment that moves nothing still shows its intended glide:
 * a land moment the lead-in the compiler used, `MomentSpan.leadIn`); otherwise they are
 * estimated from the glide. A land moment's compiled bar starts where its glide really starts,
 * after any wait for earlier moments (build log "Land always arrives"). A chord or unison that
 * establishes notes from silence (`voices`, the compiled lines, show it) is a point: its box is
 * its label alone.
 * `harmony` (the compiled timeline) names chords; with `keys`, a progression's chords that have
 * no harmony entry are named in the key at their time.
 */
export function laneItems(
  piece: Piece,
  spans: readonly MomentSpan[],
  compiledAt?: ReadonlyMap<MomentId, Seconds>,
  harmony?: readonly HarmonyChange[],
  voices?: readonly Pick<CompiledVoice, 'lives' | 'segments'>[],
  keys?: readonly KeyChange[],
): LaneItem[] {
  const byId = new Map<MomentId, MomentSpan>();
  for (const s of spans) byId.set(s.id, s);
  const chordName = new Map<MomentId, string>();
  for (const h of harmony ?? []) if (!h.from) chordName.set(h.momentId, h.label);
  // A progression's chords are named in the key at each chord's time (`keys` timeline).
  const keyOf = (t: Seconds): Key => {
    let k = piece.key;
    for (const e of keys ?? []) if (e.t <= t) k = e.key;
    return k;
  };
  const established = voices ? establishedIds(voices) : new Set<MomentId>();
  const defaults = piece.defaults.glide;
  return piece.moments.map((m) => {
    const s = byId.get(m.id);
    const stale = compiledAt !== undefined && compiledAt.get(m.id) !== m.at;
    let start: Seconds;
    let end: Seconds;
    const land = landsAtMarker(m, defaults);
    if (s && s.end > s.start && !stale && !m.muted) {
      start = Math.min(s.start, m.at);
      end = Math.max(s.end, m.at);
    } else if (s && !stale && !m.muted && isEstablishing(m) && established.has(m.id)) {
      start = end = m.at;
    } else if (land && s?.leadIn !== undefined && !stale && !m.muted) {
      // It moved nothing: the lead-in the compiler used (it may have waited or started late).
      start = Math.min(s.leadIn, m.at);
      end = m.at;
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
      land,
      art:
        m.type === 'progression'
          ? progressionArt(m, start, end, progressionChordNames(m, harmony, keyOf))
          : laneArt(m, start, end),
    };
  });
}

/** A progression's chords over its bar [start, end]: each chord's name across its span. */
export function progressionArt(
  m: Extract<Moment, { type: 'progression' }>,
  start: Seconds,
  end: Seconds,
  names: readonly string[],
): LaneArt | undefined {
  const len = end - start;
  if (!(len > 1e-6) || m.chords.length === 0) return undefined;
  const starts = progressionStarts(m);
  return {
    kind: 'progression',
    chords: m.chords.map((c, k) => ({
      left: ((starts[k] - start) / len) * 100,
      width: (Math.max(0, c.len) / len) * 100,
      name: names[k] ?? c.notes,
    })),
  };
}

/** A pulse's or tune's bar drawing over its bar [start, end] (see `LaneArt`); else undefined. */
export function laneArt(m: Moment, start: Seconds, end: Seconds): LaneArt | undefined {
  const len = end - start;
  if (!(len > 1e-6)) return undefined;
  if (m.type === 'pulse') {
    if (!(m.step > 0) || m.pattern.length === 0) return undefined;
    // Revision 14: a restarting pulse's cycle is one restart, its accents the pattern's first.
    const cycle = pulseCycleSteps(m.step, m.restart);
    if (cycle > 0) {
      const accents = Array.from({ length: cycle }, (_, j) => m.pattern[j % m.pattern.length]);
      return { kind: 'pulse', svg: patternSvg(accents), share: (m.restart! / len) * 100 };
    }
    return {
      kind: 'pulse',
      svg: patternSvg(m.pattern),
      share: cycleShare(m.step, m.pattern.length, len),
    };
  }
  if (m.type === 'tune') {
    // A rest (revision 10) is a gap in the bar.
    const ps = m.notes.map((n) => n.pitch ?? NaN).filter((p) => Number.isFinite(p));
    if (ps.length === 0) return undefined;
    const hi = Math.max(...ps);
    const range = Math.max(1, hi - Math.min(...ps));
    const notes: { left: number; width: number; top: number }[] = [];
    let t = m.at;
    for (const n of m.notes) {
      const l = Math.max(0, n.len);
      if (n.pitch !== undefined && Number.isFinite(n.pitch)) {
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
  if (m.type === 'progression') {
    const chords = progressionEndDrag(m, dt);
    return chords ? { chords } : null;
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
 * `laneMaxPx`), clamped so the score keeps SPLIT_MIN_SCORE and `scoreMin` px (the stage's CSS
 * min-height), and the lanes at least SPLIT_MIN_LANE and no more than their content (`contentH`,
 * when known). The lane minimum wins a conflict; CSS keeps the score's minimum then.
 */
export function splitLanePx(
  share: number | null,
  columnH: number,
  rulerH: number,
  gap: number,
  contentH = Infinity,
  scoreMin = 0,
): number {
  if (share === null || !Number.isFinite(share)) {
    const room = Math.floor(columnH - rulerH - gap - scoreMin);
    return Math.min(laneMaxPx(columnH, rulerH, gap), Math.max(SPLIT_MIN_LANE, room));
  }
  return clampLanePx(share * columnH, columnH, rulerH, gap, contentH, scoreMin);
}

/** A lane height (px) clamped to the divider's limits (see `splitLanePx`). */
export function clampLanePx(
  px: number,
  columnH: number,
  rulerH: number,
  gap: number,
  contentH = Infinity,
  scoreMin = 0,
): number {
  const max = Math.min(
    contentH,
    Math.floor(columnH * (1 - SPLIT_MIN_SCORE) - rulerH - gap),
    Math.floor(columnH - rulerH - gap - scoreMin),
  );
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

// ---------------------------------------------------------------------------------------------
// Rows and blocks on the lane (PLAN §6.4, M10b-3): the row model (./rows.ts) laid out in px
// ---------------------------------------------------------------------------------------------

/** Row headers. */
export const ROW_TITLE: Record<RowName, string> = {
  key: 'Key',
  chords: 'Chords',
  texture: 'Texture',
  melody: 'Melody',
  level: 'Level',
  sound: 'Sound',
};

/**
 * Rows shown even when empty (with parts: one row of the group); the others only with a block, or
 * under a preview of their type.
 */
export const ALWAYS_ROWS: ReadonlySet<RowName> = new Set(['key', 'chords', 'texture']);

/** Rows whose blocks run to the next block on the row (their label is clipped to the block). */
export const CHAINED_ROWS: ReadonlySet<RowName> = new Set(['key', 'chords']);

/**
 * Sub-row height (px). Key: a 14 px block. Chords: the block and a 4 px glide strip under it. The
 * rows with block art (Texture, Melody, Level, Sound): an 11 px label band over a 7 px art band, so
 * a label never crosses its block's art (owner 2026-11-23).
 */
export const SUB_H = 16;
export const CHORD_SUB_H = 20;
export const ART_SUB_H = 20;
/** Height of a dot sub-row (note and pin moments, on top of the Chords row). */
export const DOT_H = 10;
/** Padding (px) above and below a row's sub-rows. */
export const ROW_PAD = 2;
/** The level curve's band (px) at the top of the first Level row, above its blocks. */
export const LEVEL_CURVE_H = 16;
/** Half a marker's width (px): a block's box starts this far left of its time. */
export const MARKER_HALF = 5;

/** One block as the lane draws it: a moment (a progression's chord blocks merged into one). */
export interface LaneBlock {
  /** Moment id; `PIECE_KEY` for the piece key's band. */
  id: MomentId;
  row: RowName;
  part?: string;
  start: Seconds;
  end: Seconds;
  label: string;
  detail?: string;
  /** A progression's chords, one block each (same moment). */
  chords?: { start: Seconds; end: Seconds; label: string }[];
}

/** The lane's blocks from the row model, one per moment (progressions merged), and its dots. */
export function laneBlocks(view: RowsView): LaneBlock[] {
  const out: LaneBlock[] = [];
  const prog = new Map<MomentId, LaneBlock>();
  for (const r of view.rows) {
    for (const b of r.blocks) {
      if (b.index !== undefined) {
        const seen = prog.get(b.id);
        const chord = { start: b.start, end: b.end, label: b.label };
        if (seen) {
          seen.chords!.push(chord);
          seen.start = Math.min(seen.start, b.start);
          seen.end = Math.max(seen.end, b.end);
          continue;
        }
        const lb: LaneBlock = { ...blockOf(b), chords: [chord] };
        prog.set(b.id, lb);
        out.push(lb);
      } else out.push(blockOf(b));
    }
  }
  for (const p of prog.values()) p.chords!.sort((a, b) => a.start - b.start);
  return out;
}

function blockOf(b: Block): LaneBlock {
  return {
    id: b.id,
    row: b.row,
    ...(b.part !== undefined ? { part: b.part } : {}),
    start: b.start,
    end: b.end,
    label: b.label,
    ...(b.detail !== undefined ? { detail: b.detail } : {}),
  };
}

/** A row's key: `chords`, or `texture:Bass` for a part row (`texture:` = All). */
export function rowKey(row: RowName, part?: string): string {
  return part === undefined ? row : `${row}:${part}`;
}

/** A row on the lane: where it sits and what its header says. */
export interface LaneRowBox {
  key: string;
  row: RowName;
  part?: string;
  /** The header: the row's name, or on a part row the part's ("All" for the All row). */
  title: string;
  /** On a part row: its group's name, on the first row of the group only. */
  group?: string;
  top: number;
  height: number;
  subRows: number;
  /** Dot sub-rows on top (Chords only). */
  dotRows: number;
}

/** Where a block or dot sits: its row, sub-row and top (px in the track). */
export interface LanePlace {
  row: string;
  sub: number;
  top: number;
}

export interface LaneRowsLayout {
  rows: LaneRowBox[];
  blocks: Map<MomentId, LanePlace>;
  dots: Map<MomentId, LanePlace>;
  ghost?: LanePlace;
  height: number;
}

/** A block's label width estimate (px): marker, label and detail, and room to clear the next. */
export function blockLabelPx(b: Pick<LaneBlock, 'label' | 'detail'>): number {
  return 14 + (b.label.length + (b.detail ? b.detail.length + 3 : 0)) * 6.5 + 6 + LABEL_GAP + 2;
}

/**
 * A block's pixel interval for stacking: its band, at least its marker wide. It starts at the
 * block's time, so a chord that starts where the one before ends shares its sub-row (the marker's
 * left half may overlap the end of that block). On rows whose blocks end on their own (texture,
 * melody, level, sound) the label counts too, so a short block's label never runs into the next
 * one; chained rows clip their labels.
 */
export function blockBoxPx(b: LaneBlock, pps: number): [number, number] {
  const x = b.start * pps;
  const min = CHAINED_ROWS.has(b.row) ? MARKER_HALF : blockLabelPx(b) - MARKER_HALF;
  return [x, Math.max(b.end * pps, x + min)];
}

/** Sub-row height of a row. */
export const subH = (row: RowName): number =>
  row === 'chords' ? CHORD_SUB_H : row === 'key' ? SUB_H : ART_SUB_H;

/** A label's left edge (px) right of its marker's time: half a marker and a gap. */
export const LABEL_INSET = MARKER_HALF + 4;
/** Clearance (px) between a label's right edge and the next marker (or the block's end handle). */
export const LABEL_GAP = 2;

/**
 * The width (px) a block's label may take from its unshifted start (`LABEL_INSET` right of the
 * marker at `at`): up to the block's end on chained rows, up to its stacking box (`blockBoxPx`,
 * which reserves the label) elsewhere, less half the next marker and a gap. So a label never runs
 * into the next block on its sub-row; past this width it is cut (Lane.tsx hides tiny remnants).
 */
export function labelRoomPx(b: LaneBlock, at: Seconds, pps: number): number {
  const right = CHAINED_ROWS.has(b.row) ? b.end * pps : blockBoxPx(b, pps)[1];
  return right - MARKER_HALF - LABEL_GAP - (at * pps + LABEL_INSET);
}

/**
 * The lane's rows, top to bottom, with each block's and dot's place (PLAN §6.4). Rows come from
 * the row model (`view`); Key, Chords and Texture always show (with parts, Texture's part rows
 * that hold a block, else its first), the others only when they hold a block or the preview's
 * `ghost` would land there (so a drop target exists). Blocks stack on
 * sub-rows by `blockBoxPx` (the ghost with them, so it shows the sub-row it would take); dots sit
 * on dot sub-rows on top of the Chords row, stacked when their markers would touch.
 */
export function laneRowsLayout(
  view: RowsView,
  pps: number,
  ghost?: LaneBlock | null,
): LaneRowsLayout {
  const blocks = laneBlocks(view);
  const rowList: { row: RowName; part?: string }[] = view.rows.map((r) =>
    r.part !== undefined ? { row: r.row, part: r.part } : { row: r.row },
  );
  // A ghost on a row the model doesn't list (a new part row, the All row): insert it in order.
  if (ghost && !rowList.some((r) => rowKey(r.row, r.part) === rowKey(ghost.row, ghost.part))) {
    const order = ROW_ORDER.indexOf(ghost.row);
    let at = rowList.findIndex((r) => ROW_ORDER.indexOf(r.row) > order);
    if (at < 0) at = rowList.length;
    rowList.splice(at, 0, {
      row: ghost.row,
      ...(ghost.part !== undefined ? { part: ghost.part } : {}),
    });
  }
  const byRow = new Map<string, LaneBlock[]>();
  for (const b of blocks) {
    const k = rowKey(b.row, b.part);
    const list = byRow.get(k);
    if (list) list.push(b);
    else byRow.set(k, [b]);
  }
  const ghostKey = ghost ? rowKey(ghost.row, ghost.part) : null;
  const rows: LaneRowBox[] = [];
  const placeB = new Map<MomentId, LanePlace>();
  const placeD = new Map<MomentId, LanePlace>();
  let ghostPlace: LanePlace | undefined;
  let top = 0;
  const groupsSeen = new Set<RowName>();
  // Shown: rows with a block or the ghost; Key, Chords and Texture always (on part rows, the
  // group's first row when none of them holds a block).
  const used = (r: { row: RowName; part?: string }): boolean => {
    const key = rowKey(r.row, r.part);
    return (byRow.get(key)?.length ?? 0) > 0 || key === ghostKey;
  };
  const shown = rowList.filter(
    (r, i) =>
      used(r) ||
      (ALWAYS_ROWS.has(r.row) &&
        (r.part === undefined ||
          (!rowList.some((o) => o.row === r.row && used(o)) &&
            rowList.findIndex((o) => o.row === r.row) === i))),
  );
  for (const r of shown) {
    const key = rowKey(r.row, r.part);
    const mine = byRow.get(key) ?? [];
    const all = ghost && key === ghostKey ? [...mine, ghost] : mine;
    const st = stackBoxes(all.map((b) => blockBoxPx(b, pps)));
    const subRows = Math.max(1, st.count);
    let dotRows = 0;
    let dotSub: number[] = [];
    if (r.row === 'chords' && view.dots.length > 0) {
      const ds = stackBoxes(
        view.dots.map((d) => [d.at * pps - MARKER_HALF - 1, d.at * pps + MARKER_HALF + 1]),
      );
      dotRows = ds.count;
      dotSub = ds.rows;
    }
    // The first Level row holds the level curve in a band of its own above its blocks.
    const curve = r.row === 'level' && !rows.some((o) => o.row === 'level') ? LEVEL_CURVE_H : 0;
    const height = ROW_PAD * 2 + curve + dotRows * DOT_H + subRows * subH(r.row);
    const parted = r.part !== undefined;
    const box: LaneRowBox = {
      key,
      row: r.row,
      ...(parted ? { part: r.part } : {}),
      title: parted ? r.part || 'All' : ROW_TITLE[r.row],
      ...(parted && !groupsSeen.has(r.row) ? { group: ROW_TITLE[r.row] } : {}),
      top,
      height,
      subRows,
      dotRows,
    };
    if (parted) groupsSeen.add(r.row);
    rows.push(box);
    const y0 = top + ROW_PAD + curve + dotRows * DOT_H;
    all.forEach((b, i) => {
      const p = { row: key, sub: st.rows[i], top: y0 + st.rows[i] * subH(r.row) };
      if (ghost && b === ghost) ghostPlace = p;
      else placeB.set(b.id, p);
    });
    view.dots.forEach((d, i) => {
      if (r.row === 'chords')
        placeD.set(d.id, { row: key, sub: dotSub[i], top: top + ROW_PAD + dotSub[i] * DOT_H });
    });
    top += height;
  }
  return {
    rows,
    blocks: placeB,
    dots: placeD,
    ...(ghostPlace ? { ghost: ghostPlace } : {}),
    height: top,
  };
}

/** Greedy interval packing (as `stackRows`) over pixel boxes, in input order on ties. */
function stackBoxes(boxes: readonly [number, number][]): Stack {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0] || a - b);
  const ends: number[] = [];
  const rows = new Array<number>(boxes.length).fill(0);
  for (const i of order) {
    const [l, r] = boxes[i];
    let row = ends.findIndex((e) => e <= l);
    if (row < 0) {
      row = ends.length;
      ends.push(r);
    } else ends[row] = r;
    rows[i] = row;
  }
  return { rows, count: ends.length };
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
