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
 */

import { defaultGlide } from '../defaults';
import { changesPitch, noEffectReason, sameKey } from '../effect';
import { harmonyLabel } from '../harmony';
import { mod } from '../math';
import { hash32, momentSeed, randHashed } from '../rng';
import { FREE_LIMITS } from '../interrupt';
import { pointMomentPlan } from '../moments/dispatch';
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
  type Life,
  type Moment,
  type MomentSpan,
  type MomentType,
  type NoteMoment,
  type Piece,
  type Pitch,
  type Seconds,
  type VoiceSelector,
  type WalkMoment,
  type WalkStepRecord,
} from '../types';
import { MIN_GLIDE, mergeGlide, sanitizeGlide } from './glide';
import { applyOverrideEnds, applyOverridePitches, overridesOf } from './overrides';
import { planMoment, type CrossingsMode, type PlanResult, type PlanTrace } from './plan';
import { Projector } from './project';
import { EventClass, EventQueue } from './queue';
import { foldIntoRange, sanitizeRange } from './range';
import { Status, VoiceRun, type Birth, type Move } from './voice';

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
]);

/** Move-start sub-order at equal times (queue `key` = sub·64 + pool index). */
export const SUB_CLOSE = 0;
export const SUB_BIRTH = 1;
export const SUB_MOVE = 2;
export const SUB_STRIDE = 64;

/** `sub` of a moment-class event that returns a note moment's note (`back`, §6.2). */
export const SUB_NOTE_BACK = 1;

/**
 * A note moment's scheduled return (§6.2 `back`): at `t`, the note `from` (where the move
 * arrived) becomes `to` (the pitch it replaced). Immutable once queued.
 */
export interface NoteBack {
  t: Seconds;
  from: Pitch;
  to: Pitch;
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
      }[]
    | null;
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

interface CloseRec {
  voice: number;
  died: Seconds;
  fade: Seconds;
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
  readonly moments: readonly Moment[];
  readonly valid: boolean[] = [];
  readonly seeds: number[] = [];
  readonly glides: Glide[] = [];
  readonly spanStart: number[] = [];
  readonly spanEnd: number[] = [];
  readonly walks: number[] = [];
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
    this.initStart();
    this.initMoments();
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
  }

  private initStart(): void {
    const start = Array.isArray(this.piece.start) ? this.piece.start : [];
    let folded = 0;
    for (const s of start) {
      const v = this.byId.get(s.voice);
      if (v === undefined) {
        this.diag('warn', 'unknown-voice', `start: there is no voice '${s.voice}'.`);
        continue;
      }
      const run = this.voices[v];
      if (run.status === Status.Active) {
        this.diag('warn', 'start-duplicate', `start: voice '${s.voice}' is listed twice.`);
        continue;
      }
      if (!Number.isFinite(s.pitch)) {
        this.diag('warn', 'invalid-moment', `start: voice '${s.voice}' has no valid pitch.`);
        continue;
      }
      const f = foldIntoRange(s.pitch, run.range[0], run.range[1]);
      if (f.folded) folded++;
      run.status = Status.Active;
      run.frontier.openAt(0, { p: f.p, v: 0, mid: false });
      run.life = { born: 0, fadeIn: 0 };
      run.lives.push(run.life);
    }
    if (folded > 0) {
      this.diag('info', 'start-out-of-range', `${folded} start pitch(es) were folded into range.`);
    }
  }

  private initMoments(): void {
    const defaults = sanitizeGlide(this.piece.defaults?.glide, defaultGlide());
    const ids = new Set<string>();
    this.moments.forEach((m, i) => {
      this.valid.push(false);
      this.frozen.push(null);
      this.seeds.push(0);
      this.glides.push(defaults);
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
      this.valid[i] = true;
      this.seeds[i] = momentSeed(this.piece.seed, m.id, m.seed);
      this.glides[i] = mergeGlide(defaults, m.glide);
      this.queue.push({ t: m.at, cls: EventClass.Moment, key: i, sub: 0, ref: i });
      if (m.type === 'walk') {
        this.walks.push(i);
        if (Array.isArray(m.fixed)) this.frozen[i] = this.initFrozen(m);
        this.queue.push({ t: m.at, cls: EventClass.Tick, key: i, sub: 0, ref: 0 });
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
    const st = this.birthProjector.get(b.parent).stateBefore(b.t);
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
  resolveTarget(sel: VoiceSelector | undefined, momentId: string | null): number[] {
    const active = this.sortedActive();
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

  /** Pool voices a split may birth at t: not active, their last life ended (§7.4). */
  dormantAt(t: Seconds): number[] {
    const out: number[] = [];
    for (const run of this.voices) {
      if (run.status === Status.Active || run.pendingBirth) continue;
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
          if (this.onMomentEvent) this.onMomentEvent(ev.t, ev.ref);
          this.touch();
          this.onMoment(ev.ref);
          this.reaim(ev.t, ev.ref);
          break;
        case EventClass.MoveStart: {
          const sub = Math.floor(ev.key / SUB_STRIDE);
          if (sub === SUB_CLOSE) this.onClose(ev.obj as CloseRec);
          else if (sub === SUB_BIRTH) this.onBirth(ev.obj as Birth);
          else this.onMove(ev.obj as Move);
          break;
        }
        case EventClass.Tick:
          this.touch();
          this.onTick(ev.key, ev.ref);
          break;
      }
    }
    return this.finish();
  }

  private onMoment(i: number): void {
    const m = this.moments[i];
    const T = m.at;
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
      case 'walk':
        this.span(i, T, m.until);
        this.activity(m.until);
        this.traceMoment(i, [], false, null, null);
        return;
      default:
        this.onPointMoment(i);
    }
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
  private onPointMoment(i: number, back: NoteBack | null = null): void {
    const n = this.voices.length;
    if (this.effBefore.length !== n) {
      this.effBefore = new Float64Array(n);
      this.effAfter = new Float64Array(n);
    }
    const before = this.destsInto(this.effBefore);
    const activeBefore = this.sortedActive();
    const dormant = this.dormantAt(this.moments[i].at).length;
    const d0 = this.diags.length;
    const { targeted, res } = this.applyPointMoment(i, back);
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
        targeted: targeted.map((v) => before[v]),
        active: activeBefore.map((v) => before[v]),
        births: births.length,
        deaths: deaths.length,
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
  ): { targeted: number[]; res: PlanResult | null } {
    const m0 = this.moments[i];
    // A return runs the note moment again at its own time, `from` and `to` swapped.
    const m: Moment = back
      ? { ...(m0 as NoteMoment), at: back.t, from: back.from, to: back.to, back: undefined }
      : m0;
    const T = m.at;
    let pre: number[];
    let subset: boolean;
    if (m.type === 'pin') {
      const v = this.byId.get(m.voice);
      pre = v !== undefined && this.voices[v].status === Status.Active ? [v] : [];
      subset = true;
    } else {
      pre = this.resolveTarget(m.target, back ? null : m.id); // a return does not re-warn
      subset = m.target !== undefined && m.target !== 'all';
    }
    const seed = back ? hash32(this.seeds[i], 'back') : this.seeds[i];
    let targeted: number[];
    let plan: MomentPlan | null;
    if (m.type === 'note') {
      // A note reads where the voices are heading before cancelling anything, and cancels only
      // when it applies: a voice whose pending move it cancels but does not change then gets a
      // move to that same destination (planMoment sees it differ from the new committed one).
      targeted = this.sortByDest(pre.slice());
      plan = noteMoment(m, this.env(i, targeted, T, seed), back !== null);
      if (plan) {
        for (const v of pre) this.voices[v].cancelPending();
        this.touch();
        targeted = this.sortByDest(pre.slice());
      }
    } else {
      for (const v of pre) this.voices[v].cancelPending();
      this.touch();
      targeted = this.sortByDest(pre.slice());
      plan = pointMomentPlan(m, this.env(i, targeted, T, seed));
    }
    if (!plan) {
      if (!back) this.span(i, T, T); // a skipped return leaves the span as it is
      this.traceMoment(i, targeted, subset, null, null, T);
      return { targeted, res: null };
    }
    const host = {
      voices: this.voices,
      t: T,
      momentId: m.id,
      momentIndex: i,
      glide: this.glides[i],
      seed,
      crossings: this.options.crossings,
      dest: (v: number) => this.destOf(v),
      diag: (level: DiagnosticLevel, code: string, message: string) =>
        this.diag(level, code, message, m.id),
    };
    // Per-voice overrides (§11.3, revision 6): not on a note's return.
    const ov = back ? null : overridesOf(m, this.voices.length);
    if (ov) applyOverridePitches(plan, ov, targeted);
    const res = planMoment(host, plan, targeted, subset);
    if (ov) applyOverrideEnds(res, ov, T, this.voices);
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
    if (res.moves.length === 0) this.span(i, T, T);
    else if (!back && m.type === 'note' && plan.note) this.scheduleBack(i, m, plan.note, plan, res);
    this.touch();
    this.recordHarmony(i, T);
    this.traceMoment(i, targeted, subset, res.trace, plan.intents, T);
    return { targeted, res };
  }

  /** Queues a note moment's return (§6.2 `back`): `back` seconds after its glide ends. */
  private scheduleBack(
    i: number,
    m: NoteMoment,
    note: { intent: number; from: Pitch },
    plan: { intents: readonly Intent[] },
    res: PlanResult,
  ): void {
    const wait = m.back;
    if (!(typeof wait === 'number' && Number.isFinite(wait) && wait >= 0)) return;
    let end = m.at;
    for (const mv of res.moves) if (mv.t0 + mv.dur > end) end = mv.t0 + mv.dur;
    const t = end + wait;
    // The carrier's target after range folding (planMoment folds the intents in place).
    const rec: NoteBack = { t, from: plan.intents[note.intent].to, to: note.from };
    this.queue.push({ t, cls: EventClass.Moment, key: i, sub: SUB_NOTE_BACK, ref: i, obj: rec });
  }

  /**
   * Appends the harmony the active voices are heading to after moment i (HUD, §10). A written
   * chord symbol always starts an entry; otherwise an unchanged pitch-class set keeps the last one.
   */
  private recordHarmony(i: number, t: Seconds): void {
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
      label: cachedHarmonyLabel(this.labels, symbol, pcs, bass, this.key),
    });
  }

  private env(i: number, targeted: number[], t: Seconds, seed: number): MomentEnv {
    const m = this.moments[i];
    return {
      t,
      momentId: m.id,
      key: this.key,
      seed,
      glide: this.glides[i],
      targeted,
      active: this.sortedActive(),
      dest: (v) => this.destOf(v),
      now: (v) => this.voices[v].frontier.stateAt(t)?.p ?? NaN,
      range: (v) => this.voices[v].range,
      id: (v) => this.voices[v].id,
      sounding: (v) => this.voices[v].sounding,
      dormant: () => this.dormantAt(t),
      indexOf: (id) => this.byId.get(id) ?? -1,
      diag: (level, code, message) => this.diag(level, code, message, m.id),
      rand: (v, step, purpose) =>
        randHashed(seed, v >= 0 ? this.voices[v].hash : this.emptyHash, step, purpose),
    };
  }

  private onBirth(b: Birth): void {
    const run = this.voices[b.voice];
    if (run.pendingBirth !== b) return;
    run.pendingBirth = null;
    const parent = b.parent >= 0 ? this.voices[b.parent].frontier.stateAt(b.t) : null;
    run.frontier.openAt(b.t, parent ?? { p: b.pitch, v: 0, mid: false });
    run.life = { born: b.t, fadeIn: b.fadeIn };
    run.lives.push(run.life);
    this.activity(b.t);
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
    this.follow(run, mv, to, mv.death ? mv.death.into : null, 0);
    return true;
  }

  /** (Re)schedules a dying voice's close; an earlier close event becomes stale (onClose). */
  private scheduleClose(run: VoiceRun, died: Seconds): void {
    run.diedAt = died;
    this.activity(died);
    const rec: CloseRec = { voice: run.index, died, fade: run.deathFade };
    this.queue.push({
      t: died,
      cls: EventClass.MoveStart,
      key: SUB_CLOSE * SUB_STRIDE + run.index,
      sub: 0,
      ref: 0,
      obj: rec,
    });
  }

  /**
   * Dying voices merged into `a` follow its move `mv` (§7.4 "glides into its neighbour, then
   * fades"; M4.5-17), so a survivor that moves on never leaves one hanging where it was. A voice
   * still in its death glide (its fade not started) also waits for the survivor to arrive: its
   * fade then starts when this move ends. `chain`: `a` itself dies into this voice, which its
   * followers follow from then on.
   */
  private follow(a: VoiceRun, mv: Move, to: Pitch, chain: number | null, depth: number): void {
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
        const seg = d.frontier.start(
          mv.t0,
          mv.dur,
          to,
          mv.ease,
          mv.limits,
          1, // the leader's crossing scale is for its own neighbours
          d.range,
          mv.momentId,
        );
        if (wasClamped) seg.clamped = true;
        end = seg.t1;
        this.activity(end);
      }
      const fadeStart = d.diedAt - d.deathFade;
      if (mv.t0 < fadeStart && end > fadeStart) this.scheduleClose(d, end + d.deathFade);
      this.follow(d, mv, to, null, depth + 1);
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
      if (a.pending.length > 0 || !a.frontier.alive) continue;
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
    run.frontier.close(rec.died);
    if (run.life) {
      run.life.died = rec.died;
      if (rec.fade > 0) run.life.fadeOut = rec.fade;
      run.life = null;
    }
    if (run.status === Status.Dying) run.status = Status.Dormant;
    run.into = -1;
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
    intents: readonly Intent[] | null,
    t: Seconds = this.moments[i].at,
  ): void {
    if (!this.trace) return;
    const m = this.moments[i];
    const kinds = ['move', 'birth', 'death'] as const;
    this.trace.moments.push({
      id: m.id,
      index: i,
      type: m.type,
      t,
      targeted,
      subset,
      plan,
      intents: intents
        ? intents.map((it) => {
            const r: NonNullable<MomentTrace['intents']>[number] = {
              voice: it.voice,
              to: it.to,
              kind: kinds[it.kind],
            };
            if (it.kind === IntentKind.Birth) r.parent = it.parent ?? -1;
            if (it.kind === IntentKind.Death) r.into = it.into ?? -1;
            return r;
          })
        : null,
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
    const voices: CompiledVoice[] = this.voices.map((run) => {
      const def = run.def;
      const lives: Life[] = run.lives.filter((l) => l.died === undefined || l.died > l.born);
      const sends: CompiledVoice['sends'] = {};
      if (def.sends && typeof def.sends.reverb === 'number') sends.reverb = def.sends.reverb;
      if (def.sends && typeof def.sends.delay === 'number') sends.delay = def.sends.delay;
      return {
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
