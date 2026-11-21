import { useEffect, useRef } from 'react';
import { barGrid, xToTime, type View } from '../../render';
import { onScoreFrame } from '../loop';
import { snapToGrid } from '../editor/shortcuts';
import { withEnd } from '../editor/end';
import { beginGesture, cancelGesture, edit, endGesture, updateGesture } from '../editor/history';
import { changePoints, snapTime, type ChangePoint } from '../editor/snap';
import {
  LOOP_BAND_PX,
  LOOP_DRAG_PX,
  dragLoopEdge,
  loopEdgeAt,
  loopFromDrag,
  rulerLabel,
  rulerStep,
  tickTimes,
  type LoopSpan,
} from '../ruler';
import { camera, loopDraft, loopRegion, scrubEnd, scrubTo, setLoop, usePlayer } from '../store';

/**
 * The time ruler above the score (PLAN.md §11.2 "Time" row): labelled ticks, and the bar grid
 * (beats faint, bars stronger; §11.3 revision 7), on the shared axis (§10). Click or drag seeks (silent while dragging, like the
 * player's scrubber); the view holds still during the drag. Its top strip is the loop band
 * (§11.3 revision 6): drag there, or Shift-drag anywhere, to set the loop region; drag a region
 * edge to move it; double-click the band to clear it (Alt skips grid snapping). The piece's end is
 * a handle (open-ended canvas, revision 7): drag it to set `end.at` (one undo entry; snaps to note
 * changes, Alt free), double-click it for the automatic end; the canvas past it is tinted. Placed every frame from the loop's
 * camera (`onScoreFrame`) by direct DOM writes; its content box lines up with the score canvas.
 */
/** Draws lines every `step` s as a repeating gradient on `el` (hidden when `step` is 0). */
function stripe(el: HTMLElement, step: number, v: View): void {
  el.hidden = !(step > 0);
  if (el.hidden) return;
  const px = step * v.pps;
  el.style.backgroundSize = `${px}px 100%`;
  el.style.backgroundPositionX = `${-((v.start % step) * v.pps)}px`;
  el.dataset.step = String(step);
}

/** How close to the piece's end a ruler press grabs the end handle, px. */
const END_GRAB_PX = 6;

export function Ruler() {
  const root = useRef<HTMLDivElement>(null);
  const ticks = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const barsEl = useRef<HTMLDivElement>(null);
  const endEl = useRef<HTMLDivElement>(null);
  const duration = usePlayer((s) => s.compiled.duration);

  useEffect(() => {
    const el = root.current;
    const box = ticks.current;
    const beats = grid.current;
    const bars = barsEl.current;
    const endMark = endEl.current;
    if (!el || !box || !beats || !bars || !endMark) return;
    const pool: HTMLSpanElement[] = [];
    let view: View | null = null;
    let lastKey = '';
    let lastBeat = '';
    let lastNow = -1;
    let lastEnd = '';

    const layout = (v: View): void => {
      view = v;
      const step = rulerStep(v.pps);
      const key = `${v.start}|${v.pps}|${v.width}`;
      if (key !== lastKey) {
        lastKey = key;
        const times = tickTimes(v.start, v.window, step);
        while (pool.length < times.length) {
          const s = document.createElement('span');
          s.className = 'ruler-tick';
          box.appendChild(s);
          pool.push(s);
        }
        for (let i = 0; i < pool.length; i++) {
          const s = pool[i]!;
          const t = times[i];
          if (t === undefined) {
            s.hidden = true;
            continue;
          }
          s.hidden = false;
          const label = rulerLabel(t, step);
          if (s.textContent !== label) s.textContent = label;
          s.dataset.t = String(t);
          s.style.transform = `translateX(${(t - v.start) * v.pps}px)`;
        }
      }
      // The bar grid also follows the piece's tempo and meter.
      const pv = usePlayer.getState().piece.view;
      const { beat: bt, bar } = barGrid(pv.gridBpm, pv.meter, v.pps);
      const beat = `${bt}|${bar}|${v.start}|${v.pps}`;
      if (beat !== lastBeat) {
        lastBeat = beat;
        stripe(beats, bt, v);
        stripe(bars, bar, v);
      }
      const st = usePlayer.getState();
      const endX = (st.compiled.duration - v.start) * v.pps;
      const auto = st.piece.end.at === undefined;
      const endKey = `${endX}|${auto}`;
      if (endKey !== lastEnd) {
        lastEnd = endKey;
        endMark.style.transform = `translateX(${endX}px)`;
        endMark.dataset.t = String(st.compiled.duration);
        endMark.dataset.auto = String(auto);
      }
      const now = Math.round(v.t);
      if (now !== lastNow) {
        lastNow = now;
        el.setAttribute('aria-valuenow', String(now));
        el.setAttribute('aria-valuetext', rulerLabel(v.t, 1));
      }
    };
    const off = onScoreFrame(layout);

    // A press seeks (silent scrub), or on the loop band / with Shift sets the loop region.
    type Drag =
      | { id: number; kind: 'seek' }
      | { id: number; kind: 'new'; t0: number; x0: number }
      | { id: number; kind: 'edge'; edge: 'start' | 'end'; span: LoopSpan }
      | { id: number; kind: 'end'; points: readonly ChangePoint[] };
    let drag: Drag | null = null;
    const timeAt = (clientX: number): number | null => {
      if (!view) return null;
      return xToTime(view, clientX - box.getBoundingClientRect().left);
    };
    const inBand = (clientY: number): boolean =>
      clientY - el.getBoundingClientRect().top - el.clientTop < LOOP_BAND_PX;
    const snapped = (t: number, e: PointerEvent): number =>
      e.altKey ? Math.max(0, t) : snapToGrid(t, usePlayer.getState().piece.view.gridBpm);
    const pieceLength = (): number => usePlayer.getState().compiled.duration;
    const edgeAt = (t: number): 'start' | 'end' | null =>
      view ? loopEdgeAt(loopRegion(), t, view.pps) : null;
    /** True when time `t` is within `END_GRAB_PX` of the piece's end. */
    const onEnd = (t: number): boolean =>
      !!view && Math.abs(t - pieceLength()) * view.pps <= END_GRAB_PX;
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || drag !== null) return;
      const t = timeAt(e.clientX);
      if (t === null) return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      camera.hold = true;
      camera.release = false;
      if (inBand(e.clientY) || e.shiftKey) {
        const r = loopRegion();
        const edge = edgeAt(t);
        if (r && edge) {
          drag = { id: e.pointerId, kind: 'edge', edge, span: { start: r.start, end: r.end } };
          loopDraft.span = drag.span;
        } else {
          drag = { id: e.pointerId, kind: 'new', t0: snapped(t, e), x0: e.clientX };
        }
        return;
      }
      if (onEnd(t)) {
        const { compiled, piece } = usePlayer.getState();
        drag = { id: e.pointerId, kind: 'end', points: changePoints(compiled, piece) };
        beginGesture('Move the end');
        return;
      }
      drag = { id: e.pointerId, kind: 'seek' };
      scrubTo(t);
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag) {
        const t = timeAt(e.clientX);
        const band = inBand(e.clientY) || e.shiftKey;
        el.dataset.hover = !band
          ? t !== null && onEnd(t)
            ? 'end'
            : ''
          : t !== null && edgeAt(t)
            ? 'edge'
            : 'band';
        return;
      }
      if (e.pointerId !== drag.id) return;
      const t = timeAt(e.clientX);
      if (t === null) return;
      if (drag.kind === 'seek') scrubTo(t);
      else if (drag.kind === 'end') {
        const at = snapTime(t, { points: drag.points }, view?.pps ?? 0, e.altKey);
        updateGesture((p) => withEnd(p, at));
      } else if (drag.kind === 'edge') {
        loopDraft.span = dragLoopEdge(drag.span, drag.edge, snapped(t, e), pieceLength());
      } else if (Math.abs(e.clientX - drag.x0) >= LOOP_DRAG_PX) {
        loopDraft.span = loopFromDrag(drag.t0, snapped(t, e), pieceLength());
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      camera.release = true;
      if (d.kind === 'seek') {
        scrubEnd();
        return;
      }
      if (d.kind === 'end') {
        if (e.type === 'pointercancel') cancelGesture();
        else endGesture();
        return;
      }
      const span = loopDraft.span;
      if (span && e.type !== 'pointercancel') setLoop(span);
      else loopDraft.span = null;
    };
    const onDouble = (e: MouseEvent): void => {
      if (inBand(e.clientY)) {
        setLoop(null);
        return;
      }
      const t = timeAt(e.clientX);
      if (t !== null && onEnd(t)) edit((p) => withEnd(p, undefined), 'Automatic end');
    };
    const onLeave = (): void => {
      if (!drag) el.dataset.hover = '';
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('dblclick', onDouble);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      off();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('dblclick', onDouble);
      el.removeEventListener('pointerleave', onLeave);
      loopDraft.span = null;
      camera.hold = camera.release = false;
    };
  }, []);

  return (
    <div
      ref={root}
      className="ruler"
      data-testid="ruler"
      role="slider"
      tabIndex={0}
      aria-label="Position in the piece (click or drag to seek; arrow keys step; drag the top strip to loop; drag the end mark to set the end)"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
    >
      <div
        className="ruler-band"
        title="Loop: drag here to set a region, drag its edges, double-click to clear"
      />
      <div ref={grid} className="ruler-grid" data-testid="ruler-beats" hidden />
      <div ref={barsEl} className="ruler-grid ruler-bars" data-testid="ruler-bars" hidden />
      <div ref={ticks} className="ruler-ticks" />
      <div ref={endEl} className="ruler-end" data-testid="ruler-end" aria-hidden="true" />
    </div>
  );
}
