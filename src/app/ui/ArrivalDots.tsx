/**
 * Editor overlay (§11.3 "Every dot is draggable", revision 6): arrival dots on the score.
 * - The selected moment's dots: a chord's notes at its span end, a walk's steps, a note's `to`,
 *   any other moment's landings (./editor/arrival-points).
 * - Hover: with the mouse near another moment's arrival, that moment's dots (a walk: the near
 *   steps), from a fixed pool of buttons written per frame, so no React render on pointer moves.
 * Dragging any dot vertically changes that note (`dragArrival`: snapped to the key, Shift =
 * chromatic, one undo entry). A click without a drag selects the walk step, or the hovered moment.
 * DOM buttons positioned per score frame; the inspector is the keyboard path, so not tab stops.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { keyAt } from '../../core/query';
import type { CompiledScore, Piece } from '../../core/types';
import { pitchToY, timeToX, xToTime, yToPitch, type View } from '../../render';
import { dragArrival } from '../editor/actions';
import { allArrivals, hoverPick, momentArrivals, type ArrivalDot } from '../editor/arrival-points';
import { dragPitch } from '../editor/chord-notes';
import { select, useEditor } from '../editor/history';
import { selectStep, useStepSelection } from '../editor/step-selection';
import { sameStep } from '../editor/walk-steps';
import { hoverPointer } from '../hover';
import { onScoreFrame } from '../loop';
import { usePlayer } from '../store';
import { useChordNotes } from './inspector/ChordNotes';
import './walk-dots.css';

const MARGIN = 8;
/** Hover reach around a dot, CSS px. */
const HOVER_PX = 12;
/** Most hover dots shown at once. */
const HOVER_MAX = 16;
/** Pointer travel (px) before a press on a dot becomes a drag. */
const SLOP = 3;

const TEST_IDS: Record<string, [box: string, dot: string]> = {
  walk: ['walk-dots', 'walk-dot'],
  chord: ['chord-dots', 'chord-dot'],
  note: ['note-dots', 'note-dot'],
};

function place(el: HTMLElement, v: View, d: ArrivalDot): void {
  const x = (d.t - v.start) * v.pps;
  const show = x >= -MARGIN && x <= v.width + MARGIN;
  const tf = show ? `translate(${x.toFixed(1)}px, ${pitchToY(v, d.pitch).toFixed(1)}px)` : '';
  if (el.style.transform !== tf) el.style.transform = tf;
  if (el.hidden === show) el.hidden = !show;
}

/** Hover index, rebuilt when the compiled score changes. */
let index: { score: CompiledScore; piece: Piece; dots: ArrivalDot[] } | null = null;
function arrivalsOf(score: CompiledScore): ArrivalDot[] {
  const piece = usePlayer.getState().piece;
  if (index?.score !== score || index.piece !== piece) {
    index = { score, piece, dots: allArrivals(piece, score) };
  }
  return index.dots;
}

export function ArrivalDots() {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const selectedStep = useStepSelection((s) => s.step);
  const moment = useMemo(() => {
    if (selection.length !== 1) return null;
    return piece.moments.find((x) => x.id === selection[0]) ?? null;
  }, [selection, piece]);
  const chordNotes = useChordNotes(moment?.type === 'chord' ? moment : null);
  const dots = useMemo(
    () => (moment ? momentArrivals(compiled, moment, chordNotes) : []),
    [moment, compiled, chordNotes],
  );

  const box = useRef<HTMLDivElement>(null);
  const els = useRef<(HTMLButtonElement | null)[]>([]);
  const hoverEls = useRef<(HTMLButtonElement | null)[]>([]);
  const view = useRef<View | null>(null);
  const geo = useRef<ArrivalDot[]>([]);
  const selectedId = useRef<string | null>(null);
  const hover = useRef<{ dots: ArrivalDot[]; key: string; held: boolean; dragging: boolean }>({
    dots: [],
    key: '',
    held: false,
    dragging: false,
  });
  useLayoutEffect(() => {
    geo.current = dots;
    selectedId.current = moment?.id ?? null;
  }, [dots, moment]);

  useEffect(
    () =>
      onScoreFrame((v, score) => {
        view.current = v;
        const g = geo.current;
        for (let i = 0; i < g.length; i++) {
          const el = els.current[i];
          if (el) place(el, v, g[i]);
        }
        // Hover: re-picked when the pointer, the camera or the score changed; held while the
        // pointer is on a hover dot (the canvas then reports a leave) or a drag runs.
        const h = hover.current;
        if (!h.held && !h.dragging) {
          const key = `${hoverPointer.version}|${v.start}|${v.pps}|${v.pLo}|${v.pHi}|${v.height}`;
          if (key !== h.key || index?.score !== score) {
            h.key = key;
            const on = hoverPointer.on && box.current?.closest('[data-layout="full"]') !== null;
            h.dots = on
              ? hoverPick(
                  arrivalsOf(score),
                  { x: (t) => timeToX(v, t), y: (p) => pitchToY(v, p), t: (x) => xToTime(v, x) },
                  hoverPointer.x,
                  hoverPointer.y,
                  HOVER_PX,
                  selectedId.current,
                  HOVER_MAX,
                )
              : [];
          }
        }
        for (let i = 0; i < HOVER_MAX; i++) {
          const el = hoverEls.current[i];
          if (!el) continue;
          const d = h.dots[i];
          if (!d) {
            if (!el.hidden) el.hidden = true;
            continue;
          }
          el.dataset.moment = d.momentId;
          el.dataset.type = d.type;
          el.dataset.pitch = String(d.pitch);
          place(el, v, d);
        }
      }),
    [],
  );

  /** A press on a dot: past the slop, a pitch drag; otherwise a click (`onClick`). */
  const press = (
    e: React.PointerEvent<HTMLButtonElement>,
    dot: ArrivalDot,
    onClick?: () => void,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const key = keyAt(usePlayer.getState().compiled, dot.t);
    const h = hover.current;
    let drag: ReturnType<typeof dragArrival> | undefined;
    let last = dot.pitch;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (drag === undefined) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) <= SLOP) return;
        h.dragging = true;
        drag = dragArrival(dot);
      }
      const v = view.current;
      const rect = box.current?.getBoundingClientRect();
      if (!drag || !v || !rect) return;
      const p = dragPitch(yToPitch(v, ev.clientY - rect.top), key, ev.shiftKey);
      if (p === last) return;
      last = p;
      drag.to(p);
    };
    const done = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      h.dragging = false;
      h.held = false;
      h.key = '';
      if (drag) drag.end(ev.type === 'pointercancel');
      else if (drag === undefined && ev.type === 'pointerup') onClick?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };

  const ids = moment ? (TEST_IDS[moment.type] ?? ['arrival-dots', 'arrival-dot']) : null;
  return (
    <>
      {moment && ids && dots.length > 0 && (
        <div className="walk-dots" data-testid={ids[0]} aria-hidden="true">
          {dots.map((d, i) => {
            const on = d.type === 'note' || (!!d.step && sameStep(d.step, selectedStep));
            const cls = d.type === 'walk' ? 'walk-dot' : 'walk-dot chord-dot';
            return (
              <button
                key={d.step ? `${d.step.tick}:${d.step.voice}` : i}
                ref={(el) => {
                  els.current[i] = el;
                }}
                type="button"
                tabIndex={-1}
                hidden
                className={on ? `${cls} on` : cls}
                data-testid={ids[1]}
                data-index={d.type === 'chord' ? i : undefined}
                data-tick={d.step?.tick}
                data-voice={d.step?.voice}
                data-selected={d.step && on ? 'true' : undefined}
                data-t={d.t.toFixed(3)}
                data-pitch={d.pitch}
                onPointerDown={(e) => press(e, d, d.step ? () => selectStep(d.step!) : undefined)}
              />
            );
          })}
        </div>
      )}
      <div ref={box} className="walk-dots" data-testid="hover-dots" aria-hidden="true">
        {Array.from({ length: HOVER_MAX }, (_, i) => (
          <button
            key={i}
            ref={(el) => {
              hoverEls.current[i] = el;
            }}
            type="button"
            tabIndex={-1}
            hidden
            className="walk-dot chord-dot hover-dot"
            data-testid="hover-dot"
            onPointerEnter={() => {
              hover.current.held = true;
            }}
            onPointerLeave={() => {
              if (hover.current.dragging) return;
              hover.current.held = false;
              hover.current.key = '';
            }}
            onPointerDown={(e) => {
              const d = hover.current.dots[i];
              if (!d) return;
              press(e, d, () => {
                select([d.momentId]);
                if (d.step) selectStep(d.step);
              });
            }}
          />
        ))}
      </div>
    </>
  );
}
