/**
 * Editor overlay (§11.3 Chord notes, revision 6): with one chord selected, its notes as dots on
 * the score where the chord arrives (its span end). Dragging a dot vertically sets that note,
 * snapped to the key (Shift: chromatic); the first change freezes the chord, and a whole drag is
 * one undo entry. Positioned per score frame like WalkStepDots; the inspector's note list is the
 * keyboard path, so dots aren't tab stops.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { keyAt } from '../../core/query';
import type { ChordMoment } from '../../core/types';
import { pitchToY, yToPitch, type View } from '../../render';
import { dragChordNote } from '../editor/actions';
import { chordArrival, dragPitch } from '../editor/chord-notes';
import { useEditor } from '../editor/history';
import { onScoreFrame } from '../loop';
import { usePlayer } from '../store';
import { useChordNotes } from './inspector/ChordNotes';
import './walk-dots.css';

const MARGIN = 8;

export function ChordNoteDots() {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const chord = useMemo(() => {
    if (selection.length !== 1) return null;
    const m = piece.moments.find((x) => x.id === selection[0]);
    return m?.type === 'chord' ? m : null;
  }, [selection, piece]);
  const notes = useChordNotes(chord);

  const box = useRef<HTMLDivElement>(null);
  const dots = useRef<(HTMLButtonElement | null)[]>([]);
  const view = useRef<View | null>(null);
  const geo = useRef<{ t: number; p: number[] }>({ t: 0, p: [] });
  useLayoutEffect(() => {
    geo.current = { t: chord ? chordArrival(compiled, chord) : 0, p: notes ?? [] };
  }, [chord, compiled, notes]);

  useEffect(
    () =>
      onScoreFrame((v) => {
        view.current = v;
        const { t, p } = geo.current;
        const x = (t - v.start) * v.pps;
        const show = x >= -MARGIN && x <= v.width + MARGIN;
        for (let i = 0; i < p.length; i++) {
          const el = dots.current[i];
          if (!el) continue;
          const tf = show ? `translate(${x.toFixed(1)}px, ${pitchToY(v, p[i]).toFixed(1)}px)` : '';
          if (el.style.transform !== tf) el.style.transform = tf;
          if (el.hidden === show) el.hidden = !show;
        }
      }),
    [],
  );

  if (!chord || !notes || notes.length === 0) return null;

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, m: ChordMoment, i: number) => {
    if (e.button !== 0) return;
    const drag = dragChordNote(m.id, i);
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const key = keyAt(compiled, m.at);
    let last = notes[i];
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
    <div ref={box} className="walk-dots" data-testid="chord-dots" aria-hidden="true">
      {notes.map((p, i) => (
        <button
          key={i}
          ref={(el) => {
            dots.current[i] = el;
          }}
          type="button"
          tabIndex={-1}
          hidden
          className="walk-dot chord-dot"
          data-testid="chord-dot"
          data-index={i}
          data-pitch={p}
          onPointerDown={(e) => startDrag(e, chord, i)}
        />
      ))}
    </div>
  );
}
