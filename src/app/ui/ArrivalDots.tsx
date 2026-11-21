/**
 * Editor overlay (§11.3 "Every dot is draggable", revision 6; "Score selection", revision 7):
 * arrival dots on the score.
 * - The selected moments' dots: a chord's notes at its span end, a walk's steps, a note's changes,
 *   any other moment's landings (./editor/arrival-points). Selected dots (click, Shift-click, the
 *   marquee; ./editor/dot-selection) are marked `picked`.
 * - Hover: with the mouse near another moment's arrival, that moment's dots (a walk: the near
 *   steps), from a fixed pool of buttons written per frame, so no React render on pointer moves.
 * - The selection rectangle canvas-input draws (../marquee), and the Shift-drag octave guides and
 *   label (../octave-guide), placed per frame.
 * Dragging a dot moves it (`dragDots`), with every other selected dot when it is selected (Shift
 * on an unselected one adds it): vertically its pitch (snapped to the key, the others by the same
 * scale steps; Shift: whole octaves from its start, all by the same octaves; Alt = chromatic;
 * clamped at the view's edge, which holds still during the drag), horizontally its arrival
 * (snapped to note changes within 8 px, a walk step first to its walk's other steps, Alt = free;
 * only once the pointer has moved sideways past the slop), one undo entry; Shift or Alt pressed
 * mid-drag switch live. The grabbed dot follows the pointer and the moved dots stay selected. A
 * click without a drag selects the dot (and its moment; a walk dot also its step); Shift-click
 * adds or removes it. DOM buttons positioned per score frame; the inspector is the keyboard path, so not tab stops.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { keyAt } from '../../core/query';
import type { Moment, MomentId } from '../../core/types';
import { pitchToY, timeToX, xToTime, type View } from '../../render';
import { dragDots, landedDots } from '../editor/actions';
import {
  cachedArrivals,
  hoverPick,
  momentArrivals,
  type ArrivalDot,
} from '../editor/arrival-points';
import { chordNotes, dragPitch } from '../editor/chord-notes';
import {
  currentDots,
  isDot,
  pickedIn,
  selectDots,
  toggleDot,
  useDotSelection,
} from '../editor/dot-selection';
import { useEditor } from '../editor/history';
import { holdNote, stopAudition } from '../audition';
import { edgePitch } from '../editor/drag-edge';
import { dotSnaps, ofVoice, snapTime, type SnapSet } from '../editor/snap';
import { selectStep, useStepSelection } from '../editor/step-selection';
import { sameStep } from '../editor/walk-steps';
import { hoverPointer } from '../hover';
import { onScoreFrame } from '../loop';
import { marquee } from '../marquee';
import { hideOctaves, octaveGuide, showOctaves } from '../octave-guide';
import { camera, usePlayer } from '../store';
import './walk-dots.css';

const MARGIN = 8;
/** Hover reach around a dot, CSS px. */
const HOVER_PX = 12;
/** Most hover dots shown at once. */
const HOVER_MAX = 16;
/** Pointer travel (px) before a press on a dot becomes a drag. */
const SLOP = 3;
/** Most octave guide lines (MIDI 0..127 holds 11 octaves of a pitch). */
const GUIDES_MAX = 11;

const TEST_IDS: Record<string, [box: string, dot: string]> = {
  walk: ['walk-dots', 'walk-dot'],
  chord: ['chord-dots', 'chord-dot'],
  note: ['note-dots', 'note-dot'],
};

function place(el: HTMLElement, v: View, d: { t: number; pitch: number }): void {
  const x = (d.t - v.start) * v.pps;
  const show = x >= -MARGIN && x <= v.width + MARGIN;
  const tf = show ? `translate(${x.toFixed(1)}px, ${pitchToY(v, d.pitch).toFixed(1)}px)` : '';
  if (el.style.transform !== tf) el.style.transform = tf;
  if (el.hidden === show) el.hidden = !show;
}

/** Shift-drag feedback (../octave-guide): a line per octave of the start pitch, and the label. */
function placeOctaves(
  v: View,
  lines: readonly (HTMLDivElement | null)[],
  label: HTMLDivElement | null,
): void {
  const g = octaveGuide;
  for (let i = 0; i < GUIDES_MAX; i++) {
    const el = lines[i];
    if (!el) continue;
    const p = g.on ? g.guides[i] : undefined;
    if (p === undefined) {
      if (!el.hidden) el.hidden = true;
      continue;
    }
    const tf = `translateY(${pitchToY(v, p).toFixed(1)}px)`;
    if (el.style.transform !== tf) el.style.transform = tf;
    el.dataset.pitch = String(p);
    if (el.hidden) el.hidden = false;
  }
  if (!label) return;
  if (!g.on) {
    if (!label.hidden) label.hidden = true;
    return;
  }
  if (label.textContent !== g.label) label.textContent = g.label;
  place(label, v, g);
}

function placeMarquee(el: HTMLElement): void {
  if (!marquee.on) {
    if (!el.hidden) el.hidden = true;
    return;
  }
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  el.style.width = `${Math.abs(marquee.x1 - marquee.x0).toFixed(1)}px`;
  el.style.height = `${Math.abs(marquee.y1 - marquee.y0).toFixed(1)}px`;
  if (el.hidden) el.hidden = false;
}

export function ArrivalDots() {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const selectedStep = useStepSelection((s) => s.step);
  const sel = useDotSelection((s) => s.dots);
  /** The selected moments and their dots. */
  const groups = useMemo(() => {
    const out: { m: Moment; dots: ArrivalDot[] }[] = [];
    for (const id of selection) {
      const m = piece.moments.find((x) => x.id === id);
      if (!m) continue;
      const notes = m.type === 'chord' ? chordNotes(piece, compiled, m) : null;
      out.push({ m, dots: momentArrivals(compiled, m, notes) });
    }
    return out;
  }, [selection, piece, compiled]);
  // Dots of moments that left the selection are dropped (a lane click, delete, undo).
  useEffect(() => {
    const cur = currentDots();
    if (cur.length !== useDotSelection.getState().dots.length) {
      useDotSelection.setState({ dots: cur });
    }
  }, [selection]);
  const dots = useMemo(() => groups.flatMap((g) => g.dots), [groups]);
  const picked = useMemo(() => pickedIn(sel, dots), [sel, dots]);

  const box = useRef<HTMLDivElement>(null);
  const els = useRef<(HTMLButtonElement | null)[]>([]);
  const hoverEls = useRef<(HTMLButtonElement | null)[]>([]);
  /** The dragged dot, drawn at the pointer (the pressed one hides while the score catches up). */
  const ghost = useRef<HTMLDivElement>(null);
  const rect = useRef<HTMLDivElement>(null);
  const guideEls = useRef<(HTMLDivElement | null)[]>([]);
  const octLabel = useRef<HTMLDivElement>(null);
  const follow = useRef<ArrivalDot | null>(null);
  const view = useRef<View | null>(null);
  const geo = useRef<ArrivalDot[]>([]);
  const pickedRef = useRef<boolean[]>([]);
  const selectedIds = useRef<ReadonlySet<MomentId>>(new Set());
  const hover = useRef<{
    dots: ArrivalDot[];
    key: string;
    score: unknown;
    held: boolean;
    dragging: boolean;
  }>({ dots: [], key: '', score: null, held: false, dragging: false });
  useLayoutEffect(() => {
    geo.current = dots;
    pickedRef.current = picked;
    selectedIds.current = new Set(groups.map((g) => g.m.id));
  }, [dots, picked, groups]);

  useEffect(
    () =>
      onScoreFrame((v, score) => {
        view.current = v;
        const g = geo.current;
        for (let i = 0; i < g.length; i++) {
          const el = els.current[i];
          if (el) place(el, v, g[i]);
        }
        if (rect.current) placeMarquee(rect.current);
        placeOctaves(v, guideEls.current, octLabel.current);
        // Hover: re-picked when the pointer, the camera or the score changed; held while the
        // pointer is on a hover dot (the canvas then reports a leave) or a drag runs.
        const h = hover.current;
        if (!h.held && !h.dragging) {
          const key = `${hoverPointer.version}|${v.start}|${v.pps}|${v.pLo}|${v.pHi}|${v.height}`;
          if (key !== h.key || h.score !== score) {
            h.key = key;
            h.score = score;
            const on = hoverPointer.on && box.current?.closest('[data-layout="full"]') !== null;
            h.dots = on
              ? hoverPick(
                  cachedArrivals(usePlayer.getState().piece, score),
                  { x: (t) => timeToX(v, t), y: (p) => pitchToY(v, p), t: (x) => xToTime(v, x) },
                  hoverPointer.x,
                  hoverPointer.y,
                  HOVER_PX,
                  selectedIds.current,
                  HOVER_MAX,
                )
              : [];
          }
        }
        const gh = ghost.current;
        if (gh) {
          if (follow.current) place(gh, v, follow.current);
          else if (!gh.hidden) gh.hidden = true;
        }
        for (let i = 0; i < HOVER_MAX; i++) {
          const el = hoverEls.current[i];
          if (!el) continue;
          const d = h.dragging ? undefined : h.dots[i];
          if (!d) {
            if (!el.hidden) el.hidden = true;
            continue;
          }
          el.dataset.moment = d.momentId;
          el.dataset.type = d.type;
          el.dataset.pitch = String(d.pitch);
          el.dataset.t = d.t.toFixed(3);
          place(el, v, d);
        }
      }),
    [],
  );

  /** The dots a drag of `dot` moves: the dot selection when it holds `dot`, else `dot` alone. */
  const groupFor = (dot: ArrivalDot, add: boolean): ArrivalDot[] => {
    const cur = geo.current.filter((_, i) => pickedRef.current[i]);
    const i = cur.findIndex((d) => d === dot || isDot(d, dot));
    if (i >= 0) return cur.map((d, j) => (j === i ? dot : d));
    return add ? [...cur, dot] : [dot];
  };

  /** A press on a dot: past the slop, a drag of it (and the selection); otherwise a click. */
  const press = (e: React.PointerEvent<HTMLButtonElement>, dot: ArrivalDot) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const add = e.shiftKey;
    const key = keyAt(usePlayer.getState().compiled, dot.t);
    const h = hover.current;
    let drag: ReturnType<typeof dragDots> | undefined;
    let last = dot.pitch;
    let lastT = dot.t;
    let sideways = false;
    let snaps: SnapSet | null = null;
    /** The last pointer position and modifiers, re-applied when Shift or Alt changes mid-drag. */
    let at = { x: x0, y: y0, shift: e.shiftKey, alt: e.altKey };
    const apply = () => {
      const v = view.current;
      const r = box.current?.getBoundingClientRect();
      if (!drag || !v || !r) return;
      const raw = edgePitch(v, at.y - r.top);
      // Shift: whole octaves from the start pitch; Alt: chromatic and off the grid; else the key.
      const oct = at.shift && !at.alt ? drag.octaves(raw) : null;
      const p = oct ? oct.pitch : dragPitch(raw, key, at.alt);
      if (Math.abs(at.x - x0) > SLOP) sideways = true;
      let t = dot.t;
      if (sideways && snaps) t = snapTime(xToTime(v, at.x - r.left), snaps, v.pps, at.alt);
      follow.current = { ...dot, t, pitch: p };
      if (oct) showOctaves(oct.k, t, p, oct.guides);
      else hideOctaves();
      if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
      if (ghost.current) place(ghost.current, v, follow.current);
      // Sounds the dragged note at its snapped pitch (§11.3 auditioning); a new pitch replaces it.
      holdNote(dot.voice, p, dot.t);
      if (p === last && t === lastT) return;
      last = p;
      lastT = t;
      drag.to(p, t, oct !== null || at.alt);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (drag === undefined) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) <= SLOP) return;
        h.dragging = true;
        const group = groupFor(dot, add);
        drag = dragDots(group, dot);
        const v0 = view.current;
        if (v0 && drag) camera.pitch = [v0.pLo, v0.pHi];
        const st = usePlayer.getState();
        const own = dotSnaps(st.compiled, st.piece, dot);
        // Not to the dragged dots' own note changes.
        const others = group.filter((d) => d !== dot).map((d) => ofVoice(d.momentId, d.voice));
        const ex = own.exclude;
        snaps =
          others.length === 0
            ? own
            : { ...own, exclude: (p) => !!ex?.(p) || others.some((f) => f(p)) };
      }
      at = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey };
      apply();
    };
    /** Pressing or releasing Shift or Alt mid-drag switches mode live. */
    const keys = (ev: KeyboardEvent) => {
      if (ev.key !== 'Shift' && ev.key !== 'Alt') return;
      if (at.shift === ev.shiftKey && at.alt === ev.altKey) return;
      at = { ...at, shift: ev.shiftKey, alt: ev.altKey };
      apply();
    };
    const done = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      window.removeEventListener('keydown', keys);
      window.removeEventListener('keyup', keys);
      hideOctaves();
      h.dragging = false;
      if (drag) camera.pitch = null;
      h.held = false;
      h.key = '';
      follow.current = null;
      el.style.visibility = '';
      if (ghost.current) ghost.current.hidden = true;
      stopAudition();
      if (drag) {
        const r = drag.end(ev.type === 'pointercancel');
        if (!r) return;
        // The moved dots stay selected, where they ended up.
        selectDots(landedDots(r));
        const step = r.targets.length === 1 ? r.steps[0] : undefined;
        if (step) selectStep(step);
      } else if (drag === undefined && ev.type === 'pointerup') {
        if (add) toggleDot(dot);
        else {
          selectDots([dot]);
          if (dot.step) selectStep(dot.step);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', keys);
  };

  let flat = 0;
  return (
    <>
      {groups.map(({ m, dots: ds }) => {
        const ids = TEST_IDS[m.type] ?? ['arrival-dots', 'arrival-dot'];
        if (ds.length === 0) return null;
        return (
          <div key={m.id} className="walk-dots" data-testid={ids[0]} aria-hidden="true">
            {ds.map((d, j) => {
              const i = flat++;
              const on = d.type === 'note' || (!!d.step && sameStep(d.step, selectedStep));
              const base = d.type === 'walk' ? 'walk-dot' : 'walk-dot chord-dot';
              const cls = `${base}${on ? ' on' : ''}${picked[i] ? ' picked' : ''}`;
              return (
                <button
                  key={d.step ? `${d.step.tick}:${d.step.voice}` : j}
                  ref={(el) => {
                    els.current[i] = el;
                  }}
                  type="button"
                  tabIndex={-1}
                  hidden
                  className={cls}
                  data-testid={ids[1]}
                  data-dot-moment={m.id}
                  data-index={d.type === 'chord' ? j : undefined}
                  data-change={d.change}
                  data-tick={d.step?.tick}
                  data-voice={d.step?.voice}
                  data-selected={d.step && on ? 'true' : undefined}
                  data-picked={picked[i] ? 'true' : undefined}
                  data-t={d.t.toFixed(3)}
                  data-pitch={d.pitch}
                  onPointerDown={(e) => press(e, d)}
                />
              );
            })}
          </div>
        );
      })}
      <div ref={box} className="walk-dots" data-testid="hover-dots" aria-hidden="true">
        <div ref={rect} className="marquee" data-testid="marquee" hidden />
        {Array.from({ length: GUIDES_MAX }, (_, i) => (
          <div
            key={i}
            ref={(el) => {
              guideEls.current[i] = el;
            }}
            className="octave-guide"
            data-testid="octave-guide"
            hidden
          />
        ))}
        <div ref={octLabel} className="octave-label" data-testid="octave-label" hidden />
        <div ref={ghost} className="walk-dot on drag-dot" data-testid="drag-dot" hidden />
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
              if (d) press(e, d);
            }}
          />
        ))}
      </div>
    </>
  );
}
