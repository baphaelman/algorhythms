/**
 * Recording a live take into moments (PLAN.md §9 "Recording", §17 "record into silence").
 *
 * - **Where.** A take starts at the playhead T₀ and replaces the piece from there (`takeBase`):
 *   moments at or after T₀ are removed, regions running past it are cut at T₀, and lines still
 *   sounding at T₀ are merged away (`merge` to 0, fading over TAKE_CUT_FADE), so the take is
 *   recorded into silence and played back the same way.
 * - **What.** Each press (core/live.ts MERGE_WINDOW: changes of H within 15 ms of the first one)
 *   becomes one moment at the live time its first change applied at (the worklet's stamped
 *   frame), decided as the press's last change was:
 *   - from silence: a `chord` with one pitch per live voice (`byVoice`, targeting the live
 *     voices) that establishes them on their notes, as live mode steps them there;
 *   - one note: `unison` (`octaves` per the single-note setting); several: `chord` with the held
 *     pitches (`exact`) or the voiced targets (`range`, which no NoteSet names), voicing `even`,
 *     the live assignment;
 *   - with the glide settings in effect (length, stagger, order, ease, together, no jitter) and
 *     the seed of its stagger-order draws;
 *   - a level ramp (a fade coming back) as a `level` moment after it.
 *   Releasing everything: `hold` writes nothing, `fade` a `level` to 0 over the release fade,
 *   `tonic` a `unison` on 'tonic'. A key from silence after a completed fade first merges the
 *   silent lines away (`merge` to 0 where the fade ended), so it establishes again.
 * - Bend and note velocity are not recorded (no moment holds them).
 */

import { compile } from './compiler/compile';
import type { LiveSettings, LiveUpdate } from './live';
import { lifeAt } from './query';
import type {
  ChordMoment,
  Glide,
  LevelMoment,
  MergeMoment,
  Moment,
  MomentId,
  Piece,
  Pitch,
  Seconds,
  UnisonMoment,
} from './types';

/** Fade of the lines a take cuts off at its start (s). */
export const TAKE_CUT_FADE: Seconds = 0.05;
/** A merge to 0 closes its lines this long before an establishing chord may reuse them (s). */
const CLOSE_GAP: Seconds = 0.001;

/** One posted live change, as recording needs it (src/audio/live-engine.ts LiveChange). */
export interface TakeChange {
  /** Seq of its press's first change. */
  press: number;
  /** Live time its press's first change applied at (s). */
  time: Seconds;
  held: readonly Pitch[];
  settings: Readonly<LiveSettings>;
  seed: number;
  update: LiveUpdate;
}

export interface TakeOptions {
  /** Piece time of the take start, and the live time it maps to. */
  at: Seconds;
  liveAt: Seconds;
  /** The live voices' ids, in live voice order. */
  voices: readonly string[];
  /** Earliest piece time a moment may have (after the take's cut-off fade). */
  earliest?: Seconds;
  newId: () => MomentId;
}

function glideOf(s: Readonly<LiveSettings>): Glide {
  return {
    length: s.glide,
    jitter: 0,
    stagger: s.stagger,
    arrive: 'together',
    order: s.order,
    ease: s.ease,
  };
}

/**
 * The moments of a take: `changes` in posting order (each press's changes together), already
 * stamped. The take starts in silence.
 */
export function takeMoments(changes: readonly TakeChange[], opts: TakeOptions): Moment[] {
  const out: Moment[] = [];
  const finals: TakeChange[] = [];
  for (const c of changes) {
    const last = finals[finals.length - 1];
    if (last && last.press === c.press) finals[finals.length - 1] = c;
    else finals.push(c);
  }
  let sounding = false;
  let fadeEnd = -Infinity;
  let prevT = -Infinity;
  for (const c of finals) {
    const u = c.update;
    if (u.moves.length === 0 && u.level === null) continue;
    let T = opts.at + (c.time - opts.liveAt);
    if (opts.earliest !== undefined && T < opts.earliest) T = opts.earliest;
    if (T < prevT) T = prevT;
    const lastAt = prevT;
    prevT = T;
    const s = c.settings;
    const base = { id: '', at: T };
    if (u.silent && u.targets) {
      if (sounding) {
        const m: MergeMoment = {
          ...base,
          id: opts.newId(),
          type: 'merge',
          at: Math.max(lastAt, Math.min(fadeEnd, T - CLOSE_GAP)),
          count: 0,
          which: 'outer',
          fade: 0,
        };
        out.push(m);
      }
      const m: ChordMoment = {
        ...base,
        id: opts.newId(),
        type: 'chord',
        target: { voices: [...opts.voices] },
        notes: { kind: 'pitches', pitches: [...u.targets] },
        byVoice: true,
        voicing: 'even',
        assign: s.assign,
        glide: glideOf(s),
      };
      out.push(m);
      sounding = true;
      continue;
    }
    if (c.held.length > 0 && u.targets) {
      if (c.held.length === 1) {
        const m: UnisonMoment = {
          ...base,
          id: opts.newId(),
          type: 'unison',
          pitch: c.held[0],
          octaves: s.single === 'octaves',
          glide: glideOf(s),
          seed: c.seed,
        };
        out.push(m);
      } else {
        const pitches =
          s.chord === 'range'
            ? [...new Set(u.targets)].sort((a, b) => a - b)
            : [...c.held].sort((a, b) => a - b);
        const m: ChordMoment = {
          ...base,
          id: opts.newId(),
          type: 'chord',
          notes: { kind: 'pitches', pitches },
          voicing: 'even',
          assign: s.assign,
          glide: glideOf(s),
          seed: c.seed,
        };
        out.push(m);
      }
    } else if (u.targets) {
      // Release 'tonic'.
      const m: UnisonMoment = {
        ...base,
        id: opts.newId(),
        type: 'unison',
        pitch: 'tonic',
        octaves: s.single === 'octaves',
        glide: glideOf(s),
        seed: c.seed,
      };
      out.push(m);
    }
    if (u.level) {
      const m: LevelMoment = {
        ...base,
        id: opts.newId(),
        type: 'level',
        gain: u.level.gain,
        over: u.level.over,
      };
      out.push(m);
      fadeEnd = u.level.gain <= 0 ? T + u.level.over : Infinity;
    }
  }
  return out;
}

/** `m` cut to end by T (null: nothing of it is left before T). */
function cutMoment(m: Moment, T: Seconds): Moment | null {
  if (m.at >= T) return null;
  switch (m.type) {
    case 'walk':
    case 'pulse':
      return m.until > T ? { ...m, until: T } : m;
    case 'tune': {
      let t = m.at;
      const notes = [];
      for (const n of m.notes) {
        if (t >= T) break;
        notes.push(t + n.len > T ? { ...n, len: T - t } : n);
        t += n.len;
      }
      return notes.length > 0 ? { ...m, notes } : null;
    }
    case 'progression': {
      let t = m.at;
      const chords = [];
      for (const c of m.chords) {
        if (t >= T) break;
        chords.push(t + c.len > T ? { ...c, len: T - t } : c);
        t += c.len;
      }
      return chords.length > 0 ? { ...m, chords } : null;
    }
    default:
      return m;
  }
}

/**
 * The piece a take starting at T is recorded onto: everything from T on removed, regions cut at
 * T, and a `merge` to 0 at T when lines would still sound there (they fade over TAKE_CUT_FADE).
 * `silentFrom` is when the take may first sound.
 */
export function takeBase(
  piece: Piece,
  T: Seconds,
  newId: () => MomentId,
): { piece: Piece; silentFrom: Seconds } {
  const moments: Moment[] = [];
  for (const m of piece.moments) {
    const c = cutMoment(m, T);
    if (c) moments.push(c);
  }
  const cut: Piece = { ...piece, moments, end: { ...piece.end } };
  delete cut.end.at;
  // Lines sound at T if the take extends the piece past it.
  const probe = compile({ ...cut, end: { ...cut.end, at: T + 1 } });
  const sounding = probe.voices.some((v) => lifeAt(v, T) !== null);
  if (!sounding) return { piece: cut, silentFrom: T };
  const merge: MergeMoment = {
    id: newId(),
    type: 'merge',
    at: T,
    count: 0,
    which: 'outer',
    fade: TAKE_CUT_FADE,
  };
  return {
    piece: { ...cut, moments: [...moments, merge] },
    silentFrom: T + TAKE_CUT_FADE + CLOSE_GAP,
  };
}
