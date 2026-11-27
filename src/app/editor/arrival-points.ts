/**
 * Arrival points (PLAN.md §11.3 "Every dot is draggable", revision 6): where a moment's voices land
 * on their new pitches, as draggable dots on the score. Pure helpers: the points of one moment,
 * the piece-wide index for hover, the hover pick, and what a drag of a dot does.
 */

import { noteChanges } from '../../core/moments/note';
import { walkStepGlide } from '../../core/moments/walk';
import { noteAt } from '../../core/query';
import type {
  ChordMoment,
  CompiledScore,
  CompiledVoice,
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
import { noteLanding } from './note-points';
import { tuneDots } from './tune';
import type { StepRef } from './walk-steps';

/** One dot: moment `momentId` brings a voice to `pitch` at `t`. */
export interface ArrivalDot {
  momentId: MomentId;
  type: MomentType;
  t: Seconds;
  pitch: Pitch;
  /** Pool index of the voice that lands there, when known. */
  voice?: number;
  /** Walk dots: the step. */
  step?: StepRef;
  /** Note dots: the index of the change in `noteChanges(m)`. */
  change?: number;
  /** Tune dots: the note's index in `notes` (R9-8). */
  note?: number;
}

/** True if voice `v` is fading out (a merge's dying voice) at t. */
function dyingAt(v: CompiledVoice, t: Seconds): boolean {
  return v.lives.some(
    (l) => l.born <= t && l.died !== undefined && l.died - (l.fadeOut ?? 0) <= t + SAME_T,
  );
}

/**
 * Adds a landing to `list` unless one is already there; a dot shared with a dying voice belongs
 * to the survivor. Returns the entry added, or null.
 */
function addLanding(
  list: { t: Seconds; p: Pitch; v: number }[],
  score: CompiledScore,
  b: { t: Seconds; p: Pitch; v: number },
): { t: Seconds; p: Pitch; v: number } | null {
  const o = list.find((o) => Math.abs(o.t - b.t) < SAME_T && Math.abs(o.p - b.p) < SAME_P);
  if (!o) {
    list.push(b);
    return b;
  }
  if (dyingAt(score.voices[o.v], o.t) && !dyingAt(score.voices[b.v], b.t)) o.v = b.v;
  return null;
}

/**
 * True for a hold an establishing moment opened (M4.5-27): it starts a life with no fade-in and
 * carries the moment's id. Its dot is at its start, where the note comes in.
 */
function opening(v: CompiledVoice, s: CompiledVoice['segments'][number]): boolean {
  return (
    s.momentId !== undefined &&
    s.p0 === s.p1 &&
    v.lives.some((l) => l.born === s.t0 && l.fadeIn === 0)
  );
}

/** Dots closer than this in time (s) and pitch (st) are one dot. */
const SAME_T = 1e-3;
const SAME_P = 0.05;

/**
 * Where moment `id`'s glides land, from the compiled segments: per voice, the end of its latest
 * segment of the moment that moves and wasn't interrupted, or where an establishing moment
 * brings the voice in (the start of its opening hold). A dying voice that glides onto a
 * neighbour lands on that neighbour's dot, so duplicates are merged. Sorted by t, then pitch.
 */
export function segmentArrivals(
  score: CompiledScore,
  id: MomentId,
): { t: Seconds; p: Pitch; v: number }[] {
  const out: { t: Seconds; p: Pitch; v: number }[] = [];
  for (const v of score.voices) {
    let best: { t: Seconds; p: Pitch; v: number } | null = null;
    for (const s of v.segments) {
      if (s.momentId !== id) continue;
      if (s.p0 === s.p1) {
        if (!best && opening(v, s)) best = { t: s.t0, p: s.p0, v: v.index };
        continue;
      }
      if (s.curve && s.curve.t1 > s.t1 + 1e-9) continue;
      if (!best || s.t1 >= best.t) best = { t: s.t1, p: s.p1, v: v.index };
    }
    if (best) addLanding(out, score, best);
  }
  return out.sort((a, b) => a.t - b.t || a.p - b.p);
}

/** Pool index of a voice id in `score`, or undefined. */
function voiceIndex(score: CompiledScore, id: string): number | undefined {
  return score.voices.find((v) => v.id === id)?.index;
}

function walkDots(score: CompiledScore, w: WalkMoment): ArrivalDot[] {
  const out: ArrivalDot[] = [];
  for (const s of score.walkSteps) {
    if (s.momentId !== w.id) continue;
    out.push({
      momentId: w.id,
      type: 'walk',
      t: s.t + (walkStepGlide(w, s.tick) ?? 0),
      pitch: s.to,
      voice: voiceIndex(score, s.voice),
      step: { momentId: w.id, tick: s.tick, voice: s.voice },
    });
  }
  return out;
}

/** A note moment's dots: one per change, at its `to` where it arrives (§11.3 revision 7). */
function noteDots(score: CompiledScore, m: NoteMoment): ArrivalDot[] {
  const list = noteChanges(m);
  const used = new Set<number>();
  return list.map((c, change) => {
    const { t, voice } = noteLanding(score, m, c.to, used);
    if (voice !== undefined) used.add(voice);
    const d: ArrivalDot = { momentId: m.id, type: 'note', t, pitch: c.to, change };
    if (voice !== undefined) d.voice = voice;
    return d;
  });
}

/**
 * The dots of moment `m`. A chord with `chordNotes` (its full note list, ./chord-notes) gets one
 * dot per note at its span end, including voices already on their note; without it, the landings
 * of the voices that move. Walk: its steps. Note: `to` where it arrives. Progression: none
 * (Freeze it to edit notes). Others: the landings.
 */
export function momentArrivals(
  score: CompiledScore,
  m: Moment,
  chordNotes?: readonly Pitch[] | null,
): ArrivalDot[] {
  if (m.type === 'walk') return walkDots(score, m);
  if (m.type === 'note') return noteDots(score, m);
  if (m.type === 'tune') return tuneDots(score, m);
  // A progression's notes are edited after Freeze (as chord moments), so it has no dots.
  if (m.type === 'progression') return [];
  if (m.type === 'chord' && chordNotes) {
    const t = chordArrival(score, m);
    return chordNotes.map((pitch) => {
      const d: ArrivalDot = { momentId: m.id, type: 'chord', t, pitch };
      const v = noteAt(score, t, pitch, 0.25)?.voice;
      if (v !== undefined) d.voice = v;
      return d;
    });
  }
  return segmentArrivals(score, m.id).map(({ t, p, v }) => ({
    momentId: m.id,
    type: m.type,
    t,
    pitch: p,
    voice: v,
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
  const landings = new Map<MomentId, { t: Seconds; p: Pitch; v: number }[]>();
  const best = new Map<MomentId, { t: Seconds; p: Pitch; v: number }>();
  for (const v of score.voices) {
    best.clear();
    for (const s of v.segments) {
      const id = s.momentId;
      if (id === undefined) continue;
      if (s.p0 === s.p1) {
        if (!best.has(id) && opening(v, s)) best.set(id, { t: s.t0, p: s.p0, v: v.index });
        continue;
      }
      if (s.curve && s.curve.t1 > s.t1 + 1e-9) continue;
      const b = best.get(id);
      if (!b || s.t1 >= b.t) best.set(id, { t: s.t1, p: s.p1, v: v.index });
    }
    for (const [id, b] of best) {
      const type = byId.get(id)?.type;
      if (
        type === undefined ||
        type === 'walk' ||
        type === 'note' ||
        type === 'tune' ||
        type === 'progression'
      )
        continue;
      let list = landings.get(id);
      if (!list) landings.set(id, (list = []));
      if (addLanding(list, score, b)) out.push({ momentId: id, type, t: b.t, pitch: b.p });
    }
  }
  // Voices, after merging shared landings (the survivor owns a shared dot).
  for (const d of out) {
    const l = landings.get(d.momentId)?.find((o) => o.t === d.t && o.p === d.pitch);
    if (l) d.voice = l.v;
  }
  for (const s of score.walkSteps) {
    const w = byId.get(s.momentId);
    if (w?.type !== 'walk') continue;
    out.push({
      momentId: w.id,
      type: 'walk',
      t: s.t + (walkStepGlide(w, s.tick) ?? 0),
      pitch: s.to,
      voice: voiceIndex(score, s.voice),
      step: { momentId: w.id, tick: s.tick, voice: s.voice },
    });
  }
  for (const m of byId.values()) {
    if (m.type === 'note') out.push(...noteDots(score, m));
    else if (m.type === 'tune') out.push(...tuneDots(score, m));
  }
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
 * excluding `exclude` (the selected moment or moments, whose dots already show). A walk shows only its near
 * steps (it may have hundreds); other moments show all their dots, nearest moment first, at most
 * `max` in all. `dots` must be sorted by t.
 */
export function hoverPick(
  dots: readonly ArrivalDot[],
  map: DotMapping,
  x: number,
  y: number,
  radius: number,
  exclude: MomentId | ReadonlySet<MomentId> | null = null,
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
    if (typeof exclude === 'string' ? d.momentId === exclude : exclude?.has(d.momentId)) continue;
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

/**
 * What dragging a dot does (§11.3, revision 6): it moves that dot by editing its moment. Chord:
 * that note (freezing) and that voice's arrival; walk: that step's tick and pitch; note: `to` and
 * the arrival; tune: that note's pitch and start; anything else: a per-voice override. `none`:
 * the moment is gone.
 */
export type DotAction =
  | { kind: 'chord'; id: MomentId; index: number; voice?: number }
  | { kind: 'walk'; step: StepRef }
  | { kind: 'note'; id: MomentId; change: number; voice?: number }
  | { kind: 'tune'; id: MomentId; note: number }
  | { kind: 'override'; id: MomentId; voice: number }
  | { kind: 'none' };

/** The index in `notes` nearest `pitch` (ties low); -1 when empty. */
export function nearestIndex(notes: readonly Pitch[], pitch: Pitch): number {
  let best = -1;
  for (let i = 0; i < notes.length; i++) {
    if (best < 0 || Math.abs(notes[i] - pitch) < Math.abs(notes[best] - pitch)) best = i;
  }
  return best;
}

/** The action for a drag of `dot` (`chordNotes(m)`: the chord's note list). */
export function dotAction(
  piece: Piece,
  dot: ArrivalDot,
  chordNotes: (m: ChordMoment) => readonly Pitch[] | null,
): DotAction {
  const m = piece.moments.find((x) => x.id === dot.momentId);
  if (!m || m.type === 'progression') return { kind: 'none' };
  const voice = dot.voice;
  if (m.type === 'chord') {
    const notes = chordNotes(m);
    const index = notes ? nearestIndex(notes, dot.pitch) : -1;
    if (index >= 0)
      return voice === undefined
        ? { kind: 'chord', id: m.id, index }
        : { kind: 'chord', id: m.id, index, voice };
  }
  if (m.type === 'walk') return dot.step ? { kind: 'walk', step: dot.step } : { kind: 'none' };
  if (m.type === 'note') {
    const change = dot.change ?? 0;
    return voice === undefined
      ? { kind: 'note', id: m.id, change }
      : { kind: 'note', id: m.id, change, voice };
  }
  if (m.type === 'tune') {
    return dot.note === undefined ? { kind: 'none' } : { kind: 'tune', id: m.id, note: dot.note };
  }
  return voice === undefined ? { kind: 'none' } : { kind: 'override', id: m.id, voice };
}

let cached: { piece: Piece; score: CompiledScore; dots: ArrivalDot[] } | null = null;

/** `allArrivals`, cached for the last piece and score (hover and the marquee share it). */
export function cachedArrivals(piece: Piece, score: CompiledScore): readonly ArrivalDot[] {
  if (cached?.piece !== piece || cached.score !== score) {
    cached = { piece, score, dots: allArrivals(piece, score) };
  }
  return cached.dots;
}
