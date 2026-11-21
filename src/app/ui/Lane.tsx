/**
 * The lane rows under the score (PLAN.md §11.2, §11.3, §11.3a, §11.5), on the score's time axis
 * at every frame: **Moments** (marker and name) and **Transitions** (each moment's compiled span
 * as a bar; walks striped), both stacked in sub-rows so overlapping moments never share one
 * (revision 7; the lane grows to fit) and **Level** (the mean level curve). One DOM
 * item per moment holds its marker and its bar, so selection, focus and drags act on both.
 *
 * React renders the items (on piece, score or selection changes only). Positions are written
 * directly: the loop's per-frame camera (`onScoreFrame`) translates one inner container, and item
 * offsets (time × pixels-per-second) and row packing are rewritten only when the zoom or the items
 * change. Drags write transforms at once and commit the piece once per animation frame through
 * an editor gesture (one undo entry per drag; Escape cancels).
 *
 * Pointer: click selects, Shift-click toggles, a click on empty lane clears and a drag there pans
 * (Follow turns off during playback); drag an item to move it (snapping
 * to the BPM grid unless Alt is held); Alt at press duplicates; dragging a span end changes the
 * glide length (Shift: stagger; a walk's end, a level ramp's length). Keys on a focused item:
 * ←/→ nudge, ↑/↓/Home/End move focus, Delete/Backspace delete, Enter selects (Space plays and pauses). Focusing an
 * off-screen item pans the paused view to it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompiledScore, Moment, MomentId, Piece, Seconds } from '../../core/types';
import type { View } from '../../render';
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
  dragDt,
  endDragPatch,
  gridStep,
  laneItems,
  levelCurve,
  nudgeDt,
  revealPan,
  stackRows,
  spokenTime,
  type LaneItem,
  type LevelPoint,
} from '../editor/lane';
import { copyMoments, moveMomentsBy, newMomentIds, patchMoment } from '../editor/ops';
import { changePoints, ofMoments, snapTime, type SnapSet } from '../editor/snap';
import { onScoreFrame } from '../loop';
import { attachPaletteDrop } from '../palette-drop';
import { panBy, usePlayer } from '../store';
import './lane.css';

/**
 * Row geometry (px; lane.css reads `--mom-h` and `--trans-h`). Moments and Transitions each hold
 * `n` sub-rows (revision 7 stacking, at least MIN_SUBROWS): a marker and name per Moments sub-row,
 * a bar per Transitions sub-row; a moment uses the same sub-row index in both.
 */
const MIN_SUBROWS = 2;
const ROW_H = 20;
const MOM_TOP = 2;
const BAR_H = 14;
/** Moments row height, Transitions row height and the first bar's top for `n` sub-rows. */
const momH = (n: number): number => n * ROW_H + 4;
const transH = (n: number): number => n * BAR_H + 4;
const transTop = (n: number): number => momH(n) + 2;
/** Level: the curve's box. */
const LEVEL_H = 28;
const LEVEL_PAD = 3;
/** Half the marker's width: an item's box starts this far left of its time. */
const MARKER_HALF = 5;
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

/** A press on the lane background: a click clears the selection, a drag pans. */
interface Pan {
  pointerId: number;
  x0: number;
  lastX: number;
  shift: boolean;
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
  /** Times of the dragged moments, and the span end of an end drag, at drag start. */
  origAt: Map<MomentId, Seconds>;
  origEnd: Seconds;
  /** Snap targets, taken at the first preview. */
  snaps?: SnapSet;
}

/** The imperative half of the lane: element registry, layout and pointer drags. */
class LaneController {
  track: HTMLElement | null = null;
  inner: HTMLElement | null = null;
  liveRegion: HTMLElement | null = null;
  levelLine: SVGPolylineElement | null = null;
  levelFill: SVGPolygonElement | null = null;
  levelSvg: SVGSVGElement | null = null;
  items: LaneItem[] = [];
  curve: LevelPoint[] = [];
  readonly els = new Map<MomentId, HTMLElement>();
  private view: View | null = null;
  private offset = NaN;
  private pps = NaN;
  private dirty = true;
  /** x of the score canvas's left edge relative to the track's padding box (0 when aligned). */
  private axisLeft = 0;
  private rowOf = new Map<MomentId, number>();
  /** Sub-rows shown (≥ MIN_SUBROWS; 0 until the first layout). */
  private subRows = 0;
  /** Preview times of moved items, and the preview end of an end drag. */
  private previewAt = new Map<MomentId, Seconds>();
  private previewEnd: { id: MomentId; end: Seconds } | null = null;
  drag: Drag | null = null;
  private pan: Pan | null = null;
  private raf = 0;
  private flip = false;

  setItems(items: LaneItem[], curve: LevelPoint[]): void {
    this.items = items;
    this.curve = curve;
    this.invalidate();
  }

  /** Re-measures the score canvas's left edge against the track (on resize). */
  measure = (): void => {
    const track = this.track;
    const canvas = document.getElementById('score');
    if (!track || !canvas) return;
    const a = canvas.getBoundingClientRect().left + canvas.clientLeft;
    const b = track.getBoundingClientRect().left + track.clientLeft;
    const left = Math.round((a - b) * 100) / 100;
    if (left !== this.axisLeft) {
      this.axisLeft = left;
      this.offset = NaN;
      if (this.view) this.layout(this.view);
    }
  };

  invalidate(): void {
    this.dirty = true;
    if (this.view) this.layout(this.view);
  }

  /** Per-frame: translate the container; re-place items when the zoom or items changed. */
  layout(view: View): void {
    this.view = view;
    const inner = this.inner;
    if (!inner || !(view.pps > 0)) return;
    const offset = this.axisLeft - view.start * view.pps;
    if (offset !== this.offset) {
      this.offset = offset;
      inner.style.transform = `translateX(${offset.toFixed(2)}px)`;
    }
    if (!this.dirty && view.pps === this.pps) return;
    this.dirty = false;
    this.pps = view.pps;
    const pps = view.pps;
    if (!this.drag?.started) {
      const { rows, count } = stackRows(this.items, pps);
      this.rowOf = new Map(this.items.map((it, i) => [it.id, rows[i]]));
      this.setSubRows(Math.max(MIN_SUBROWS, count));
    }
    for (const it of this.items) this.place(it, pps);
    this.placeLevel(pps);
  }

  /** Grows or shrinks the Moments and Transitions rows to `n` sub-rows. */
  private setSubRows(n: number): void {
    const track = this.track;
    if (n === this.subRows || !track) return;
    this.subRows = n;
    track.style.setProperty('--mom-h', `${momH(n)}px`);
    track.style.setProperty('--trans-h', `${transH(n)}px`);
    track.dataset.subrows = String(n);
  }

  /** The level curve in seconds × pps; full height is the larger of 1.2 (headroom) and the peak. */
  private placeLevel(pps: number): void {
    const { levelLine, levelFill, levelSvg } = this;
    if (!levelLine || !levelFill || !levelSvg) return;
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

  private place(it: LaneItem, pps: number): void {
    const el = this.els.get(it.id);
    if (!el) return;
    const at = this.previewAt.get(it.id) ?? it.at;
    const row = this.rowOf.get(it.id) ?? this.rowOfCopy(it.id, this.rowOf);
    const y = MOM_TOP + row * ROW_H;
    el.style.transform = `translate(${(at * pps).toFixed(2)}px, ${y}px)`;
    const bar = el.firstElementChild as HTMLElement | null;
    if (!bar) return;
    const end = this.previewEnd?.id === it.id ? Math.max(it.start, this.previewEnd.end) : it.end;
    const w = Math.max(0, (end - it.start) * pps);
    bar.style.left = `${(MARKER_HALF + (it.start - it.at) * pps).toFixed(2)}px`;
    bar.style.top = `${transTop(Math.max(MIN_SUBROWS, this.subRows)) + row * BAR_H - y}px`;
    bar.style.width = `${w.toFixed(2)}px`;
    const handle = it.endEdit !== 'none' && w >= MIN_HANDLE_BAR;
    if (el.dataset.handle !== String(handle)) el.dataset.handle = String(handle);
  }

  /** A copy made mid-drag sits on its original's rows. */
  private rowOfCopy(id: MomentId, rows: Map<MomentId, number>): number {
    const d = this.drag;
    const i = d ? d.newIds.indexOf(id) : -1;
    return i >= 0 && d ? (rows.get(d.ids[i]) ?? 0) : 0;
  }

  /** Pans the (paused) view so item `id` is visible: Tab focus onto an off-screen item. */
  reveal(id: MomentId): void {
    const it = this.items.find((x) => x.id === id);
    const width = this.track?.clientWidth ?? 0;
    if (!it || !this.view || this.drag || !(this.pps > 0)) return;
    const x = (this.previewAt.get(id) ?? it.at) * this.pps + this.offset;
    const dt = revealPan(x, width, this.pps, REVEAL_MARGIN);
    if (dt !== 0) panBy(dt);
  }

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
    if (this.drag || this.pan || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target instanceof Element ? e.target : null;
    const itemEl = target?.closest<HTMLElement>('[data-moment]');
    if (!itemEl) {
      this.track?.setPointerCapture(e.pointerId);
      this.pan = {
        pointerId: e.pointerId,
        x0: e.clientX,
        lastX: e.clientX,
        shift: e.shiftKey,
        started: false,
      };
      return;
    }
    const id = itemEl.dataset.moment as MomentId;
    const onHandle = !!target?.closest('[data-end-handle]');
    const sel = useEditor.getState().selection;
    const wasSelected = sel.includes(id);
    if (!wasSelected && !e.shiftKey) select([id]);
    this.track?.setPointerCapture(e.pointerId);
    this.drag = {
      pointerId: e.pointerId,
      kind: onHandle ? 'end' : 'move',
      id,
      x0: e.clientX,
      t0: this.timeAt(e.clientX),
      dup: !onHandle && e.altKey,
      shift: e.shiftKey,
      started: false,
      ids: [],
      newIds: [],
      dt: 0,
      raw: 0,
      alt: e.altKey,
      wasSelected,
      origAt: new Map(),
      origEnd: 0,
    };
  };

  /** Background drag: the content follows the pointer. */
  private onPanMove(e: PointerEvent, p: Pan): void {
    if (!p.started) {
      if (Math.abs(e.clientX - p.x0) <= DRAG_SLOP) return;
      p.started = true;
      this.track?.classList.add('panning');
    }
    const dx = e.clientX - p.lastX;
    p.lastX = e.clientX;
    if (dx !== 0 && this.pps > 0) panBy(-dx / this.pps);
  }

  private endPan(e: PointerEvent, p: Pan): void {
    this.pan = null;
    this.track?.classList.remove('panning');
    if (this.track?.hasPointerCapture(p.pointerId)) this.track.releasePointerCapture(p.pointerId);
    if (!p.started && e.type !== 'pointercancel' && !p.shift) select([]);
  }

  onMove = (e: PointerEvent): void => {
    const p = this.pan;
    if (p && e.pointerId === p.pointerId) {
      this.onPanMove(e, p);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.started) {
      if (Math.abs(e.clientX - d.x0) <= DRAG_SLOP) return;
      this.start(d);
    }
    d.raw = this.timeAt(e.clientX) - d.t0;
    d.alt = e.altKey;
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
      d.origEnd = this.items.find((x) => x.id === d.id)?.end ?? 0;
      beginGesture(d.shift ? 'Change stagger' : 'Change glide length');
      return;
    }
    // A plain or Shift press on a selected item drags the whole selection.
    if (d.shift && !d.wasSelected) select([...useEditor.getState().selection, d.id]);
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
      d.dt = d.raw;
      this.previewEnd = { id: d.id, end: d.origEnd + d.raw };
      const it = this.items.find((x) => x.id === d.id);
      if (it && this.view) this.place(it, this.view.pps);
      return;
    }
    const primary = d.origAt.get(d.id);
    if (primary === undefined) return;
    // Revision 7: snaps to note changes (not the bar grid), outside the dragged moments.
    const st = usePlayer.getState();
    d.snaps ??= { points: changePoints(st.compiled, st.piece), exclude: ofMoments(d.ids) };
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
      if (d.shift) {
        select(d.wasSelected ? sel.filter((x) => x !== d.id) : [...sel, d.id]);
      } else {
        select([d.id]);
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
    } else if (m.type === 'walk') {
      this.announce(`${name} ends at ${spokenTime(m.until)}`);
    } else if (m.type === 'level') {
      this.announce(`${name} ramp ${spokenTime(m.over)}`);
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

  attach(track: HTMLElement, inner: HTMLElement): () => void {
    this.inner = inner;
    this.track = track;
    this.liveRegion = track.parentElement?.querySelector<HTMLElement>('[aria-live]') ?? null;
    this.levelSvg = inner.querySelector<SVGSVGElement>('.lane-level');
    this.levelLine = inner.querySelector<SVGPolylineElement>('.lane-level-line');
    this.levelFill = inner.querySelector<SVGPolygonElement>('.lane-level-fill');
    track.addEventListener('pointerdown', this.onDown);
    track.addEventListener('pointermove', this.onMove);
    track.addEventListener('pointerup', this.onUp);
    track.addEventListener('pointercancel', this.onUp);
    const off = onScoreFrame((v) => this.layout(v));
    const offDrop = attachPaletteDrop(track);
    const ro = new ResizeObserver(this.measure);
    ro.observe(track);
    const canvas = document.getElementById('score');
    if (canvas) ro.observe(canvas);
    this.measure();
    return () => {
      this.cancel();
      off();
      offDrop();
      ro.disconnect();
      track.removeEventListener('pointerdown', this.onDown);
      track.removeEventListener('pointermove', this.onMove);
      track.removeEventListener('pointerup', this.onUp);
      track.removeEventListener('pointercancel', this.onUp);
      this.track = null;
    };
  }
}

/** A span's length as shown on its bar. */
function barText(it: LaneItem): string {
  const len = it.end - it.start;
  return len > 1e-3 ? `${len.toFixed(1)} s` : '';
}

/** Moments with a `no-effect` diagnostic (revision 6) and its message. */
function noEffectReasons(compiled: CompiledScore): Map<MomentId, string> {
  const out = new Map<MomentId, string>();
  for (const d of compiled.diagnostics) {
    if (d.code === 'no-effect' && d.momentId !== undefined) out.set(d.momentId, d.message);
  }
  return out;
}

function itemLabel(it: LaneItem): string {
  const kind = it.text === it.type ? it.type : `${it.text} (${it.type})`;
  const span = it.end - it.at > 1e-3 ? `, ${spokenTime(it.end - it.at)} long` : '';
  return `${kind} at ${spokenTime(it.at)}${span}${it.muted ? ', muted' : ''}`;
}

/** The moment lane. Rendered only in the wide (editor) layout. */
export function Lane() {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const selection = useEditor((s) => s.selection);
  const noEffect = useMemo(() => noEffectReasons(compiled), [compiled]);
  const items = useMemo(
    () => laneItems(piece, compiled.momentSpans, sourceAt.get(compiled), compiled.harmony),
    [piece, compiled],
  );
  const curve = useMemo(() => levelCurve(compiled), [compiled]);
  const ctl = useMemo(() => new LaneController(), []);
  const track = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<MomentId | null>(null);

  useLayoutEffect(() => ctl.setItems(items, curve));
  useEffect(
    () => (track.current && inner.current ? ctl.attach(track.current, inner.current) : undefined),
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.metaKey || e.ctrlKey) return;
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
      case 'ArrowDown':
        focusItem(byTime[pos + (e.key === 'ArrowUp' ? -1 : 1)]?.it.id);
        break;
      case 'Home':
        focusItem(byTime[0]?.it.id);
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
        ref={track}
        className="lane-track"
        role="group"
        aria-label="Moments"
        aria-describedby="lane-help"
        onKeyDown={onKeyDown}
      >
        <div className="lane-row" data-row="moments" aria-hidden="true">
          <span className="lane-row-name">Moments</span>
        </div>
        <div className="lane-row" data-row="transitions" aria-hidden="true">
          <span className="lane-row-name">Transitions</span>
        </div>
        <div className="lane-row" data-row="level" aria-hidden="true">
          <span className="lane-row-name">Level</span>
        </div>
        <div ref={inner} className="lane-inner">
          <svg className="lane-level" data-testid="lane-level" height={LEVEL_H} aria-hidden="true">
            <polygon className="lane-level-fill" />
            <polyline className="lane-level-line" />
          </svg>
          {items.map((it) => (
            <div
              key={it.id}
              ref={(el) => {
                if (el) ctl.els.set(it.id, el);
                else ctl.els.delete(it.id);
              }}
              className="lane-item"
              data-moment={it.id}
              data-type={it.type}
              data-selected={selected.has(it.id) || undefined}
              data-muted={it.muted || undefined}
              data-no-effect={noEffect.has(it.id) || undefined}
              title={noEffect.get(it.id)}
              role="button"
              aria-pressed={selected.has(it.id)}
              aria-label={itemLabel(it) + (noEffect.has(it.id) ? ', no effect' : '')}
              tabIndex={it.id === tabId ? 0 : -1}
              onFocus={() => {
                setFocusId(it.id);
                ctl.reveal(it.id);
              }}
            >
              <span className="lane-bar">
                <span className="lane-bar-text">{barText(it)}</span>
                {it.endEdit !== 'none' && <span className="lane-end" data-end-handle="" />}
              </span>
              <span className="lane-marker" />
              <span className="lane-label">{it.text}</span>
            </div>
          ))}
        </div>
      </div>
      <p id="lane-help" className="visually-hidden">
        Left and right arrows nudge the moment, up and down move between moments, Delete removes it,
        Enter selects it.
      </p>
      <div className="visually-hidden" aria-live="polite" data-testid="lane-live" />
    </div>
  );
}
