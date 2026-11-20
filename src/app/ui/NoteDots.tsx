/**
 * Editor overlay (§11.3 Note points, revision 6): with one note moment selected, its dot on the
 * line where the note arrives at `to`. Dragging the dot vertically sets `to`, snapped to the key
 * (Shift: chromatic); a whole drag is one undo entry. Positioned per score frame like
 * WalkStepDots; the inspector's ▲/▼ (and the ▲/▼ keys) are the keyboard path.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { keyAt } from '../../core/query';
import type { NoteMoment } from '../../core/types';
import { pitchToY, yToPitch, type View } from '../../render';
import { dragNote } from '../editor/actions';
import { dragPitch } from '../editor/chord-notes';
import { useEditor } from '../editor/history';
import { noteArrival } from '../editor/note-points';
import { onScoreFrame } from '../loop';
import { usePlayer } from '../store';
import './walk-dots.css';

const MARGIN = 8;

export function NoteDots() {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const note = useMemo(() => {
    if (selection.length !== 1) return null;
    const m = piece.moments.find((x) => x.id === selection[0]);
    return m?.type === 'note' ? m : null;
  }, [selection, piece]);

  const box = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLButtonElement>(null);
  const view = useRef<View | null>(null);
  const geo = useRef<{ t: number; p: number }>({ t: 0, p: 0 });
  useLayoutEffect(() => {
    if (note) geo.current = { t: noteArrival(compiled, note), p: note.to };
  }, [note, compiled]);

  useEffect(
    () =>
      onScoreFrame((v) => {
        view.current = v;
        const el = dot.current;
        if (!el) return;
        const { t, p } = geo.current;
        const x = (t - v.start) * v.pps;
        const show = x >= -MARGIN && x <= v.width + MARGIN;
        const tf = show ? `translate(${x.toFixed(1)}px, ${pitchToY(v, p).toFixed(1)}px)` : '';
        if (el.style.transform !== tf) el.style.transform = tf;
        if (el.hidden === show) el.hidden = !show;
      }),
    [],
  );

  if (!note) return null;

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, m: NoteMoment) => {
    if (e.button !== 0) return;
    const drag = dragNote(m.id);
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const key = keyAt(compiled, m.at);
    let last = m.to;
    const move = (ev: PointerEvent) => {
      const v = view.current;
      const rect = box.current?.getBoundingClientRect();
      if (!v || !rect) return;
      const p = dragPitch(yToPitch(v, ev.clientY - rect.top), key, ev.shiftKey);
      if (p === last) return;
      last = p;
      drag.to(p);
    };
    const done = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
      drag.end(ev.type === 'pointercancel');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  };

  return (
    <div ref={box} className="walk-dots" data-testid="note-dots" aria-hidden="true">
      <button
        ref={dot}
        type="button"
        tabIndex={-1}
        hidden
        className="walk-dot chord-dot on"
        data-testid="note-dot"
        data-pitch={note.to}
        onPointerDown={(e) => startDrag(e, note)}
      />
    </div>
  );
}
