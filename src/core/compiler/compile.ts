/**
 * `compile(piece)` (PLAN.md §7): a discrete-event simulation over a priority queue.
 *
 * Pure and synchronous: the same Piece gives the same CompiledScore on every engine (§7.11). Every
 * decision reads the state at the time it is made, so a walk can't overwrite a chord that lands
 * inside it (§7.1).
 *
 * Events (queue.ts), in time order; at equal times moment events (array order), then move starts
 * (life closes, then births, then moves, each by pool index), then walk ticks (array order).
 * - moment: resolve the target at this time, cancel the targeted voices' pending moves, run the
 *   moment on their committed destinations, plan and schedule the moves (plan.ts).
 * - move start: read the actual pitch and velocity, interrupt a running glide (§7.5), write the
 *   segment. A birth opens a life on the parent's pitch; a death glide schedules its life's close.
 * - tick: one walk step for every eligible voice (moments/walk.ts).
 * Then every voice is closed at the end (`end.at`, or the last activity + 4 s) with the end fade.
 */

import { defaultGlide } from '../defaults';
import { hash32, momentSeed, randHashed } from '../rng';
import { FREE_LIMITS } from '../interrupt';
import { chordMoment } from '../moments/chord';
import { mergeMoment } from '../moments/merge';
import { pinMoment } from '../moments/pin';
import { shiftMoment } from '../moments/shift';
import { splitMoment } from '../moments/split';
import { spreadMoment } from '../moments/spread';
import type { MomentEnv, MomentPlan } from '../moments/types';
import { unisonMoment } from '../moments/unison';
import { walkTick } from '../moments/walk';
import {
  MAX_VOICES,
  type CompiledScore,
  type CompiledVoice,
  type Diagnostic,
  type DiagnosticLevel,
  type Glide,
  type Key,
  type KeyChange,
  type Life,
  type Moment,
  type MomentSpan,
  type MomentType,
  type Piece,
  type Pitch,
  type Seconds,
  type VoiceSelector,
  type WalkMoment,
} from '../types';
import { MIN_GLIDE, mergeGlide, sanitizeGlide } from './glide';
import { planMoment, type PlanTrace } from './plan';
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
  'pin',
  'key',
  'level',
]);

/** Move-start sub-order at equal times (queue `key` = sub·64 + pool index). */
const SUB_CLOSE = 0;
const SUB_BIRTH = 1;
const SUB_MOVE = 2;
const SUB_STRIDE = 64;

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
}

/** Extra output of `compileWithTrace`. */
export interface CompileTrace {
  moments: MomentTrace[];
  /** End time used. */
  end: Seconds;
}

interface CloseRec {
  voice: number;
  died: Seconds;
  fade: Seconds;
}

class Compiler {
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
  key: Key;
  readonly keys: KeyChange[];
  lastActivity = 0;
  readonly endAt: Seconds;
  readonly endFade: Seconds;
  readonly trace: CompileTrace | null;
  private readonly emptyHash = hash32('');

  // Committed-destination cache, invalidated by bumping the epoch.
  private epoch = 1;
  private destEpoch: Int32Array;
  private destVal: Float64Array;
  private birthProjector: Projector | null = null;

  constructor(
    readonly piece: Piece,
    tracing: boolean,
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
        this.queue.push({ t: m.at, cls: EventClass.Tick, key: i, sub: 0, ref: 0 });
      }
    });
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

  private sortByDest(vs: number[]): number[] {
    return vs.sort((a, b) => this.destOf(a) - this.destOf(b) || a - b);
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
          this.touch();
          this.onMoment(ev.ref);
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
        this.key = m.key;
        this.keys.push({ t: T, key: m.key });
        this.span(i, T, T);
        this.traceMoment(i, [], false, null);
        return;
      case 'level': {
        const vs = this.resolveTarget(m.target, m.id);
        const over = Number.isFinite(m.over) && m.over > 0 ? m.over : 0;
        if (!Number.isFinite(m.gain)) {
          this.diag('error', 'invalid-moment', 'The level gain is not a number.', m.id);
          return;
        }
        for (const v of vs) this.voices[v].level.push({ t: T, gain: m.gain, over });
        if (vs.length === 0)
          this.diag('info', 'no-targets', 'The level targets no active voice.', m.id);
        this.span(i, T, T + over);
        this.activity(T + over);
        this.traceMoment(i, vs, m.target !== undefined && m.target !== 'all', null);
        return;
      }
      case 'walk':
        this.span(i, T, m.until);
        this.activity(m.until);
        this.traceMoment(i, [], false, null);
        return;
      default:
        this.onPointMoment(i);
    }
  }

  private onPointMoment(i: number): void {
    const m = this.moments[i];
    const T = m.at;
    let pre: number[];
    let subset: boolean;
    if (m.type === 'pin') {
      const v = this.byId.get(m.voice);
      pre = v !== undefined && this.voices[v].status === Status.Active ? [v] : [];
      subset = true;
    } else {
      pre = this.resolveTarget(m.target, m.id);
      subset = m.target !== undefined && m.target !== 'all';
    }
    for (const v of pre) this.voices[v].cancelPending();
    this.touch();
    const targeted = this.sortByDest(pre.slice());
    const env = this.env(i, targeted);
    let plan: MomentPlan | null;
    switch (m.type) {
      case 'chord':
        plan = chordMoment(m, env);
        break;
      case 'unison':
        plan = unisonMoment(m, env);
        break;
      case 'split':
        plan = splitMoment(m, env);
        break;
      case 'merge':
        plan = mergeMoment(m, env);
        break;
      case 'shift':
        plan = shiftMoment(m, env);
        break;
      case 'spread':
        plan = spreadMoment(m, env);
        break;
      case 'pin':
        plan = pinMoment(m, env);
        break;
      default:
        plan = null;
    }
    if (!plan) {
      this.span(i, T, T);
      this.traceMoment(i, targeted, subset, null);
      return;
    }
    const host = {
      voices: this.voices,
      t: T,
      momentId: m.id,
      momentIndex: i,
      glide: this.glides[i],
      seed: this.seeds[i],
      dest: (v: number) => this.destOf(v),
      diag: (level: DiagnosticLevel, code: string, message: string) =>
        this.diag(level, code, message, m.id),
    };
    const res = planMoment(host, plan, targeted, subset);
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
    this.touch();
    this.traceMoment(i, targeted, subset, res.trace);
  }

  private env(i: number, targeted: number[]): MomentEnv {
    const m = this.moments[i];
    const seed = this.seeds[i];
    return {
      t: m.at,
      momentId: m.id,
      key: this.key,
      seed,
      glide: this.glides[i],
      targeted,
      active: this.sortedActive(),
      dest: (v) => this.destOf(v),
      range: (v) => this.voices[v].range,
      id: (v) => this.voices[v].id,
      sounding: (v) => this.voices[v].sounding,
      dormant: () => this.dormantAt(m.at),
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
    const seg = run.frontier.start(
      mv.t0,
      mv.dur,
      mv.to,
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
      const died = seg.t1 + mv.death.fade;
      run.diedAt = died;
      this.activity(died);
      const rec: CloseRec = { voice: mv.voice, died, fade: mv.death.fade };
      this.queue.push({
        t: died,
        cls: EventClass.MoveStart,
        key: SUB_CLOSE * SUB_STRIDE + mv.voice,
        sub: 0,
        ref: 0,
        obj: rec,
      });
    }
    return true;
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
    run.frontier.close(rec.died);
    if (run.life) {
      run.life.died = rec.died;
      if (rec.fade > 0) run.life.fadeOut = rec.fade;
      run.life = null;
    }
    if (run.status === Status.Dying) run.status = Status.Dormant;
  }

  private onTick(wi: number, k: number): void {
    const w = this.moments[wi] as WalkMoment;
    const t = w.at + k * w.grid;
    const next = w.at + (k + 1) * w.grid;
    if (next < w.until)
      this.queue.push({ t: next, cls: EventClass.Tick, key: wi, sub: 0, ref: k + 1 });
    const inTarget = new Set(this.resolveTarget(w.target, k === 0 ? w.id : null));
    if (inTarget.size === 0) return;
    // §7.1: when two walks target a voice, the one that started later drives it.
    const claimed = new Set<number>();
    for (const wj of this.walks) {
      if (wj === wi) continue;
      const o = this.moments[wj] as WalkMoment;
      if (!(o.at <= t && t < o.until)) continue;
      if (!(o.at > w.at || (o.at === w.at && wj > wi))) continue;
      for (const v of this.resolveTarget(o.target, null)) claimed.add(v);
    }
    const order = this.sortedActive();
    const glide = this.glides[wi];
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
    const dur = Number.isFinite(w.stepGlide) && w.stepGlide > MIN_GLIDE ? w.stepGlide : MIN_GLIDE;
    for (const s of steps) {
      this.startMove({
        voice: s.voice,
        t0: t,
        dur,
        to: s.to,
        ease: glide.ease,
        momentId: w.id,
        limits: FREE_LIMITS,
        crossScale: 1,
        cancelled: false,
        momentIndex: wi,
      });
    }
    if (steps.length > 0) this.touch();
  }

  /** Active, sounding, no move in progress and nothing pending (§7.1 walk rules). */
  private idle(v: number, t: Seconds): boolean {
    const run = this.voices[v];
    return (
      run.status === Status.Active &&
      run.frontier.alive &&
      !run.pendingBirth &&
      run.pending.length === 0 &&
      !run.frontier.busyAt(t)
    );
  }

  private traceMoment(
    i: number,
    targeted: number[],
    subset: boolean,
    plan: PlanTrace | null,
  ): void {
    if (!this.trace) return;
    const m = this.moments[i];
    this.trace.moments.push({ id: m.id, index: i, type: m.type, t: m.at, targeted, subset, plan });
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
      diagnostics: this.diags,
      keys: this.keys,
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
export function compile(piece: Piece): CompiledScore {
  return new Compiler(piece, false).run();
}

/** `compile` plus a trace of every planned moment, for tests and debugging. */
export function compileWithTrace(piece: Piece): { score: CompiledScore; trace: CompileTrace } {
  const c = new Compiler(piece, true);
  const score = c.run();
  return { score, trace: c.trace! };
}
