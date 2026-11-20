/**
 * The moment lane (PLAN.md §11.2, §11.3, §11.3a, §11.5): one DOM item per moment under the score
 * view, aligned with it at every frame.
 *
 * React renders the items (on piece, score or selection changes only). Positions are written
 * directly: the loop's per-frame camera (`onScoreFrame`) translates one inner container, and item
 * offsets (time × pixels-per-second) and row packing are rewritten only when the zoom or the items
 * change. Drags write transforms at once and commit the piece once per animation frame through
 * an editor gesture (one undo entry per drag; Escape cancels).
 *
 * Pointer: click selects, Shift-click toggles, a click on empty lane clears; drag moves (snapping
 * to the BPM grid unless Alt is held); Alt at press duplicates; dragging a span end changes the
 * glide length (Shift: stagger; a walk's end, a level ramp's length). Keys on a focused item:
 * ←/→ nudge, ↑/↓/Home/End move focus, Delete/Backspace delete, Enter/Space select.
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
  nudgeDt,
  packRows,
  spokenTime,
  type LaneItem,
} from '../editor/lane';
import { copyMoments, moveMomentsBy, newMomentIds, patchMoment } from '../editor/ops';
import { onScoreFrame } from '../loop';
import { usePlayer } from '../store';
import './lane.css';

/** Rows items are packed into, and their height (px; keep in step with lane.css). */
const ROWS = 3;
const ROW_H = 20;
/** Horizontal travel (px) before a press becomes a drag. */
const DRAG_SLOP = 3;
/** Bars narrower than this (px) hide their end handle, so the marker stays clickable. */
const MIN_HANDLE_BAR = 6;

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
}

/** The imperative half of the lane: element registry, layout and pointer drags. */
class LaneController {
  track: HTMLElement | null = null;
  inner: HTMLElement | null = null;
  liveRegion: HTMLElement | null = null;
  items: LaneItem[] = [];
  readonly els = new Map<MomentId, HTMLElement>();
  private view: View | null = null;
  private offset = NaN;
  private pps = NaN;
  private dirty = true;
  private rowOf = new Map<MomentId, number>();
  /** Preview times of moved items, and the preview end of an end drag. */
  private previewAt = new Map<MomentId, Seconds>();
  private previewEnd: { id: MomentId; end: Seconds } | null = null;
  drag: Drag | null = null;
  private raf = 0;
  private flip = false;

  setItems(items: LaneItem[]): void {
    this.items = items;
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
    if (this.view) this.layout(this.view);
  }

  /** Per-frame: translate the container; re-place items when the zoom or items changed. */
  layout(view: View): void {
    this.view = view;
    const inner = this.inner;
    if (!inner || !(view.pps > 0)) return;
    const offset = view.xAnchor - view.tc * view.pps;
    if (offset !== this.offset) {
      this.offset = offset;
      inner.style.transform = `translateX(${offset.toFixed(2)}px)`;
    }
    if (!this.dirty && view.pps === this.pps) return;
    this.dirty = false;
    this.pps = view.pps;
    const pps = view.pps;
    if (!this.drag?.started) {
      const rows = packRows(this.items, pps, ROWS);
      this.rowOf = new Map(this.items.map((it, i) => [it.id, rows[i]]));
    }
    for (const it of this.items) this.place(it, pps);
  }

  private place(it: LaneItem, pps: number): void {
    const el = this.els.get(it.id);
    if (!el) return;
    const at = this.previewAt.get(it.id) ?? it.at;
    const row = this.rowOf.get(it.id) ?? this.rowOfCopy(it.id);
    el.style.transform = `translate(${(at * pps).toFixed(2)}px, ${row * ROW_H}px)`;
    const bar = el.firstElementChild as HTMLElement | null;
    if (!bar) return;
    const end = this.previewEnd?.id === it.id ? Math.max(it.start, this.previewEnd.end) : it.end;
    const w = Math.max(0, (end - it.start) * pps);
    bar.style.left = `${((it.start - it.at) * pps).toFixed(2)}px`;
    bar.style.width = `${w.toFixed(2)}px`;
    const handle = it.endEdit !== 'none' && w >= MIN_HANDLE_BAR;
    if (el.dataset.handle !== String(handle)) el.dataset.handle = String(handle);
  }

  /** A copy made mid-drag sits on its original's row. */
  private rowOfCopy(id: MomentId): number {
    const d = this.drag;
    const i = d ? d.newIds.indexOf(id) : -1;
    return i >= 0 && d ? (this.rowOf.get(d.ids[i]) ?? 0) : 0;
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
    if (this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target instanceof Element ? e.target : null;
    const itemEl = target?.closest<HTMLElement>('[data-moment]');
    if (!itemEl) {
      if (!e.shiftKey) select([]);
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

  onMove = (e: PointerEvent): void => {
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
    const step = gridStep(pieceNow().view.gridBpm);
    let dt = dragDt(primary, d.raw, step, !d.alt);
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
    track.addEventListener('pointerdown', this.onDown);
    track.addEventListener('pointermove', this.onMove);
    track.addEventListener('pointerup', this.onUp);
    track.addEventListener('pointercancel', this.onUp);
    const off = onScoreFrame((v) => this.layout(v));
    return () => {
      this.cancel();
      off();
      track.removeEventListener('pointerdown', this.onDown);
      track.removeEventListener('pointermove', this.onMove);
      track.removeEventListener('pointerup', this.onUp);
      track.removeEventListener('pointercancel', this.onUp);
      this.track = null;
    };
  }
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
  const items = useMemo(
    () => laneItems(piece, compiled.momentSpans, sourceAt.get(compiled)),
    [piece, compiled],
  );
  const ctl = useMemo(() => new LaneController(), []);
  const track = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<MomentId | null>(null);

  useLayoutEffect(() => ctl.setItems(items));
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
      case ' ':
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
        <div ref={inner} className="lane-inner">
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
              role="button"
              aria-pressed={selected.has(it.id)}
              aria-label={itemLabel(it)}
              tabIndex={it.id === tabId ? 0 : -1}
              onFocus={() => setFocusId(it.id)}
            >
              <span className="lane-bar">
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
