/**
 * Does a moment change anything at its time? (PLAN.md §7.9 `no-effect`, §11.3 palette; revision 6.)
 *
 * A moment has no effect when no voice's pitch target changes, the count changes only by unison
 * doublings (a death whose pitch a survivor keeps sounding, as in a merge on a unison; a birth on
 * its parent's pitch), and no level or key changes. Unison voices sound as one (§8.4 lock), so such
 * count changes are not heard.
 *
 * The compiler (compile.ts) checks every applied moment against its own state. `momentEffectAt`
 * answers the same question for the palette from a compiled score, without recompiling: it reads
 * the state at t (sounding voices and where they are heading, the key, the levels) and runs the
 * moment's function (moments/) on it.
 */

import { defaultGlide } from './defaults';
import { pitchClassOf, scalePcs } from './scales';
import { foldIntoRange, sanitizeRange } from './compiler/range';
import { mergeGlide, sanitizeGlide } from './compiler/glide';
import { pointMomentPlan } from './moments/dispatch';
import { noteIsNoop } from './moments/note';
import { IntentKind, type MomentEnv } from './moments/types';
import { countsLines } from './compiler/lines';
import { keyAt, lifeAt, pitchAt, segmentIndexAt, stackAt } from './query';
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

/** Every v1 moment type, in palette order. */
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
  const n = c.active.length;
  if (n === 0 && m.type !== 'key') return 'no voice is sounding';
  if (c.targeted.length === 0 && m.type !== 'key' && m.type !== 'split' && m.type !== 'merge') {
    return 'it targets no sounding voice';
  }
  const onePitch = distinctPitches(c.targeted) <= 1;
  switch (m.type) {
    case 'unison':
      return c.targeted.length === 1
        ? 'the voice is already on that pitch'
        : onePitch
          ? 'all voices already on one pitch'
          : 'the voices are already there';
    case 'merge':
      if (c.deaths === 0) {
        return n === 1 ? 'only one voice is sounding' : `only ${n} voices are sounding`;
      }
      return distinctPitches(c.active) === 1
        ? 'all voices already on one pitch'
        : 'the merging voices already double the voices they merge into';
    case 'split':
      if (c.births === 0) {
        return c.dormant === 0
          ? 'every pool voice is already sounding'
          : `${n} voices are already sounding`;
      }
      return 'the new voices only double their parents';
    case 'shift':
      return m.by === 0 ? 'shift by 0' : 'no voice moves';
    case 'spread':
      if (c.targeted.length === 1) return 'only one voice is sounding';
      if (onePitch) return 'all voices already on one pitch';
      return m.factor === 1 ? 'factor 1' : 'no voice moves';
    case 'chord':
      return 'the voices already sound this chord';
    case 'note':
      return noteIsNoop(m) ? 'the note does not change' : 'no voice moves';
    case 'pin':
      return 'the voice is already on that pitch';
    case 'key':
      return 'the piece is already in this key';
    case 'level':
      return 'the voices are already at this level';
    case 'walk':
      return 'no voice is sounding';
  }
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

/** True for moment types that can end a voice's life (§7.4). */
const kills = (m: Moment): boolean =>
  m.type === 'merge' || (m.type === 'chord' && m.count !== undefined);

/** The state at t from a compiled score (no recompile); see `momentEffectAt`. */
export function readState(piece: Piece, score: CompiledScore, t: Seconds): StateAt {
  const byId = new Map<string, Moment>();
  for (const m of piece.moments) if (m && !m.muted) byId.set(m.id, m);
  const scheduled = (id: string | undefined): boolean => {
    const m = id === undefined ? undefined : byId.get(id);
    return !!m && m.type !== 'walk' && m.at <= t;
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
    // Fading out (a merge, or a line that arrived on another's pitch, revision 8).
    if (end < score.duration && t >= end - (life.fadeOut ?? 0)) return;
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
        if (m && kills(m) && m.at <= t) return;
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
      const u = free.length > 0 ? free.shift()! : synth++;
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
): number[] {
  const active = st.active;
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
  // Moments with a count count lines; the others see stacked voices (compiler/lines.ts).
  const st = countsLines(m) ? st0 : (st0.stacked ?? st0);
  const no = (reason: string): MomentEffect => ({ effect: false, reason });
  const ids = score.voices.map((v) => v.id);
  for (let u = ids.length; u < st.dest.length; u++) ids.push(`${ids[st.base[u]]}~${u}`);
  const indexOf = (id: string): number => ids.indexOf(id);
  const targeted =
    m.type === 'pin'
      ? st.active.filter((v) => ids[v] === m.voice)
      : resolveTarget(m.target, st, indexOf);
  const ctx = (births = 0, deaths = 0): EffectContext => ({
    targeted: targeted.map((v) => st.dest[v]),
    active: st.active.map((v) => st.dest[v]),
    births,
    deaths,
    dormant: st.dormant.length,
  });
  switch (m.type) {
    case 'key':
      return sameKey(m.key, st.key) ? no(noEffectReason(m, ctx())) : { effect: true };
    case 'level':
      return targeted.some((v) => st.level[v] !== m.gain)
        ? { effect: true }
        : no(noEffectReason(m, ctx()));
    case 'walk':
      return targeted.length > 0 ? { effect: true } : no(noEffectReason(m, ctx()));
    default:
  }
  const seed = momentSeed(piece.seed, m.id, m.seed);
  const emptyHash = hash32('');
  const hashes = ids.map((id) => hash32(id));
  const ranges = ids.map((_, u) => {
    const def = piece.voices[st.base[u] === u ? u : st.base[u]];
    const own = piece.voices[u];
    return sanitizeRange((u < piece.voices.length ? own : def)?.range ?? [0, 127]);
  });
  let error: string | null = null;
  const env: MomentEnv = {
    t: st.t,
    momentId: m.id,
    key: st.key,
    seed,
    glide: mergeGlide(sanitizeGlide(piece.defaults?.glide, defaultGlide()), m.glide),
    targeted,
    active: st.active,
    dest: (v) => st.dest[v],
    now: (v) =>
      st.dest[v] === st.dest[v] ? (pitchAt(score.voices[st.base[v]], st.t) ?? NaN) : NaN,
    range: (v) => ranges[v] ?? [0, 127],
    id: (v) => ids[v],
    sounding: (v) => st.dest[v] === st.dest[v],
    dormant: () => st.dormant.slice(),
    indexOf,
    diag: (level, code, message) => {
      if ((level === 'error' || code === 'note-not-sounding') && error === null) error = message;
    },
    rand: (v, step, purpose) => randHashed(seed, v >= 0 ? hashes[v] : emptyHash, step, purpose),
  };
  const plan = pointMomentPlan(m, env);
  if (error !== null) return no(error);
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

/**
 * Would adding `m` at `m.at` change anything? Reads the state at that time from `score` (the
 * compiled `piece`), without recompiling.
 */
export function momentEffectAt(piece: Piece, score: CompiledScore, m: Moment): MomentEffect {
  return effectOn(piece, score, readState(piece, score, m.at), m);
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
  const st = readState(piece, score, t);
  const out = {} as Record<MomentType, MomentEffect>;
  for (const type of EFFECT_MOMENT_TYPES) out[type] = effectOn(piece, score, st, make(type, t));
  return out;
}
