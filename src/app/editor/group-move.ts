/**
 * Moving arrival dots (PLAN.md §11.3 revision 7 "Score selection", "Grouped note changes"). Pure.
 * - `groupTargets`: the grabbed dot's drag applied to every selected dot (same scale steps in the
 *   key at each dot, or the same semitones when chromatic; same time offset).
 * - `moveDots`: one recipe that moves dots by editing their moments ("Every dot is draggable"):
 *   chord notes (freezing), walk steps, per-voice overrides, and note changes. A note change whose
 *   new time lands on another note moment's `at` joins it; one moved off its moment's time splits
 *   into its own moment (or moves the moment, when all its changes move).
 * - `noteHostAt`: the note moment a hand-made change at a time joins.
 * - `dotsInRect`: marquee hit testing.
 */

import { freezeWalk } from '../../core/moments/walk';
import { noteChanges, withNoteChanges } from '../../core/moments/note';
import { momentSeed } from '../../core/rng';
import { pitchOfDegreeIndex, scaleDegreeIndex, snapToScale } from '../../core/scales';
import type {
  ChordMoment,
  CompiledScore,
  Key,
  Moment,
  MomentId,
  NoteChange,
  NoteMoment,
  Piece,
  Pitch,
  Seconds,
  TuneMoment,
  WalkMoment,
  WalkNote,
} from '../../core/types';
import { nearestIndex, type ArrivalDot } from './arrival-points';
import { frozenPatch } from './chord-notes';
import { inRange } from './drag-edge';
import { insertMoments, patchMoment, removeMoments, type MomentPatch } from './ops';
import { arrivalEnd, withOverride } from './overrides';
import { moveTuneStarts, setTunePitch } from './tune';
import { tickAt, withNote, type StepRef } from './walk-steps';

/** Times within this (s) are the same time: a note change there joins that note moment. */
export const JOIN_T = 1e-4;

/** One dot's move: from where `dot` is to (`pitch`, `t`). */
export interface DotMove {
  dot: ArrivalDot;
  pitch: Pitch;
  t: Seconds;
}

/**
 * Every dot of `dots` moved like `grabbed` (one of them) moved to (`pitch`, `t`): the same time
 * offset (never before 0), and the same number of scale steps in the key at each dot (`keyAt`),
 * keeping a dot's chromatic offset from the scale; `chromatic`: the same semitones. Pitches are
 * kept inside `range(dot)`. The grabbed dot gets (`pitch`, `t`) exactly; unchanged values stay
 * identical (so callers can tell a vertical from a sideways drag).
 */
export function groupTargets(
  dots: readonly ArrivalDot[],
  grabbed: ArrivalDot,
  pitch: Pitch,
  t: Seconds,
  keyAt: (t: Seconds) => Key,
  chromatic: boolean,
  range: (d: ArrivalDot) => readonly [Pitch, Pitch] | undefined = () => undefined,
): DotMove[] {
  const dt = t - grabbed.t;
  const k0 = keyAt(grabbed.t);
  const steps = chromatic ? 0 : scaleDegreeIndex(pitch, k0) - scaleDegreeIndex(grabbed.pitch, k0);
  const dp = pitch - grabbed.pitch;
  return dots.map((d) => {
    if (d === grabbed) return { dot: d, pitch, t };
    let p = d.pitch;
    if (pitch !== grabbed.pitch) {
      if (chromatic) p = d.pitch + dp;
      else if (steps !== 0) {
        const key = keyAt(d.t);
        const off = d.pitch - snapToScale(d.pitch, key);
        p = pitchOfDegreeIndex(scaleDegreeIndex(d.pitch, key) + steps, key) + off;
      }
      p = inRange(p, range(d));
    }
    return { dot: d, pitch: p, t: dt === 0 ? d.t : Math.max(0, d.t + dt) };
  });
}

/** What `moveDots` needs besides the piece. */
export interface MoveEnv {
  /** The score `piece` compiled (taken at gesture start). */
  score: CompiledScore;
  /** A chord's note list (./chord-notes `chordNotes`). */
  chordNotes(m: ChordMoment): readonly Pitch[] | null;
  /** "Keep lines in order" for chord edits. */
  keep: boolean;
  /** The `order` a pitch-edited note gets (./line-order `noteOrder`). */
  order: true | undefined;
  /** Fresh moment ids for split-off note changes (at least one per move). */
  ids: readonly MomentId[];
}

/** `moveDots`' result: the piece, and per move the moment that now holds it (walk: the step). */
export interface MoveResult {
  piece: Piece;
  hosts: MomentId[];
  steps: (StepRef | undefined)[];
}

const roundUs = (t: Seconds): Seconds => Math.max(0, Math.round(t * 1e6) / 1e6) + 0;

/**
 * Applies `moves` (dots of `piece`, compiled as `env.score`) in one recipe, editing each dot's
 * moment and never adding one, except a note change split off its moment. A pitch changes only
 * when it differs from the dot's, a time only when it differs from `dot.t`.
 * - chord: that note (freezing) and that voice's arrival (`overrides` `end`);
 * - walk: the step's pitch and tick (freezing);
 * - tune: the note's pitch, and sideways its start (the note before it and the note change
 *   length; every note of the tune moving shifts the tune);
 * - note: the change's `to`, and sideways its time (the change's `at`, glide kept): it joins a
 *   note moment already at the new time, else moves its moment (when every change of it moves
 *   together) or splits into a new moment;
 * - anything else: that voice's override (`pitch`, `end`).
 */
export function moveDots(piece: Piece, moves: readonly DotMove[], env: MoveEnv): MoveResult {
  const hosts = moves.map((mv) => mv.dot.momentId);
  const steps: (StepRef | undefined)[] = moves.map((mv) => mv.dot.step);
  const groups = new Map<MomentId, number[]>();
  moves.forEach((mv, i) => {
    const g = groups.get(mv.dot.momentId);
    if (g) g.push(i);
    else groups.set(mv.dot.momentId, [i]);
  });
  let p = piece;
  const notes: { m: NoteMoment; idx: number[] }[] = [];
  for (const [id, idx] of groups) {
    const m = piece.moments.find((x) => x.id === id);
    if (!m) continue;
    const ms = idx.map((i) => moves[i]);
    let patch: MomentPatch | null = null;
    if (m.type === 'note') notes.push({ m, idx });
    else if (m.type === 'chord') patch = chordPatch(m, ms, env);
    else if (m.type === 'walk') {
      const r = walkPatch(m, ms, env.score);
      if (r) {
        patch = { fixed: r.fixed };
        idx.forEach((i, j) => (steps[i] = r.refs[j]));
      }
    } else if (m.type === 'tune') patch = tunePatch(m, ms);
    else patch = overridePatch(piece, m, ms);
    if (patch) p = patchMoment(p, id, patch);
  }
  if (notes.length > 0) p = moveNoteChanges(p, moves, notes, env, hosts);
  return { piece: p, hosts, steps };
}

function chordPatch(m: ChordMoment, ms: readonly DotMove[], env: MoveEnv): MomentPatch | null {
  const notes0 = env.chordNotes(m);
  const notes = notes0 ? notes0.slice() : null;
  let frozen = false;
  let overrides = m.overrides;
  for (const { dot, pitch, t } of ms) {
    const i = notes0 ? nearestIndex(notes0, dot.pitch) : -1;
    if (notes && i >= 0 && pitch !== dot.pitch && pitch >= 0 && pitch <= 127) {
      if (notes[i] !== pitch) frozen = true;
      notes[i] = pitch;
    }
    if (dot.voice !== undefined && t !== dot.t) {
      overrides = withOverride(overrides, dot.voice, { end: arrivalEnd(m, t) });
    }
  }
  const patch = {
    ...(frozen && notes ? frozenPatch(m, notes, env.keep) : {}),
    ...(overrides !== m.overrides ? { overrides } : {}),
  } as MomentPatch;
  return Object.keys(patch).length > 0 ? patch : null;
}

function walkPatch(
  w: WalkMoment,
  ms: readonly DotMove[],
  score: CompiledScore,
): { fixed: WalkNote[]; refs: (StepRef | undefined)[] } | null {
  const moved = ms.filter(
    ({ dot, pitch, t }) => dot.step && (pitch !== dot.pitch || t !== dot.t) && pitch >= 0,
  );
  if (moved.length === 0) return null;
  const gone = (n: WalkNote) =>
    moved.some(({ dot }) => dot.step!.tick === n.tick && dot.step!.voice === n.voice);
  // All the old notes go first, so a step moved onto another moved step's tick keeps both.
  let fixed = (w.fixed ?? freezeWalk(score, w.id)).filter((n) => !gone(n));
  const refs = ms.map(({ dot, pitch, t }) => {
    const ref = dot.step;
    if (!ref || !moved.some((x) => x.dot === dot)) return ref;
    const tick = t === dot.t ? ref.tick : (tickAt(w, t - (w.stepGlide ?? 0)) ?? ref.tick);
    fixed = withNote(fixed, { tick, voice: ref.voice, pitch: Math.min(127, pitch) });
    return { momentId: w.id, tick, voice: ref.voice };
  });
  return { fixed, refs };
}

function tunePatch(m: TuneMoment, ms: readonly DotMove[]): MomentPatch | null {
  let notes = m.notes;
  const starts = new Map<number, Seconds>();
  for (const { dot, pitch, t } of ms) {
    const k = dot.note;
    if (k === undefined) continue;
    // Dots show sounding pitches (revision 10): write back the un-transposed one.
    const shift = dot.pitch - (m.notes[k]?.pitch ?? dot.pitch);
    if (pitch !== dot.pitch) notes = setTunePitch(notes, k, pitch - shift) ?? notes;
    if (t !== dot.t) starts.set(k, t);
  }
  const moved = starts.size > 0 ? moveTuneStarts({ at: m.at, notes }, starts) : null;
  if (moved) return moved.at === m.at ? { notes: moved.notes } : moved;
  return notes === m.notes ? null : { notes };
}

function overridePatch(piece: Piece, m: Moment, ms: readonly DotMove[]): MomentPatch | null {
  let list = m.overrides;
  for (const { dot, pitch, t } of ms) {
    const v = dot.voice;
    if (v === undefined) continue;
    if (pitch !== dot.pitch) {
      // Kept inside the voice's range: the compiler would fold it by an octave (§7.8).
      list = withOverride(list, v, { pitch: inRange(pitch, piece.voices[v]?.range) });
    }
    if (t !== dot.t) list = withOverride(list, v, { end: arrivalEnd(m, t) });
  }
  return list === m.overrides ? null : ({ overrides: list } as MomentPatch);
}

/** The unmuted note moment at `at` (within JOIN_T) a hand-made change there joins, or null. */
export function noteHostAt(
  piece: Piece,
  at: Seconds,
  skip?: ReadonlySet<MomentId>,
): NoteMoment | null {
  for (const m of piece.moments) {
    if (m.type === 'note' && !m.muted && !skip?.has(m.id) && Math.abs(m.at - at) <= JOIN_T) {
      return m;
    }
  }
  return null;
}

/** `m` with `patch`'s fields set (`undefined` removes them). */
function withFields(m: NoteMoment, patch: Partial<NoteMoment>): NoteMoment {
  const out: Record<string, unknown> = { ...m };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as NoteMoment;
}

function replaceMoment(p: Piece, m: Moment): Piece {
  return { ...p, moments: p.moments.map((x) => (x.id === m.id ? m : x)) };
}

/** The note part of `moveDots`: changes edited in place, moved, joined or split off. */
function moveNoteChanges(
  piece: Piece,
  moves: readonly DotMove[],
  groups: readonly { m: NoteMoment; idx: number[] }[],
  env: MoveEnv,
  hosts: MomentId[],
): Piece {
  let p = piece;
  interface Mover {
    change: NoteChange;
    at: Seconds;
    src: NoteMoment;
    move: number;
    pitched: boolean;
  }
  const movers: Mover[] = [];
  /** Moments every change of which moves: reused for their changes' new time, else removed. */
  const vacant = new Set<MomentId>();
  for (const { m, idx } of groups) {
    const list = noteChanges(m);
    const stay = list.map((c) => ({ from: c.from, to: c.to }));
    const moving = new Set<number>();
    let pitched = false;
    for (const i of idx) {
      const { dot, pitch, t } = moves[i];
      const c = dot.change ?? 0;
      if (c >= list.length || moving.has(c)) continue;
      const to = pitch !== dot.pitch ? pitch : list[c].to;
      const at = t !== dot.t ? roundUs(m.at + (t - dot.t)) : m.at;
      if (Math.abs(at - m.at) <= JOIN_T) {
        if (to !== stay[c].to) pitched = true;
        stay[c].to = to;
      } else {
        moving.add(c);
        movers.push({
          change: { from: list[c].from, to },
          at,
          src: m,
          move: i,
          pitched: to !== list[c].to,
        });
      }
    }
    const rest = stay.filter((_, c) => !moving.has(c));
    if (rest.length === 0) vacant.add(m.id);
    else {
      const changed = moving.size > 0 || pitched;
      if (changed) {
        p = replaceMoment(
          p,
          withFields(withNoteChanges(m, rest), pitched ? { order: env.order } : {}),
        );
      }
    }
  }
  // Movers by new time (in move order); each group joins, reuses its moment, or splits off.
  const byAt: Mover[][] = [];
  for (const mv of movers) {
    const g = byAt.find((x) => Math.abs(x[0].at - mv.at) <= JOIN_T);
    if (g) g.push(mv);
    else byAt.push([mv]);
  }
  const reused = new Set<MomentId>();
  let nextId = 0;
  for (const g of byAt) {
    const at = g[0].at;
    const changes = g.map((x) => x.change);
    const pitched = g.some((x) => x.pitched);
    const order = pitched ? { order: env.order } : {};
    const host = noteHostAt(p, at, vacant);
    let id: MomentId;
    if (host) {
      id = host.id;
      p = replaceMoment(
        p,
        withFields(withNoteChanges(host, [...noteChanges(host), ...changes]), order),
      );
    } else {
      const src = g[0].src;
      const own = g.every((x) => x.src === src) && vacant.has(src.id) && !reused.has(src.id);
      if (own) {
        id = src.id;
        reused.add(id);
        const cur = p.moments.find((x) => x.id === id) as NoteMoment;
        p = replaceMoment(p, withFields(withNoteChanges(cur, changes), order));
        p = patchMoment(p, id, { at }); // re-sorts by time
      } else {
        id = env.ids[nextId++] ?? `${src.id}-${nextId}`;
        const { id: _i, overrides: _o, label: _l, ...rest } = src;
        const fresh: NoteMoment = withFields(
          withNoteChanges(
            { ...rest, id, at, seed: momentSeed(piece.seed, src.id, src.seed) },
            changes,
          ),
          order,
        );
        p = insertMoments(p, [fresh]);
      }
    }
    for (const x of g) hosts[x.move] = id;
  }
  const gone = [...vacant].filter((id) => !reused.has(id));
  if (gone.length > 0) p = removeMoments(p, gone);
  return p;
}

/** A screen rectangle, CSS px, any corner order. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The dots of `dots` inside `r` (edges included), mapped to screen by `x`/`y`. */
export function dotsInRect(
  dots: readonly ArrivalDot[],
  r: Rect,
  x: (t: Seconds) => number,
  y: (p: Pitch) => number,
): ArrivalDot[] {
  const xl = Math.min(r.x0, r.x1);
  const xr = Math.max(r.x0, r.x1);
  const yt = Math.min(r.y0, r.y1);
  const yb = Math.max(r.y0, r.y1);
  return dots.filter((d) => {
    const dx = x(d.t);
    const dy = y(d.pitch);
    return dx >= xl && dx <= xr && dy >= yt && dy <= yb;
  });
}
