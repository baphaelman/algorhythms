/**
 * The lane rows under the score (PLAN.md §6.4, §11.2, §11.3 incl. "Dense lanes", §11.3a, §11.5),
 * on the score's time axis at every frame: Key, Chords, Texture, Melody, Level and Sound (one row
 * per part on the last four when the piece has parts), from the row model (../editor/rows.ts) laid
 * out by `laneRowsLayout`. Key, Chords and Texture always show; the others only with a block or
 * under a preview of their type. Each moment is one block on its row, from its marker to its end
 * (a chord to the next chord block, a texture to its own end), with a short label; overlapping
 * blocks stack on sub-rows. A Chords block draws its glide as a strip under it (land lead-ins
 * reach back before the marker); a progression draws one block per chord; the Level row draws
 * the mean level curve behind its blocks. Note and pin moments are dots on top of the Chords
 * row. The lane area grows to fit up to the divider's split, then scrolls vertically. One DOM item
 * per moment holds its marker, block and bar, so selection, focus and drags act on all of them.
 *
 * React renders the items (on piece, score or selection changes only). Positions are written
 * directly: the loop's per-frame camera (`onScoreFrame`) translates one inner container, and item
 * offsets (time × pixels-per-second) and row packing are rewritten only when the zoom or the items
 * change. Drags write transforms at once and commit the piece once per animation frame through
 * an editor gesture (one undo entry per drag; Escape cancels).
 *
 * Pointer: click selects, Shift- or ⌘/Ctrl-click toggles, a click on empty lane clears and a drag
 * there (or on the piece key's band, which never moves) pans (Follow turns off during playback);
 * a Shift-drag there draws a marquee that selects the moments it touches (⌘/Ctrl+Shift: adds
 * them); drag an item to move it along its row (snapping as a palette drop; Alt is free); Alt at
 * press duplicates; dragging a span end changes the glide length (Shift: stagger; a texture's
 * end, a level ramp's length, a fade). Keys on a focused item:
 * ←/→ nudge, ↑/↓/Home/End move focus, Delete/Backspace delete, Enter selects, Shift+Enter toggles
 * (Space plays and pauses); on a selected item these act on the whole selection. Focusing an
 * off-screen item pans the paused view to it.
 *
 * Touch (§11.3b, ../touch): a finger needs more travel before a drag, a background drag also
 * scrolls the rows vertically, and a long press opens the touch menu on the item (or the
 * background). Its latched modifiers stand in for keys: Snap off for Alt, "Ends set stagger" for
 * Shift on a span end, Select more for Shift-click and the Shift-drag marquee.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompiledScore, Moment, MomentId, Piece, Seconds } from '../../core/types';
import { partScope } from '../../core/parts';
import { scopeLabel } from '../editor/parts';
import type { View } from '../../render';
import { auditionMoment } from '../audition';
import { keyName } from '../../render';
import { PIECE_KEY_ID } from '../editor/piece-key';
import { previewState, type PreviewGhost } from '../preview';
import { deleteMoments, moveMoments } from '../editor/actions';
import {
  beginGesture,
  cancelGesture,
  endGesture,
  select,
  updateGesture,
  useEditor,
} from '../editor/history';
import {
  clampLanePx,
  dragDt,
  endDragDelta,
  endDragPatch,
  endDragSpan,
  gridStep,
  laneBlocks,
  laneItems,
  blockLabelPx,
  labelRoomPx,
  laneRowsLayout,
  levelCurve,
  nudgeDt,
  revealPan,
  revealScroll,
  splitLanePx,
  spokenTime,
  DOT_H,
  LABEL_INSET,
  LEVEL_CURVE_H,
  MARKER_HALF,
  ROW_PAD,
  type LaneBlock,
  type LaneItem,
  type LanePlace,
  type LaneRowsLayout,
  type LevelPoint,
} from '../editor/lane';
import { PIECE_KEY, rowOf, rowsOf, type RowsView } from '../editor/rows';
import { loadLaneSplit, saveLaneSplit } from '../lane-split';
import { useProgressionFocus } from '../progression-focus';
import { copyMoments, moveMomentsBy, newMomentIds, patchMoment } from '../editor/ops';
import { idsInRect, marqueeSelection, rectOf, type Rect } from '../editor/selection';
import { beatStep, changePoints, ofMoments, snapTime, type SnapSet } from '../editor/snap';
import { onScoreFrame } from '../loop';
import { attachPaletteDrop, trackPointer } from '../palette-drop';
import { panBy, usePlayer, zoomBy } from '../store';
import {
  freeOf,
  openTouchMenu,
  slopFor,
  startLongPress,
  touchMods,
  type LongPress,
} from '../touch';
import { wheelIntent } from '../wheel';
import './lane.css';

/** Tallest block (px; lane.css); rows and sub-rows are laid out by `laneRowsLayout`. */
const BLOCK_H = 18;
/** The level curve's box (px): its band at the top of the first Level row. */
const LEVEL_H = LEVEL_CURVE_H;
const LEVEL_PAD = 2;
/** A cut label narrower than this (px: a character and the ellipsis) is hidden instead. */
const MIN_LABEL = 18;
/** The divider between the score and the lanes (lane.css `.lane-divider`). */
const DIVIDER_H = 10;
/** Keyboard step (px) for the divider; Shift or Page keys move further. */
const DIVIDER_STEP = 16;
/** Horizontal travel (px) before a press becomes a drag. */
const DRAG_SLOP = 3;
/** Bars narrower than this (px) hide their end handle, so the marker stays clickable. */
const MIN_HANDLE_BAR = 6;
/** A focused item is kept at least this far (px) inside the lane's edges. */
const REVEAL_MARGIN = 48;

// Moment times each compiled score was built from, so stale spans (mid-drag) fall back to estimates.
const sourceAt = new WeakMap<CompiledScore, Map<MomentId, Seconds>>();
function recordSource(compiled: CompiledScore, piece: Piece): void {
  if (sourceAt.has(compiled)) return;
  sourceAt.set(compiled, new Map(piece.moments.map((m) => [m.id, m.at])));
}
recordSource(usePlayer.getState().compiled, usePlayer.getState().piece);
usePlayer.subscribe((s, prev) => {
  if (s.compiled !== prev.compiled) recordSource(s.compiled, s.piece);
});

const pieceNow = (): Piece => usePlayer.getState().piece;
const momentOf = (p: Piece, id: MomentId): Moment | undefined => p.moments.find((m) => m.id === id);
const nameOf = (m: Pick<Moment, 'type' | 'label'>): string => m.label?.trim() || m.type;
/** Note and pin moments are dots, not blocks (PLAN §6.4). */
const isDot = (type: Moment['type']): boolean => rowOf(type) === null;

/**
 * A press on a block's band that is also on a marker takes the marker: a band ends at the next
 * marker's centre, and a selected block (raised) would otherwise cover that marker's left half.
 */
function markerUnder(e: PointerEvent): Element | null {
  if (!(e.target instanceof Element) || !e.target.closest('.lane-band')) return null;
  return (
    document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('.lane-marker')) ??
    null
  );
}

/**
 * A press on the lane background: a click clears the selection, a drag pans; with Shift the drag
 * draws a marquee that selects the moments it touches (⌘/Ctrl+Shift: added to the selection).
 */
interface Pan {
  pointerId: number;
  x0: number;
  y0: number;
  lastX: number;
  lastY: number;
  /** A finger or pen: a vertical drag also scrolls the rows. */
  touch: boolean;
  shift: boolean;
  /** ⌘/Ctrl at press: the marquee extends the selection. */
  extend: boolean;
  started: boolean;
}

interface Drag {
  pointerId: number;
  kind: 'move' | 'end';
  id: MomentId;
  x0: number;
  t0: Seconds;
  /** Alt at press: duplicate instead of move. */
  dup: boolean;
  /** Shift at press: an end drag edits the stagger. */
  shift: boolean;
  /** Shift or ⌘/Ctrl at press: a click toggles the item in the selection. */
  toggle: boolean;
  started: boolean;
  /** Moments moved or copied (move); [id] for an end drag. */
  ids: MomentId[];
  newIds: MomentId[];
  /** Offset to commit: the move's dt, or the raw end offset. */
  dt: Seconds;
  /** Raw pointer offset and current Alt state (snap is off while Alt is held). */
  raw: Seconds;
  alt: boolean;
  /** Was the pressed item selected at press time. */
  wasSelected: boolean;
  /** The dragged bar at the press (an end drag). */
  orig?: Pick<LaneItem, 'at' | 'start' | 'end' | 'land'>;
  /** Times of the dragged moments at drag start. */
  origAt: Map<MomentId, Seconds>;
  /** Snap targets, taken at the first preview. */
  snaps?: SnapSet;
}

/** A block's label and where its block is (px, before the camera's offset). */
interface StickyLabel {
  label: HTMLElement;
  x: number;
  /** The width it may take unshifted (`labelRoomPx`), and its estimated full width. */
  room: number;
  need: number;
  row: string;
}

/** A press on the piece key at 0:00: a click selects it; a drag does nothing (it can't move). */
interface KeyPress {
  pointerId: number;
  x0: number;
  shift: boolean;
  moved: boolean;
}

/** The imperative half of the lane: element registry, layout and pointer drags. */
class LaneController {
  track: HTMLElement | null = null;
  /** The lane area's vertical scroller (capped height, PLAN rev 7 lane stacking amended). */
  scroller: HTMLElement | null = null;
  inner: HTMLElement | null = null;
  /** The score/lanes divider, and its split (lane share of the timeline; null: default). */
  divider: HTMLElement | null = null;
  private split: number | null = loadLaneSplit();
  private divDrag: { pointerId: number; y0: number; h0: number } | null = null;
  /** The preview's would-be moment (owner 2026-11-21), drawn ghosted; hidden when none. */
  ghostEl: HTMLElement | null = null;
  /** The piece key's band at 0:00 (not a moment). */
  pieceKeyEl: HTMLElement | null = null;
  private ghost: LaneItem | null = null;
  private ghostBlock: LaneBlock | null = null;
  private lastGhost: PreviewGhost | null = null;
  private keyPress: KeyPress | null = null;
  /** This press's drag threshold (larger for a finger) and its long-press timer (§11.3b). */
  private slop = DRAG_SLOP;
  private hold: LongPress | null = null;
  /** Fingers down on the track, and the two-finger pinch/pan they became (§11.3b). */
  private fingers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; window: number } | null = null;
  /** The Shift-drag selection rectangle (track px), and the items it touches during the drag. */
  marqueeEl: HTMLElement | null = null;
  private marqueeIds: MomentId[] = [];
  liveRegion: HTMLElement | null = null;
  levelLine: SVGPolylineElement | null = null;
  levelFill: SVGPolygonElement | null = null;
  levelSvg: SVGSVGElement | null = null;
  items: LaneItem[] = [];
  /** The row model (PLAN §6.4), its blocks by moment id, and the laid-out rows. */
  private rowsView: RowsView = { rows: [], dots: [] };
  private blocks = new Map<MomentId, LaneBlock>();
  private L: LaneRowsLayout | null = null;
  /** Row elements by row key (laid out without React: a preview can add a row). */
  rowsEl: HTMLElement | null = null;
  private rowEls = new Map<string, HTMLElement>();
  /** Each row header's right edge (px), and the labels kept clear of it (`stick`). */
  private gutter = new Map<string, number>();
  private labels = new Map<HTMLElement, StickyLabel>();
  curve: LevelPoint[] = [];
  readonly els = new Map<MomentId, HTMLElement>();
  private view: View | null = null;
  private offset = NaN;
  private pps = NaN;
  private dirty = true;
  /** x of the score canvas's left edge relative to the track's padding box (0 when aligned). */
  private axisLeft = 0;
  /** Each placed item's top (px in the track), for scrolling it into view. */
  private yOf = new Map<MomentId, number>();
  /** Preview times of moved items, and the preview end of an end drag. */
  private previewAt = new Map<MomentId, Seconds>();
  private previewEnd: { id: MomentId; start: Seconds; end: Seconds } | null = null;
  drag: Drag | null = null;
  private pan: Pan | null = null;
  private raf = 0;
  private flip = false;

  /** Drops a removed item's element. */
  forget(id: MomentId): void {
    const el = this.els.get(id);
    if (el) this.labels.delete(el);
    this.els.delete(id);
  }

  setItems(items: LaneItem[], rows: RowsView, curve: LevelPoint[]): void {
    this.items = items;
    this.rowsView = rows;
    this.blocks = new Map(laneBlocks(rows).map((b) => [b.id, b]));
    this.curve = curve;
    this.invalidate();
  }

  /** Re-measures the score canvas's left edge against the track (on resize). */
  measure = (): void => {
    const track = this.track;
    const canvas = document.getElementById('score');
    if (!track || !canvas) return;
    this.capHeight();
    const a = canvas.getBoundingClientRect().left + canvas.clientLeft;
    const b = track.getBoundingClientRect().left + track.clientLeft;
    const left = Math.round((a - b) * 100) / 100;
    if (left !== this.axisLeft) {
      this.axisLeft = left;
      this.offset = NaN;
      if (this.view) this.layout(this.view);
    }
  };

  /** The timeline's height, the ruler's and the lane content's (px), for the split. */
  private dims(): {
    columnH: number;
    rulerH: number;
    contentH: number;
    scoreMin: number;
  } | null {
    const timeline = this.scroller?.parentElement?.parentElement;
    if (!timeline) return null;
    const stage = timeline.querySelector<HTMLElement>('.stage');
    const scoreMin = stage ? parseFloat(getComputedStyle(stage).minHeight) : 0;
    return {
      columnH: timeline.clientHeight,
      rulerH: timeline.querySelector<HTMLElement>('.ruler')?.offsetHeight ?? 0,
      contentH: this.scroller?.scrollHeight ?? Infinity,
      scoreMin: Number.isFinite(scoreMin) ? scoreMin : 0,
    };
  }

  /**
   * Caps the lane slot at the divider's split (default: the score keeps 55 % of the timeline);
   * rows past it scroll.
   */
  private capHeight(): void {
    const slot = this.scroller?.parentElement;
    const d = this.dims();
    if (!slot || !d) return;
    const lane = splitLanePx(this.split, d.columnH, d.rulerH, DIVIDER_H, Infinity, d.scoreMin);
    const v = `${lane + DIVIDER_H}px`;
    if (slot.style.maxHeight !== v) slot.style.maxHeight = v;
    const div = this.divider;
    if (div && d.columnH > 0) {
      const shown = Math.min(lane, d.contentH);
      div.setAttribute('aria-valuenow', String(Math.round((shown / d.columnH) * 100)));
    }
    this.updateMore();
  }

  /** Sets the lane area to `px` tall (clamped), remembers the split and re-caps. */
  private setLaneHeight(px: number, save: boolean): void {
    const d = this.dims();
    if (!d || !(d.columnH > 0)) return;
    const h = clampLanePx(px, d.columnH, d.rulerH, DIVIDER_H, d.contentH, d.scoreMin);
    this.split = h / d.columnH;
    if (save) saveLaneSplit(this.split);
    this.capHeight();
  }

  /** Double-click (or Enter) on the divider: back to the default split. */
  resetSplit = (): void => {
    this.split = null;
    saveLaneSplit(null);
    this.capHeight();
  };

  private onDividerDown = (e: PointerEvent): void => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || !this.scroller) return;
    e.preventDefault();
    this.divider?.setPointerCapture(e.pointerId);
    this.divDrag = { pointerId: e.pointerId, y0: e.clientY, h0: this.scroller.clientHeight };
  };

  private onDividerMove = (e: PointerEvent): void => {
    const d = this.divDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.setLaneHeight(d.h0 - (e.clientY - d.y0), false);
  };

  private onDividerUp = (e: PointerEvent): void => {
    const d = this.divDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.divDrag = null;
    if (this.divider?.hasPointerCapture(d.pointerId))
      this.divider.releasePointerCapture(d.pointerId);
    if (e.type !== 'pointercancel' && Math.abs(e.clientY - d.y0) > 0) saveLaneSplit(this.split);
  };

  /** Keys on the focused divider: ↑/↓ grow or shrink the lanes (Shift, PageUp/Down: more). */
  onDividerKey = (e: KeyboardEvent): void => {
    const sc = this.scroller;
    if (!sc) return;
    const big = DIVIDER_STEP * 4;
    let dy = 0;
    if (e.key === 'ArrowUp') dy = e.shiftKey ? big : DIVIDER_STEP;
    else if (e.key === 'ArrowDown') dy = -(e.shiftKey ? big : DIVIDER_STEP);
    else if (e.key === 'PageUp') dy = big;
    else if (e.key === 'PageDown') dy = -big;
    else if (e.key === 'Home') dy = -Infinity;
    else if (e.key === 'End') dy = Infinity;
    else if (e.key === 'Enter') {
      this.resetSplit();
    } else return;
    e.preventDefault();
    e.stopPropagation();
    if (dy !== 0) this.setLaneHeight(sc.clientHeight + dy, true);
  };

  /** Marks the slot when rows are hidden above or below (lane.css draws a fade there). */
  updateMore = (): void => {
    const sc = this.scroller;
    const slot = sc?.parentElement;
    if (!sc || !slot) return;
    const below = sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1;
    const above = sc.scrollTop > 1;
    if ((slot.dataset.moreBelow !== undefined) !== below) {
      if (below) slot.dataset.moreBelow = '';
      else delete slot.dataset.moreBelow;
    }
    if ((slot.dataset.moreAbove !== undefined) !== above) {
      if (above) slot.dataset.moreAbove = '';
      else delete slot.dataset.moreAbove;
    }
  };

  invalidate(): void {
    this.dirty = true;
    if (this.view) this.layout(this.view);
  }

  /** Per-frame: translate the container; re-place items when the zoom, items or preview changed. */
  layout(view: View): void {
    this.view = view;
    if (previewState.ghost !== this.lastGhost) this.setGhost(previewState.ghost);
    const inner = this.inner;
    if (!inner || !(view.pps > 0)) return;
    const offset = this.axisLeft - view.start * view.pps;
    if (offset !== this.offset) {
      this.offset = offset;
      inner.style.transform = `translateX(${offset.toFixed(2)}px)`;
      for (const s of this.labels.values()) this.stick(s);
    }
    if (!this.dirty && view.pps === this.pps) return;
    this.dirty = false;
    this.pps = view.pps;
    const pps = view.pps;
    if (!this.drag?.started || !this.L) {
      // The ghost is stacked with the real blocks, so it shows the row and sub-row it would take
      // (and what it would push down); a row of its type shows while it is there.
      this.L = laneRowsLayout(this.rowsView, pps, this.ghost ? this.ghostBlock : null);
      this.setRows(this.L);
    }
    this.placeLevel(pps);
    const key = this.pieceKeyEl;
    if (key) this.placeBlock(key, this.blocks.get(PIECE_KEY), 0, pps, this.L.blocks.get(PIECE_KEY));
    for (const it of this.items) this.place(it, pps);
    if (this.ghost && this.ghostEl) this.place(this.ghost, pps, this.ghostEl, true);
  }

  /** Shows the preview's lane item (or hides it), as `place` lays out real ones. */
  private setGhost(g: PreviewGhost | null): void {
    this.lastGhost = g;
    // A preview without a block (a dot type) shows on the score only.
    this.ghost = g?.block ? g.lane : null;
    this.ghostBlock = g?.block ?? null;
    this.dirty = true;
    const el = this.ghostEl;
    if (!el) return;
    const it = this.ghost;
    const b = this.ghostBlock;
    el.hidden = !it || !b;
    if (!it || !b) {
      delete el.dataset.at;
      delete el.dataset.row;
      delete el.dataset.sub;
      delete el.dataset.part;
      return;
    }
    el.dataset.type = it.type;
    el.dataset.row = b.row;
    if (b.part !== undefined) el.dataset.part = b.part;
    else delete el.dataset.part;
    el.dataset.at = String(it.at);
    el.dataset.handle = 'false';
    const label = el.querySelector('.lane-label');
    const detail = el.querySelector('.lane-detail');
    if (label) label.textContent = b.label;
    if (detail) detail.textContent = b.detail ?? '';
    const art = el.querySelector<HTMLElement>('.lane-bar .lane-art');
    if (art) paintArt(art, it.art);
    const chords = el.querySelector<HTMLElement>('.lane-band .lane-art');
    if (chords) paintChords(chords, b);
  }

  /** Writes the rows (headers, tops, heights) and the track's height. */
  private setRows(L: LaneRowsLayout): void {
    const track = this.track;
    const host = this.rowsEl;
    if (!track || !host) return;
    const h = `${L.height}px`;
    if (track.style.getPropertyValue('--lane-h') !== h) track.style.setProperty('--lane-h', h);
    const chords = L.rows.find((r) => r.row === 'chords');
    track.dataset.subrows = String(chords?.subRows ?? 1);
    const keep = new Set<string>();
    let prev: HTMLElement | null = null;
    for (const r of L.rows) {
      keep.add(r.key);
      let el = this.rowEls.get(r.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lane-row';
        el.setAttribute('aria-hidden', 'true');
        el.dataset.testid = 'lane-row';
        el.setAttribute('data-testid', 'lane-row');
        el.dataset.row = r.row;
        if (r.part !== undefined) el.dataset.part = r.part;
        const name = document.createElement('span');
        name.className = 'lane-row-name';
        el.append(name);
        this.rowEls.set(r.key, el);
      }
      const name = el.firstElementChild as HTMLElement;
      const text = r.group ? `${r.group} ${r.title}` : r.title;
      if (name.textContent !== text) {
        // A part row's header: the group's name (first row of the group) and the part's.
        name.replaceChildren();
        if (r.group) {
          const g = document.createElement('span');
          g.className = 'lane-row-group';
          g.textContent = r.group;
          name.append(g, ` ${r.title}`);
        } else name.textContent = r.title;
      }
      if (r.group) el.dataset.group = '';
      else delete el.dataset.group;
      el.style.top = `${r.top}px`;
      el.style.height = `${r.height}px`;
      el.dataset.subRows = String(r.subRows);
      // Keep DOM order = row order.
      const at: ChildNode | null = prev ? prev.nextSibling : host.firstChild;
      if (at !== el) host.insertBefore(el, at);
      prev = el;
    }
    for (const [k, el] of this.rowEls) {
      if (!keep.has(k)) {
        el.remove();
        this.rowEls.delete(k);
      }
    }
    this.gutter.clear();
    for (const [k, el] of this.rowEls) {
      const name = el.firstElementChild as HTMLElement;
      this.gutter.set(k, name.offsetLeft + name.offsetWidth);
    }
  }

  /** The level curve in the first Level row; full height is the larger of 1.2 and the peak. */
  private placeLevel(pps: number): void {
    const { levelLine, levelFill, levelSvg } = this;
    if (!levelLine || !levelFill || !levelSvg) return;
    const row = this.L?.rows.find((r) => r.row === 'level');
    levelSvg.style.display = row ? '' : 'none';
    if (!row) return;
    levelSvg.style.top = `${row.top + ROW_PAD}px`;
    const c = this.curve;
    let peak = 1.2;
    for (const p of c) if (p.v > peak) peak = p.v;
    const h = LEVEL_H - 2 * LEVEL_PAD;
    const line = c
      .map((p) => `${(p.t * pps).toFixed(2)},${(LEVEL_PAD + (1 - p.v / peak) * h).toFixed(2)}`)
      .join(' ');
    levelLine.setAttribute('points', line);
    const last = c.at(-1);
    levelFill.setAttribute(
      'points',
      last ? `0,${LEVEL_H} ${line} ${(last.t * pps).toFixed(2)},${LEVEL_H}` : '',
    );
    levelSvg.style.width = `${((last?.t ?? 0) * pps).toFixed(2)}px`;
  }

  /** A block's band (its extent on the row, from its marker at `at`) and place. */
  private placeBlock(
    el: HTMLElement,
    b: LaneBlock | undefined,
    at: Seconds,
    pps: number,
    p: LanePlace | undefined,
    origAt = at,
  ): number {
    const y = p?.top ?? 0;
    el.style.transform = `translate(${(at * pps).toFixed(2)}px, ${y}px)`;
    if (p && el.dataset.sub !== String(p.sub)) el.dataset.sub = String(p.sub);
    const band = el.querySelector<HTMLElement>(':scope > .lane-band');
    if (!band || !b) return 0;
    const w = Math.max(0, (b.end - b.start) * pps);
    band.style.left = `${(MARKER_HALF + (b.start - origAt) * pps).toFixed(2)}px`;
    band.style.width = `${w.toFixed(2)}px`;
    const label = el.querySelector<HTMLElement>(':scope > .lane-text');
    if (label && p) {
      const s = {
        label,
        x: at * pps,
        room: labelRoomPx(b, origAt, pps),
        need: blockLabelPx(b) - 14 - 10,
        row: p.row,
      };
      this.labels.set(el, s);
      this.stick(s);
    }
    return w;
  }

  /**
   * Keeps a block's label readable and clear of other blocks: cut at its room (`labelRoomPx`, so
   * a short chord's name never reaches the next marker), hidden when under a character is left,
   * and pushed right of its row's header while the block's start is under it (so a block that
   * began off-screen still shows its name).
   */
  private stick(s: StickyLabel): void {
    const start = s.x + this.offset + LABEL_INSET;
    const want = (this.gutter.get(s.row) ?? 0) + 4 - start;
    const shift = Math.round(Math.max(0, Math.min(want, s.room - 24)));
    const tf = shift > 0 ? `translateX(${shift}px)` : '';
    if (s.label.style.transform !== tf) s.label.style.transform = tf;
    const left = Math.floor(s.room - shift);
    const max = `${left >= Math.min(MIN_LABEL, s.need) ? left : 0}px`;
    if (s.label.style.maxWidth !== max) s.label.style.maxWidth = max;
  }

  private place(it: LaneItem, pps: number, el = this.els.get(it.id), ghost = false): void {
    if (!el || !this.L) return;
    const at = this.previewAt.get(it.id) ?? it.at;
    const dot = isDot(it.type);
    const p = ghost
      ? this.L.ghost
      : ((dot ? this.L.dots.get(it.id) : this.L.blocks.get(it.id)) ?? this.placeOfCopy(it.id));
    const b = ghost ? (this.ghostBlock ?? undefined) : this.blocks.get(it.id);
    this.placeBlock(el, b, at, pps, p, it.at);
    if (p) this.yOf.set(it.id, p.top);
    const bar = el.querySelector<HTMLElement>(':scope > .lane-bar');
    if (!bar) return;
    // Key changes and dots have no bar; a chord block's bar is its glide strip under the block.
    const span = this.previewEnd?.id === it.id ? this.previewEnd : it;
    const w = dot || it.type === 'key' ? 0 : Math.max(0, (span.end - span.start) * pps);
    bar.style.left = `${(MARKER_HALF + (span.start - it.at) * pps).toFixed(2)}px`;
    bar.style.width = `${w.toFixed(2)}px`;
    const handle = !ghost && !dot && it.endEdit !== 'none' && w >= MIN_HANDLE_BAR;
    if (el.dataset.handle !== String(handle)) el.dataset.handle = String(handle);
  }

  /** A copy made mid-drag sits on its original's row. */
  private placeOfCopy(id: MomentId): LanePlace | undefined {
    const d = this.drag;
    const i = d ? d.newIds.indexOf(id) : -1;
    if (i < 0 || !d || !this.L) return undefined;
    return this.L.blocks.get(d.ids[i]) ?? this.L.dots.get(d.ids[i]);
  }

  /** Pans the (paused) view so item `id` is visible: Tab focus onto an off-screen item. */
  reveal(id: MomentId): void {
    const it = this.items.find((x) => x.id === id);
    const width = this.track?.clientWidth ?? 0;
    if (!it || !this.view || this.drag || !(this.pps > 0)) return;
    const x = (this.previewAt.get(id) ?? it.at) * this.pps + this.offset;
    const dt = revealPan(x, width, this.pps, REVEAL_MARGIN);
    if (dt !== 0) panBy(dt);
    this.revealY(id);
  }

  /** Scrolls the lane area vertically so item `id`'s marker is in view. */
  revealY(id: MomentId): void {
    const sc = this.scroller;
    if (!sc || this.drag?.started || sc.scrollHeight <= sc.clientHeight) return;
    if (this.dirty && this.view) this.layout(this.view);
    const y = this.yOf.get(id);
    const it = this.items.find((x) => x.id === id);
    if (y === undefined || !it) return;
    const h = isDot(it.type) ? DOT_H : BLOCK_H;
    const top = (this.track?.clientTop ?? 0) + y;
    const next = revealScroll(top, h, sc.scrollTop, sc.clientHeight);
    if (next !== sc.scrollTop) sc.scrollTop = next;
  }

  /** Wheel over the lane area: zoom and pan as on the score; a plain vertical wheel scrolls it. */
  private onWheel = (e: WheelEvent): void => {
    const w = wheelIntent(e);
    if (w.kind === 'zoom') {
      e.preventDefault();
      zoomBy(w.factor);
    } else if (w.kind === 'pan') {
      e.preventDefault();
      if (this.pps > 0) panBy(w.px / this.pps);
    }
  };

  announce(text: string): void {
    const el = this.liveRegion;
    if (!el) return;
    // Alternate a trailing no-break space so a repeated message is still announced.
    this.flip = !this.flip;
    el.textContent = this.flip ? text : `${text}\u00a0`;
  }

  /** Time under a client x, from the inner container's on-screen position. */
  private timeAt(clientX: number): Seconds {
    if (!this.inner || !(this.pps > 0)) return 0;
    return (clientX - this.inner.getBoundingClientRect().left) / this.pps;
  }

  // ---- pointer ------------------------------------------------------------------------------

  onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.fingers.size === 2) {
        this.beginPinch(e);
        return;
      }
      if (this.fingers.size > 2 || this.pinch) return;
    }
    if (this.drag || this.pan || this.keyPress || (e.pointerType === 'mouse' && e.button !== 0))
      return;
    const target = markerUnder(e) ?? (e.target instanceof Element ? e.target : null);
    this.slop = slopFor(e.pointerType, DRAG_SLOP);
    const mods = touchMods();
    if (target?.closest('[data-piece-key]')) {
      this.startHold(e, PIECE_KEY_ID);
      this.track?.setPointerCapture(e.pointerId);
      this.keyPress = {
        pointerId: e.pointerId,
        x0: e.clientX,
        shift: e.shiftKey || e.metaKey || e.ctrlKey,
        moved: false,
      };
      return;
    }
    const itemEl = target?.closest<HTMLElement>('[data-moment]');
    if (!itemEl) {
      this.startHold(e, null);
      this.track?.setPointerCapture(e.pointerId);
      this.pan = {
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        touch: e.pointerType !== 'mouse',
        shift: e.shiftKey || mods.add,
        extend: e.metaKey || e.ctrlKey || mods.add,
        started: false,
      };
      return;
    }
    const id = itemEl.dataset.moment as MomentId;
    const onHandle = !!target?.closest('[data-end-handle]');
    const sel = useEditor.getState().selection;
    const wasSelected = sel.includes(id);
    const toggle = e.shiftKey || e.metaKey || e.ctrlKey || mods.add;
    if (!wasSelected && !toggle) select([id]);
    this.startHold(e, id);
    this.track?.setPointerCapture(e.pointerId);
    this.drag = {
      pointerId: e.pointerId,
      kind: onHandle ? 'end' : 'move',
      id,
      x0: e.clientX,
      t0: this.timeAt(e.clientX),
      dup: !onHandle && e.altKey,
      shift: e.shiftKey || (onHandle && mods.stagger),
      toggle,
      started: false,
      ids: [],
      newIds: [],
      dt: 0,
      raw: 0,
      alt: freeOf(e),
      wasSelected,
      origAt: new Map(),
    };
  };

  /** The second finger: abandons the first finger's press and starts pinching (zoom) and panning. */
  private beginPinch(e: PointerEvent): void {
    this.endHold();
    this.cancel();
    const p = this.pan;
    if (p) {
      this.pan = null;
      this.clearMarquee();
      this.track?.classList.remove('panning');
      if (this.track?.hasPointerCapture(p.pointerId)) this.track.releasePointerCapture(p.pointerId);
    }
    this.keyPress = null;
    this.track?.setPointerCapture(e.pointerId);
    this.pinch = { dist: this.fingerDistance(), window: usePlayer.getState().view.window };
  }

  private fingerDistance(): number {
    const [a, b] = [...this.fingers.values()];
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  }

  /** Spreading the fingers zooms in (a shorter window); moving them together pans, as on the score. */
  private pinchMove(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    const g = this.pinch;
    if (!f || !g) return;
    const dx = e.clientX - f.x;
    f.x = e.clientX;
    f.y = e.clientY;
    if (this.fingers.size < 2) return;
    const view = usePlayer.getState().view;
    zoomBy((g.window * (g.dist / this.fingerDistance())) / view.window);
    if (dx !== 0 && this.pps > 0) panBy(-dx / this.fingers.size / this.pps);
  }

  /** Lifts a finger; the pinch ends with the last one (the rest of the gesture does nothing). */
  private fingerUp(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch' || !this.fingers.delete(e.pointerId)) return false;
    if (this.track?.hasPointerCapture(e.pointerId)) this.track.releasePointerCapture(e.pointerId);
    if (!this.pinch) return false;
    if (this.fingers.size === 0) this.pinch = null;
    return true;
  }

  /**
   * A long press (finger or pen) opens the touch menu on `id` (null: the background), unless the
   * press became a drag first; the press then does nothing more.
   */
  private startHold(e: PointerEvent, id: MomentId | null): void {
    this.endHold();
    const { clientX: x, clientY: y, pointerId } = e;
    this.hold = startLongPress(e, () => {
      this.hold = null;
      if (this.drag?.started || this.pan?.started || this.keyPress?.moved) return;
      if (this.drag) this.finish();
      this.pan = null;
      this.keyPress = null;
      if (this.track?.hasPointerCapture(pointerId)) this.track.releasePointerCapture(pointerId);
      const sel = useEditor.getState().selection;
      if (id && !sel.includes(id)) select(touchMods().add ? [...sel, id] : [id]);
      openTouchMenu(x, y, id);
    });
  }

  private endHold(): void {
    this.hold?.cancel();
    this.hold = null;
  }

  /** A long press is the touch menu, not the browser's. */
  onContext = (e: MouseEvent): void => {
    const pt = (e as MouseEvent & { pointerType?: string }).pointerType;
    if (this.hold || (pt !== undefined && pt !== 'mouse')) e.preventDefault();
  };

  /** Background drag: the content follows the pointer; with Shift, a marquee. */
  private onPanMove(e: PointerEvent, p: Pan): void {
    if (!p.started) {
      const dy = p.shift || p.touch ? e.clientY - p.y0 : 0;
      if (Math.hypot(e.clientX - p.x0, dy) <= this.slop) return;
      p.started = true;
      if (!p.shift) this.track?.classList.add('panning');
    }
    if (p.shift) {
      this.drawMarquee(p, e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.lastX;
    p.lastX = e.clientX;
    if (dx !== 0 && this.pps > 0) panBy(-dx / this.pps);
    // A finger scrolls the rows too (the track takes every touch gesture, `touch-action: none`).
    const dy = e.clientY - p.lastY;
    p.lastY = e.clientY;
    if (p.touch && dy !== 0 && this.scroller) this.scroller.scrollTop -= dy;
  }

  /** Shows the marquee from the press to (x, y) and marks the items it touches. */
  private drawMarquee(p: Pan, x: number, y: number): void {
    const el = this.marqueeEl;
    const track = this.track;
    if (!el || !track) return;
    const r = rectOf(p.x0, p.y0, x, y);
    const t = track.getBoundingClientRect();
    el.hidden = false;
    el.style.left = `${r.left - t.left}px`;
    el.style.top = `${r.top - t.top}px`;
    el.style.width = `${r.right - r.left}px`;
    el.style.height = `${r.bottom - r.top}px`;
    const boxes: ({ id: MomentId } & Rect)[] = [];
    for (const [id, item] of this.els) {
      // The marker, block, glide strip and (clipped) label, not the item's whole box.
      for (const part of item.querySelectorAll<HTMLElement>(
        ':scope > .lane-marker, :scope > .lane-band, :scope > .lane-bar, :scope > .lane-text',
      )) {
        const b = part.getBoundingClientRect();
        if (b.width > 0 || b.height > 0)
          boxes.push({ id, left: b.left, top: b.top, right: b.right, bottom: b.bottom });
      }
    }
    const inside = [...new Set(idsInRect(boxes, r))];
    for (const id of this.marqueeIds)
      if (!inside.includes(id)) this.els.get(id)?.removeAttribute('data-marquee');
    for (const id of inside) this.els.get(id)?.setAttribute('data-marquee', '');
    this.marqueeIds = inside;
  }

  private clearMarquee(): void {
    if (this.marqueeEl) this.marqueeEl.hidden = true;
    for (const id of this.marqueeIds) this.els.get(id)?.removeAttribute('data-marquee');
    this.marqueeIds = [];
  }

  private endPan(e: PointerEvent, p: Pan): void {
    this.pan = null;
    this.track?.classList.remove('panning');
    if (this.track?.hasPointerCapture(p.pointerId)) this.track.releasePointerCapture(p.pointerId);
    const ok = e.type !== 'pointercancel';
    if (p.shift && p.started) {
      if (ok) this.drawMarquee(p, e.clientX, e.clientY);
      const inside = this.marqueeIds;
      this.clearMarquee();
      if (!ok) return;
      const next = marqueeSelection(useEditor.getState().selection, inside, p.extend);
      select(next);
      this.announce(`Selected ${next.length} ${next.length === 1 ? 'moment' : 'moments'}`);
      // Focus the first so ←/→ nudge and Delete act on the group.
      const first = next.find((id) => this.els.has(id));
      if (first) this.els.get(first)?.focus({ preventScroll: true });
      return;
    }
    if (!p.started && ok && !p.shift && !p.extend) select([]);
  }

  onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && this.fingers.has(e.pointerId)) {
      if (this.pinch) {
        this.pinchMove(e);
        return;
      }
      const f = this.fingers.get(e.pointerId);
      if (f) {
        f.x = e.clientX;
        f.y = e.clientY;
      }
    }
    this.hold?.move(e.clientX, e.clientY);
    const k = this.keyPress;
    if (k && e.pointerId === k.pointerId) {
      if (Math.abs(e.clientX - k.x0) <= this.slop) return;
      // The piece key never moves: a drag on its band pans, as on the background.
      k.moved = true;
      this.endHold();
      this.keyPress = null;
      this.pan = {
        pointerId: k.pointerId,
        x0: k.x0,
        y0: e.clientY,
        lastX: k.x0,
        lastY: e.clientY,
        touch: e.pointerType !== 'mouse',
        shift: false,
        extend: false,
        started: false,
      };
      this.onPanMove(e, this.pan);
      return;
    }
    const p = this.pan;
    if (p && e.pointerId === p.pointerId) {
      this.onPanMove(e, p);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.started) {
      if (Math.abs(e.clientX - d.x0) <= this.slop) return;
      this.endHold();
      this.start(d);
    }
    d.raw = this.timeAt(e.clientX) - d.t0;
    d.alt = freeOf(e);
    this.preview(d);
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.commit();
      });
    }
  };

  private start(d: Drag): void {
    d.started = true;
    window.addEventListener('keydown', this.onKey, true);
    if (d.kind === 'end') {
      d.ids = [d.id];
      const it = this.items.find((x) => x.id === d.id);
      if (it) d.orig = { at: it.at, start: it.start, end: it.end, land: it.land };
      beginGesture(endLabel(it?.endEdit, d.shift));
      return;
    }
    // A plain or Shift press on a selected item drags the whole selection.
    if (d.toggle && !d.wasSelected) select([...useEditor.getState().selection, d.id]);
    const sel = useEditor.getState().selection;
    d.ids = sel.includes(d.id) ? [...sel] : [d.id];
    const p = pieceNow();
    for (const m of p.moments) if (d.ids.includes(m.id)) d.origAt.set(m.id, m.at);
    if (d.dup) {
      const order = p.moments.filter((m) => d.ids.includes(m.id)).map((m) => m.id);
      d.ids = order;
      d.newIds = newMomentIds(p, order.length);
      beginGesture(order.length === 1 ? 'Duplicate moment' : 'Duplicate moments');
    } else {
      beginGesture(d.ids.length === 1 ? 'Move moment' : 'Move moments');
    }
  }

  /** Immediate feedback: moved items' transforms, or the dragged bar's end. */
  private preview(d: Drag): void {
    if (d.kind === 'end') {
      const it = this.items.find((x) => x.id === d.id);
      let raw = d.raw;
      // A region's end (walk, pulse, tune) snaps like a moment (beats, note changes; Alt: free).
      if (
        d.orig &&
        it &&
        (it.endEdit === 'until' || it.endEdit === 'notes' || it.endEdit === 'chords')
      ) {
        const st = usePlayer.getState();
        d.snaps ??= {
          points: changePoints(st.compiled, st.piece),
          exclude: ofMoments([d.id]),
          grid: beatStep(st.piece.view),
        };
        raw = snapTime(d.orig.end + d.raw, d.snaps, this.view?.pps ?? 0, d.alt) - d.orig.end;
      }
      // A bar that lands at its marker grows to the left: the glide gets longer as it drags left.
      // The preview is the bar as it was at the press, dragged (the piece updates under it).
      d.dt = d.orig ? endDragDelta(d.orig, raw) : raw;
      if (d.orig) this.previewEnd = { id: d.id, ...endDragSpan(d.orig, raw) };
      if (it && this.view) this.place(it, this.view.pps);
      return;
    }
    const primary = d.origAt.get(d.id);
    if (primary === undefined) return;
    // Revision 7: snaps to note changes (not the bar grid), outside the dragged moments.
    const st = usePlayer.getState();
    d.snaps ??= {
      points: changePoints(st.compiled, st.piece),
      exclude: ofMoments(d.ids),
      grid: beatStep(st.piece.view),
    };
    const to = snapTime(primary + d.raw, d.snaps, this.view?.pps ?? 0, d.alt);
    let dt = dragDt(primary, to - primary, null, false);
    // The group stops when its earliest moment reaches 0.
    dt = Math.max(dt, -Math.min(...d.origAt.values()));
    d.dt = dt;
    if (d.dup || !this.view) return;
    for (const [id, at] of d.origAt) {
      this.previewAt.set(id, at + dt);
      const it = this.items.find((x) => x.id === id);
      if (it) this.place(it, this.view.pps);
    }
  }

  private commit(): void {
    const d = this.drag;
    if (!d?.started) return;
    if (d.kind === 'end') {
      updateGesture((p) => {
        const m = momentOf(p, d.id);
        const patch = m && endDragPatch(m, p.defaults.glide, d.dt, d.shift);
        return patch ? patchMoment(p, d.id, patch) : p;
      });
    } else if (d.dup) {
      updateGesture((p) => copyMoments(p, d.ids, d.dt, d.newIds).piece);
    } else {
      updateGesture((p) => moveMomentsBy(p, d.ids, d.dt));
    }
  }

  onUp = (e: PointerEvent): void => {
    if (this.fingerUp(e)) return;
    this.endHold();
    const k = this.keyPress;
    if (k && e.pointerId === k.pointerId) {
      this.keyPress = null;
      if (this.track?.hasPointerCapture(k.pointerId)) this.track.releasePointerCapture(k.pointerId);
      if (e.type === 'pointercancel') return;
      const sel = useEditor.getState().selection;
      if (k.shift) {
        select(
          sel.includes(PIECE_KEY_ID)
            ? sel.filter((x) => x !== PIECE_KEY_ID)
            : [...sel, PIECE_KEY_ID],
        );
      } else {
        select([PIECE_KEY_ID]);
      }
      return;
    }
    const p = this.pan;
    if (p && e.pointerId === p.pointerId) {
      this.endPan(e, p);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.type === 'pointercancel') {
      this.cancel();
      return;
    }
    this.finish();
    if (!d.started) {
      const sel = useEditor.getState().selection;
      if (d.toggle) {
        select(d.wasSelected ? sel.filter((x) => x !== d.id) : [...sel, d.id]);
      } else {
        select([d.id]);
        // Plays what the moment moves to (§11.3 auditioning; stopped transport only).
        auditionMoment(d.id);
      }
      return;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.commit();
    endGesture();
    if (d.dup) select(d.newIds);
    this.announceDrag(d);
  };

  private announceDrag(d: Drag): void {
    const p = pieceNow();
    const m = momentOf(p, d.dup ? (d.newIds[d.ids.indexOf(d.id)] ?? d.id) : d.id);
    if (!m) return;
    const name = nameOf(m);
    const more = d.ids.length > 1 ? ` and ${d.ids.length - 1} more` : '';
    if (d.kind === 'move') {
      this.announce(`${d.dup ? 'Duplicated' : 'Moved'} ${name}${more} to ${spokenTime(m.at)}`);
    } else if (m.type === 'walk' || m.type === 'pulse') {
      this.announce(`${name} ends at ${spokenTime(m.until)}`);
    } else if (m.type === 'tune') {
      const last = m.notes.at(-1);
      if (last) this.announce(`${name} last note ${spokenTime(last.len)}`);
    } else if (m.type === 'progression') {
      const last = m.chords.at(-1);
      if (last) this.announce(`${name} last chord ${spokenTime(last.len)}`);
    } else if (m.type === 'level') {
      this.announce(`${name} ramp ${spokenTime(m.over)}`);
    } else if (m.type === 'timbre') {
      this.announce(`${name} fade ${spokenTime(m.fade)}`);
    } else {
      const g = { ...p.defaults.glide, ...m.glide };
      this.announce(
        d.shift
          ? `${name} stagger ${spokenTime(g.stagger)}`
          : `${name} glide ${spokenTime(g.length)}`,
      );
    }
  }

  private finish(): void {
    const d = this.drag;
    this.drag = null;
    if (d && this.track?.hasPointerCapture(d.pointerId))
      this.track.releasePointerCapture(d.pointerId);
    window.removeEventListener('keydown', this.onKey, true);
    this.previewAt.clear();
    this.previewEnd = null;
    this.dirty = true;
  }

  cancel(): void {
    this.endHold();
    const d = this.drag;
    if (!d) return;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.finish();
    if (d.started) {
      cancelGesture();
      this.announce('Drag cancelled');
    }
    this.invalidate();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    this.cancel();
  };

  attach(
    scroller: HTMLElement,
    track: HTMLElement,
    inner: HTMLElement,
    ghost: HTMLElement | null,
    divider: HTMLElement | null,
    marquee: HTMLElement | null = null,
    rows: HTMLElement | null = null,
    pieceKey: HTMLElement | null = null,
  ): () => void {
    this.marqueeEl = marquee;
    this.rowsEl = rows;
    this.pieceKeyEl = pieceKey;
    this.scroller = scroller;
    this.divider = divider;
    if (divider) {
      divider.addEventListener('pointerdown', this.onDividerDown);
      divider.addEventListener('pointermove', this.onDividerMove);
      divider.addEventListener('pointerup', this.onDividerUp);
      divider.addEventListener('pointercancel', this.onDividerUp);
      divider.addEventListener('dblclick', this.resetSplit);
      divider.addEventListener('keydown', this.onDividerKey);
    }
    this.inner = inner;
    this.ghostEl = ghost;
    this.track = track;
    scroller.addEventListener('wheel', this.onWheel, { passive: false });
    scroller.addEventListener('scroll', this.updateMore, { passive: true });
    // A newly selected moment (from the score, inspector or keys) is scrolled into view.
    let revealRaf = 0;
    const offSel = useEditor.subscribe((s, prev) => {
      if (s.selection === prev.selection) return;
      const id = s.selection.find((x) => !prev.selection.includes(x)) ?? s.selection[0];
      if (!id) return;
      cancelAnimationFrame(revealRaf);
      revealRaf = requestAnimationFrame(() => this.revealY(id));
    });
    this.liveRegion = scroller.parentElement?.querySelector<HTMLElement>('[aria-live]') ?? null;
    this.levelSvg = inner.querySelector<SVGSVGElement>('.lane-level');
    this.levelLine = inner.querySelector<SVGPolylineElement>('.lane-level-line');
    this.levelFill = inner.querySelector<SVGPolygonElement>('.lane-level-fill');
    track.addEventListener('pointerdown', this.onDown);
    track.addEventListener('pointermove', this.onMove);
    track.addEventListener('pointerup', this.onUp);
    track.addEventListener('pointercancel', this.onUp);
    track.addEventListener('contextmenu', this.onContext);
    const off = onScoreFrame((v) => this.layout(v));
    const offDrop = attachPaletteDrop(track);
    const untrack = trackPointer(track);
    const ro = new ResizeObserver(this.measure);
    ro.observe(track);
    ro.observe(scroller);
    const canvas = document.getElementById('score');
    if (canvas) ro.observe(canvas);
    const timeline = scroller.parentElement?.parentElement;
    if (timeline) ro.observe(timeline);
    this.measure();
    return () => {
      this.cancel();
      this.keyPress = null;
      off();
      offDrop();
      untrack();
      offSel();
      cancelAnimationFrame(revealRaf);
      scroller.removeEventListener('wheel', this.onWheel);
      scroller.removeEventListener('scroll', this.updateMore);
      ro.disconnect();
      track.removeEventListener('pointerdown', this.onDown);
      track.removeEventListener('pointermove', this.onMove);
      track.removeEventListener('pointerup', this.onUp);
      track.removeEventListener('pointercancel', this.onUp);
      track.removeEventListener('contextmenu', this.onContext);
      if (divider) {
        divider.removeEventListener('pointerdown', this.onDividerDown);
        divider.removeEventListener('pointermove', this.onDividerMove);
        divider.removeEventListener('pointerup', this.onDividerUp);
        divider.removeEventListener('pointercancel', this.onDividerUp);
        divider.removeEventListener('dblclick', this.resetSplit);
        divider.removeEventListener('keydown', this.onDividerKey);
      }
      this.divDrag = null;
      this.track = null;
      this.rowsEl = null;
      this.rowEls.clear();
      this.L = null;
      this.scroller = null;
      this.divider = null;
    };
  }
}

/** The undo label of a span-end drag. */
function endLabel(edit: LaneItem['endEdit'] | undefined, shift: boolean): string {
  if (edit === 'until') return 'Change region';
  if (edit === 'notes') return 'Change last note length';
  if (edit === 'chords') return 'Change last chord length';
  if (edit === 'over') return 'Change ramp';
  if (edit === 'fade') return 'Change fade';
  return shift ? 'Change stagger' : 'Change glide length';
}

/** CSS mask for a pulse's accent cycle: the SVG as a data URL, repeated every `share` %. */
function pulseMask(art: Extract<LaneItem['art'], { kind: 'pulse' }>): {
  url: string;
  size: string;
} {
  return {
    url: `url("data:image/svg+xml,${encodeURIComponent(art.svg)}")`,
    size: `${art.share.toFixed(4)}% 100%`,
  };
}

/** A tune note dash's vertical place in the art band: 0 % (the highest note) to its bottom. */
const tuneTop = (top: number): string => `calc((100% - 2px) * ${(top / 100).toFixed(4)})`;

/** A pulse's accent cycle or a tune's notes, drawn inside its bar (R9-7). */
function BarArt({ art }: { art: LaneItem['art'] }) {
  if (!art || art.kind === 'progression') return null;
  if (art.kind === 'pulse') {
    const { url, size } = pulseMask(art);
    return (
      <span
        className="lane-art lane-pulse"
        aria-hidden="true"
        style={{ maskImage: url, WebkitMaskImage: url, maskSize: size, WebkitMaskSize: size }}
      />
    );
  }
  return (
    <span className="lane-art lane-tune" aria-hidden="true">
      {art.notes.map((n, i) => (
        <span key={i} style={{ left: `${n.left}%`, width: `${n.width}%`, top: tuneTop(n.top) }} />
      ))}
    </span>
  );
}

/** A progression's chords as blocks of their own inside its band, in % of the band. */
function chordBoxes(b: LaneBlock): { left: number; width: number; label: string }[] {
  const len = b.end - b.start;
  if (!b.chords || !(len > 1e-6)) return [];
  return b.chords.map((c) => ({
    left: ((c.start - b.start) / len) * 100,
    width: (Math.max(0, c.end - c.start) / len) * 100,
    label: c.label,
  }));
}

/** A progression's chord blocks (revision 10; §6.4: one block per chord, one moment). */
function BandArt({ block, id }: { block: LaneBlock | undefined; id: MomentId }) {
  // The inspector's focused progression chord (cheap: one selector, a class on one span).
  const focus = useProgressionFocus((s) => (s.id === id ? s.k : -1));
  if (!block?.chords) return null;
  return (
    <span className="lane-art lane-progression" aria-hidden="true">
      {chordBoxes(block).map((c, i) => (
        <span
          key={i}
          data-testid="lane-prog-chord"
          className={i === focus ? 'on' : undefined}
          style={{ left: `${c.left}%`, width: `${c.width}%` }}
        >
          {c.label}
        </span>
      ))}
    </span>
  );
}

/** `BandArt` written into the lane ghost's band (the ghost is laid out without React). */
function paintChords(el: HTMLElement, b: LaneBlock): void {
  el.className = b.chords ? 'lane-art lane-progression' : 'lane-art';
  el.replaceChildren();
  for (const c of chordBoxes(b)) {
    const d = document.createElement('span');
    d.style.left = `${c.left}%`;
    d.style.width = `${c.width}%`;
    d.textContent = c.label;
    el.append(d);
  }
}

/** `BarArt` written into the lane ghost's art slot (the ghost is laid out without React). */
function paintArt(el: HTMLElement, art: LaneItem['art']): void {
  el.className = art && art.kind !== 'progression' ? `lane-art lane-${art.kind}` : 'lane-art';
  el.replaceChildren();
  const st = el.style;
  st.maskImage = st.webkitMaskImage = st.maskSize = st.webkitMaskSize = '';
  if (art?.kind === 'pulse') {
    const { url, size } = pulseMask(art);
    st.maskImage = st.webkitMaskImage = url;
    st.maskSize = st.webkitMaskSize = size;
  } else if (art?.kind === 'tune') {
    for (const n of art.notes) {
      const d = document.createElement('span');
      d.style.left = `${n.left}%`;
      d.style.width = `${n.width}%`;
      d.style.top = tuneTop(n.top);
      el.append(d);
    }
  }
}

/** Moments with a `no-effect` diagnostic (revision 6) and its message. */
function noEffectReasons(compiled: CompiledScore): Map<MomentId, string> {
  const out = new Map<MomentId, string>();
  for (const d of compiled.diagnostics) {
    if (d.code === 'no-effect' && d.momentId !== undefined) out.set(d.momentId, d.message);
  }
  return out;
}

/** Moments with a part target and its label (revisions 9–10: "Melody", "all but Bass"). */
function momentParts(piece: Piece): Map<MomentId, string> {
  const out = new Map<MomentId, string>();
  for (const m of piece.moments) {
    const scope = partScope(m.target);
    if (scope !== null) out.set(m.id, scopeLabel(scope));
  }
  return out;
}

/** What a landing moment's tooltip says: the notes arrive on the marker (revision 9). */
function landText(it: LaneItem): string | undefined {
  if (!it.land) return undefined;
  return it.at - it.start > 1e-3
    ? `Notes arrive on the marker; the glide starts at ${spokenTime(it.start)}`
    : 'Notes arrive on the marker';
}

/**
 * The lane item's tooltip: its name (dots show it only on hover, focus or selection), where its notes arrive when it lands at the marker, its part, then the no-effect
 * reason; undefined when none.
 */
function itemTitle(
  name: string | undefined,
  part: string | undefined,
  reason: string | undefined,
  land?: string,
): string | undefined {
  const lines = [
    name ?? '',
    land ?? '',
    part !== undefined ? `Part: ${part}` : '',
    reason ?? '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function itemLabel(it: LaneItem): string {
  const kind = it.text === it.type ? it.type : `${it.text} (${it.type})`;
  const long = it.end - it.start;
  const span =
    long <= 1e-3
      ? ''
      : it.land
        ? `, ${spokenTime(long)} glide, arriving at the marker`
        : `, ${spokenTime(long)} long`;
  const notes =
    it.art?.kind === 'tune'
      ? `, ${it.art.notes.length} notes`
      : it.art?.kind === 'progression'
        ? `, chords ${it.art.chords.map((c) => c.name).join(', ')}`
        : '';
  return `${kind} at ${spokenTime(it.at)}${span}${notes}${it.muted ? ', muted' : ''}`;
}

/** The moment lane. Rendered only in the wide (editor) layout. */
export function Lane() {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const selection = useEditor((s) => s.selection);
  const noEffect = useMemo(() => noEffectReasons(compiled), [compiled]);
  const partOfMoment = useMemo(() => momentParts(piece), [piece]);
  const items = useMemo(
    () =>
      laneItems(
        piece,
        compiled.momentSpans,
        sourceAt.get(compiled),
        compiled.harmony,
        compiled.voices,
        compiled.keys,
      ),
    [piece, compiled],
  );
  const rowsView = useMemo(() => rowsOf(piece, compiled), [piece, compiled]);
  const blocks = useMemo(() => new Map(laneBlocks(rowsView).map((b) => [b.id, b])), [rowsView]);
  const curve = useMemo(() => levelCurve(compiled), [compiled]);
  const ctl = useMemo(() => new LaneController(), []);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<MomentId | null>(null);
  const pieceKeyEl = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const keyText = keyName(piece.key);

  useLayoutEffect(() => ctl.setItems(items, rowsView, curve));
  useEffect(
    () =>
      scroller.current && track.current && inner.current
        ? ctl.attach(
            scroller.current,
            track.current,
            inner.current,
            ghost.current,
            divider.current,
            marqueeRef.current,
            rowsRef.current,
            pieceKeyEl.current,
          )
        : undefined,
    [ctl],
  );

  const selected = useMemo(() => new Set(selection), [selection]);
  const byTime = useMemo(
    () => items.map((it, i) => ({ it, i })).sort((a, b) => a.it.at - b.it.at || a.i - b.i),
    [items],
  );
  const tabId =
    focusId && items.some((it) => it.id === focusId)
      ? focusId
      : (selection.find((id) => items.some((it) => it.id === id)) ?? byTime[0]?.it.id ?? null);

  const focusItem = (id: MomentId | undefined): void => {
    if (!id) return;
    setFocusId(id);
    ctl.els.get(id)?.focus({ preventScroll: true });
  };

  /** Keys on the piece key at 0:00: Enter selects; it can't be nudged or deleted. */
  const onPieceKeyKey = (e: React.KeyboardEvent<HTMLElement>): void => {
    let handled = true;
    switch (e.key) {
      case 'Enter':
        if (e.shiftKey) {
          select(
            selected.has(PIECE_KEY_ID)
              ? selection.filter((x) => x !== PIECE_KEY_ID)
              : [...selection, PIECE_KEY_ID],
          );
        } else {
          select([PIECE_KEY_ID]);
        }
        break;
      case 'Delete':
      case 'Backspace':
        ctl.announce("The piece's key can't be deleted");
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        ctl.announce("The piece's key stays at 0:00");
        break;
      case 'ArrowDown':
      case 'Home':
        focusItem(byTime[0]?.it.id);
        break;
      case 'End':
        focusItem(byTime.at(-1)?.it.id);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.metaKey || e.ctrlKey) return;
    if ((e.target as Element).closest('[data-piece-key]')) {
      if (!ctl.drag) onPieceKeyKey(e);
      return;
    }
    const el = (e.target as Element).closest<HTMLElement>('[data-moment]');
    if (!el || ctl.drag) return;
    const id = el.dataset.moment as MomentId;
    const p = pieceNow();
    const m = momentOf(p, id);
    if (!m) return;
    const ids = selected.has(id) ? selection : [id];
    const pos = byTime.findIndex((x) => x.it.id === id);
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (e.altKey) {
          handled = false;
          break;
        }
        const dt = nudgeDt(m.at, e.key === 'ArrowLeft' ? -1 : 1, gridStep(p.view.gridBpm));
        if (dt !== 0 && moveMoments(ids, dt)) {
          const after = momentOf(pieceNow(), id);
          const more = ids.length > 1 ? ` and ${ids.length - 1} more` : '';
          if (after) ctl.announce(`Moved ${nameOf(after)}${more} to ${spokenTime(after.at)}`);
        }
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const next = byTime[pos + (e.key === 'ArrowUp' ? -1 : 1)]?.it.id;
        if (next) focusItem(next);
        else if (e.key === 'ArrowUp') pieceKeyEl.current?.focus({ preventScroll: true });
        break;
      }
      case 'Home':
        pieceKeyEl.current?.focus({ preventScroll: true });
        break;
      case 'End':
        focusItem(byTime.at(-1)?.it.id);
        break;
      case 'Delete':
      case 'Backspace': {
        const gone = new Set(ids);
        const next =
          byTime.slice(pos + 1).find((x) => !gone.has(x.it.id)) ??
          byTime
            .slice(0, pos)
            .reverse()
            .find((x) => !gone.has(x.it.id));
        if (deleteMoments(ids)) {
          const more = ids.length > 1 ? ` and ${ids.length - 1} more` : '';
          ctl.announce(`Deleted ${nameOf(m)}${more}`);
          if (next) focusItem(next.it.id);
          else setFocusId(null);
        }
        break;
      }
      case 'Enter':
        if (e.shiftKey) {
          select(selected.has(id) ? selection.filter((x) => x !== id) : [...selection, id]);
        } else {
          select([id]);
          auditionMoment(id);
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="slot lane" data-slot="lane" data-testid="lane">
      <div
        ref={divider}
        className="lane-divider"
        data-testid="lane-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Score and lanes divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-describedby="lane-divider-help"
        title="Drag to resize the score and the lanes; double-click to reset"
        tabIndex={0}
      />
      <p id="lane-divider-help" className="visually-hidden">
        Up and down arrows resize the lanes, Enter resets.
      </p>
      <div ref={scroller} className="lane-scroll" data-testid="lane-scroll">
        <div
          ref={track}
          className="lane-track"
          role="group"
          aria-label="Moments"
          aria-describedby="lane-help"
          onKeyDown={onKeyDown}
        >
          <div ref={rowsRef} className="lane-rows" />
          <div
            ref={marqueeRef}
            className="lane-marquee"
            data-testid="lane-marquee"
            aria-hidden="true"
            hidden
          />
          <div ref={inner} className="lane-inner">
            <svg
              className="lane-level"
              data-testid="lane-level"
              height={LEVEL_H}
              aria-hidden="true"
            >
              <polygon className="lane-level-fill" />
              <polyline className="lane-level-line" />
            </svg>
            <div
              ref={pieceKeyEl}
              className="lane-item lane-piece-key"
              data-piece-key=""
              data-type="key"
              data-row="key"
              data-testid="lane-piece-key"
              data-selected={selected.has(PIECE_KEY_ID) || undefined}
              title="The piece's key: edit it in the inspector. It stays at 0:00."
              role="button"
              aria-pressed={selected.has(PIECE_KEY_ID)}
              aria-label={`Piece key ${keyText} at 0 s, fixed`}
              tabIndex={0}
            >
              <span className="lane-band" />
              <span className="lane-marker" />
              <span className="lane-text">
                <span className="lane-label">{keyText}</span>
              </span>
            </div>
            <div
              ref={ghost}
              className="lane-item lane-ghost"
              data-testid="lane-ghost"
              aria-hidden="true"
              hidden
            >
              <span className="lane-band">
                <span className="lane-art" aria-hidden="true" />
              </span>
              <span className="lane-bar">
                <span className="lane-art" aria-hidden="true" />
              </span>
              <span className="lane-marker" />
              <span className="lane-text">
                <span className="lane-label" />
                <span className="lane-detail" />
              </span>
            </div>
            {items.map((it) => {
              const b = blocks.get(it.id);
              const dot = isDot(it.type);
              return (
                <div
                  key={it.id}
                  ref={(el) => {
                    if (el) ctl.els.set(it.id, el);
                    else ctl.forget(it.id);
                  }}
                  className="lane-item"
                  data-moment={it.id}
                  data-type={it.type}
                  data-row={b?.row ?? 'chords'}
                  data-part={b?.part}
                  data-dot={dot || undefined}
                  data-selected={selected.has(it.id) || undefined}
                  data-muted={it.muted || undefined}
                  data-land={it.land || undefined}
                  data-no-effect={noEffect.has(it.id) || undefined}
                  title={itemTitle(
                    dot ? it.text : undefined,
                    partOfMoment.get(it.id),
                    noEffect.get(it.id),
                    landText(it),
                  )}
                  role="button"
                  aria-pressed={selected.has(it.id)}
                  aria-label={itemLabel(it) + (noEffect.has(it.id) ? ', no effect' : '')}
                  tabIndex={it.id === tabId ? 0 : -1}
                  onFocus={() => {
                    setFocusId(it.id);
                    ctl.reveal(it.id);
                  }}
                >
                  <span className="lane-band">
                    <BandArt block={b} id={it.id} />
                  </span>
                  <span className="lane-bar">
                    <BarArt art={it.art} />
                    {it.endEdit !== 'none' && <span className="lane-end" data-end-handle="" />}
                  </span>
                  <span className="lane-marker" />
                  <span className="lane-text">
                    <span className="lane-label">{dot ? it.text : (b?.label ?? it.text)}</span>
                    {b?.detail && <span className="lane-detail">{b.detail}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p id="lane-help" className="visually-hidden">
        Left and right arrows nudge the moment, up and down move between moments, Delete removes it,
        Enter selects it, Shift+Enter adds it to the selection. On a selected moment these act on
        the whole selection. Command or Control with C, X and V copy, cut and paste at the playhead;
        with A, select all. Shift-drag on the lane selects the moments it touches.
      </p>
      <div className="visually-hidden" aria-live="polite" data-testid="lane-live" />
    </div>
  );
}
