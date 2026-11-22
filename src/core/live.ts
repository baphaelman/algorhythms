/**
 * Live voice leading (PLAN.md §9): from the held notes H and the live voice state to new targets
 * and glides. Pure; the main thread runs it on its mirror of the live voice state (src/audio
 * live-engine.ts) and posts the result to the worklet.
 *
 * It reuses the compiler's own functions, so a take recorded as moments voices the same way:
 * - |H| = 1: `unisonMoment` (`unison`, or `octaves`: each voice to its nearest octave of H);
 * - |H| > 1, `exact`: `chordMoment` with a `pitches` NoteSet (surjective doubling, §7.2/§7.3);
 * - |H| > 1, `range`: `voiceNotes` with H's pitch classes, `even` voicing over the register, and
 *   `assignOrdered` / `assignFree` (as `voiceChord` does; no NoteSet names a pitch-class set);
 * - release `tonic`: `unisonMoment` with pitch 'tonic' in `settings.key`;
 * - targets fold into ranges (`foldIntoRange`, §7.8);
 * - timings: `drawTimings` (stagger, order) with every move ending together (`sharedEnd`), and the
 *   §7.2 crossing rule (an overtaking voice adopts the overtaken one's timing);
 * - interruption: `carriedVelocity` (§7.5) with the overshoot clamp. A move records the clamp as a
 *   scale on m₀, because the worklet re-derives the start pitch and velocity at the frame it
 *   actually applies the move at (dsp/live.ts), and m₀ follows from those.
 *
 * Gain: every live voice stays alive (so the sum normalisation g_n is constant); silence is a
 * shared level of 0. From silence the first key steps every voice to its target and ramps the
 * level up over LIVE_ATTACK; a `fade` release ramps it to 0 over `releaseFade`.
 */

import { DEFAULT_GLIDE } from './defaults';
import { easeCodeOf, bezierOf, easeSlope0 } from './ease';
import {
  carriedVelocity,
  CHECK_SAMPLES,
  FREE_LIMITS,
  MAX_OVERSHOOT,
  type OvershootLimits,
} from './interrupt';
import { drawTimings, MIN_GLIDE, sharedEnd, type TimedVoice } from './compiler/glide';
import { foldIntoRange } from './compiler/range';
import { exp2, log2 } from './math';
import { chordMoment } from './moments/chord';
import type { MomentEnv } from './moments/types';
import { unisonMoment } from './moments/unison';
import { hash32 } from './rng';
import { evalSegment } from './segment';
import type { AssignMode, EaseRef, Glide, GlideOrder, Key, Pitch, Seconds, Segment } from './types';
import { assignFree, assignOrdered } from './voice-leading';
import { voiceNotes } from './voicing';

/** |H| = 1: all voices on the note, or each on its nearest octave of it. */
export type LiveSingle = 'unison' | 'octaves';
/** |H| > 1: the held notes themselves (doubled), or their pitch classes across the range. */
export type LiveChord = 'exact' | 'range';
/** What releasing every note does. */
export type LiveRelease = 'hold' | 'fade' | 'tonic';

/** The live panel's settings (§9). */
export interface LiveSettings {
  /** Glide length (s). CC1 sets it (`glideFromModWheel`). */
  glide: Seconds;
  /** Spread of start times across the moving voices (s). */
  stagger: Seconds;
  /** Which voices start first within the stagger. */
  order: GlideOrder;
  ease: EaseRef;
  /** Voice leading: 'ordered' (no crossings) or 'free'. */
  assign: AssignMode;
  single: LiveSingle;
  chord: LiveChord;
  release: LiveRelease;
  /** Fade-out length of release 'fade' (s). */
  releaseFade: Seconds;
  /** Key whose tonic release 'tonic' returns to (the piece's key at the playhead, by default). */
  key: Key;
  /** Register of `range` voicing; absent: the union of the live voices' ranges. */
  register?: [Pitch, Pitch];
  /** Pitch bend range (semitones each way). */
  bendRange: number;
}

/** Defaults (integrator, M7): unison, exact, hold, glide 0.25 s, no stagger, the chord's order. */
export const DEFAULT_LIVE_SETTINGS: Readonly<LiveSettings> = Object.freeze({
  glide: 0.25,
  stagger: 0,
  order: DEFAULT_GLIDE.order,
  ease: DEFAULT_GLIDE.ease as EaseRef,
  assign: 'ordered',
  single: 'unison',
  chord: 'exact',
  release: 'hold',
  releaseFade: 1,
  key: Object.freeze({ tonic: 'C', scale: 'major' }) as Key,
  bendRange: 2,
});

/** Level ramp from silence (s): short enough for the latency target, long enough not to click. */
export const LIVE_ATTACK: Seconds = 0.012;
/** Shortest and longest glide the mod wheel sets (s), exponentially in between. */
export const MOD_GLIDE_MIN: Seconds = 0.02;
export const MOD_GLIDE_MAX: Seconds = 4;
/**
 * Changes of H within this of a press's first change (s) belong to that press (§9): they are
 * re-planned from the state before it, starting where it started (LiveEngine, dsp/live.ts
 * `rewind`), and a take records the press as one moment.
 */
export const MERGE_WINDOW: Seconds = 0.015;
/** Longest live glide accepted from the panel (s). */
export const LIVE_GLIDE_MAX: Seconds = 30;

const ASSIGNS: readonly AssignMode[] = ['ordered', 'free'];
const ORDERS: readonly GlideOrder[] = [
  'random',
  'low-first',
  'high-first',
  'center-out',
  'outside-in',
];

function finite(x: unknown, lo: number, hi: number): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? (x < lo ? lo : x > hi ? hi : x) : undefined;
}

/** `base` with the usable fields of `patch` applied (others ignored). */
export function mergeLiveSettings(
  base: Readonly<LiveSettings>,
  patch: Partial<LiveSettings>,
): LiveSettings {
  const out: LiveSettings = { ...base };
  out.glide = finite(patch.glide, MIN_GLIDE, LIVE_GLIDE_MAX) ?? out.glide;
  out.stagger = finite(patch.stagger, 0, LIVE_GLIDE_MAX) ?? out.stagger;
  out.releaseFade = finite(patch.releaseFade, MIN_GLIDE, 60) ?? out.releaseFade;
  out.bendRange = finite(patch.bendRange, 0, 24) ?? out.bendRange;
  if (patch.order !== undefined && ORDERS.includes(patch.order)) out.order = patch.order;
  if (patch.assign !== undefined && ASSIGNS.includes(patch.assign)) out.assign = patch.assign;
  if (patch.single === 'unison' || patch.single === 'octaves') out.single = patch.single;
  if (patch.chord === 'exact' || patch.chord === 'range') out.chord = patch.chord;
  if (patch.release === 'hold' || patch.release === 'fade' || patch.release === 'tonic') {
    out.release = patch.release;
  }
  if (patch.ease !== undefined) out.ease = patch.ease;
  if (patch.key !== undefined) out.key = patch.key;
  if ('register' in patch) {
    const r = patch.register;
    if (r && Number.isFinite(r[0]) && Number.isFinite(r[1])) {
      out.register = r[0] <= r[1] ? [r[0], r[1]] : [r[1], r[0]];
    } else delete out.register;
  }
  return out;
}

/** CC1 (0..127) → glide length: MOD_GLIDE_MIN · (MAX/MIN)^(cc/127). */
export function glideFromModWheel(cc: number): Seconds {
  const u = cc <= 0 ? 0 : cc >= 127 ? 1 : cc / 127;
  return MOD_GLIDE_MIN * exp2(u * log2(MOD_GLIDE_MAX / MOD_GLIDE_MIN));
}

/** A 14-bit MIDI pitch-bend value (0..16383, centre 8192) → semitones within ±range. */
export function bendFromMidi(
  value: number,
  range: number = DEFAULT_LIVE_SETTINGS.bendRange,
): number {
  const v = value < 0 ? 0 : value > 16383 ? 16383 : value;
  return ((v - 8192) / (v >= 8192 ? 8191 : 8192)) * range;
}

/** Bend clamped to ±range semitones (NaN: 0). */
export function clampBend(semitones: number, range: number): number {
  if (!(semitones === semitones)) return 0;
  return semitones < -range ? -range : semitones > range ? range : semitones;
}

// ---------------------------------------------------------------------------------------------
// Held notes: keys down plus notes the sustain pedal holds
// ---------------------------------------------------------------------------------------------

/** The held set H (§9): keys down, plus keys released while the sustain pedal (CC64) is down. */
export class LiveKeys {
  private readonly down = new Set<Pitch>();
  private readonly kept = new Set<Pitch>();
  private pedal = false;

  /** H, sorted ascending. */
  get held(): Pitch[] {
    const out = new Set<Pitch>([...this.down, ...this.kept]);
    return [...out].sort((a, b) => a - b);
  }

  get sustain(): boolean {
    return this.pedal;
  }

  /** Key down; true if H changed. */
  noteOn(p: Pitch): boolean {
    const had = this.has(p);
    this.down.add(p);
    this.kept.delete(p);
    return !had;
  }

  /** Key up; true if H changed (not while the pedal holds it). */
  noteOff(p: Pitch): boolean {
    if (!this.down.delete(p)) return false;
    if (this.pedal) {
      this.kept.add(p);
      return false;
    }
    return true;
  }

  /** Sustain pedal; lifting it drops the notes it held. True if H changed. */
  setSustain(on: boolean): boolean {
    this.pedal = on;
    if (on || this.kept.size === 0) return false;
    let changed = false;
    for (const p of this.kept) if (!this.down.has(p)) changed = true;
    this.kept.clear();
    return changed;
  }

  /** Releases everything (pedal included); true if H changed. */
  allOff(): boolean {
    const changed = this.down.size + this.kept.size > 0;
    this.down.clear();
    this.kept.clear();
    this.pedal = false;
    return changed;
  }

  private has(p: Pitch): boolean {
    return this.down.has(p) || this.kept.has(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/** One live voice's state at the decision time (from the main thread's mirror). */
export interface LiveVoiceView {
  /** Pool index (in the live score). */
  index: number;
  id: string;
  range: readonly [Pitch, Pitch];
  /** Pitch sounding now (without bend). */
  pitch: Pitch;
  /** dp/dt now, semitones per second. */
  velocity: number;
  /** Mid-glide now (the interruption rule applies). */
  gliding: boolean;
  /** Committed destination: where its moves already posted end. */
  dest: Pitch;
}

/** The live state a decision reads. */
export interface LiveView {
  voices: readonly LiveVoiceView[];
  /** Shared level now and the level it is ramping to (0 = silent). */
  level: number;
  levelTarget: number;
}

/**
 * The voices sorted by committed destination, ties by pool index (§7.2), as the compiler orders
 * its logical voices: voices on one path (same pitch, velocity and destination) are one line
 * there, the lowest-index one standing for it and the others its phantoms, which follow every
 * line with that destination (compiler/lines.ts `expand`). So a voice doubled on a line ranks
 * after a single line heading to the same pitch, and a take voices the same way.
 */
function byDest(voices: readonly LiveVoiceView[]): LiveVoiceView[] {
  const phantom = new Set<number>();
  for (const v of voices) {
    for (const u of voices) {
      if (
        u.index < v.index &&
        u.dest === v.dest &&
        Math.abs(u.pitch - v.pitch) <= 1e-9 &&
        Math.abs(u.velocity - v.velocity) <= 1e-9
      ) {
        phantom.add(v.index);
        break;
      }
    }
  }
  const rank = (v: LiveVoiceView): number => (phantom.has(v.index) ? 1 : 0);
  return [...voices].sort((a, b) => a.dest - b.dest || rank(a) - rank(b) || a.index - b.index);
}

/** A MomentEnv over `sorted` (env voice v = sorted[v]), all targeted and active. */
function envOf(sorted: readonly LiveVoiceView[], s: LiveSettings): MomentEnv {
  const all = sorted.map((_, i) => i);
  const glide: Glide = {
    length: s.glide,
    jitter: 0,
    stagger: s.stagger,
    arrive: 'together',
    order: s.order,
    ease: s.ease,
  };
  return {
    t: 0,
    momentId: 'live',
    key: s.key,
    seed: 0,
    glide,
    targeted: all,
    active: all,
    dest: (v) => sorted[v].dest,
    now: (v) => sorted[v].pitch,
    range: (v) => sorted[v].range,
    id: (v) => sorted[v].id,
    part: () => '',
    sounding: () => true,
    dormant: () => [],
    indexOf: (id) => sorted.findIndex((x) => x.id === id),
    diag: () => undefined,
    rand: () => 0,
  };
}

function unionRange(voices: readonly LiveVoiceView[]): [Pitch, Pitch] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of voices) {
    if (v.range[0] < lo) lo = v.range[0];
    if (v.range[1] > hi) hi = v.range[1];
  }
  return [lo, hi];
}

/**
 * The targets for held notes `held` (any order; empty → release 'tonic' semantics, i.e. the
 * tonic), one per voice of `voices` in the same order, folded into each voice's range. Null if
 * nothing can be voiced (no voices, or no valid notes).
 */
export function liveTargets(
  voices: readonly LiveVoiceView[],
  held: readonly Pitch[],
  s: LiveSettings,
): Pitch[] | null {
  if (voices.length === 0) return null;
  const notes = [...new Set(held.filter((p) => Number.isFinite(p)))].sort((a, b) => a - b);
  const sorted = byDest(voices);
  const env = envOf(sorted, s);
  let plan: { voice: number; to: Pitch }[] | null;
  if (notes.length <= 1) {
    const u = unisonMoment(
      {
        id: 'live',
        type: 'unison',
        at: 0,
        pitch: notes.length === 1 ? notes[0] : 'tonic',
        octaves: s.single === 'octaves',
      },
      env,
    );
    plan = u ? u.intents : null;
  } else if (s.chord === 'exact') {
    const p = chordMoment(
      {
        id: 'live',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: notes },
        voicing: 'even',
        assign: s.assign,
      },
      env,
    );
    plan = p ? p.intents : null;
  } else {
    const p = sorted.map((v) => v.dest);
    const voiced = voiceNotes({
      notes: { kind: 'current' },
      k: sorted.length,
      mode: 'even',
      register: s.register ?? unionRange(sorted),
      key: s.key,
      current: notes,
      voices: p,
    });
    if (!voiced.ok || voiced.targets.length === 0) {
      return liveTargets(voices, held, { ...s, chord: 'exact' });
    }
    const q = voiced.targets;
    const f = s.assign === 'free' ? assignFree(p, q) : assignOrdered(p, q);
    plan = sorted.map((_, i) => ({ voice: i, to: q[f[i]] }));
  }
  if (!plan) return null;
  const byIndex = new Map<number, Pitch>();
  for (const it of plan) {
    const v = sorted[it.voice];
    byIndex.set(v.index, foldIntoRange(it.to, v.range[0], v.range[1]).p);
  }
  return voices.map((v) => byIndex.get(v.index) ?? v.dest);
}

// ---------------------------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------------------------

/** One voice's live move, as posted to the worklet (dsp/live.ts LIVE_* records). */
export interface LiveMove {
  /** Pool index. */
  voice: number;
  /** Start, seconds after the time the worklet applies the message at (stagger). */
  delay: Seconds;
  /** Glide length; 0 steps to `p1` at once (from silence). */
  dur: Seconds;
  p1: Pitch;
  ease: EaseRef;
  /** Scale on the carried-velocity term m₀ (the §7.5 overshoot clamp, or the §7.2 tightening). */
  scale: number;
  /** Share of a soft articulation strike at its arrival (1/√k for k arriving together). */
  share: number;
}

/** What one change of H (or of the release) does. */
export interface LiveUpdate {
  moves: LiveMove[];
  /** New shared level and its ramp, or null to keep it. */
  level: { gain: number; over: Seconds } | null;
  /** Every voice's target (view order), or null when nothing was voiced (hold, fade, none). */
  targets: Pitch[] | null;
  /** Decided from silence (the voices step to their targets). */
  silent: boolean;
}

/**
 * Overshoot limits (§7.5) of every voice's move, by the compiler's rule (plan.ts step 4), so a
 * recorded take plays back as it was played (§15 M7): under `ordered`, L = min(1 semitone, gap to
 * each pitch-order neighbour, the gap being the smaller of the two moves' start-destination and
 * target differences). The compiler plans lines, not stacked voices: voices with the same
 * destination and target are one participant there, so they are here.
 */
export function liveLimits(
  voices: readonly LiveVoiceView[],
  targets: readonly Pitch[],
  ordered: boolean,
): OvershootLimits[] {
  if (!ordered) return voices.map(() => FREE_LIMITS);
  const parts: { pre: Pitch; to: Pitch }[] = [];
  const partOf = voices.map((v, i) => {
    const to = targets[i];
    let k = parts.findIndex((p) => p.pre === v.dest && p.to === to);
    if (k < 0) k = parts.push({ pre: v.dest, to }) - 1;
    return k;
  });
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => parts[a].to - parts[b].to || parts[a].pre - parts[b].pre);
  const rank = new Map<number, number>();
  order.forEach((p, r) => rank.set(p, r));
  const gap = (a: number, b: number): number =>
    Math.min(Math.abs(parts[a].pre - parts[b].pre), Math.abs(parts[a].to - parts[b].to));
  return partOf.map((k) => {
    const r = rank.get(k) as number;
    let up = MAX_OVERSHOOT;
    let down = MAX_OVERSHOOT;
    if (r + 1 < order.length) up = Math.min(up, gap(k, order[r + 1]));
    if (r > 0) down = Math.min(down, gap(k, order[r - 1]));
    return { up, down };
  });
}

/** Raw m₀ = v·d − (p₁ − p₀)·e′(0) of a move (0 when holding). */
function rawM0(v: LiveVoiceView, d: Seconds, p1: Pitch, ease: EaseRef): number {
  if (!v.gliding) return 0;
  const s0 = easeSlope0(easeCodeOf(ease), bezierOf(ease));
  return v.velocity * d - (Number.isFinite(s0) ? (p1 - v.pitch) * s0 : 0);
}

/**
 * Pitch of voice `v` at time t (from the decision) under its planned move `seg`; before the move
 * starts it is taken as holding its pitch now (stagger offsets are short).
 */
function pathAt(v: LiveVoiceView, seg: Segment, t: Seconds): Pitch {
  return t < seg.t0 ? v.pitch : evalSegment(seg, t);
}

/**
 * The glides that take `voices` to `targets` (same order), starting at the decision time 0:
 * stagger and order by `drawTimings`, every move ending together (`sharedEnd`), the overshoot
 * clamp, and under `ordered` the §7.2 crossing rule on adjacent moving voices. Voices already
 * heading to their target (or holding it) do not move.
 */
export function liveMoves(
  voices: readonly LiveVoiceView[],
  targets: readonly Pitch[],
  s: LiveSettings,
  seed: number,
): LiveMove[] {
  const target = new Map<number, Pitch>();
  voices.forEach((v, i) => target.set(v.index, targets[i]));
  const all = byDest(voices).filter(
    (v) => Math.abs((target.get(v.index) ?? v.dest) - v.dest) > 1e-9,
  );
  if (all.length === 0) return [];
  // Voices on one path going to one target move as one line, as in the compiler: one timing draw
  // and one crossing check per line (stagger is stratified over lines, not doubled voices).
  const lines: LiveVoiceView[][] = [];
  for (const v of all) {
    const to = target.get(v.index);
    const line = lines.find(
      (l) =>
        l[0].dest === v.dest &&
        target.get(l[0].index) === to &&
        Math.abs(l[0].pitch - v.pitch) <= 1e-9 &&
        Math.abs(l[0].velocity - v.velocity) <= 1e-9,
    );
    if (line) line.push(v);
    else lines.push([v]);
  }
  lines.sort(
    (a, b) =>
      a[0].dest - b[0].dest ||
      (target.get(a[0].index) as Pitch) - (target.get(b[0].index) as Pitch) ||
      a[0].index - b[0].index,
  );
  const movers = lines.map((l) => l[0]);
  const n = movers.length;
  const glide: Glide = {
    length: s.glide,
    jitter: 0,
    stagger: s.stagger,
    arrive: 'together',
    order: s.order,
    ease: s.ease,
  };
  const timed: TimedVoice[] = movers.map((v) => ({ hash: hash32(v.id), index: v.index }));
  const draws = drawTimings(timed, glide, seed);
  let last = 0;
  for (const d of draws) if (d.offset > last) last = d.offset;
  const end = sharedEnd(last, glide, seed);
  const start = draws.map((d) => d.offset);
  const dur = start.map((o) => Math.max(MIN_GLIDE, end - o));
  const q = movers.map((v) => target.get(v.index) as Pitch);
  const ordered = s.assign !== 'free';
  const limits = liveLimits(voices, targets, ordered);
  const limitOf = new Map<number, OvershootLimits>();
  voices.forEach((v, i) => limitOf.set(v.index, limits[i]));
  const scale = movers.map((v, i) => {
    const raw = rawM0(v, dur[i], q[i], s.ease);
    if (raw === 0) return 1;
    const c = carriedVelocity(
      { p: v.pitch, v: v.velocity, mid: true },
      dur[i],
      q[i],
      s.ease,
      limitOf.get(v.index) as OvershootLimits,
    );
    return c.m0 / raw;
  });
  if (ordered && n > 1) enforceOrder(movers, q, start, dur, scale, s.ease);
  const share = 1 / Math.sqrt(n);
  const out: LiveMove[] = [];
  lines.forEach((l, i) => {
    for (const v of l) {
      out.push({
        voice: v.index,
        delay: start[i],
        dur: dur[i],
        p1: q[i],
        ease: s.ease,
        scale: scale[i],
        share,
      });
    }
  });
  return out;
}

/**
 * Order reversals up to this are touching, not crossing (semitones: 1 cent). Lines a hair apart
 * that re-target together can swap order by far less, from their carried velocities alone.
 */
const CROSS_EPS = 0.01;

/**
 * §7.2 crossing rule for live moves (`movers` sorted by committed destination): sample each
 * adjacent pair over the window at CHECK_SAMPLES points; if the curves cross, the voice that
 * starts earlier adopts the other's start and length. Repeats until no pair crosses (at worst all
 * share one timing). A crossing that equal timing cannot remove (carried velocity) drops the
 * overtaker's carried velocity.
 */
function enforceOrder(
  movers: readonly LiveVoiceView[],
  q: readonly Pitch[],
  start: Seconds[],
  dur: Seconds[],
  scale: number[],
  ease: EaseRef,
): void {
  const n = movers.length;
  const segOf = (i: number): Segment => {
    const v = movers[i];
    const m0 = rawM0(v, dur[i], q[i], ease) * scale[i];
    const seg: Segment = { t0: start[i], t1: start[i] + dur[i], p0: v.pitch, p1: q[i], ease };
    if (m0 !== 0) seg.m0 = m0;
    return seg;
  };
  const crosses = (a: number, b: number): boolean => {
    if (q[a] > q[b] + 1e-9) return false; // free-assigned endpoints: not ours to fix
    const sa = segOf(a);
    const sb = segOf(b);
    const t1 = Math.max(sa.t1, sb.t1);
    // An order already inverted at the start (an interrupted glide restarts its ease, so a
    // neighbour that kept accelerating can be a hair past it) is not a crossing of this move.
    const d0 = movers[a].pitch - movers[b].pitch;
    const allow = (d0 > 0 ? d0 : 0) + CROSS_EPS;
    for (let k = 0; k < CHECK_SAMPLES; k++) {
      const t = (t1 * k) / (CHECK_SAMPLES - 1);
      if (pathAt(movers[a], sa, t) - pathAt(movers[b], sb, t) > allow) return true;
    }
    return false;
  };
  for (let iter = 0; iter <= n; iter++) {
    let any = false;
    for (let i = 0; i + 1 < n; i++) {
      if (!crosses(i, i + 1)) continue;
      any = true;
      if (start[i] === start[i + 1] && dur[i] === dur[i + 1]) {
        const j = scale[i] !== 0 ? i : i + 1;
        scale[j] = 0;
        continue;
      }
      const [from, to] = start[i] <= start[i + 1] ? [i + 1, i] : [i, i + 1];
      start[to] = start[from];
      dur[to] = dur[from];
    }
    if (!any) return;
  }
}

/** All voices step to their targets at once (from silence). */
function stepMoves(voices: readonly LiveVoiceView[], targets: readonly Pitch[], s: LiveSettings) {
  const share = 1 / Math.sqrt(voices.length);
  return voices.map((v, i): LiveMove => ({
    voice: v.index,
    delay: 0,
    dur: 0,
    p1: targets[i],
    ease: s.ease,
    scale: 0,
    share,
  }));
}

/** True when the live voices are silent: level 0 and not ramping up. */
export function isSilent(view: Pick<LiveView, 'level' | 'levelTarget'>): boolean {
  return view.level <= 0 && view.levelTarget <= 0;
}

/**
 * What H becoming `held` does (§9), deciding at the current state `view`:
 * - from silence: every voice steps to its target and the level ramps up over LIVE_ATTACK;
 * - otherwise: glides to the new targets (interruptions carry velocity); a level fading out ramps
 *   back up;
 * - H empty: `hold` keeps everything, `fade` ramps the level to 0 over `releaseFade`, `tonic`
 *   glides to the tonic (as a single note).
 * `seed` keys the stagger-order draws (§7.7).
 */
export function liveUpdate(
  view: LiveView,
  held: readonly Pitch[],
  s: LiveSettings,
  seed: number,
): LiveUpdate {
  const silent = isSilent(view);
  const none: LiveUpdate = { moves: [], level: null, targets: null, silent };
  if (held.length === 0) {
    if (s.release === 'fade') {
      return view.levelTarget > 0 ? { ...none, level: { gain: 0, over: s.releaseFade } } : none;
    }
    if (s.release === 'hold' || silent) return none;
  }
  const targets = liveTargets(view.voices, held, s);
  if (!targets) return none;
  if (silent) {
    return {
      moves: stepMoves(view.voices, targets, s),
      level: { gain: 1, over: LIVE_ATTACK },
      targets,
      silent,
    };
  }
  const moves = liveMoves(view.voices, targets, s, seed);
  const level = view.levelTarget < 1 ? { gain: 1, over: LIVE_ATTACK } : null;
  return { moves, level, targets, silent };
}
