/**
 * `compile(piece)` (PLAN.md §7): a discrete-event simulation over a priority queue.
 *
 * Pure and synchronous: the same Piece gives the same CompiledScore on every engine (§7.11). Every
 * decision reads the state at the time it is made, so a walk can't overwrite a chord that lands
 * inside it (§7.1).
 *
 * Events (queue.ts), in time order; at equal times moment events (array order; a note moment's
 * return after its own moment events at that time), then move starts
 * (life closes, then births, then moves, each by pool index), then walk ticks (array order).
 * - moment: resolve the target at this time, cancel the targeted voices' pending moves, run the
 *   moment on their committed destinations, plan and schedule the moves (plan.ts).
 * - move start: read the actual pitch and velocity, interrupt a running glide (§7.5), write the
 *   segment. A birth opens a life on the parent's pitch; a death glide schedules its life's close.
 * - tick: one walk step for every eligible voice (moments/walk.ts).
 * Then every voice is closed at the end (`end.at`, or the last activity + 4 s) with the end fade.
 *
 * Schema v2 (M4.5-27): every voice starts dormant. A chord or unison that comes when nothing is
 * sounding establishes: its voices come in on their notes with no glide (`establish`). Every
 * other moment has no effect from silence.
 */

import { defaultGlide } from '../defaults';
import { crossfadeLength } from '../ease';
import { changesPitch, noEffectReason, sameKey } from '../effect';
import { harmonyLabel } from '../harmony';
import { mod } from '../math';
import { selectorPart } from '../parts';
import { nextPulseIndex, type PulseWalk } from '../pulse';
import { hash32, momentSeed, Purpose, randHashed } from '../rng';
import { FREE_LIMITS } from '../interrupt';
import { pointMomentPlan } from '../moments/dispatch';
import { establishPlan, isEstablishing } from '../moments/establish';
import { noteMoment } from '../moments/note';
import { IntentKind, type Intent, type MomentEnv, type MomentPlan } from '../moments/types';
import { walkTick } from '../moments/walk';
import {
  MAX_VOICES,
  type CompiledScore,
  type CompiledVoice,
  type Diagnostic,
  type DiagnosticLevel,
  type Glide,
  type HarmonyChange,
  type Key,
  type KeyChange,
  type KeyMoment,
  type Life,
  type Moment,
  type MomentSpan,
  type MomentType,
  type NoteMoment,
  type Piece,
  type Pitch,
  type PulseMoment,
  type PulseRecord,
  type Seconds,
  type Segment,
  type VoiceOverride,
  type VoiceSelector,
  type WalkMoment,
  type WalkStepRecord,
} from '../types';
import { glides, landing, MIN_GLIDE, mergeGlide, sanitizeGlide, type Landing } from './glide';
import { applyOverrideEnds, applyOverridePitches, overridesOf } from './overrides';
import { planMoment, type CrossingsMode, type PlanResult, type PlanTrace } from './plan';
import { Projector } from './project';
import { EventClass, EventQueue } from './queue';
import { foldIntoRange, sanitizeRange } from './range';
import { collapse, countsLines, expand, type Collapsed, type Expansion } from './lines';
import { Status, VoiceRun, type Birth, type Move } from './voice';

/**
 * Distinct notes (revision 8) and merges and splits crossfade (owner 2026-11-21): a line that
 * merges into another fades out across the end of its approach while the merged line's weight
 * rises (`crossInto`); a fork (a weighted line splitting) fades in across the start of its
 * departure while its parent's weight falls (`onBirth`). Both follow core/ease `crossfade`.
 * Without room for a crossfade before the meeting (a line born just then), a joining line still
 * fades over HANDOVER after it (MIDI writes every merge that way, midi/export.ts); FORK_FADE is a
 * fork's fade-in when its parent is not sounding yet (no crossfade then).
 */
export const HANDOVER: Seconds = 0.1;
export const FORK_FADE: Seconds = 0.1;
/** Least room before a meeting, inside both lines' lives, for a merge to crossfade (s). */
const CROSS_ROOM: Seconds = 0.01;

/** Silence after the last activity when `end.at` is absent (§5). */
export const END_TAIL: Seconds = 4;

const MOMENT_TYPES: ReadonlySet<MomentType> = new Set<MomentType>([
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
  'pulse',
]);

/** Move-start sub-order at equal times (queue `key` = sub·64 + pool index). */
export const SUB_CLOSE = 0;
export const SUB_BIRTH = 1;
export const SUB_MOVE = 2;
/** A line's arrival: merge it into a line resting on the same pitch (revision 8). */
export const SUB_JOIN = 3;
/** A dying line's fade starts: its weight passes to the line it merges into (revision 8). */
export const SUB_HANDOVER = 4;
export const SUB_STRIDE = 64;

/** `sub` of a moment-class event that returns a note moment's note (`back`, §6.2). */
export const SUB_NOTE_BACK = 1;
/**
 * `sub` of a land moment's event re-queued at its `at` (revision 9): its lead-in start found
 * nothing sounding, so it acts at its marker, without a lead-in.
 */
export const SUB_LANDED = 2;

/**
 * A note moment's scheduled return (§6.2 `back`): at `t`, each change's note `from` (where its
 * move arrived) becomes `to` (the pitch it replaced). Immutable once queued.
 */
export interface NoteBack {
  t: Seconds;
  changes: { from: Pitch; to: Pitch }[];
}

/** harmonyLabel, memoised in `cache` (a piece repeats its harmonies; the function is pure). */
function cachedHarmonyLabel(
  cache: Map<string, string>,
  symbol: string | undefined,
  pcs: readonly number[],
  bass: number,
  key: Key,
): string {
  const scale = typeof key.scale === 'string' ? key.scale : JSON.stringify(key.scale);
  const k = `${symbol ?? ''}\u0000${pcs.join(',')}\u0000${bass}\u0000${key.tonic}\u0000${scale}`;
  let label = cache.get(k);
  if (label === undefined) {
    label = harmonyLabel(symbol, pcs, bass, key);
    cache.set(k, label);
  }
  return label;
}

/** One planned moment, for property tests. */
export interface MomentTrace {
  id: string;
  index: number;
  type: MomentType;
  t: Seconds;
  /** Targeted voices (pool indices), sorted by committed destination after cancellation. */
  targeted: number[];
  /** The selector was not 'all'. */
  subset: boolean;
  /** Planner output; null if the moment was not applied (or has no moves of its own). */
  plan: PlanTrace | null;
  /**
   * The moment function's intents with folded targets (§7.8); null if not applied. Births carry
   * their parent, deaths the voice they merge into (−1: none).
   */
  intents:
    | {
        voice: number;
        to: Pitch;
        kind: 'move' | 'birth' | 'death';
        parent?: number;
        into?: number;
        /** `logical` only: the target was folded into the voice's range (§7.8). */
        folded?: true;
      }[]
    | null;
  /**
   * Revision 8: the intents on the logical voices the moment function saw (a line of count k as k
   * stacked voices; phantoms have dormant or synthetic indices), targets folded. Equals `intents`
   * when no line is stacked.
   */
  logical: MomentTrace['intents'];
}

/** Options of `compile` (not part of the Piece or the file format). */
export interface CompileOptions {
  /** 'forbid' (default) enforces voice-crossing rules (§7.2); 'allow' skips them. Dev toggle. */
  crossings?: CrossingsMode;
}

/** Extra output of `compileWithTrace`. */
export interface CompileTrace {
  moments: MomentTrace[];
  /** End time used. */
  end: Seconds;
}

/** A frozen walk's notes (§6.2, revision 5), validated at setup. */
interface FrozenWalk {
  /** Tick indices that have notes, ascending. */
  ticks: number[];
  /** Notes per tick, in file order. */
  notes: Map<number, { voice: number; pitch: Pitch }[]>;
}

/** A line arriving at `t` (revision 8 join check). Immutable once queued. */
interface JoinRec {
  voice: number;
  t: Seconds;
}

/**
 * A pulse's state, carried by its next tick event (revision 9). Immutable once queued, so
 * incremental checkpoints can keep the queued event as is.
 */
interface PulseState extends PulseWalk {
  /** Some targeted voice was sounding at a step so far. */
  heard: boolean;
}

const PULSE_START: PulseState = Object.freeze({ index: -1, dir: 1, heard: false });

/** Resting pitches closer than this are one note. */
const SAME_PITCH = 1e-6;

interface CloseRec {
  voice: number;
  died: Seconds;
  fade: Seconds;
  /** The fade is a merge's crossfade (`Life.crossOut`). */
  cross?: true;
}

/** A dying line's fade start (revision 8 weight hand-over). Immutable once queued. */
interface HandoverRec {
  voice: number;
  died: Seconds;
}

function moving(s: Segment): boolean {
  return s.p0 !== s.p1 || (s.m0 ?? 0) !== 0 || s.curve !== undefined;
}

/**
 * Length of the run of moving segments of `run` that ends at t (0 if it holds there): its
 * finished segments, then the frontier's tail (not among them until it is finished).
 */
function approachInto(run: VoiceRun, t: Seconds): Seconds {
  let start = t;
  const step = (g: Segment): boolean => {
    if (g.t0 >= start) return true;
    if (g.t1 < start - 1e-9 || !moving(g)) return false;
    start = g.t0;
    return true;
  };
  const tail = run.frontier.tail;
  if (tail && !run.frontier.open && !step(tail)) return 0;
  const segs = run.segs;
  for (let i = segs.length - 1; i >= 0; i--) if (!step(segs[i])) break;
  return t - start;
}

/** When a voice reaches its committed destination: the end of its last scheduled or running move. */
function arrivalOf(run: VoiceRun): Seconds {
  let end = -Infinity;
  for (const m of run.pending) if (!m.cancelled && m.t0 + m.dur > end) end = m.t0 + m.dur;
  const tail = run.frontier.tail;
  if (tail && !run.frontier.open && tail.t1 > end) end = tail.t1;
  return end;
}

/** The simulation. Exported for incremental.ts only; use `compile`. */
export class Compiler {
  /**
   * Called before each moment event is handled (after it is popped), for incremental.ts to take
   * a checkpoint. Moment events are the only points where it restores.
   */
  onMomentEvent: ((t: Seconds, i: number) => void) | null = null;
  readonly voices: VoiceRun[] = [];
  readonly byId = new Map<string, number>();
  readonly diags: Diagnostic[] = [];
  readonly queue = new EventQueue();
  /** Time of the event being handled. */
  clock: Seconds = 0;
  readonly moments: readonly Moment[];
  readonly valid: boolean[] = [];
  readonly seeds: number[] = [];
  readonly glides: Glide[] = [];
  /**
   * Per moment: when its event is handled (§7.1). `at`, or for a `land` moment (revision 9) its
   * lead-in start, where it decides.
   */
  readonly eventT: number[] = [];
  /** Per moment: its lead-in when it lands (revision 9), else null. */
  readonly landings: (Landing | null)[] = [];
  /** Valid key moments, by index (a land moment reads the key at its `at`). */
  private readonly keyMoments: number[] = [];
  readonly spanStart: number[] = [];
  readonly spanEnd: number[] = [];
  readonly walks: number[] = [];
  /** Valid pulse moments (indices), in array order. */
  readonly pulses: number[] = [];
  /** Per moment: the frozen walk's notes, or null (not a frozen walk). */
  readonly frozen: (FrozenWalk | null)[] = [];
  /** Steps taken by walks, in event (= time) order (§7.9 walkSteps). */
  readonly walkSteps: WalkStepRecord[] = [];
  key: Key;
  readonly keys: KeyChange[];
  readonly harmony: HarmonyChange[] = [];
  lastActivity = 0;
  readonly endAt: Seconds;
  readonly endFade: Seconds;
  readonly trace: CompileTrace | null;
  private readonly emptyHash = hash32('');
  private readonly labels = new Map<string, string>();

  // Committed-destination cache, invalidated by bumping the epoch.
  private epoch = 1;
  private destEpoch: Int32Array;
  private destVal: Float64Array;
  private birthProjector: Projector | null = null;

  constructor(
    readonly piece: Piece,
    tracing: boolean,
    readonly options: CompileOptions = {},
  ) {
    this.trace = tracing ? { moments: [], end: 0 } : null;
    this.key = piece.key;
    this.keys = [{ t: 0, key: piece.key }];
    const endAt = piece.end?.at;
    this.endAt =
      typeof endAt === 'number' && Number.isFinite(endAt) && endAt >= 0 ? endAt : Infinity;
    const fade = piece.end?.fade;
    this.endFade = typeof fade === 'number' && Number.isFinite(fade) && fade > 0 ? fade : 0;
    this.moments = Array.isArray(piece.moments) ? piece.moments : [];
    this.initVoices();
    this.destEpoch = new Int32Array(this.voices.length);
    this.destVal = new Float64Array(this.voices.length);
    this.initMoments();
    this.initWobble();
  }

  /** Revision 8: `wobble` beat between stacked lines, which no longer exist; it is ignored. */
  private initWobble(): void {
    const ts = this.piece.timbres;
    if (!ts || typeof ts !== 'object') return;
    const names = Object.keys(ts).filter((k) => {
      const w = (ts[k] as { wobble?: unknown } | undefined)?.wobble;
      return typeof w === 'number' && w > 0;
    });
    if (names.length === 0) return;
    this.diag(
      'info',
      'wobble-ignored',
      `Wobble is ignored (${names.join(', ')}): lines never share a pitch, so there is nothing to beat.`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------------------------

  private initVoices(): void {
    const defs = Array.isArray(this.piece.voices) ? this.piece.voices : [];
    if (defs.length > MAX_VOICES) {
      this.diag(
        'error',
        'too-many-voices',
        `The pool has ${defs.length} voices; only the first ${MAX_VOICES} are used.`,
      );
    }
    for (let i = 0; i < defs.length && i < MAX_VOICES; i++) {
      const def = defs[i];
      if (this.byId.has(def.id)) {
        this.diag(
          'error',
          'duplicate-voice-id',
          `Voice id '${def.id}' is used twice; the second is ignored.`,
        );
        // Keep pool indices stable: the duplicate stays in the pool but is never addressable.
        this.voices.push(new VoiceRun(i, def, sanitizeRange(def.range), hash32(def.id)));
        continue;
      }
      this.byId.set(def.id, i);
      this.voices.push(new VoiceRun(i, def, sanitizeRange(def.range), hash32(def.id)));
    }
    for (const run of this.voices) this.parts.add(run.part);
  }

  private initMoments(): void {
    const defaults = sanitizeGlide(this.piece.defaults?.glide, defaultGlide());
    const ids = new Set<string>();
    this.moments.forEach((m, i) => {
      this.valid.push(false);
      this.frozen.push(null);
      this.seeds.push(0);
      this.glides.push(defaults);
      this.eventT.push(NaN);
      this.landings.push(null);
      this.spanStart.push(NaN);
      this.spanEnd.push(NaN);
      if (!m || typeof m !== 'object') {
        this.diag('error', 'invalid-moment', `Moment ${i} is not an object.`);
        return;
      }
      if (ids.has(m.id)) {
        this.diag('warn', 'duplicate-moment-id', `Moment id '${m.id}' is used twice.`, m.id);
      }
      ids.add(m.id);
      if (m.muted) return;
      if (!MOMENT_TYPES.has(m.type)) {
        this.diag('info', 'unknown-moment-type', `Unknown moment type '${String(m.type)}'.`, m.id);
        return;
      }
      if (!(typeof m.at === 'number' && Number.isFinite(m.at) && m.at >= 0)) {
        this.diag('error', 'invalid-time', `The moment time must be a number ≥ 0.`, m.id);
        return;
      }
      if (m.type === 'walk') {
        const ok =
          typeof m.grid === 'number' &&
          Number.isFinite(m.grid) &&
          m.grid > 0 &&
          typeof m.until === 'number' &&
          Number.isFinite(m.until) &&
          m.until > m.at;
        if (!ok) {
          this.diag('error', 'walk-invalid', 'A walk needs grid > 0 and until > at.', m.id);
          return;
        }
      }
      if (m.type === 'pulse') {
        const why = pulseProblem(m);
        if (why !== null) {
          this.diag('error', 'pulse-invalid', why, m.id);
          return;
        }
      }
      this.valid[i] = true;
      this.seeds[i] = momentSeed(this.piece.seed, m.id, m.seed);
      this.glides[i] = mergeGlide(defaults, m.glide);
      const land = this.glides[i].land === true && glides(m) ? landing(m.at, this.glides[i]) : null;
      this.landings[i] = land;
      this.eventT[i] = land ? land.start : m.at;
      if (m.type === 'key') this.keyMoments.push(i);
      this.queue.push({ t: this.eventT[i], cls: EventClass.Moment, key: i, sub: 0, ref: i });
      if (m.type === 'walk') {
        this.walks.push(i);
        if (Array.isArray(m.fixed)) this.frozen[i] = this.initFrozen(m);
        this.queue.push({ t: m.at, cls: EventClass.Tick, key: i, sub: 0, ref: 0 });
      }
      if (m.type === 'pulse') {
        this.pulses.push(i);
        this.queue.push({
          t: m.at,
          cls: EventClass.Tick,
          key: i,
          sub: 0,
          ref: 0,
          obj: PULSE_START,
        });
      }
    });
  }

  /** Validates a frozen walk's notes (§6.2): unusable ones are dropped with a diagnostic. */
  private initFrozen(w: WalkMoment): FrozenWalk {
    const notes = new Map<number, { voice: number; pitch: Pitch }[]>();
    let past = 0;
    let bad = 0;
    for (const n of w.fixed ?? []) {
      const k = n?.tick;
      if (!(typeof k === 'number' && Number.isFinite(k) && k >= 0 && Number.isFinite(n.pitch))) {
        bad++;
        continue;
      }
      const v = this.byId.get(n.voice);
      if (v === undefined) {
        this.diag('warn', 'unknown-voice', `A fixed note names no voice '${n.voice}'.`, w.id);
        continue;
      }
      if (!(w.at + k * w.grid < w.until)) {
        past++;
        continue;
      }
      let list = notes.get(k);
      if (!list) notes.set(k, (list = []));
      if (list.some((x) => x.voice === v)) {
        bad++;
        continue;
      }
      list.push({ voice: v, pitch: n.pitch });
    }
    if (bad > 0) {
      this.diag(
        'info',
        'walk-note-ignored',
        `${bad} fixed note(s) are invalid or repeat a voice on a tick; they are ignored.`,
        w.id,
      );
    }
    if (past > 0) {
      this.diag(
        'info',
        'walk-note-ignored',
        `${past} fixed note(s) lie at or past the walk's end; they are ignored.`,
        w.id,
      );
    }
    return { ticks: [...notes.keys()].sort((a, b) => a - b), notes };
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  diag(level: DiagnosticLevel, code: string, message: string, momentId?: string): void {
    const d: Diagnostic = { level, code, message };
    if (momentId !== undefined) d.momentId = momentId;
    this.diags.push(d);
  }

  private touch(): void {
    this.epoch++;
    this.birthProjector = null;
  }

  /** Committed destination of a pool voice (§7.1), cached per epoch. */
  destOf(v: number): Pitch {
    if (this.destEpoch[v] === this.epoch) return this.destVal[v];
    const d = this.voices[v].dest((b) => this.birthPitch(b));
    this.destEpoch[v] = this.epoch;
    this.destVal[v] = d;
    return d;
  }

  /** Predicted pitch a pending newborn will be born on (its parent's pitch at the birth). */
  private birthPitch(b: Birth): Pitch {
    if (b.parent < 0) return b.pitch;
    if (!this.birthProjector) this.birthProjector = new Projector(this.voices, () => undefined);
    const st = this.birthProjector.birthState(b);
    return st ? st.p : b.pitch;
  }

  private activeEpoch = 0;
  private activeCache: number[] = [];

  /**
   * Active voices sorted by committed destination, ties by pool index (§7.2). Cached per epoch;
   * callers must not mutate the result.
   */
  sortedActive(): readonly number[] {
    if (this.activeEpoch === this.epoch) return this.activeCache;
    const out: number[] = [];
    for (const run of this.voices) if (run.status === Status.Active) out.push(run.index);
    this.activeCache = this.sortByDest(out);
    this.activeEpoch = this.epoch;
    return this.activeCache;
  }

  /** Scratch sort keys (committed destinations) by pool index. */
  private sortKey = new Float64Array(0);

  private sortByDest(vs: number[]): number[] {
    if (this.sortKey.length < this.voices.length)
      this.sortKey = new Float64Array(this.voices.length);
    const key = this.sortKey;
    let nan = false;
    for (const v of vs) {
      const d = this.destOf(v);
      key[v] = d;
      if (d !== d) nan = true;
    }
    if (nan) return vs.sort((a, b) => key[a] - key[b] || a - b);
    // (destination, index) is a strict total order without NaN, so any correct sort gives the
    // same result; insertion sort is fast on the short, nearly sorted lists seen here.
    for (let i = 1; i < vs.length; i++) {
      const v = vs[i];
      const kv = key[v];
      let j = i - 1;
      while (j >= 0) {
        const u = vs[j];
        const ku = key[u];
        if (ku < kv || (ku === kv && u < v)) break;
        vs[j + 1] = u;
        j--;
      }
      vs[j + 1] = v;
    }
    return vs;
  }

  /** The voices a selector picks at the current time (§6.1), sorted by committed destination. */
  resolveTarget(
    sel: VoiceSelector | undefined,
    momentId: string | null,
    x: Expansion | null = null,
  ): number[] {
    const active = x ? x.active : this.sortedActive();
    if (sel === undefined || sel === 'all') return active.slice();
    if (typeof sel === 'object' && 'voices' in sel && Array.isArray(sel.voices)) {
      const want = new Set<number>();
      for (const id of sel.voices) {
        const v = this.byId.get(id);
        if (v === undefined) {
          if (momentId !== null) {
            this.diag('warn', 'unknown-voice', `The target names no voice '${id}'.`, momentId);
          }
        } else {
          want.add(v);
        }
      }
      // A line's phantoms go with it (a merged note is targeted whole), and with their own id.
      return active.filter((v) => want.has(v) || (x !== null && want.has(x.base.get(v) ?? v)));
    }
    if (typeof sel === 'object' && 'rank' in sel && Array.isArray(sel.rank)) {
      const a = Number(sel.rank[0]);
      const b = Number(sel.rank[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
      const lo = Math.max(0, Math.ceil(Math.min(a, b)));
      const hi = Math.min(active.length - 1, Math.floor(Math.max(a, b)));
      return lo <= hi ? active.slice(lo, hi + 1) : [];
    }
    const part = selectorPart(sel);
    if (part !== null) {
      if (!this.parts.has(part)) {
        if (momentId !== null)
          this.diag('warn', 'unknown-part', `The target names no part '${part}'.`, momentId);
        return [];
      }
      return active.filter((v) => this.lineOf(v, x).part === part);
    }
    return active.slice();
  }

  /** Parts of the pool (revision 9; '' when some voice has none). */
  private parts = new Set<string>();

  /** The line a (logical) voice belongs to. */
  private lineOf(u: number, x: Expansion | null): VoiceRun {
    return this.voices[x ? (x.base.get(u) ?? u) : u];
  }

  /** Pool voices a split may birth at t: not active, their last life ended (§7.4). */
  dormantAt(t: Seconds): number[] {
    const out: number[] = [];
    for (const run of this.voices) {
      if (run.status === Status.Active || run.pendingBirth) continue;
      // A dying voice whose close falls at t is not free before that close runs (move starts
      // follow moment events at equal times): reused, the close would end its new life.
      if (run.status === Status.Dying) continue;
      if (run.diedAt <= t) out.push(run.index);
    }
    return out;
  }

  private activity(t: Seconds): void {
    if (t > this.lastActivity) this.lastActivity = t;
  }

  private span(i: number, start: Seconds, end: Seconds): void {
    if (!(this.spanStart[i] <= start)) this.spanStart[i] = start;
    if (!(this.spanEnd[i] >= end)) this.spanEnd[i] = end;
  }

  // -------------------------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------------------------

  run(): CompiledScore {
    for (;;) {
      const ev = this.queue.peek();
      if (!ev || ev.t >= this.endAt) break;
      this.queue.pop();
      this.clock = ev.t;
      // Move starts, births and closes never change a committed destination or the active set
      // (a started move's target was already the destination), so only moments and walk ticks
      // invalidate the caches.
      switch (ev.cls) {
        case EventClass.Moment:
          if (ev.sub === SUB_NOTE_BACK) {
            this.touch();
            this.onPointMoment(ev.ref, ev.obj as NoteBack);
            this.reaim(ev.t, ev.ref);
            break;
          }
          if (ev.sub === SUB_LANDED) {
            this.touch();
            this.onMoment(ev.ref, true);
            this.reaim(ev.t, ev.ref);
            break;
          }
          if (this.onMomentEvent) this.onMomentEvent(ev.t, ev.ref);
          this.touch();
          this.onMoment(ev.ref);
          this.reaim(ev.t, ev.ref);
          break;
        case EventClass.MoveStart: {
          const sub = Math.floor(ev.key / SUB_STRIDE);
          if (sub === SUB_CLOSE) this.onClose(ev.obj as CloseRec);
          else if (sub === SUB_BIRTH) this.onBirth(ev.obj as Birth);
          else if (sub === SUB_JOIN) this.onJoin(ev.obj as JoinRec);
          else if (sub === SUB_HANDOVER) this.onHandover(ev.obj as HandoverRec);
          else this.onMove(ev.obj as Move);
          break;
        }
        case EventClass.Tick:
          // A pulse changes no pitch, destination or active set: no cache to invalidate.
          if (this.moments[ev.key].type === 'pulse') {
            this.onPulseTick(ev.key, ev.ref, ev.obj as PulseState);
            break;
          }
          this.touch();
          this.onTick(ev.key, ev.ref);
          break;
      }
    }
    return this.finish();
  }

  /** `late`: a land moment re-queued at its `at` (SUB_LANDED). */
  private onMoment(i: number, late = false): void {
    const m = this.moments[i];
    const T = late ? m.at : this.eventT[i];
    this.activity(T);
    switch (m.type) {
      case 'key':
        if (sameKey(m.key, this.key)) this.noEffect(m, [], []);
        this.key = m.key;
        this.keys.push({ t: T, key: m.key });
        this.span(i, T, T);
        this.traceMoment(i, [], false, null, null);
        return;
      case 'level': {
        const vs = this.resolveTarget(m.target, m.id);
        const over = Number.isFinite(m.over) && m.over > 0 ? m.over : 0;
        if (!Number.isFinite(m.gain)) {
          this.diag('error', 'invalid-moment', 'The level gain is not a number.', m.id);
          return;
        }
        if (vs.every((v) => this.levelOf(v) === m.gain)) {
          this.noEffect(m, vs, this.sortedActive());
        }
        for (const v of vs) this.voices[v].level.push({ t: T, gain: m.gain, over });
        if (vs.length === 0)
          this.diag('info', 'no-targets', 'The level targets no active voice.', m.id);
        this.span(i, T, T + over);
        this.activity(T + over);
        this.traceMoment(i, vs, m.target !== undefined && m.target !== 'all', null, null);
        return;
      }
      case 'pulse':
        // Claim at the moment event, before any tick at T: an earlier pulse's step at T must
        // not hit a voice this one takes over.
        for (const v of this.resolveTarget(m.target, m.id)) this.pulseClaim(i, v, T);
        this.span(i, T, m.until);
        this.activity(m.until);
        this.traceMoment(i, [], false, null, null);
        return;
      case 'walk':
        this.span(i, T, m.until);
        this.activity(m.until);
        this.traceMoment(i, [], false, null, null);
        return;
      default:
        // A land moment whose lead-in finds nothing sounding waits for its marker (revision 9):
        // an establishing chord then comes in on the beat.
        if (!late && T < m.at && this.sortedActive().length === 0) {
          this.queue.push({ t: m.at, cls: EventClass.Moment, key: i, sub: SUB_LANDED, ref: i });
          return;
        }
        this.onPointMoment(i, null, late);
    }
  }

  /**
   * The key moment `i` reads: the one in effect at its `at` (§6.2 `key`), also for a land
   * moment deciding earlier (revision 9). Key moments at the same time count in array order.
   */
  private keyFor(i: number): Key {
    const at = this.moments[i].at;
    if (this.eventT[i] === at) return this.key;
    let key = this.piece.key;
    let bestAt = -Infinity;
    for (const j of this.keyMoments) {
      const aj = this.moments[j].at;
      if (!(aj < at || (aj === at && j < i))) continue;
      if (aj >= bestAt) {
        bestAt = aj;
        key = (this.moments[j] as KeyMoment).key;
      }
    }
    return key;
  }

  /** Committed destinations of the active voices (NaN otherwise), into `out`. */
  private destsInto(out: Float64Array): Float64Array {
    out.fill(NaN);
    for (const v of this.sortedActive()) out[v] = this.destOf(v);
    return out;
  }

  private effBefore = new Float64Array(0);
  private effAfter = new Float64Array(0);

  /**
   * A point moment (or a note moment's return), then the `no-effect` check (§7.9, revision 6):
   * destinations before the moment (before its cancellations) against those after it. Skipped
   * for returns, and when the moment raised an error or a `note-not-sounding` warning.
   */
  private onPointMoment(i: number, back: NoteBack | null = null, late = false): void {
    const n = this.voices.length;
    if (this.effBefore.length !== n) {
      this.effBefore = new Float64Array(n);
      this.effAfter = new Float64Array(n);
    }
    const before = this.destsInto(this.effBefore);
    // A `{ part }` target's reason reads its part (revision 9).
    const scope = selectorPart(this.moments[i].target);
    const inScope = (v: number): boolean => scope === null || this.voices[v].part === scope;
    const activeBefore = this.sortedActive().filter(inScope);
    const T = back ? back.t : late ? this.moments[i].at : this.eventT[i];
    const dormant = this.dormantAt(T).filter(inScope).length;
    // The reason reads what the moment saw: lines for a moment with a count, else the voices
    // the lines stand for (revision 8; owner, 2026-11-21).
    const flat = countsLines(this.moments[i]);
    const counts = this.voices.map((r) => (flat ? 1 : r.count));
    const d0 = this.diags.length;
    const { targeted, res, lost, absorbed } = this.applyPointMoment(i, back, late);
    if (back) return;
    for (let k = d0; k < this.diags.length; k++) {
      const d = this.diags[k];
      if (d.level === 'error' || d.code === 'note-not-sounding') return;
    }
    const deaths: { voice: number; to: Pitch }[] = [];
    const births: { voice: number; parent: number }[] = [];
    if (res) {
      for (const mv of res.moves) if (mv.death) deaths.push({ voice: mv.voice, to: mv.to });
      for (const b of res.births) births.push({ voice: b.voice, parent: b.parent });
    }
    const after = this.destsInto(this.effAfter);
    if (changesPitch({ before, after, deaths, births })) return;
    this.diag(
      'info',
      'no-effect',
      `No effect: ${noEffectReason(this.moments[i], {
        targeted: targeted.flatMap((v) => Array<number>(counts[v]).fill(before[v])),
        active: activeBefore.flatMap((v) => Array<number>(counts[v]).fill(before[v])),
        births: births.length + absorbed,
        deaths: deaths.length + lost,
        dormant,
      })}.`,
      this.moments[i].id,
    );
  }

  /** Raises `no-effect` for a key or level moment. */
  private noEffect(m: Moment, targeted: readonly number[], active: readonly number[]): void {
    const reason = noEffectReason(m, {
      targeted: targeted.map((v) => this.destOf(v)),
      active: active.map((v) => this.destOf(v)),
      births: 0,
      deaths: 0,
      dormant: 0,
    });
    this.diag('info', 'no-effect', `No effect: ${reason}.`, m.id);
  }

  /** The level target of a voice now (1 before its first level change). */
  private levelOf(v: number): number {
    const l = this.voices[v].level;
    return l.length > 0 ? l[l.length - 1].gain : 1;
  }

  private applyPointMoment(
    i: number,
    back: NoteBack | null,
    late: boolean,
  ): { targeted: number[]; res: PlanResult | null; lost: number; absorbed: number } {
    const m0 = this.moments[i];
    // A return runs the note moment again at its own time, `from` and `to` swapped.
    const m: Moment = back
      ? {
          ...(m0 as NoteMoment),
          at: back.t,
          from: undefined,
          to: undefined,
          changes: back.changes,
          back: undefined,
        }
      : m0;
    // A land moment decides at its lead-in start (revision 9); its rests are drawn at `at`.
    const land = back || late ? null : this.landings[i];
    const T = land ? land.start : m.at;
    const rest = back ? T : m0.at;
    const glide = land ? land.glide : this.glides[i];
    const key = back ? this.key : this.keyFor(i);
    if (!back && this.sortedActive().length === 0) return this.establish(i);
    // Distinct notes (revision 8): the moment function sees each line as `count` stacked voices,
    // or once when the moment's count is a number of lines (`countsLines`).
    const dormant = this.dormantAt(T);
    const x = expand(
      this.voices,
      this.sortedActive(),
      dormant,
      (v) => this.destOf(v),
      countsLines(m),
    );
    let pre: number[];
    let subset: boolean;
    if (m.type === 'pin') {
      const v = this.byId.get(m.voice);
      // A voice merged into a line is one of its stacked copies: the pin moves that copy.
      pre =
        v === undefined
          ? []
          : this.voices[v].status === Status.Active
            ? x.copies.get(v)!.slice()
            : x.base.has(v)
              ? [v]
              : [];
      subset = true;
    } else {
      pre = this.resolveTarget(m.target, back ? null : m.id, x); // a return does not re-warn
      subset = m.target !== undefined && m.target !== 'all';
    }
    const lines = (us: readonly number[]): number[] => {
      const out = new Set<number>();
      for (const u of us) out.add(x.base.get(u) ?? u);
      return [...out];
    };
    // Untargeted copies of a partly targeted line keep where it was heading.
    const preDest = new Map<number, Pitch>();
    for (const b of lines(pre)) preDest.set(b, this.destOf(b));
    const inPre = new Set(pre);
    const destU = (u: number): Pitch => {
      const b = x.base.get(u) ?? u;
      return inPre.has(u) || !preDest.has(b) ? this.destOf(b) : preDest.get(b)!;
    };
    const sortU = (us: number[]): number[] => us.sort((a, b) => destU(a) - destU(b) || a - b);
    const seed = back ? hash32(this.seeds[i], 'back') : this.seeds[i];
    const free = dormant.filter((u) => !x.reserved.has(u));
    let targeted: number[];
    let plan: MomentPlan | null;
    if (m.type === 'note') {
      // A note reads where the voices are heading before cancelling anything, and cancels only
      // when it applies: a voice whose pending move it cancels but does not change then gets a
      // move to that same destination (planMoment sees it differ from the new committed one).
      targeted = sortU(pre.slice());
      plan = noteMoment(
        m,
        this.env(i, targeted, T, seed, x, destU, free, glide, key),
        back !== null,
      );
      if (plan) {
        for (const v of lines(pre)) this.voices[v].cancelPending();
        this.touch();
        // x.active keeps the pre-cancel order the note was planned in: collapse lists the pool
        // intents in it, so an ordered note's intents stay sorted by target.
        targeted = sortU(pre.slice());
      }
    } else {
      for (const v of lines(pre)) this.voices[v].cancelPending();
      this.touch();
      x.active = sortU(x.active.slice());
      targeted = sortU(pre.slice());
      plan = pointMomentPlan(m, this.env(i, targeted, T, seed, x, destU, free, glide, key));
    }
    const targetedLines = this.sortByDest(lines(targeted));
    if (!plan) {
      if (!back) this.span(i, rest, rest); // a skipped return leaves the span as it is
      this.traceMoment(i, targetedLines, subset, null, null, T);
      return { targeted: targetedLines, res: null, lost: 0, absorbed: 0 };
    }
    const host = {
      voices: this.voices,
      t: T,
      momentId: m.id,
      momentIndex: i,
      glide,
      seed,
      crossings: this.options.crossings,
      land: land ? land.end : undefined,
      dest: (v: number) => this.destOf(v),
      diag: (level: DiagnosticLevel, code: string, message: string) =>
        this.diag(level, code, message, m.id),
    };
    this.partBirths(plan, x, free, m.id);
    // Per-voice overrides (§11.3, revision 6): not on a note's return.
    const ov = back ? null : overridesOf(m, this.voices.length);
    if (ov) applyOverridePitches(plan, ov, targeted);
    const logical = plan;
    const rangeU = (u: number): readonly [Pitch, Pitch] =>
      this.voices[u < x.pool ? u : x.base.get(u)!].range;
    const col = collapse(x, logical, targeted, this.voices, destU, free);
    if (col.exhausted > 0) {
      this.diag(
        'info',
        'pool-exhausted',
        `${col.exhausted} note(s) could not split off: no free voice in the pool.`,
        m.id,
      );
    }
    plan = col.plan;
    const res = planMoment(host, plan, targetedLines, subset);
    if (ov) applyOverrideEnds(res, ov, T, m.at, this.voices);
    this.commitLines(col, res, T, i, ov);
    for (const b of res.births) {
      const run = this.voices[b.voice];
      run.status = Status.Active;
      run.pendingBirth = b;
      this.queue.push({
        t: b.t,
        cls: EventClass.MoveStart,
        key: SUB_BIRTH * SUB_STRIDE + b.voice,
        sub: 0,
        ref: 0,
        obj: b,
      });
    }
    for (const mv of res.moves) {
      const run = this.voices[mv.voice];
      run.pending.push(mv);
      if (run.pending.length > 1) run.pending.sort((a, b) => a.t0 - b.t0);
      if (mv.death) {
        run.status = Status.Dying;
        run.diedAt = Infinity;
      }
      this.queue.push({
        t: mv.t0,
        cls: EventClass.MoveStart,
        key: SUB_MOVE * SUB_STRIDE + mv.voice,
        sub: 0,
        ref: 0,
        obj: mv,
      });
    }
    // A newborn of an earlier moment whose move this one replaced is born at its new departure,
    // not left waiting on its parent's pitch (revision 8: lines never rest on one note).
    for (const mv of res.moves) {
      const run = this.voices[mv.voice];
      const b = run.pendingBirth;
      if (!b || mv.death || b.momentId === m.id || !(mv.t0 > b.t)) continue;
      const nb: Birth = { ...b, t: mv.t0 };
      run.pendingBirth = nb;
      this.queue.push({
        t: nb.t,
        cls: EventClass.MoveStart,
        key: SUB_BIRTH * SUB_STRIDE + nb.voice,
        sub: 0,
        ref: 0,
        obj: nb,
      });
    }
    // Lines this moment left holding (a cancelled move, no new one) may now share a note.
    for (const v of targetedLines) {
      const run = this.voices[v];
      if (run.pending.length === 0 && this.holding(run, T)) this.queueJoin(v, T);
    }
    if (res.moves.length === 0) this.span(i, rest, rest);
    else if (!back && m.type === 'note' && plan.notes)
      this.scheduleBack(i, m, plan.notes, plan, res);
    this.touch();
    this.recordHarmony(i, T, key);
    this.traceMoment(
      i,
      targetedLines,
      subset,
      res.trace,
      x.stacked ? logical.intents : plan.intents,
      T,
      x.stacked ? rangeU : null,
      plan.intents,
    );
    let lost = 0;
    for (const l of col.lose.values()) lost += l.count;
    return { targeted: targetedLines, res, lost, absorbed: col.absorbed };
  }

  /**
   * Revision 9: a newborn is a voice of its parent's part (the line it forks from), so a split or
   * a chord `count` across parts never moves a voice into another part. A birth on a voice of
   * another part takes the first free voice of the parent's part; with none, it is dropped
   * (`pool-exhausted`). Without parts every voice is in one group and nothing changes.
   */
  private partBirths(plan: MomentPlan, x: Expansion, free: readonly number[], id: string): void {
    if (this.parts.size < 2) return;
    const used = new Set<number>();
    for (const it of plan.intents) if (it.kind === IntentKind.Birth) used.add(it.voice);
    const drop = new Set<Intent>();
    for (const it of plan.intents) {
      if (it.kind !== IntentKind.Birth || (it.parent ?? -1) < 0) continue;
      const want = this.lineOf(it.parent!, x).part;
      if (it.voice < x.pool && this.voices[it.voice].part === want) continue;
      const u = free.find((v) => !used.has(v) && this.voices[v].part === want);
      if (u === undefined) {
        drop.add(it);
        continue;
      }
      used.add(u);
      it.voice = u;
    }
    if (drop.size === 0) return;
    const kept = plan.intents.filter((it) => !drop.has(it));
    if (plan.notes) {
      const at = plan.notes.map((n) => kept.indexOf(plan.intents[n.intent]));
      plan.notes = plan.notes
        .map((n, j) => ({ intent: at[j], from: n.from }))
        .filter((n) => n.intent >= 0);
    }
    plan.intents = kept;
    this.diag(
      'warn',
      'pool-exhausted',
      `${drop.size} note(s) found no free voice in their line's part; they were dropped.`,
      id,
    );
  }

  /**
   * A point moment when nothing is sounding (M4.5-27). An establishing one (a chord with notes, a
   * unison) brings its voices in on their notes at its time, with no glide and no fade-in, each
   * holding its note as the moment's segment; voices sent to one pitch stack into one line
   * (count, weight and members, as a coincidence merge). Any other has nothing to act on: the
   * caller reports `no-effect`.
   */
  private establish(i: number): {
    targeted: number[];
    res: PlanResult | null;
    lost: number;
    absorbed: number;
  } {
    const m = this.moments[i];
    const T = m.at;
    const subset = m.target !== undefined && m.target !== 'all';
    const none = { targeted: [], res: null, lost: 0, absorbed: 0 };
    const free = this.dormantAt(T);
    const x = expand(this.voices, [], free, (v) => this.destOf(v), true);
    const plan = isEstablishing(m)
      ? establishPlan(
          m,
          this.env(i, [], T, this.seeds[i], x, (v) => this.destOf(v), free),
        )
      : null;
    this.span(i, T, T);
    if (!plan || plan.intents.length === 0) {
      this.traceMoment(i, [], subset, null, null, T);
      return none;
    }
    let folded = 0;
    const lines: VoiceRun[] = [];
    for (const it of plan.intents) {
      const run = this.voices[it.voice];
      const f = foldIntoRange(it.to, run.range[0], run.range[1]);
      if (f.folded || f.clampedToRange) folded++;
      it.to = f.p;
      // Voices on one pitch are one line (revision 8): the first one in carries the others.
      // Only within a part (revision 9).
      const same = lines.find(
        (r) => r.part === run.part && Math.abs(r.frontier.heading - f.p) <= SAME_PITCH,
      );
      if (same) {
        same.setCount(T, same.count + 1);
        same.weight++;
        same.members.push(it.voice);
        same.rampWeight(T, same.weight, 0);
        continue;
      }
      run.status = Status.Active;
      run.frontier.openAt(T, { p: f.p, v: 0, mid: false }, m.id);
      run.life = { born: T, fadeIn: 0 };
      run.lives.push(run.life);
      lines.push(run);
    }
    if (folded > 0) {
      this.diag(
        'info',
        'range-fold',
        `${folded} target(s) outside a voice's range were folded by octave.`,
        m.id,
      );
    }
    this.touch();
    this.recordHarmony(i, T, this.key);
    this.traceMoment(i, [], subset, null, plan.intents, T);
    return none;
  }

  /**
   * Distinct notes (revision 8): the counts, weights and members of the lines a moment changed.
   * Forks and fresh births get theirs now (they are active from the moment); the weight ramps
   * that happen at a birth are written when it happens (`onBirth`).
   */
  private commitLines(
    col: Collapsed,
    res: PlanResult,
    T: Seconds,
    i: number,
    ov: ReadonlyMap<number, VoiceOverride> | null,
  ): void {
    for (const [b, k] of col.keep) {
      const run = this.voices[b];
      run.setCount(T, k.count);
      run.members = k.members;
    }
    for (const b of res.births) {
      const run = this.voices[b.voice];
      const f = col.forks.get(b.voice);
      if (f) {
        b.fork = f.weight;
        b.forkAt = T;
        b.weight = f.weight;
        b.fadeIn = FORK_FADE;
        run.setCount(T, f.count);
        run.weight = f.weight;
        run.members = f.members;
        this.voices[f.parent].weight -= f.weight;
      } else {
        run.setCount(T, 1);
        run.weight = 1;
        run.members = [];
      }
    }
    const g = this.glides[i];
    for (const [b, l] of col.lose) {
      const run = this.voices[b];
      run.setCount(T, Math.max(1, run.count - l.count));
      run.weight -= l.weight;
      run.rampWeight(T, run.lastWeight - l.weight, g.length);
    }
    for (const [v, a] of col.absorb) {
      const run = this.voices[v];
      run.setCount(T, run.count + a.count);
      run.weight += a.weight;
      const b = res.births.find((x) => x.voice === v);
      if (b) b.weight = run.weight;
      else if (!run.pendingBirth) run.rampWeight(T, run.lastWeight + a.weight, g.length);
    }
    if (!ov) return;
    for (const [v, o] of ov) {
      if (o.weight === undefined) continue;
      const run = this.voices[v];
      const b = res.births.find((x) => x.voice === v);
      if (b) {
        // The newborn starts at the hand-set weight; its parent still gives only its share.
        b.weight = o.weight;
        run.weight = o.weight;
      } else if (run.status === Status.Active) {
        const delta = o.weight - run.weight;
        run.weight = o.weight;
        run.rampWeight(T, run.lastWeight + delta, g.length);
      }
    }
  }

  /** Queues a note moment's return (§6.2 `back`): `back` seconds after its glide ends. */
  private scheduleBack(
    i: number,
    m: NoteMoment,
    notes: readonly { intent: number; from: Pitch }[],
    plan: { intents: readonly Intent[] },
    res: PlanResult,
  ): void {
    const wait = m.back;
    if (!(typeof wait === 'number' && Number.isFinite(wait) && wait >= 0)) return;
    let end = m.at;
    for (const mv of res.moves) if (mv.t0 + mv.dur > end) end = mv.t0 + mv.dur;
    const t = end + wait;
    // The carrier's target after range folding (planMoment folds the intents in place).
    const rec: NoteBack = {
      t,
      changes: notes.map((n) => ({ from: plan.intents[n.intent].to, to: n.from })),
    };
    this.queue.push({ t, cls: EventClass.Moment, key: i, sub: SUB_NOTE_BACK, ref: i, obj: rec });
  }

  /**
   * Appends the harmony the active voices are heading to after moment i (HUD, §10). A written
   * chord symbol always starts an entry; otherwise an unchanged pitch-class set keeps the last one.
   */
  private recordHarmony(i: number, t: Seconds, key: Key): void {
    const m = this.moments[i];
    const active = this.sortedActive();
    if (active.length === 0) return;
    const notes = m.type === 'chord' || m.type === 'split' ? m.notes : undefined;
    const symbol = notes?.kind === 'chord' ? notes.symbol : undefined;
    const bass = mod(Math.round(this.destOf(active[0])), 12);
    const seen = new Set<number>();
    const pcs: number[] = [];
    for (const v of active) {
      const pc = mod(Math.round(this.destOf(v)), 12);
      if (!seen.has(pc)) {
        seen.add(pc);
        pcs.push(pc);
      }
    }
    const last = this.harmony[this.harmony.length - 1];
    if (
      symbol === undefined &&
      last &&
      last.bass === bass &&
      last.pcs.length === pcs.length &&
      last.pcs.every((p, j) => p === pcs[j])
    ) {
      return;
    }
    this.harmony.push({
      t,
      momentId: m.id,
      pcs,
      bass,
      label: cachedHarmonyLabel(this.labels, symbol, pcs, bass, key),
    });
  }

  private env(
    i: number,
    targeted: number[],
    t: Seconds,
    seed: number,
    x: Expansion,
    dest: (u: number) => Pitch,
    free: readonly number[],
    glide: Glide = this.glides[i],
    key: Key = this.key,
  ): MomentEnv {
    const m = this.moments[i];
    const P = x.pool;
    const line = (u: number): VoiceRun => this.voices[x.base.get(u) ?? u];
    // Revision 9: a moment targeting a part sees that part only (its lines, its dormant voices),
    // so its counts count the part's lines.
    const scope = selectorPart(m.target);
    const active = scope === null ? x.active : x.active.filter((u) => line(u).part === scope);
    const dormant = scope === null ? free : free.filter((u) => this.voices[u].part === scope);
    return {
      t,
      momentId: m.id,
      key,
      seed,
      glide,
      targeted,
      active,
      dest,
      now: (u) => line(u).frontier.stateAt(t)?.p ?? NaN,
      range: (u) => (u < P ? this.voices[u] : line(u)).range,
      id: (u) => (u < P ? this.voices[u].id : x.synthId[u - P]),
      part: (u) => line(u).part,
      sounding: (u) => line(u).sounding,
      dormant: () => dormant.slice(),
      indexOf: (id) => this.byId.get(id) ?? -1,
      diag: (level, code, message) => this.diag(level, code, message, m.id),
      rand: (u, step, purpose) =>
        randHashed(
          seed,
          u < 0 ? this.emptyHash : u < P ? this.voices[u].hash : x.synthHash[u - P],
          step,
          purpose,
        ),
    };
  }

  private onBirth(b: Birth): void {
    const run = this.voices[b.voice];
    if (run.pendingBirth !== b) return;
    run.pendingBirth = null;
    // A parent not born yet (its own birth moved later) is still on its parent's note: start there.
    let src = b.parent;
    for (let k = 0; src >= 0 && k <= this.voices.length; k++) {
      const pr = this.voices[src];
      if (pr.frontier.alive || !pr.pendingBirth || !(pr.pendingBirth.t >= b.t)) break;
      src = pr.pendingBirth.parent;
    }
    const parent = src >= 0 ? this.voices[src].frontier.stateAt(b.t) : null;
    run.frontier.openAt(b.t, parent ?? { p: b.pitch, v: 0, mid: false });
    run.life = { born: b.t, fadeIn: b.fadeIn };
    // A fork crossfades out of its parent (owner 2026-11-21) over the start of its departure:
    // the newborn fades in along `crossfade` while the parent's weight falls by its share (a
    // parent not sounding yet starts without it, and the newborn fades in as before).
    if (b.fork !== undefined && b.parent >= 0) {
      const p = this.voices[b.parent];
      if (p.life && p.life.born < (b.forkAt ?? b.t)) {
        let glide = 0;
        for (const mv of run.pending) {
          if (mv.cancelled) continue;
          if (mv.t0 <= b.t + 1e-9) glide = mv.dur;
          break;
        }
        const L = crossfadeLength(glide);
        run.life = { born: b.t, fadeIn: L, crossIn: true };
        p.rampWeight(b.t, p.lastWeight - b.fork, L, 0, true);
      }
    }
    run.lives.push(run.life);
    // Its committed weight now: forks taken from it before it sounded are already out of it.
    run.rampWeight(b.t, run.weight, 0);
    // A newborn whose own move a later moment replaced may now go where its parent goes.
    this.queueJoin(b.voice, b.t);
    this.activity(b.t);
    if (this.pulses.length > 0) this.pulseJoin(b.voice, b.t);
  }

  // -------------------------------------------------------------------------------------------
  // Pulse (revision 9; envelope and step rules in core/pulse.ts)
  // -------------------------------------------------------------------------------------------

  /** Pulse a started before pulse b (later `at`, then later in the array, drives a voice). */
  private pulseBefore(a: number, b: number): boolean {
    const ta = this.moments[a].at;
    const tb = this.moments[b].at;
    return ta < tb || (ta === tb && a < b);
  }

  /**
   * Puts voice v under pulse pi at t unless a later-started pulse drives it: a boundary record
   * at the pulse's floor. Returns whether pi drives it now.
   */
  private pulseClaim(pi: number, v: number, t: Seconds): boolean {
    const run = this.voices[v];
    const owner = run.pulseOwner;
    if (owner === pi) return true;
    if (owner >= 0 && !this.pulseBefore(owner, pi)) return false;
    run.pulseOwner = pi;
    const p = this.moments[pi] as PulseMoment;
    run.pulse.push({ t, accent: 1, decay: 0, floor: unit(p.floor, 0), strike: false });
    return true;
  }

  /**
   * Voice v joins the latest-started pulse running at t that targets it, if any: a voice born
   * inside a pulse sits at the floor from its birth, not only from the next step, and a voice
   * whose driving pulse ends goes back to an earlier pulse still running.
   */
  private pulseJoin(v: number, t: Seconds): void {
    let best = -1;
    for (const pi of this.pulses) {
      const p = this.moments[pi] as PulseMoment;
      if (!(p.at <= t && t < p.until)) continue;
      if (best >= 0 && this.pulseBefore(pi, best)) continue;
      if (this.resolveTarget(p.target, null).includes(v)) best = pi;
    }
    if (best >= 0) this.pulseClaim(best, v, t);
  }

  /**
   * Step k of pulse pi (core/pulse.ts): claim the targeted voices, then hit the sounding ones
   * (all, or one by the mode). The tick at or after `until` ends the pulse: its voices go back
   * to 1.
   */
  private onPulseTick(pi: number, k: number, st: PulseState): void {
    const p = this.moments[pi] as PulseMoment;
    const t = p.at + k * p.step;
    if (!(t < p.until)) {
      for (const run of this.voices) {
        if (run.pulseOwner !== pi) continue;
        run.pulseOwner = -1;
        this.pulseJoin(run.index, p.until);
        if (run.pulseOwner < 0)
          run.pulse.push({ t: p.until, accent: 1, decay: 0, floor: 1, strike: false });
      }
      if (!st.heard) this.noEffect(p, [], this.sortedActive());
      return;
    }
    const targets = this.resolveTarget(p.target, null);
    const members: number[] = [];
    for (const v of targets) {
      if (this.pulseClaim(pi, v, t) && this.voices[v].frontier.alive) members.push(v);
    }
    const accent = unit(p.pattern[k % p.pattern.length], 0);
    let next: PulseState = st;
    if (members.length > 0 && !st.heard) next = { ...next, heard: true };
    if (accent > 0 && members.length > 0) {
      const rec: PulseRecord = {
        t,
        accent,
        decay: Number.isFinite(p.decay) && p.decay > 0 ? p.decay : 0,
        floor: unit(p.floor, 0),
        strike: p.strike !== false,
        hit: true,
      };
      if (p.mode === 'together' || members.length === 1) {
        for (const v of members) this.voices[v].pulse.push(rec);
      } else {
        // Pitch order at this instant (the chord may be gliding), ties by pool index.
        const at = members.map((v) => this.voices[v].frontier.stateAt(t)?.p ?? NaN);
        const order = members
          .map((_, j) => j)
          .sort((a, b) => at[a] - at[b] || members[a] - members[b]);
        let j: number;
        if (p.mode === 'random') {
          j = Math.floor(
            randHashed(this.seeds[pi], this.emptyHash, k, Purpose.PulsePick) * order.length,
          );
        } else {
          const w = nextPulseIndex(p.mode, order.length, st);
          next = { ...next, index: w.index, dir: w.dir };
          j = w.index;
        }
        this.voices[members[order[j]]].pulse.push(rec);
      }
    }
    const tn = p.at + (k + 1) * p.step;
    this.queue.push({
      t: tn < p.until ? tn : p.until,
      cls: EventClass.Tick,
      key: pi,
      sub: 0,
      ref: k + 1,
      obj: next,
    });
  }

  /** Starts a move now (§7.1 move-start); returns false if the voice is silent. */
  private startMove(mv: Move): boolean {
    const run = this.voices[mv.voice];
    if (!run.frontier.alive) return false;
    let to = mv.to;
    let arrive = -Infinity;
    if (mv.death && mv.death.into >= 0) {
      // Glide to where the survivor is going now (a later moment may have moved it before this
      // glide started), and fade once it is there too (M4.5-17).
      // Read fresh, not from the per-epoch cache: follows change dying voices between moments.
      const a = this.voices[mv.death.into];
      const h = a.pendingBirth ? NaN : a.dest(() => NaN);
      if (h === h && h >= run.range[0] && h <= run.range[1]) {
        to = h;
        arrive = arrivalOf(a);
      }
    }
    const lead = run.frontier.stateAt(mv.t0);
    const seg = run.frontier.start(
      mv.t0,
      mv.dur,
      to,
      mv.ease,
      mv.limits,
      mv.crossScale,
      run.range,
      mv.momentId,
      mv,
    );
    this.span(mv.momentIndex, mv.t0, seg.t1);
    this.activity(seg.t1);
    if (mv.death) {
      run.into = mv.death.into;
      run.deathFade = mv.death.fade;
      this.scheduleClose(run, (arrive > seg.t1 ? arrive : seg.t1) + mv.death.fade);
    }
    this.follow(run, mv, to, mv.death ? mv.death.into : null, 0, lead);
    if (!mv.death) this.queueJoin(mv.voice, seg.t1);
    return true;
  }

  /** Queues a join check for line v at t (revision 8; `onJoin`). */
  private queueJoin(v: number, t: Seconds): void {
    const rec: JoinRec = { voice: v, t };
    this.queue.push({
      t,
      cls: EventClass.MoveStart,
      key: SUB_JOIN * SUB_STRIDE + v,
      sub: 0,
      ref: 0,
      obj: rec,
    });
  }

  /** Active and holding at t: no glide running, or one that keeps its pitch (revision 8 joins). */
  private holding(run: VoiceRun, t: Seconds): boolean {
    if (run.status !== Status.Active || !run.frontier.alive || run.pendingBirth) return false;
    if (!run.frontier.busyAt(t)) return true;
    const g = run.frontier.tail!;
    return g.p0 === g.p1 && !g.curve && !g.m0;
  }

  /**
   * Distinct notes (revision 8): a line that comes to rest on another line's resting pitch merges
   * into it, when both are heading to the same place (nothing pending, or pending moves to one
   * destination: a later moment already sends both there). The line that was there first
   * survives (the same time: the lower pool index); the other drops its pending moves and fades
   * out over HANDOVER, following it, while the survivor takes its count, weight and members.
   * Lines that only pass through each other's pitch on the way to different notes stay apart, and
   * lines of different parts never join (revision 9).
   */
  private onJoin(j: JoinRec): void {
    const a = this.voices[j.voice];
    const t = j.t;
    if (!this.holding(a, t)) return;
    const p = a.frontier.heading;
    const da = a.dest(() => NaN);
    const group: VoiceRun[] = [a];
    for (const run of this.voices) {
      if (run === a || run.part !== a.part || !this.holding(run, t)) continue;
      if (Math.abs(run.frontier.heading - p) > SAME_PITCH) continue;
      if (Math.abs(run.dest(() => NaN) - da) <= SAME_PITCH) group.push(run);
    }
    if (group.length < 2) return;
    const since = (r: VoiceRun): Seconds =>
      r.frontier.open ? r.frontier.tail!.t0 : r.frontier.tail!.t1;
    let s = group[0];
    for (const r of group) {
      const dr = since(r);
      const ds = since(s);
      if (dr < ds || (dr === ds && r.index < s.index)) s = r;
    }
    this.touch();
    // One crossfade window for the group: the end of the longest approach into the meeting.
    let glide = 0;
    for (const r of group) {
      const g = approachInto(r, t);
      if (g > glide) glide = g;
    }
    const L = crossfadeLength(glide);
    for (const d of group) {
      if (d === s) continue;
      s.setCount(t, s.count + d.count);
      s.members = [...s.members, d.index, ...d.members];
      d.setCount(t, 1);
      d.members = [];
      for (const mv of d.pending) mv.cancelled = true;
      d.pending.length = 0;
      d.status = Status.Dying;
      d.into = s.index;
      d.handed = false;
      const lead = this.crossInto(d, s, t, L);
      if (lead < 0) {
        // No room before the meeting (a line born just now): the old hand-over, after it.
        this.passWeight(d, s, t, HANDOVER);
        d.weight = 1;
        d.deathFade = HANDOVER;
        this.scheduleClose(d, t + HANDOVER);
        continue;
      }
      d.weight = 1;
      d.deathFade = lead;
      this.scheduleClose(d, t, true);
    }
  }

  /**
   * Merges and splits crossfade (owner 2026-11-21): dying line d meets line s at t (now). Across
   * the window of length L ending at t (shorter if either line was born inside it), d fades out
   * and s's weight rises by d's, along one `crossfade`, so the power of the two stays constant.
   * The weight passes in s's level (the static voice gains are a mix setting, outside the
   * simulation: incremental compiles resume across them). Returns the window's length: the
   * caller closes d at t with that fade (`Life.crossOut`). With less than CROSS_ROOM before t in
   * both lives (one was born just now) it changes nothing and returns −1: the caller hands over
   * after the meeting instead (`passWeight`), as before the crossfade.
   */
  private crossInto(d: VoiceRun, s: VoiceRun, t: Seconds, L: Seconds): Seconds {
    const lo = Math.max(d.life ? d.life.born : t, s.life ? s.life.born : t);
    const lead = t - L < lo ? t - lo : L;
    if (lead < CROSS_ROOM) return -1;
    d.handed = true;
    const f = this.levelRatio(d, s);
    s.weight += d.weight * f;
    s.rampWeight(t, s.lastWeight + d.lastWeight * f, lead, lead, true);
    return lead;
  }

  /** (Power) ratio of d's level to s's: a weight passed from d to s is scaled by it. */
  private levelRatio(d: VoiceRun, s: VoiceRun): number {
    const gs = this.levelOf(s.index);
    const gd = this.levelOf(d.index);
    return gs > 0 ? (gd * gd) / (gs * gs) : 1;
  }

  /** Passes d's weight to s with a linear ramp from t over `over` (no crossfade room). */
  private passWeight(d: VoiceRun, s: VoiceRun, t: Seconds, over: Seconds): void {
    d.handed = true;
    const f = this.levelRatio(d, s);
    s.weight += d.weight * f;
    s.rampWeight(t, s.lastWeight + d.lastWeight * f, over);
  }

  /**
   * (Re)schedules a dying voice's close, and the hand-over of its weight when its fade starts; an
   * earlier close or hand-over event becomes stale (onClose, onHandover).
   */
  private scheduleClose(run: VoiceRun, died: Seconds, cross = false): void {
    run.diedAt = died;
    this.activity(died);
    const rec: CloseRec = { voice: run.index, died, fade: run.deathFade };
    if (cross) rec.cross = true;
    this.queue.push({
      t: died,
      cls: EventClass.MoveStart,
      key: SUB_CLOSE * SUB_STRIDE + run.index,
      sub: 0,
      ref: 0,
      obj: rec,
    });
    if (run.into < 0 || run.handed || run.deathFade <= 0) return;
    const h: HandoverRec = { voice: run.index, died };
    const t = died - run.deathFade;
    this.queue.push({
      t: t > this.clock ? t : this.clock,
      cls: EventClass.MoveStart,
      key: SUB_HANDOVER * SUB_STRIDE + run.index,
      sub: 0,
      ref: 0,
      obj: h,
    });
  }

  /**
   * A merge or `count` death meets its survivor (its old fade start): its weight passes to the
   * survivor (owner, 2026-11-21) across a crossfade ending now, and it closes now.
   */
  private onHandover(rec: HandoverRec): void {
    const d = this.voices[rec.voice];
    if (rec.died !== d.diedAt || d.status !== Status.Dying) return;
    const lead = this.handOver(d, this.clock, d.deathFade);
    if (lead < 0) return;
    d.deathFade = lead;
    this.scheduleClose(d, this.clock, true);
  }

  /**
   * Passes dying `d`'s weight to the line it merges into (following survivors that already
   * handed theirs on) at t, where they meet: `crossInto`, over the end of the longer of their
   * approaches. Returns the crossfade's length, or −1 if nothing was passed on (no survivor
   * sounding: d keeps its own fade).
   */
  private handOver(d: VoiceRun, t: Seconds, over: Seconds): Seconds {
    if (d.handed) return -1;
    d.handed = true;
    let s = d.into;
    for (let k = 0; s >= 0 && k <= this.voices.length; k++) {
      const r = this.voices[s];
      if (r.status !== Status.Dying || !r.handed) break;
      s = r.into;
    }
    if (s < 0 || s === d.index) return -1;
    const sr = this.voices[s];
    // A survivor not born yet (a newborn of the dying line, say) is born now, on the dying line's
    // note, rather than later in mid-air once nothing sounds there.
    const pb = sr.pendingBirth;
    if (!sr.frontier.alive && pb && pb.t > t && d.frontier.alive) {
      const nb: Birth = { ...pb, t };
      sr.pendingBirth = nb;
      this.onBirth(nb);
    }
    if (sr.status === Status.Dormant || !sr.frontier.alive) return -1;
    const ga = approachInto(d, t);
    const gb = approachInto(sr, t);
    const lead = this.crossInto(d, sr, t, crossfadeLength(ga > gb ? ga : gb));
    // No room (the survivor was born just now): d keeps its own fade, as before.
    if (lead < 0) this.passWeight(d, sr, t, over);
    return lead;
  }

  /**
   * Dying voices merged into `a` follow its move `mv` (§7.4 "glides into its neighbour, then
   * fades"; M4.5-17), so a survivor that moves on never leaves one hanging where it was. A voice
   * still in its death glide (its fade not started) also waits for the survivor to arrive: its
   * fade then starts when this move ends. `chain`: `a` itself dies into this voice, which its
   * followers follow from then on. `lead`: the leader's pitch and velocity as `mv` starts; a
   * follower riding on the leader then takes the leader's crossing scale, so the two stay one
   * line (seed −320129613/300: with scale 1 its carried velocity bowed it off the leader).
   */
  private follow(
    a: VoiceRun,
    mv: Move,
    to: Pitch,
    chain: number | null,
    depth: number,
    lead: { p: Pitch; v: number } | null,
  ): void {
    if (depth > this.voices.length) return;
    for (const d of this.voices) {
      if (d.into !== a.index || d.status !== Status.Dying) continue;
      if (chain !== null) d.into = chain;
      if (!d.frontier.alive || d.pending.length > 0 || !(d.diedAt > mv.t0)) continue;
      if (to < d.range[0] || to > d.range[1]) continue;
      // A voice already gliding there in this moment (its own glide, maybe with its own `end`
      // override) keeps that glide and only waits for the survivor.
      let end = mv.t0 + mv.dur;
      const tail = d.frontier.tail!;
      const own = !d.frontier.open && tail.momentId === mv.momentId && tail.t1 > mv.t0;
      if (d.frontier.heading !== to || !(own || (!d.frontier.open && tail.t1 === end))) {
        // Replacing a glide that starts now drops it: keep its C⁰ flag on the replacement.
        const wasClamped = tail.t0 === mv.t0 && tail.clamped === true;
        // The leader's crossing scale is for its own neighbours: a follower elsewhere keeps 1.
        const st = d.frontier.stateAt(mv.t0);
        const onLead =
          lead !== null &&
          st !== null &&
          Math.abs(st.p - lead.p) < 1e-9 &&
          Math.abs(st.v - lead.v) < 1e-9;
        const seg = d.frontier.start(
          mv.t0,
          mv.dur,
          to,
          mv.ease,
          mv.limits,
          onLead ? mv.crossScale : 1,
          d.range,
          mv.momentId,
        );
        if (wasClamped) seg.clamped = true;
        end = seg.t1;
        this.activity(end);
      }
      const fadeStart = d.diedAt - d.deathFade;
      if (mv.t0 < fadeStart && end > fadeStart) this.scheduleClose(d, end + d.deathFade);
      this.follow(d, mv, to, null, depth + 1, lead);
    }
  }

  /**
   * After moment i at t: a dying voice whose survivor will no longer reach the pitch it is
   * gliding to (the moment cancelled the survivor's move and left it where it is) glides to
   * where the survivor now is, arriving with it (M4.5-17). A survivor given a new move is
   * followed when that move starts (`follow`).
   */
  private reaim(t: Seconds, i: number): void {
    for (const d of this.voices) {
      if (d.status !== Status.Dying || d.into < 0 || d.pending.length > 0) continue;
      if (!d.frontier.alive || !(d.diedAt > t)) continue;
      const a = this.voices[d.into];
      if (!a.frontier.alive) continue;
      if (a.pending.length > 0) {
        // The move the dying voice glided towards was replaced by later ones (seed
        // 599296392/298): it waits off the survivor's pitch, so it fades only once the survivor
        // has arrived, following it from when its moves start (`follow`).
        if (d.frontier.heading === a.frontier.heading) continue;
        const arrive = arrivalOf(a);
        if (d.diedAt - d.deathFade < arrive) this.scheduleClose(d, arrive + d.deathFade);
        continue;
      }
      const h = a.frontier.heading;
      if (h === d.frontier.heading || h < d.range[0] || h > d.range[1]) continue;
      const tail = d.frontier.tail!;
      let end = arrivalOf(a);
      if (!d.frontier.open && tail.t1 > end) end = tail.t1;
      const dur = end - t > MIN_GLIDE ? end - t : this.glides[i].length;
      const seg = d.frontier.start(
        t,
        dur,
        h,
        this.glides[i].ease,
        { up: 0, down: 0 },
        1,
        d.range,
        this.moments[i].id,
      );
      this.activity(seg.t1);
      const fadeStart = d.diedAt - d.deathFade;
      if (t < fadeStart && seg.t1 > fadeStart) this.scheduleClose(d, seg.t1 + d.deathFade);
    }
  }

  private onMove(mv: Move): void {
    if (mv.cancelled) return;
    const run = this.voices[mv.voice];
    const k = run.pending.indexOf(mv);
    if (k >= 0) run.pending.splice(k, 1);
    this.startMove(mv);
  }

  private onClose(rec: CloseRec): void {
    const run = this.voices[rec.voice];
    if (rec.died !== run.diedAt) return; // rescheduled by `follow`
    let fade = rec.fade;
    let cross = rec.cross === true;
    if (run.status === Status.Dying && run.into >= 0) {
      // A death with no fade meets its survivor here: crossfade into it.
      const lead = this.handOver(run, rec.died, 0);
      if (lead >= 0) {
        fade = lead;
        cross = true;
      }
    }
    run.handed = false;
    run.frontier.close(rec.died);
    if (run.life) {
      run.life.died = rec.died;
      if (fade > 0) run.life.fadeOut = fade;
      if (cross) run.life.crossOut = true;
      run.life = null;
    }
    if (run.status === Status.Dying) run.status = Status.Dormant;
    if (run.into >= 0) this.passOn(run.index, run.into, rec.died);
    run.into = -1;
  }

  /**
   * Line `from` has just merged into `to` and closed (revision 8). What still depended on it
   * depends on `to` instead, so nothing follows or forks from the voice once it is reused: lines
   * dying into it follow `to` (and hand their weight to it); newborns waiting to fork from it fork
   * from `to`, on the note `from` joined, not in mid-air.
   */
  private passOn(from: number, to: number, t: Seconds): void {
    for (const run of this.voices) {
      if (run.status === Status.Dying && run.into === from) run.into = to;
      for (let k = 0; k < run.pending.length; k++) {
        const mv = run.pending[k];
        if (mv.cancelled || !mv.death || mv.death.into !== from) continue;
        const nm: Move = { ...mv, death: { ...mv.death, into: to } };
        mv.cancelled = true;
        run.pending[k] = nm;
        this.queue.push({
          t: nm.t0,
          cls: EventClass.MoveStart,
          key: SUB_MOVE * SUB_STRIDE + nm.voice,
          sub: 0,
          ref: 0,
          obj: nm,
        });
      }
      const b = run.pendingBirth;
      if (!b || b.parent !== from || run.index === to || !(b.t >= t)) continue;
      const nb: Birth = { ...b, parent: to };
      run.pendingBirth = nb;
      this.touch();
      this.queue.push({
        t: nb.t,
        cls: EventClass.MoveStart,
        key: SUB_BIRTH * SUB_STRIDE + nb.voice,
        sub: 0,
        ref: 0,
        obj: nb,
      });
    }
  }

  private onTick(wi: number, k: number): void {
    const w = this.moments[wi] as WalkMoment;
    const t = w.at + k * w.grid;
    const fz = this.frozen[wi];
    if (fz) {
      // A frozen walk ticks only where it has notes (tick 0 is always queued, see initMoments).
      const next = fz.ticks.find((j) => j > k);
      if (next !== undefined)
        this.queue.push({
          t: w.at + next * w.grid,
          cls: EventClass.Tick,
          key: wi,
          sub: 0,
          ref: next,
        });
    } else {
      const next = w.at + (k + 1) * w.grid;
      if (next < w.until)
        this.queue.push({ t: next, cls: EventClass.Tick, key: wi, sub: 0, ref: k + 1 });
    }
    const inTarget = new Set(this.resolveTarget(w.target, k === 0 ? w.id : null));
    if (fz) {
      const notes = fz.notes.get(k);
      if (notes) this.frozenTick(wi, w, k, t, notes, inTarget);
      return;
    }
    if (inTarget.size === 0) return;
    const claimed = this.claimedAt(wi, w, t);
    const order = this.sortedActive();
    const steps = walkTick(w, {
      t,
      tick: k,
      key: this.key,
      seed: this.seeds[wi],
      order,
      dest: (v) => this.destOf(v),
      inTarget: (v) => inTarget.has(v),
      eligible: (v) => inTarget.has(v) && !claimed.has(v) && this.idle(v, t),
      range: (v) => this.voices[v].range,
      hash: (v) => this.voices[v].hash,
    });
    for (const s of steps) this.walkStep(wi, w, k, t, s.voice, s.from, s.to, false);
    if (steps.length > 0) this.touch();
  }

  /** Voices driven at t by a walk that started after walk wi (§7.1: the later walk drives). */
  private claimedAt(wi: number, w: WalkMoment, t: Seconds): Set<number> {
    const claimed = new Set<number>();
    for (const wj of this.walks) {
      if (wj === wi) continue;
      const o = this.moments[wj] as WalkMoment;
      if (!(o.at <= t && t < o.until)) continue;
      if (!(o.at > w.at || (o.at === w.at && wj > wi))) continue;
      for (const v of this.resolveTarget(o.target, null)) claimed.add(v);
    }
    return claimed;
  }

  /**
   * One tick of a frozen walk (§6.2): each listed voice glides to its note, unlisted voices hold.
   * A note that would cross or touch a neighbour's destination, or leave the voice's range, holds
   * (warn). Notes for voices not active in the walk are ignored (info), as are notes for voices
   * still moving or driven by a later walk (§7.1).
   */
  private frozenTick(
    wi: number,
    w: WalkMoment,
    k: number,
    t: Seconds,
    notes: readonly { voice: number; pitch: Pitch }[],
    inTarget: ReadonlySet<number>,
  ): void {
    const order = this.sortedActive();
    const n = order.length;
    const from = order.map((v) => this.destOf(v));
    const to = from.slice();
    const listed: boolean[] = new Array<boolean>(n).fill(false);
    const blocked: boolean[] = new Array<boolean>(n).fill(false);
    const inactive: string[] = [];
    const busy: string[] = [];
    let claimed: Set<number> | null = null;
    for (const note of notes) {
      const v = note.voice;
      const i = order.indexOf(v);
      if (i < 0 || !inTarget.has(v)) {
        inactive.push(this.voices[v].id);
        continue;
      }
      claimed ??= this.claimedAt(wi, w, t);
      if (claimed.has(v) || !this.idle(v, t)) {
        busy.push(this.voices[v].id);
        continue;
      }
      listed[i] = true;
      const r = this.voices[v].range;
      if (note.pitch < r[0] || note.pitch > r[1]) blocked[i] = true;
      else to[i] = note.pitch;
    }
    // Revert moving notes that cross or touch a neighbour until none does; reverting only ever
    // removes moves, so this ends.
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < n; i++) {
        if (to[i] === from[i]) continue;
        if ((i > 0 && to[i] <= to[i - 1]) || (i < n - 1 && to[i] >= to[i + 1])) {
          to[i] = from[i];
          blocked[i] = true;
          changed = true;
        }
      }
    }
    let moved = false;
    const held: string[] = [];
    for (let i = 0; i < n; i++) {
      if (!listed[i]) continue;
      if (blocked[i]) held.push(this.voices[order[i]].id);
      if (to[i] !== from[i]) moved = true;
      this.walkStep(wi, w, k, t, order[i], from[i], to[i], true);
    }
    if (inactive.length > 0) {
      this.diag(
        'info',
        'walk-note-ignored',
        `Tick ${k}: fixed notes for ${inactive.join(', ')} are ignored (not active in the walk).`,
        w.id,
      );
    }
    if (busy.length > 0) {
      this.diag(
        'info',
        'walk-note-ignored',
        `Tick ${k}: fixed notes for ${busy.join(', ')} are ignored (still moving, or another walk drives them).`,
        w.id,
      );
    }
    if (held.length > 0) {
      this.diag(
        'warn',
        'walk-note-blocked',
        `Tick ${k}: ${held.join(', ')} hold: the fixed note would cross or touch a neighbour, or leave the range.`,
        w.id,
      );
    }
    if (moved) this.touch();
  }

  /** Records a walk step and, if it moves, starts its glide. */
  private walkStep(
    wi: number,
    w: WalkMoment,
    k: number,
    t: Seconds,
    v: number,
    from: Pitch,
    to: Pitch,
    fixed: boolean,
  ): void {
    this.walkSteps.push({ momentId: w.id, tick: k, voice: this.voices[v].id, t, from, to, fixed });
    if (to === from) return;
    const dur = Number.isFinite(w.stepGlide) && w.stepGlide > MIN_GLIDE ? w.stepGlide : MIN_GLIDE;
    this.startMove({
      voice: v,
      t0: t,
      dur,
      to,
      ease: this.glides[wi].ease,
      momentId: w.id,
      limits: FREE_LIMITS,
      crossScale: 1,
      cancelled: false,
      momentIndex: wi,
    });
  }

  /** Active, sounding, no move in progress and nothing pending (§7.1 walk rules). */
  private idle(v: number, t: Seconds): boolean {
    const run = this.voices[v];
    return (
      run.status === Status.Active &&
      run.frontier.alive &&
      !run.pendingBirth &&
      run.pending.length === 0 &&
      !run.frontier.busyAt(t) &&
      !this.parentOfPending(v)
    );
  }

  /**
   * A newborn not yet born forks from v (§7.4): v holds for it, so that it starts on the pitch
   * its moment planned (a walk step would move the fork, M4.5-17).
   */
  private parentOfPending(v: number): boolean {
    for (const run of this.voices)
      if (run.pendingBirth && run.pendingBirth.parent === v) return true;
    return false;
  }

  private traceMoment(
    i: number,
    targeted: number[],
    subset: boolean,
    plan: PlanTrace | null,
    logical: readonly Intent[] | null,
    t: Seconds = this.moments[i].at,
    rangeU: ((u: number) => readonly [Pitch, Pitch]) | null = null,
    lines: readonly Intent[] | null = logical,
  ): void {
    if (!this.trace) return;
    const m = this.moments[i];
    const kinds = ['move', 'birth', 'death'] as const;
    const map = (list: readonly Intent[] | null, fold: typeof rangeU) =>
      list
        ? list.map((it) => {
            let to = it.to;
            let folded = false;
            if (fold && Number.isFinite(to)) {
              const r = fold(it.voice);
              const f = foldIntoRange(to, r[0], r[1]);
              to = f.p;
              folded = f.folded || f.clampedToRange;
            }
            const r: NonNullable<MomentTrace['intents']>[number] = {
              voice: it.voice,
              to,
              kind: kinds[it.kind],
            };
            if (folded) r.folded = true;
            if (it.kind === IntentKind.Birth) r.parent = it.parent ?? -1;
            if (it.kind === IntentKind.Death) r.into = it.into ?? -1;
            return r;
          })
        : null;
    const pool = map(lines, null);
    this.trace.moments.push({
      id: m.id,
      index: i,
      type: m.type,
      t,
      targeted,
      subset,
      plan,
      intents: pool,
      logical: lines === logical ? pool : map(logical, rangeU),
    });
  }

  // -------------------------------------------------------------------------------------------
  // The end (§7.1 step 4) and output (step 5)
  // -------------------------------------------------------------------------------------------

  private finish(): CompiledScore {
    const E = Number.isFinite(this.endAt) ? this.endAt : this.lastActivity + END_TAIL;
    if (this.trace) this.trace.end = E;
    this.moments.forEach((m, i) => {
      if (this.valid[i] && m.at >= E && Number.isFinite(this.endAt)) {
        this.diag('info', 'after-end', `The moment is at or after the end (${E} s).`, m.id);
      }
    });
    for (const run of this.voices) {
      if (!run.frontier.alive) continue;
      run.frontier.close(E);
      const life = run.life;
      if (!life) continue;
      // A death fade still running at the end merges with the end fade.
      const deathFadeStart =
        Number.isFinite(run.diedAt) && run.status === Status.Dying
          ? run.diedAt - (life.fadeOut ?? 0)
          : Infinity;
      const fadeStart = Math.max(life.born, Math.min(E - this.endFade, deathFadeStart));
      life.died = E;
      const fo = E - fadeStart;
      if (fo > 0) life.fadeOut = fo;
      else delete life.fadeOut;
      run.life = null;
    }
    // A walk that starts in silence and never steps has no effect (M4.5-27).
    for (const wi of this.walks) {
      const w = this.moments[wi];
      if (this.walkSteps.some((s) => s.momentId === w.id)) continue;
      const sounding = this.voices.some((r) =>
        r.lives.some((l) => l.born <= w.at && (l.died === undefined || l.died > w.at)),
      );
      if (sounding) continue;
      const none = { targeted: [], active: [], births: 0, deaths: 0, dormant: 0 };
      this.diag('info', 'no-effect', `No effect: ${noEffectReason(w, none)}.`, w.id);
    }
    const voices: CompiledVoice[] = this.voices.map((run) => {
      const def = run.def;
      const lives: Life[] = run.lives.filter((l) => l.died === undefined || l.died > l.born);
      const sends: CompiledVoice['sends'] = {};
      if (def.sends && typeof def.sends.reverb === 'number') sends.reverb = def.sends.reverb;
      if (def.sends && typeof def.sends.delay === 'number') sends.delay = def.sends.delay;
      const cv: CompiledVoice = {
        id: def.id,
        index: run.index,
        lives,
        segments: run.segs,
        timbre: [{ t: 0, preset: def.timbre, fade: 0 }],
        level: run.level,
        gain: typeof def.gain === 'number' && Number.isFinite(def.gain) ? def.gain : 1,
        pan: def.pan === undefined ? 'auto' : def.pan,
        mute: !!def.mute,
        solo: !!def.solo,
        sends,
      };
      if (run.weights.length > 0) cv.weight = run.weights;
      if (run.counts.length > 0) cv.stack = run.counts;
      if (run.pulse.length > 0) cv.pulse = run.pulse;
      return cv;
    });
    let duration = 0;
    for (const v of voices)
      for (const l of v.lives) if ((l.died ?? E) > duration) duration = l.died ?? E;
    const momentSpans: MomentSpan[] = [];
    this.moments.forEach((m, i) => {
      if (!this.valid[i]) return;
      const s = this.spanStart[i];
      const e = this.spanEnd[i];
      momentSpans.push({
        id: m.id,
        start: Number.isNaN(s) ? m.at : s,
        end: Number.isNaN(e) ? m.at : e,
      });
    });
    return {
      duration,
      voices,
      momentSpans,
      walkSteps: this.walkSteps,
      diagnostics: this.diags,
      keys: this.keys,
      harmony: this.harmony,
      referenceHz:
        typeof this.piece.tuning?.referenceHz === 'number' ? this.piece.tuning.referenceHz : 440,
      seed: this.piece.seed,
    };
  }
}

/** A finite number clamped to 0..1, else `fallback`. */
function unit(x: unknown, fallback: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return fallback;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Why a pulse can't run (`pulse-invalid`), or null. */
function pulseProblem(m: PulseMoment): string | null {
  if (!(typeof m.step === 'number' && Number.isFinite(m.step) && m.step > 0))
    return 'A pulse needs a step > 0.';
  if (!(typeof m.until === 'number' && Number.isFinite(m.until) && m.until > m.at))
    return 'A pulse needs until > at.';
  if (!Array.isArray(m.pattern) || m.pattern.length === 0)
    return 'A pulse needs a non-empty pattern.';
  if (!m.pattern.every((a) => typeof a === 'number' && Number.isFinite(a)))
    return 'Every accent of a pulse pattern must be a number.';
  return null;
}

/**
 * Compiles a piece into its score (§7): pure, synchronous and deterministic. Problems become
 * diagnostics; this never throws on a parsed piece.
 */
export function compile(piece: Piece, options?: CompileOptions): CompiledScore {
  return new Compiler(piece, false, options).run();
}

/** `compile` plus a trace of every planned moment, for tests and debugging. */
export function compileWithTrace(
  piece: Piece,
  options?: CompileOptions,
): { score: CompiledScore; trace: CompileTrace } {
  const c = new Compiler(piece, true, options);
  const score = c.run();
  return { score, trace: c.trace! };
}
