/**
 * Arrival points (PLAN.md §11.3 "Every dot is draggable", revision 6): where a moment's voices land
 * on their new pitches, as draggable dots on the score. Pure helpers: the points of one moment,
 * the piece-wide index for hover, the hover pick, and what a drag of a dot does.
 */

import type {
  ChordMoment,
  CompiledScore,
  Moment,
  MomentId,
  MomentType,
  NoteMoment,
  Piece,
  Pitch,
  Seconds,
  WalkMoment,
} from '../../core/types';
import { chordArrival } from './chord-notes';
import { noteArrival } from './note-points';
import type { StepRef } from './walk-steps';

/** One dot: moment `momentId` brings a voice to `pitch` at `t`. */
export interface ArrivalDot {
  momentId: MomentId;
  type: MomentType;
  t: Seconds;
  pitch: Pitch;
  /** Walk dots: the step. */
  step?: StepRef;
}

/** Dots closer than this in time (s) and pitch (st) are one dot. */
const SAME_T = 1e-3;
const SAME_P = 0.05;

/**
 * Where moment `id`'s glides land, from the compiled segments: per voice, the end of its latest
 * segment of the moment that moves and wasn't interrupted. A dying voice that glides onto a
 * neighbour lands on that neighbour's dot, so duplicates are merged. Sorted by t, then pitch.
 */
export function segmentArrivals(score: CompiledScore, id: MomentId): { t: Seconds; p: Pitch }[] {
  const out: { t: Seconds; p: Pitch }[] = [];
  for (const v of score.voices) {
    let best: { t: Seconds; p: Pitch } | null = null;
    for (const s of v.segments) {
      if (s.momentId !== id || s.p0 === s.p1) continue;
      if (s.curve && s.curve.t1 > s.t1 + 1e-9) continue;
      if (!best || s.t1 >= best.t) best = { t: s.t1, p: s.p1 };
    }
    if (
      best &&
      !out.some((o) => Math.abs(o.t - best.t) < SAME_T && Math.abs(o.p - best.p) < SAME_P)
    )
      out.push(best);
  }
  return out.sort((a, b) => a.t - b.t || a.p - b.p);
}

function walkDots(score: CompiledScore, w: WalkMoment): ArrivalDot[] {
  const out: ArrivalDot[] = [];
  for (const s of score.walkSteps) {
    if (s.momentId !== w.id) continue;
    out.push({
      momentId: w.id,
      type: 'walk',
      t: s.t + (w.stepGlide ?? 0),
      pitch: s.to,
      step: { momentId: w.id, tick: s.tick, voice: s.voice },
    });
  }
  return out;
}

function noteDot(score: CompiledScore, m: NoteMoment): ArrivalDot {
  return { momentId: m.id, type: 'note', t: noteArrival(score, m), pitch: m.to };
}

/**
 * The dots of moment `m`. A chord with `chordNotes` (its full note list, ./chord-notes) gets one
 * dot per note at its span end, including voices already on their note; without it, the landings
 * of the voices that move. Walk: its steps. Note: `to` where it arrives. Others: the landings.
 */
export function momentArrivals(
  score: CompiledScore,
  m: Moment,
  chordNotes?: readonly Pitch[] | null,
): ArrivalDot[] {
  if (m.type === 'walk') return walkDots(score, m);
  if (m.type === 'note') return [noteDot(score, m)];
  if (m.type === 'chord' && chordNotes) {
    const t = chordArrival(score, m);
    return chordNotes.map((pitch) => ({ momentId: m.id, type: 'chord', t, pitch }));
  }
  return segmentArrivals(score, m.id).map(({ t, p }) => ({
    momentId: m.id,
    type: m.type,
    t,
    pitch: p,
  }));
}

/**
 * Every moment's dots (muted moments have none), sorted by t, for hover. One pass over the
 * segments, so it stays cheap on long pieces.
 */
export function allArrivals(piece: Piece, score: CompiledScore): ArrivalDot[] {
  const byId = new Map<MomentId, Moment>();
  for (const m of piece.moments) if (!m.muted) byId.set(m.id, m);
  const out: ArrivalDot[] = [];
  const landings = new Map<MomentId, { t: Seconds; p: Pitch }[]>();
  const best = new Map<MomentId, { t: Seconds; p: Pitch }>();
  for (const v of score.voices) {
    best.clear();
    for (const s of v.segments) {
      const id = s.momentId;
      if (id === undefined || s.p0 === s.p1) continue;
      if (s.curve && s.curve.t1 > s.t1 + 1e-9) continue;
      const b = best.get(id);
      if (!b || s.t1 >= b.t) best.set(id, { t: s.t1, p: s.p1 });
    }
    for (const [id, b] of best) {
      const type = byId.get(id)?.type;
      if (type === undefined || type === 'walk' || type === 'note') continue;
      let list = landings.get(id);
      if (!list) landings.set(id, (list = []));
      if (!list.some((o) => Math.abs(o.t - b.t) < SAME_T && Math.abs(o.p - b.p) < SAME_P)) {
        list.push(b);
        out.push({ momentId: id, type, t: b.t, pitch: b.p });
      }
    }
  }
  for (const s of score.walkSteps) {
    const w = byId.get(s.momentId);
    if (w?.type !== 'walk') continue;
    out.push({
      momentId: w.id,
      type: 'walk',
      t: s.t + (w.stepGlide ?? 0),
      pitch: s.to,
      step: { momentId: w.id, tick: s.tick, voice: s.voice },
    });
  }
  for (const m of byId.values()) if (m.type === 'note') out.push(noteDot(score, m));
  return out.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
}

/** Screen mapping for `hoverPick`. */
export interface DotMapping {
  x(t: Seconds): number;
  y(p: Pitch): number;
  /** Time at screen x. */
  t(x: number): Seconds;
}

/**
 * The dots to show for a pointer at (x, y): those of the moment(s) with a dot within `radius` px,
 * excluding `exclude` (the selected moment, whose dots already show). A walk shows only its near
 * steps (it may have hundreds); other moments show all their dots, nearest moment first, at most
 * `max` in all. `dots` must be sorted by t.
 */
export function hoverPick(
  dots: readonly ArrivalDot[],
  map: DotMapping,
  x: number,
  y: number,
  radius: number,
  exclude: MomentId | null = null,
  max = 16,
): ArrivalDot[] {
  const t0 = map.t(x - radius);
  const t1 = map.t(x + radius);
  let lo = 0;
  let hi = dots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dots[mid].t < t0) lo = mid + 1;
    else hi = mid;
  }
  const near: { d: ArrivalDot; dist: number }[] = [];
  for (let i = lo; i < dots.length && dots[i].t <= t1; i++) {
    const d = dots[i];
    if (d.momentId === exclude) continue;
    const dist = Math.hypot(map.x(d.t) - x, map.y(d.pitch) - y);
    if (dist <= radius) near.push({ d, dist });
  }
  near.sort((a, b) => a.dist - b.dist);
  const out: ArrivalDot[] = [];
  const seen = new Set<MomentId>();
  for (const { d } of near) {
    if (out.length >= max) break;
    if (d.type === 'walk') {
      out.push(d);
      continue;
    }
    if (seen.has(d.momentId)) continue;
    seen.add(d.momentId);
    for (const e of dots) {
      if (e.momentId === d.momentId && out.length < max) out.push(e);
    }
  }
  return out;
}

/** What dragging a dot does (§11.3). */
export type DotAction =
  | { kind: 'chord'; id: MomentId; index: number }
  | { kind: 'walk'; step: StepRef }
  | { kind: 'note'; id: MomentId }
  | { kind: 'add'; at: Seconds; from: Pitch };

/** The index in `notes` nearest `pitch` (ties low); -1 when empty. */
export function nearestIndex(notes: readonly Pitch[], pitch: Pitch): number {
  let best = -1;
  for (let i = 0; i < notes.length; i++) {
    if (best < 0 || Math.abs(notes[i] - pitch) < Math.abs(notes[best] - pitch)) best = i;
  }
  return best;
}

/**
 * The action for a drag of `dot`: a chord edits its nearest note (`chordNotes(m)`, the chord's
 * note list), a walk moves its step, a note sets `to`; anything else (or a moment that's gone)
 * adds a note at the arrival (rounded to the ms) with `from` = the dot's pitch.
 */
export function dotAction(
  piece: Piece,
  dot: ArrivalDot,
  chordNotes: (m: ChordMoment) => readonly Pitch[] | null,
): DotAction {
  const m = piece.moments.find((x) => x.id === dot.momentId);
  if (m?.type === 'chord') {
    const notes = chordNotes(m);
    const index = notes ? nearestIndex(notes, dot.pitch) : -1;
    if (index >= 0) return { kind: 'chord', id: m.id, index };
  }
  if (m?.type === 'walk' && dot.step) return { kind: 'walk', step: dot.step };
  if (m?.type === 'note') return { kind: 'note', id: m.id };
  return { kind: 'add', at: Math.round(dot.t * 1000) / 1000, from: dot.pitch };
}
