import { useEffect, useRef } from 'react';
import { xToTime, type View } from '../../render';
import { onScoreFrame } from '../loop';
import { beatPx, rulerLabel, rulerStep, tickTimes } from '../ruler';
import { camera, scrubEnd, scrubTo, usePlayer } from '../store';

/**
 * The time ruler above the score (PLAN.md §11.2 "Time" row): labelled ticks, and the BPM grid when
 * the piece has one, on the shared axis (§10). Click or drag seeks (silent while dragging, like the
 * player's scrubber); the view holds still during the drag. Placed every frame from the loop's
 * camera (`onScoreFrame`) by direct DOM writes; its content box lines up with the score canvas.
 */
export function Ruler() {
  const root = useRef<HTMLDivElement>(null);
  const ticks = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const duration = usePlayer((s) => s.compiled.duration);

  useEffect(() => {
    const el = root.current;
    const box = ticks.current;
    const beats = grid.current;
    if (!el || !box || !beats) return;
    const pool: HTMLSpanElement[] = [];
    let view: View | null = null;
    let lastKey = '';
    let lastBeat = '';
    let lastNow = -1;

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
        const bpm = usePlayer.getState().piece.view.gridBpm;
        const px = beatPx(bpm, v.pps);
        const offset = px === null || !bpm ? 0 : -((v.start % (60 / bpm)) * v.pps);
        const beat = px === null ? '' : `${px}|${offset}`;
        if (beat !== lastBeat) {
          lastBeat = beat;
          beats.hidden = px === null;
          if (px !== null) {
            beats.style.backgroundSize = `${px}px 100%`;
            beats.style.backgroundPositionX = `${offset}px`;
          }
        }
      }
      const now = Math.round(v.t);
      if (now !== lastNow) {
        lastNow = now;
        el.setAttribute('aria-valuenow', String(now));
        el.setAttribute('aria-valuetext', rulerLabel(v.t, 1));
      }
    };
    const off = onScoreFrame(layout);

    let dragging: number | null = null;
    const timeAt = (clientX: number): number | null => {
      if (!view) return null;
      return xToTime(view, clientX - box.getBoundingClientRect().left);
    };
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || dragging !== null) return;
      const t = timeAt(e.clientX);
      if (t === null) return;
      e.preventDefault();
      dragging = e.pointerId;
      el.setPointerCapture?.(e.pointerId);
      camera.hold = true;
      camera.release = false;
      scrubTo(t);
    };
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== dragging) return;
      const t = timeAt(e.clientX);
      if (t !== null) scrubTo(t);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== dragging) return;
      dragging = null;
      scrubEnd();
      camera.release = true;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    return () => {
      off();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
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
      aria-label="Position in the piece (click or drag to seek; arrow keys step)"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
    >
      <div ref={grid} className="ruler-grid" hidden />
      <div ref={ticks} className="ruler-ticks" />
    </div>
  );
}
