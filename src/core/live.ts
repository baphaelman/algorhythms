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
import { MIN_GLIDE } from './compiler/glide';
import { foldIntoRange } from './compiler/range';
import { exp2, log2 } from './math';
import { chordMoment } from './moments/chord';
import type { MomentEnv } from './moments/types';
import { unisonMoment } from './moments/unison';
import { planLive } from './live-plan';
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
// Staggered chord release
// ---------------------------------------------------------------------------------------------

/**
 * A key release that leaves keys down waits this long (s, by call time) before re-targeting, so
 * a chord lifted key by key, slightly unevenly, is one release (integrator, M7).
 */
export const RELEASE_GRACE: Seconds = 0.06;

/**
 * The staggered-release rule. A release that leaves keys down starts a grace and posts nothing:
 * the chord as held keeps sounding.
 * - Every key up within RELEASE_GRACE of the first release (inclusive): one all-keys release,
 *   decided then, so the release setting acts on the chord as held.
 * - Keys still down after it (`due`): the caller re-targets to them then (at grace expiry: what
 *   was heard until then is the held chord, so a take records the re-target where it sounded).
 * - Any other change of H (a press, the pedal, all notes off) ends the grace and is decided at
 *   once with the released keys gone (`end`). Presses are never delayed. The sustain pedal is
 *   unaffected: a key released under it does not change H.
 * Callers check `due` before each change of H and on a timer (LiveEngine) or each block (rigs).
 */
export class ReleaseGrace {
  private from: number | null = null;

  /** A grace is running. */
  get waiting(): boolean {
    return this.from !== null;
  }

  /** When it runs out (s, the callers' clock), or Infinity. */
  get until(): number {
    return this.from === null ? Infinity : this.from + RELEASE_GRACE;
  }

  /** True when a grace is running and `at` is past it: re-target to the keys down, then `end`. */
  due(at: number): boolean {
    return this.from !== null && at - this.from > RELEASE_GRACE;
  }

  /**
   * A key release at `at` left H = `held`: true to wait (post nothing), false to decide now (H is
   * empty: one all-keys release, ending any grace).
   */
  release(at: number, held: readonly Pitch[]): boolean {
    if (held.length === 0) {
      this.from = null;
      return false;
    }
    if (this.from === null) this.from = at;
    return true;
  }

  end(): void {
    this.from = null;
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
  /** The segment in force now, times from the decision (absent: a hold, or a glide to dest). */
  seg?: Segment;
  /** The line it is on: the pool index standing for it (absent: its own). */
  line?: number;
  /** Its part (absent: none); lines of different parts never merge (compile.ts `onJoin`). */
  part?: string;
  /** It has moves posted that have not started (a new move cancels them). */
  pending?: boolean;
  /**
   * A fork not departed yet (compile.ts `pendingBirth`): when it leaves (from the decision) and
   * the line it forms. Until then it follows its parent's line (`line`).
   */
  unborn?: { t: Seconds; line: number };
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
 * its logical voices (compiler/lines.ts `expand`: a stacked line's phantoms are its former
 * members, the live voices on its path, sorted with everything else by index).
 */
function byDest(voices: readonly LiveVoiceView[]): LiveVoiceView[] {
  return [...voices].sort((a, b) => a.dest - b.dest || a.index - b.index);
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
  /** The line the voice is on after the move (a pool index; absent: its own). */
  line?: number;
  /** A fork's departure (dsp/live.ts LIVE_BORN). */
  born?: boolean;
  /** The line it is on from its arrival, when it merges there (dsp/live.ts LIVE_JOIN; absent: `line`). */
  join?: number;
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

/** The segment in force for a view without one (unit tests): a hold, or a linear glide to dest. */
function segOf(v: LiveVoiceView): Segment {
  if (v.seg) return v.seg;
  const dt = v.velocity !== 0 ? (v.dest - v.pitch) / v.velocity : 0;
  if (!v.gliding || !(dt > 0) || !Number.isFinite(dt)) {
    return { t0: 0, t1: Infinity, p0: v.pitch, p1: v.pitch, ease: 'linear' };
  }
  return { t0: 0, t1: dt, p0: v.pitch, p1: v.dest, ease: 'linear' };
}

/**
 * The glides that take `voices` to `targets` (same order), planned from the decision time 0 by
 * the compiler's rules (core/live-plan.ts): lines and forks, stagger and order by `drawTimings`
 * with every move ending together, the overshoot clamp, and under `ordered` the §7.2 crossing
 * loop, which re-times lines still gliding that a move overtakes. Strike share 1/√(moving parts).
 */
export function liveMoves(
  voices: readonly LiveVoiceView[],
  targets: readonly Pitch[],
  s: LiveSettings,
  seed: number,
): LiveMove[] {
  const glide: Glide = {
    length: s.glide,
    jitter: 0,
    stagger: s.stagger,
    arrive: 'together',
    order: s.order,
    ease: s.ease,
  };
  const planned = planLive(
    voices.map((v) => ({ ...v, seg: segOf(v), line: v.line ?? v.index })),
    targets,
    glide,
    s.ease,
    s.assign !== 'free',
    seed,
  );
  const parts = new Set(planned.filter((m) => m.part >= 0).map((m) => m.part)).size;
  const share = parts > 0 ? 1 / Math.sqrt(parts) : 1;
  return planned
    .sort((x, y) => x.order - y.order)
    .map((m) => ({
      voice: m.voice,
      delay: m.delay,
      dur: m.dur,
      p1: m.p1,
      ease: s.ease,
      scale: m.scale,
      share,
      line: m.line,
      born: m.born,
      ...(m.join >= 0 ? { join: m.join } : {}),
    }));
}

/**
 * All voices step to their targets at once (from silence). Voices of a part on one note are one
 * line, the lowest index standing for it (as the compiler's establishing moment leaves them).
 */
function stepMoves(voices: readonly LiveVoiceView[], targets: readonly Pitch[], s: LiveSettings) {
  const share = 1 / Math.sqrt(voices.length);
  return voices.map((v, i): LiveMove => {
    let line = v.index;
    voices.forEach((u, j) => {
      if (targets[j] === targets[i] && (u.part ?? '') === (v.part ?? '') && u.index < line)
        line = u.index;
    });
    return {
      voice: v.index,
      delay: 0,
      dur: 0,
      p1: targets[i],
      ease: s.ease,
      scale: 0,
      share,
      line,
    };
  });
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
