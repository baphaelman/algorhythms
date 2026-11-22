/**
 * Does a moment change anything at its time? (PLAN.md §7.9 `no-effect`, §11.3 palette; revision 6.)
 *
 * A moment has no effect when no voice's pitch target changes, the count changes only by unison
 * doublings (a death whose pitch a survivor keeps sounding, as in a merge on a unison; a birth on
 * its parent's pitch), and no level, key or timbre changes. A timbre moment (M6) acts on silent
 * voices too, so it has an effect from silence. Unison voices sound as one (§8.4 lock), so such
 * count changes are not heard.
 *
 * From silence only an establishing moment (a chord with notes, a unison; moments/establish.ts)
 * has an effect.
 *
 * The compiler (compile.ts) checks every applied moment against its own state. `momentEffectAt`
 * answers the same question for the palette from a compiled score, without recompiling: it reads
 * the state at t (sounding voices and where they are heading, the key, the levels) and runs the
 * moment's function (moments/) on it.
 */

import { defaultGlide } from './defaults';
import { pitchClassOf, scalePcs } from './scales';
import { foldIntoRange, sanitizeRange } from './compiler/range';
import { decisionTime, momentGlide, sanitizeGlide } from './compiler/glide';
import { pointMomentPlan } from './moments/dispatch';
import { bringsIn, establishPlan, isEstablishing } from './moments/establish';
import { noteIsNoop } from './moments/note';
import { IntentKind, type MomentEnv } from './moments/types';
import { countsLines } from './compiler/lines';
import { keyAt, lifeAt, pitchAt, segmentIndexAt, stackAt } from './query';
import { isRest, tuneRestrikes, tuneShift } from './moments/tune';
import { progressionChords } from './moments/progression';
import { inPartScope, partOf, partScope, scopeName } from './parts';
import { hash32, momentSeed, randHashed } from './rng';
import type {
  CompiledScore,
  Key,
  Moment,
  MomentType,
  Piece,
  Pitch,
  Seconds,
  VoiceSelector,
} from './types';

/** Pitches closer than this are the same (semitones). */
export const EFFECT_EPS = 1e-6;

/**
 * The palette's moment types, in palette order. `pulse` and `tune` (revision 9) and `timbre`
 * (M6) are not listed until the editor can make them; `momentEffectAt` handles them already.
 */
export const EFFECT_MOMENT_TYPES: readonly MomentType[] = [
  'chord',
  'unison',
  'split',
  'merge',
  'shift',
  'spread',
  'walk',
  'note',
  'pin',
  'key',
  'level',
];

const same = (a: Pitch, b: Pitch): boolean => Math.abs(a - b) <= EFFECT_EPS;

/** A point moment's pitch outcome, per pool index. */
export interface PitchOutcome {
  /** Committed destination before the moment; NaN when not active. */
  before: ArrayLike<number>;
  /** After it; newborns included, dying voices NaN. */
  after: ArrayLike<number>;
  /** Voices the moment kills, and where their death glide ends. */
  deaths: readonly { voice: number; to: Pitch }[];
  /** Voices the moment births, and their parents (−1: none). */
  births: readonly { voice: number; parent: number }[];
}

/** True if the outcome changes a pitch target or what sounds (see the module comment). */
export function changesPitch(o: PitchOutcome): boolean {
  const { before, after } = o;
  const n = before.length;
  for (let v = 0; v < n; v++) {
    const b = before[v];
    const a = after[v];
    const wasOn = b === b;
    const isOn = a === a;
    if (wasOn && isOn) {
      if (!same(a, b)) return true;
    } else if (wasOn) {
      const d = o.deaths.find((x) => x.voice === v);
      if (!d || !same(d.to, b)) return true;
      let kept = false;
      for (let u = 0; u < n && !kept; u++) kept = after[u] === after[u] && same(after[u], b);
      if (!kept) return true;
    } else if (isOn) {
      const bt = o.births.find((x) => x.voice === v);
      if (!bt || bt.parent < 0) return true;
      const pb = before[bt.parent];
      if (!(pb === pb && same(a, pb))) return true;
    }
  }
  return false;
}

/** Number of distinct pitches (within EFFECT_EPS). */
export function distinctPitches(ps: readonly Pitch[]): number {
  const s = ps.filter((p) => p === p).sort((a, b) => a - b);
  let k = s.length > 0 ? 1 : 0;
  for (let i = 1; i < s.length; i++) if (!same(s[i], s[i - 1])) k++;
  return k;
}

/** What `noEffectReason` needs to know about the state before the moment. */
export interface EffectContext {
  /** Committed destinations of the targeted voices. */
  targeted: readonly Pitch[];
  /** Committed destinations of every active voice. */
  active: readonly Pitch[];
  /** Voices born and killed by the moment. */
  births: number;
  deaths: number;
  /** Dormant pool voices available to a split. */
  dormant: number;
}

/** Why a moment with no effect has none, for the `no-effect` message and the palette. */
export function noEffectReason(m: Moment, c: EffectContext): string {
  if (m.type === 'tune' && m.notes.length === 0) return 'the tune has no notes';
  // Silent voices count for a timbre change; the compiler raises `no-targets` when it has none.
  if (m.type === 'timbre') return 'the notes already have this timbre';
  const n = c.active.length;
  // A silent part (composing.md §3 #4): a chord, unison or tune brings it in.
  const scope = partScope(m.target);
  if (n === 0 && scope !== null && m.type !== 'key' && m.type !== 'level' && m.type !== 'pulse') {
    const name = scopeName(scope);
    const is = scope.names.length === 1 && !scope.except ? 'is' : 'are';
    return c.dormant === 0 && bringsIn(m)
      ? `${name} ${is} silent here and ${is === 'is' ? 'has' : 'have'} no free voice`
      : `${name} ${is} silent here; bring ${is === 'is' ? 'it' : 'them'} in with a chord, a unison or a tune`;
  }
  if (n === 0 && m.type !== 'key') {
    // Nothing sounds yet (M4.5-27): only a chord or a unison can start the sound.
    return isEstablishing(m) || m.type === 'level' || m.type === 'pulse'
      ? 'no note is sounding'
      : 'no note is sounding; start with a chord or a unison';
  }
  if (c.targeted.length === 0 && m.type !== 'key' && m.type !== 'split' && m.type !== 'merge') {
    return 'it targets no sounding note';
  }
  const onePitch = distinctPitches(c.targeted) <= 1;
  switch (m.type) {
    case 'unison':
      return c.targeted.length === 1
        ? 'the note is already on that pitch'
        : onePitch
          ? 'all notes already on one pitch'
          : 'the notes are already there';
    case 'merge':
      if (c.deaths === 0) {
        return n === 1 ? 'only one note is sounding' : `only ${n} notes are sounding`;
      }
      return distinctPitches(c.active) === 1
        ? 'all notes already on one pitch'
        : 'the merging notes already double the notes they merge into';
    case 'split':
      if (c.births === 0) {
        return c.dormant === 0
          ? 'every pool note is already sounding'
          : `${n} notes are already sounding`;
      }
      return 'the new notes only double their parents';
    case 'shift':
      return m.by === 0 ? 'shift by 0' : 'no note moves';
    case 'spread':
      if (c.targeted.length === 1) return 'only one note is sounding';
      if (onePitch) return 'all notes already on one pitch';
      return m.factor === 1 ? 'factor 1' : 'no note moves';
    case 'chord':
      return 'the notes already sound this chord';
    case 'note':
      return noteIsNoop(m) ? 'the note does not change' : 'no note moves';
    case 'pin':
      return 'the note is already on that pitch';
    case 'key':
      return 'the piece is already in this key';
    case 'level':
      return 'the notes are already at this level';
    case 'walk':
      return 'no note is sounding';
    case 'pulse':
      return 'it targets no sounding note';
    case 'tune':
      return 'the line already plays every note of the tune';
    case 'progression':
      return m.chords.length === 0
        ? 'the progression has no chords'
        : 'the notes already sound these chords';
  }
}

/**
 * A timbre moment's voices in a compiled score (as compile.ts `timbreTargets`): pool voices,
 * sounding or not; `{ rank }` picks sounding voices (`active`, in pitch order).
 */
function timbreTargetsIn(piece: Piece, m: Moment, active: readonly number[]): number[] {
  const sel = m.target;
  const n = piece.voices.length;
  const all = Array.from({ length: n }, (_, v) => v);
  if (typeof sel === 'object' && sel !== null && 'rank' in sel && Array.isArray(sel.rank)) {
    const a = Number(sel.rank[0]);
    const b = Number(sel.rank[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    const lo = Math.max(0, Math.ceil(Math.min(a, b)));
    const hi = Math.min(active.length - 1, Math.floor(Math.max(a, b)));
    return lo <= hi ? active.slice(lo, hi + 1) : [];
  }
  if (typeof sel === 'object' && sel !== null && 'voices' in sel && Array.isArray(sel.voices)) {
    const want = new Set(sel.voices);
    return all.filter((v) => want.has(piece.voices[v].id));
  }
  const scope = partScope(sel);
  return all.filter((v) => inPartScope(scope, partOf(piece.voices[v])));
}

/** The preset a voice's timbre timeline is heading for at `t` (entries at `t` included). */
function timbreAt(score: CompiledScore, v: number, t: Seconds): string | undefined {
  let preset: string | undefined;
  for (const c of score.voices[v]?.timbre ?? []) if (c.t <= t) preset = c.preset;
  return preset;
}

/** Same key: same tonic pitch class and scale. */
export function sameKey(a: Key, b: Key): boolean {
  if (pitchClassOf(a.tonic) !== pitchClassOf(b.tonic)) return false;
  const x = scalePcs(a);
  const y = scalePcs(b);
  return x.length === y.length && x.every((p, i) => p === y[i]);
}

// ---------------------------------------------------------------------------------------------
// Palette: the effect of a new moment at t, from a compiled score
// ---------------------------------------------------------------------------------------------

export interface MomentEffect {
  effect: boolean;
  /** Why not, when `effect` is false. */
  reason?: string;
}

/** The state of a compiled score at t, as a moment at t would see it. */
export interface StateAt {
  t: Seconds;
  key: Key;
  /** Per pool index: where the voice is heading; NaN when not active. */
  dest: Float64Array;
  /** Active voices sorted by destination (ties: pool index). */
  active: number[];
  /** Voices a split may birth. */
  dormant: number[];
  /** Per pool index: the voice's level target at t. */
  level: Float64Array;
  /** Revision 8: the line each (logical) voice belongs to; identity on lines. */
  base: number[];
  /**
   * Revision 8: the same state with each line listed as many times as the voices it stands for
   * (`stack`), as the compiler's moments without a count see it (compiler/lines.ts): its phantoms
   * take dormant pool indices, then indices ≥ the pool size. Absent when no line is stacked.
   */
  stacked?: StateAt;
}

const EMPTY_CONTEXT: EffectContext = { targeted: [], active: [], births: 0, deaths: 0, dormant: 0 };

/** True for moment types that can end a voice's life (§7.4). */
const kills = (m: Moment): boolean =>
  m.type === 'merge' || ((m.type === 'chord' || m.type === 'progression') && m.count !== undefined);

/** The state at t from a compiled score (no recompile); see `momentEffectAt`. */
export function readState(piece: Piece, score: CompiledScore, t: Seconds): StateAt {
  const byId = new Map<string, Moment>();
  for (const m of piece.moments) if (m && !m.muted) byId.set(m.id, m);
  // Moments decided by t (a land moment decides at its lead-in start, revision 9).
  const defaults = sanitizeGlide(piece.defaults?.glide, defaultGlide());
  const decided = new Map<string, boolean>();
  const isDecided = (m: Moment): boolean => {
    let d = decided.get(m.id);
    if (d === undefined) decided.set(m.id, (d = decisionTime(m, defaults) <= t));
    return d;
  };
  const scheduled = (id: string | undefined): boolean => {
    const m = id === undefined ? undefined : byId.get(id);
    // Walk steps, tune notes and progression chords are decided where their moves start, so
    // later ones are not scheduled yet at t.
    if (!m || !isDecided(m)) return false;
    return m.type !== 'walk' && m.type !== 'tune' && m.type !== 'progression';
  };
  const n = score.voices.length;
  const dest = new Float64Array(n).fill(NaN);
  const level = new Float64Array(n).fill(1);
  const dormant: number[] = [];
  score.voices.forEach((v, i) => {
    for (const l of v.level) if (l.t <= t) level[i] = l.gain;
    const life = lifeAt(v, t);
    if (!life) {
      dormant.push(i);
      return;
    }
    const end = life.died ?? Infinity;
    // Fading out (a merge, or a line that arrived on another's pitch, revision 8). A merge's
    // crossfade ends where the line meets the merged one: it is active until then.
    if (end < score.duration && !life.crossOut && t >= end - (life.fadeOut ?? 0)) return;
    const segs = v.segments;
    // Dying: the life ends before the piece does, and its last move belongs to a moment at ≤ t
    // that kills (a merge, or a chord with `count`).
    if (end < score.duration) {
      let j = segmentIndexAt(v, end);
      while (j >= 0 && segs[j].t0 >= end) j--;
      for (; j >= 0 && segs[j].t0 >= life.born; j--) {
        const id = segs[j].momentId;
        if (id === undefined) continue;
        const m = byId.get(id);
        if (m && kills(m) && isDecided(m)) return;
        break;
      }
    }
    // Where it is heading: the segment at t, then the moves already scheduled by moments at ≤ t
    // (staggered starts after t); holds are transparent.
    let j = segmentIndexAt(v, t);
    if (j < 0) return;
    const at = segs[j];
    let d = at.curve ? at.curve.p1 : at.p1;
    for (j++; j < segs.length && segs[j].t0 < end; j++) {
      const s = segs[j];
      const hold = s.p0 === s.p1 && !s.m0 && !s.curve;
      if (scheduled(s.momentId)) d = s.curve ? s.curve.p1 : s.p1;
      else if (!hold) break;
    }
    dest[i] = d;
  });
  const lines: number[] = [];
  for (let i = 0; i < n; i++) if (dest[i] === dest[i]) lines.push(i);
  const identity: number[] = [];
  for (let i = 0; i < n; i++) identity.push(i);
  const key = keyAt(score, t);
  const flat: StateAt = {
    t,
    key,
    dest,
    active: lines.slice().sort((a, b) => dest[a] - dest[b] || a - b),
    dormant: dormant.slice(),
    level,
    base: identity,
  };
  // Stacked voices of lines that stand for several (revision 8), for moments without a count.
  const extra: { b: number; u: number }[] = [];
  const free = dormant.slice();
  let synth = n;
  for (const b of lines) {
    for (let j = stackAt(score.voices[b], t); j > 1; j--) {
      // A phantom is a dormant voice of the line's part (revision 9; compiler/lines.ts).
      const k = free.findIndex((v) => partOf(piece.voices[v]) === partOf(piece.voices[b]));
      const u = k >= 0 ? free.splice(k, 1)[0] : synth++;
      extra.push({ b, u });
    }
  }
  if (extra.length === 0) return flat;
  const base = identity.slice();
  const all = new Float64Array(synth).fill(NaN);
  all.set(dest);
  const lvl = new Float64Array(synth).fill(1);
  lvl.set(level);
  for (const { b, u } of extra) {
    all[u] = all[b];
    lvl[u] = level[b];
    base[u] = b;
  }
  const active: number[] = [];
  for (let i = 0; i < all.length; i++) if (all[i] === all[i]) active.push(i);
  active.sort((a, b) => all[a] - all[b] || a - b);
  return {
    ...flat,
    stacked: { t, key, dest: all, active, dormant: free, level: lvl, base },
  };
}

function resolveTarget(
  sel: VoiceSelector | undefined,
  st: StateAt,
  indexOf: (id: string) => number,
  partAt: (v: number) => string,
): number[] {
  const active = st.active;
  const scope = partScope(sel);
  if (scope !== null) return active.filter((v) => inPartScope(scope, partAt(v)));
  if (sel === undefined || sel === 'all') return active.slice();
  if (typeof sel === 'object' && 'voices' in sel && Array.isArray(sel.voices)) {
    const want = new Set(sel.voices.map(indexOf));
    return active.filter((v) => want.has(v));
  }
  if (typeof sel === 'object' && 'rank' in sel && Array.isArray(sel.rank)) {
    const a = Number(sel.rank[0]);
    const b = Number(sel.rank[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    const lo = Math.max(0, Math.ceil(Math.min(a, b)));
    const hi = Math.min(active.length - 1, Math.floor(Math.max(a, b)));
    return lo <= hi ? active.slice(lo, hi + 1) : [];
  }
  return active.slice();
}

function effectOn(piece: Piece, score: CompiledScore, st0: StateAt, m: Moment): MomentEffect {
  if (m.type === 'progression') {
    // Its first chord decides at its time; a second, different chord always moves something.
    const chords = progressionChords(m, piece.seed);
    if (chords.length === 0) return { effect: false, reason: noEffectReason(m, EMPTY_CONTEXT) };
    const first = effectOn(piece, score, st0, chords[0]);
    return first.effect || new Set(m.chords.map((c) => c.notes.trim())).size > 1
      ? { effect: true }
      : first;
  }
  // Moments with a count count lines; the others see stacked voices (compiler/lines.ts).
  const st = countsLines(m) ? st0 : (st0.stacked ?? st0);
  const no = (reason: string): MomentEffect => ({ effect: false, reason });
  const ids = score.voices.map((v) => v.id);
  for (let u = ids.length; u < st.dest.length; u++) ids.push(`${ids[st.base[u]]}~${u}`);
  const indexOf = (id: string): number => ids.indexOf(id);
  const partAt = (v: number): string => partOf(piece.voices[st.base[v]]);
  const targeted =
    m.type === 'pin'
      ? st.active.filter((v) => ids[v] === m.voice)
      : resolveTarget(m.target, st, indexOf, partAt);
  // A `{ part }` target sees that part only (as the compiler's env, revision 9).
  const scope = partScope(m.target);
  const active = st.active.filter((v) => inPartScope(scope, partAt(v)));
  const dormant = st.dormant.filter((v) => inPartScope(scope, partOf(piece.voices[v])));
  const ctx = (births = 0, deaths = 0): EffectContext => ({
    targeted: targeted.map((v) => st.dest[v]),
    active: active.map((v) => st.dest[v]),
    births,
    deaths,
    dormant: dormant.length,
  });
  switch (m.type) {
    case 'timbre': {
      const vs = timbreTargetsIn(piece, m, st0.active);
      if (vs.length === 0) return no('it targets no note');
      return vs.some((v) => timbreAt(score, v, m.at) !== m.preset)
        ? { effect: true }
        : no(noEffectReason(m, ctx()));
    }
    case 'key':
      return sameKey(m.key, st.key) ? no(noEffectReason(m, ctx())) : { effect: true };
    case 'level':
      return targeted.some((v) => st.level[v] !== m.gain)
        ? { effect: true }
        : no(noEffectReason(m, ctx()));
    case 'walk':
    case 'pulse':
      return targeted.length > 0 ? { effect: true } : no(noEffectReason(m, ctx()));
    default:
  }
  const ranges = ids.map((_, u) => {
    const def = piece.voices[st.base[u] === u ? u : st.base[u]];
    const own = piece.voices[u];
    return sanitizeRange((u < piece.voices.length ? own : def)?.range ?? [0, 127]);
  });
  if (m.type === 'tune') {
    // The tune's line: the lowest (or with line 'high' the highest) of the target in pitch order.
    // It has an effect if some note (folded into its range) is not where the line is heading.
    if (m.notes.length === 0) return no(noEffectReason(m, ctx()));
    if (targeted.length === 0) {
      // On a silent part its first note brings a line in (composing.md §3 #4).
      const enters =
        scope !== null &&
        active.length === 0 &&
        establishPlan(m, envFor(piece, score, st, m, targeted, active, dormant, ids, ranges)) !==
          null;
      return enters ? { effect: true } : no(noEffectReason(m, ctx()));
    }
    const v = m.line === 'high' ? targeted[targeted.length - 1] : targeted[0];
    const r = ranges[v] ?? [0, 127];
    // Revision 10: a rest silences the line, a repeated note re-strikes; notes sound shifted.
    const shift = tuneShift(m.writtenIn, st.key);
    const moves = m.notes.some(
      (x, k) =>
        isRest(x) ||
        tuneRestrikes(m, k) ||
        (Number.isFinite(x.pitch) &&
          !same(foldIntoRange(x.pitch + shift, r[0], r[1]).p, st.dest[v])),
    );
    return moves ? { effect: true } : no(noEffectReason(m, ctx()));
  }
  const errors: string[] = [];
  const env = envFor(piece, score, st, m, targeted, active, dormant, ids, ranges, errors);
  // From silence only an establishing moment acts (M4.5-27); later one brings a silent part in
  // (composing.md §3 #4; a chord with `count` births by itself).
  const enters =
    scope !== null &&
    active.length === 0 &&
    isEstablishing(m) &&
    !(m.type === 'chord' && m.count !== undefined);
  const plan =
    st.active.length > 0 && !enters
      ? pointMomentPlan(m, env)
      : isEstablishing(m)
        ? establishPlan(m, env)
        : null;
  if (errors.length > 0) return no(errors[0]);
  if (!plan) return no(noEffectReason(m, ctx()));
  const after = Float64Array.from(st.dest);
  const deaths: { voice: number; to: Pitch }[] = [];
  const births: { voice: number; parent: number }[] = [];
  for (const it of plan.intents) {
    const r = ranges[it.voice] ?? [0, 127];
    const to = Number.isFinite(it.to) ? foldIntoRange(it.to, r[0], r[1]).p : st.dest[it.voice];
    if (it.kind === IntentKind.Death) {
      deaths.push({ voice: it.voice, to });
      after[it.voice] = NaN;
    } else {
      if (it.kind === IntentKind.Birth) births.push({ voice: it.voice, parent: it.parent ?? -1 });
      after[it.voice] = to;
    }
  }
  return changesPitch({ before: st.dest, after, deaths, births })
    ? { effect: true }
    : no(noEffectReason(m, ctx(births.length, deaths.length)));
}

/** The moment env of `m` on state `st` (as the compiler's); errors and `note-not-sounding` go to `errors`. */
function envFor(
  piece: Piece,
  score: CompiledScore,
  st: StateAt,
  m: Moment,
  targeted: readonly number[],
  active: readonly number[],
  dormant: readonly number[],
  ids: readonly string[],
  ranges: readonly (readonly [Pitch, Pitch])[],
  errors: string[] = [],
): MomentEnv {
  const seed = momentSeed(piece.seed, m.id, m.seed);
  const emptyHash = hash32('');
  const hashes = ids.map((id) => hash32(id));
  return {
    t: st.t,
    momentId: m.id,
    key: st.key,
    seed,
    glide: momentGlide(sanitizeGlide(piece.defaults?.glide, defaultGlide()), m),
    targeted,
    active,
    dest: (v) => st.dest[v],
    now: (v) =>
      st.dest[v] === st.dest[v] ? (pitchAt(score.voices[st.base[v]], st.t) ?? NaN) : NaN,
    range: (v) => ranges[v] ?? [0, 127],
    id: (v) => ids[v],
    part: (v) => partOf(piece.voices[st.base[v]]),
    sounding: (v) => st.dest[v] === st.dest[v],
    dormant: () => dormant.slice(),
    indexOf: (id) => ids.indexOf(id),
    diag: (level, code, message) => {
      if (level === 'error' || code === 'note-not-sounding') errors.push(message);
    },
    rand: (v, step, purpose) => randHashed(seed, v >= 0 ? hashes[v] : emptyHash, step, purpose),
  };
}

/**
 * Would adding `m` at `m.at` change anything? Reads the state where the compiler would decide it
 * from `score` (the compiled `piece`), without recompiling.
 */
export function momentEffectAt(piece: Piece, score: CompiledScore, m: Moment): MomentEffect {
  return effectOn(piece, score, stateFor(piece, score, m, new Map()), m);
}

/**
 * The state moment `m` decides on: at `m.at`, or for a land moment (revision 9) at its lead-in
 * start with the key in effect at `m.at`; a land moment that finds nothing sounding there acts at
 * `m.at` (compile.ts SUB_LANDED). `cache`: states by time.
 */
function stateFor(
  piece: Piece,
  score: CompiledScore,
  m: Moment,
  cache: Map<Seconds, StateAt>,
): StateAt {
  const read = (t: Seconds): StateAt => {
    let st = cache.get(t);
    if (!st) cache.set(t, (st = readState(piece, score, t)));
    return st;
  };
  const t = decisionTime(m, sanitizeGlide(piece.defaults?.glide, defaultGlide()));
  if (!(t < m.at)) return read(m.at);
  const st = read(t);
  if (st.active.length === 0) return read(m.at);
  const key = keyAt(score, m.at);
  return { ...st, key, stacked: st.stacked && { ...st.stacked, key } };
}

/**
 * For the palette (§11.3): for each moment type, whether a new moment of that type at t would
 * have an effect, and why not. `make` builds the new moment with its default fields (the editor's
 * `defaultMoment`).
 */
export function momentEffectsAt(
  piece: Piece,
  score: CompiledScore,
  t: Seconds,
  make: (type: MomentType, at: Seconds) => Moment,
): Record<MomentType, MomentEffect> {
  // Only EFFECT_MOMENT_TYPES are filled (no `pulse` yet).
  const cache = new Map<Seconds, StateAt>();
  const out = {} as Record<MomentType, MomentEffect>;
  for (const type of EFFECT_MOMENT_TYPES) {
    const m = make(type, t);
    out[type] = effectOn(piece, score, stateFor(piece, score, m, cache), m);
  }
  return out;
}
