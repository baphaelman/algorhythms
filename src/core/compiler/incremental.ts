/**
 * Incremental compile (PLAN.md §7.10): editor edits recompile from the last checkpoint before the
 * earliest change instead of from 0. The output is identical to `compile(piece)`.
 *
 * The simulation is causal: what happens before time T depends only on the setup and on the
 * moments that start before T. So the compiler snapshots its state before every second moment
 * event; on the next compile it finds the first moment array index k where the moments differ,
 * T* = the earliest time of any moment at index ≥ k in the old or the new array, and resumes from
 * the last checkpoint at or before (T*, k) in event order. Every event handled before that
 * checkpoint involves only moments below k, which are the same in both pieces with the same
 * indices (this holds for unsorted moment arrays too; it just resumes earlier).
 *
 * A checkpoint holds what the simulation mutates (compile.ts, voice.ts): per voice the status,
 * pending moves and birth, the frontier tail with the fields `finishAt` mutates by value, the open
 * Life, and the lengths of the append-only arrays (segments, lives, level, pulse); the queued move
 * starts, walk and pulse ticks (a pulse tick's state rides on the event, immutable), note returns
 * and tunes' next notes (a `TuneStep`, immutable) with each move's `cancelled` flag (a move's
 * `memo` is a pure cache, left as is);
 * key, keys/harmony/walkSteps/simulation-diagnostic lengths, lastActivity, and the spans of moments that can
 * still change (later moves extend earlier moments' spans). Array prefixes and final spans are
 * read from the previous run, whose arrays are never truncated (each run builds new ones, so
 * returned scores stay intact). Restored tails and lives are fresh copies.
 *
 * Full compile: no previous state, or a different setup (seed, key, end, glide defaults,
 * voice ids, ranges or parts). Voice fields that only reach the output (gain, pan, timbre, …) are read
 * fresh by `finish`, so they resume like any other edit.
 */

import { partOf } from '../parts';
import type {
  CompiledScore,
  Diagnostic,
  HarmonyChange,
  Key,
  KeyChange,
  Life,
  Piece,
  Seconds,
  Segment,
  StackChange,
  WalkStepRecord,
  WeightChange,
} from '../types';
import {
  Compiler,
  SUB_LANDED,
  SUB_MOVE,
  SUB_NOTE_BACK,
  SUB_STRIDE,
  SUB_TUNE,
  type CompileOptions,
} from './compile';
import { decisionTime, sanitizeGlide } from './glide';
import { defaultGlide } from '../defaults';
import { EventClass, type QueuedEvent } from './queue';
import type { Birth, Move, Status, VoiceRun } from './voice';

/**
 * A checkpoint is taken before every STRIDE-th moment event. On the benchmark piece, 1 costs a full
 * compile about 11 % more instructions, 2 about 6 %; a resume then replays at most one extra moment.
 */
const STRIDE = 2;

/**
 * Per-voice state in two flat arrays (checkpoints are many; few objects keep GC cheap).
 * Numbers, NUMS per voice: status, diedAt, segs/lives/level lengths, open, bornT, bornV, bornMid,
 * the tail's t1 and p1 (the fields `finishAt` mutates), into, deathFade, count, weight, weights
 * length, handed, counts length, pulse length, pulse owner, tune end. References, REFS per voice: pending moves (a copy), pending birth,
 * open life, tail, tail curve, members (a copy), the last weight and stack entries (`rampWeight` and
 * `setCount` may replace them in the shared arrays after the checkpoint).
 */
const NUMS = 21;
const REFS = 8;
const NO_MOVES: readonly Move[] = [];

interface Checkpoint {
  /** The moment event about to be handled: its time and moment index. */
  t: Seconds;
  i: number;
  /**
   * Queued move starts, walk ticks after the first and note returns (moment events and first
   * ticks are rebuilt from the piece).
   */
  events: QueuedEvent[];
  /** Per event: the move's `cancelled` flag (false for non-moves). */
  cancelled: boolean[];
  next: number;
  nums: number[];
  refs: unknown[];
  key: Key;
  keys: number;
  harmony: number;
  walkSteps: number;
  /** Diagnostics raised by the simulation (after the init ones). */
  diags: number;
  lastActivity: Seconds;
  /**
   * Spans of the moments that can still change (a queued, uncancelled move or tick of theirs), as
   * [index, start, end] triples. Every other handled moment's span is already final, so it is
   * read from the previous run's arrays.
   */
  spans: number[];
}

/** What the previous compile left. */
interface State {
  piece: Piece;
  checkpoints: Checkpoint[];
  segs: Segment[][];
  lives: Life[][];
  level: VoiceRun['level'][];
  weights: VoiceRun['weights'][];
  counts: VoiceRun['counts'][];
  pulse: VoiceRun['pulse'][];
  keys: KeyChange[];
  harmony: HarmonyChange[];
  walkSteps: WalkStepRecord[];
  diags: Diagnostic[];
  initDiags: number;
  spanStart: number[];
  spanEnd: number[];
}

/** How the last `compile` ran, for tests and measurements. */
export interface IncrementalStats {
  /** 'full': from 0; 'resume': from a checkpoint. */
  mode: 'full' | 'resume';
  /** Time of the checkpoint resumed from (0 for a full compile). */
  from: Seconds;
  /** Checkpoints reused from the previous compile. */
  reused: number;
}

export interface IncrementalCompiler {
  /** Same result as `compile(piece, options)`. */
  compile(piece: Piece): CompiledScore;
  /** Drops the saved state; the next compile is a full one. */
  reset(): void;
  readonly stats: IncrementalStats;
}

/** Structural equality of JSON-like values (NaN equals NaN). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return a !== a && b !== b;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** True when everything `compile` reads besides the moments (and output-only fields) is equal. */
function sameSetup(a: Piece, b: Piece): boolean {
  if (!(
    a.seed === b.seed &&
    same(a.key, b.key) &&
    same(a.end, b.end) &&
    same(a.defaults?.glide, b.defaults?.glide)
  )) {
    return false;
  }
  const va = a.voices;
  const vb = b.voices;
  if (va === vb) return true;
  if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
  for (let i = 0; i < va.length; i++) {
    if (va[i] === vb[i]) continue;
    if (va[i].id !== vb[i].id || !same(va[i].range, vb[i].range)) return false;
    if (partOf(va[i]) !== partOf(vb[i])) return false; // revision 9: parts decide merges
  }
  return true;
}

function snapshot(c: Compiler, t: Seconds, i: number, initDiags: number): Checkpoint {
  const items = c.queue.items;
  const events: QueuedEvent[] = [];
  const spans: number[] = [];
  const live = (j: number): void => {
    for (let q = 0; q < spans.length; q += 3) if (spans[q] === j) return;
    spans.push(j, c.spanStart[j], c.spanEnd[j]);
  };
  for (const ev of items) {
    if (
      ev.cls === EventClass.MoveStart ||
      (ev.cls === EventClass.Tick && ev.ref > 0) ||
      (ev.cls === EventClass.Moment &&
        (ev.sub === SUB_NOTE_BACK || ev.sub === SUB_LANDED || ev.sub === SUB_TUNE))
    ) {
      events.push(ev);
    } else if (ev.cls === EventClass.Tick && c.spanEnd[ev.key] === c.spanEnd[ev.key]) {
      // A walk's first tick (queued by the setup, so not saved) can still extend the span its
      // moment event already set.
      live(ev.key);
    }
  }
  const cancelled: boolean[] = [];
  for (const ev of events) {
    let off = false;
    if (ev.cls !== EventClass.MoveStart) {
      live(ev.key); // a walk tick, a note return, a tune's next note or a land moment waiting
    } else if (Math.floor(ev.key / SUB_STRIDE) === SUB_MOVE) {
      const mv = ev.obj as Move;
      off = mv.cancelled;
      if (!off) live(mv.momentIndex);
    }
    cancelled.push(off);
  }
  const nums: number[] = [];
  const refs: unknown[] = [];
  for (const run of c.voices) {
    const f = run.frontier;
    const tail = f.tail;
    nums.push(
      run.status,
      run.diedAt,
      run.segs.length,
      run.lives.length,
      run.level.length,
      f.open ? 1 : 0,
      f.bornT,
      f.bornV,
      f.bornMid ? 1 : 0,
      tail ? tail.t1 : 0,
      tail ? tail.p1 : 0,
      run.into,
      run.deathFade,
      run.count,
      run.weight,
      run.weights.length,
      run.handed ? 1 : 0,
      run.counts.length,
      run.pulse.length,
      run.pulseOwner,
      run.tuneUntil,
    );
    refs.push(
      run.pending.length > 0 ? run.pending.slice() : NO_MOVES,
      run.pendingBirth,
      run.life,
      tail,
      tail ? tail.curve : undefined,
      run.members.slice(),
      run.weights[run.weights.length - 1],
      run.counts[run.counts.length - 1],
    );
  }
  return {
    t,
    i,
    events,
    cancelled,
    next: c.queue.next,
    nums,
    refs,
    key: c.key,
    keys: c.keys.length,
    harmony: c.harmony.length,
    walkSteps: c.walkSteps.length,
    diags: c.diags.length - initDiags,
    lastActivity: c.lastActivity,
    spans,
  };
}

function pushPrefix<T>(to: T[], from: readonly T[], n: number, start = 0): void {
  for (let j = start; j < n; j++) to.push(from[j]);
}

/**
 * Puts `c` (just constructed from the new piece) into the state of checkpoint `cp`. `k` is the
 * first moment index that differs; moments below it are the same in both pieces.
 */
function restore(c: Compiler, cp: Checkpoint, prev: State, k: number): void {
  pushPrefix(c.diags, prev.diags, prev.initDiags + cp.diags, prev.initDiags);

  // Moment events and first walk ticks from the new piece, if not yet handled at the checkpoint
  // (a fresh queue holds no note returns: those come from the checkpoint).
  const events: QueuedEvent[] = [];
  for (const ev of c.queue.items) {
    const keep =
      ev.cls === EventClass.Moment
        ? ev.t > cp.t || (ev.t === cp.t && ev.key >= cp.i)
        : ev.t >= cp.t;
    if (keep) events.push(ev);
  }
  for (let j = 0; j < cp.events.length; j++) {
    const ev = cp.events[j];
    if (ev.cls === EventClass.MoveStart && Math.floor(ev.key / SUB_STRIDE) === SUB_MOVE) {
      (ev.obj as Move).cancelled = cp.cancelled[j];
    }
    events.push(ev);
  }
  c.queue.restore(events, cp.next);

  const { nums, refs } = cp;
  c.voices.forEach((run, v) => {
    const n = v * NUMS;
    const r = v * REFS;
    run.status = nums[n] as Status;
    run.diedAt = nums[n + 1];
    run.into = nums[n + 11];
    run.deathFade = nums[n + 12];
    run.count = nums[n + 13];
    run.weight = nums[n + 14];
    run.weights.length = 0;
    pushPrefix(run.weights, prev.weights[v], nums[n + 15]);
    if (run.weights.length > 0) run.weights[run.weights.length - 1] = refs[r + 6] as WeightChange;
    run.members = (refs[r + 5] as number[]).slice();
    run.handed = nums[n + 16] === 1;
    run.counts.length = 0;
    pushPrefix(run.counts, prev.counts[v], nums[n + 17]);
    if (run.counts.length > 0) run.counts[run.counts.length - 1] = refs[r + 7] as StackChange;
    run.segs.length = 0;
    pushPrefix(run.segs, prev.segs[v], nums[n + 2]);
    run.lives.length = 0;
    pushPrefix(run.lives, prev.lives[v], nums[n + 3]);
    run.level.length = 0;
    pushPrefix(run.level, prev.level[v], nums[n + 4]);
    run.pulse.length = 0;
    pushPrefix(run.pulse, prev.pulse[v], nums[n + 18]);
    run.pulseOwner = nums[n + 19];
    run.tuneUntil = nums[n + 20];
    run.pending = (refs[r] as Move[]).slice();
    run.pendingBirth = refs[r + 1] as Birth | null;
    // An open life has only `born`, `fadeIn` and `crossIn` (closing sets the rest, and drops it).
    const open = refs[r + 2] as Life | null;
    if (open) {
      const life: Life = { born: open.born, fadeIn: open.fadeIn };
      if (open.crossIn) life.crossIn = true;
      run.lives[nums[n + 3] - 1] = life;
      run.life = life;
    } else {
      run.life = null;
    }
    const f = run.frontier;
    f.open = nums[n + 5] === 1;
    f.bornT = nums[n + 6];
    f.bornV = nums[n + 7];
    f.bornMid = nums[n + 8] === 1;
    const tail = refs[r + 3] as Segment | null;
    if (tail) {
      const t = { ...tail };
      t.t1 = nums[n + 9];
      t.p1 = nums[n + 10];
      const curve = refs[r + 4] as Segment['curve'];
      if (curve) t.curve = curve;
      else delete t.curve;
      f.tail = t;
    } else {
      f.tail = null;
    }
  });

  c.key = cp.key;
  pushPrefix(c.keys, prev.keys, cp.keys, 1); // keys[0] is the new piece's own (equal) start key
  pushPrefix(c.harmony, prev.harmony, cp.harmony);
  pushPrefix(c.walkSteps, prev.walkSteps, cp.walkSteps);
  c.lastActivity = cp.lastActivity;
  // Spans of the moments handled before the checkpoint (all below k): final ones from the
  // previous run, then the ones that were still open.
  const n = Math.min(k, prev.spanStart.length, c.spanStart.length);
  for (let j = 0; j < n; j++) {
    if (!c.valid[j]) continue;
    const at = c.eventT[j];
    if (at < cp.t || (at === cp.t && j < cp.i)) {
      c.spanStart[j] = prev.spanStart[j];
      c.spanEnd[j] = prev.spanEnd[j];
    }
  }
  for (let q = 0; q < cp.spans.length; q += 3) {
    c.spanStart[cp.spans[q]] = cp.spans[q + 1];
    c.spanEnd[cp.spans[q]] = cp.spans[q + 2];
  }
}

/**
 * First moment index where the pieces differ, and the earliest event time of a moment from there
 * on (a land moment's lead-in start, revision 9; the glide defaults are equal, `sameSetup`).
 */
function firstChange(a: Piece, b: Piece): { k: number; t: Seconds } {
  const defaults = sanitizeGlide(b.defaults?.glide, defaultGlide());
  const ma = a.moments;
  const mb = b.moments;
  const n = Math.min(ma.length, mb.length);
  let k = 0;
  while (k < n && (ma[k] === mb[k] || same(ma[k], mb[k]))) k++;
  let t = Infinity;
  for (const ms of [ma, mb]) {
    for (let j = k; j < ms.length; j++) {
      const m = ms[j];
      const raw = m && typeof m === 'object' ? (m as { at?: unknown }).at : undefined;
      // A moment without a finite time never makes an event; any other value is conservative.
      if (!(typeof raw === 'number' && raw === raw)) continue;
      const at = Number.isFinite(raw) && raw >= 0 ? decisionTime(m, defaults) : raw;
      if (at < t) t = at;
      // A land moment deciding before a changed key moment may read it (it reads the key at its
      // own `at`): resume before its lead-in too.
      if (m.type === 'key') {
        for (const x of mb) {
          if (!x || typeof x !== 'object' || !(typeof x.at === 'number' && x.at >= raw)) continue;
          const d = decisionTime(x, defaults);
          if (d < raw && d < t) t = d;
        }
      }
    }
  }
  return { k, t };
}

/**
 * A compiler that keeps checkpoints between calls, so recompiling an edited piece resumes from
 * just before the first change. Not reentrant.
 */
export function createIncrementalCompiler(options: CompileOptions = {}): IncrementalCompiler {
  let state: State | null = null;
  const stats: IncrementalStats = { mode: 'full', from: 0, reused: 0 };

  const compileOne = (piece: Piece): CompiledScore => {
    const c = new Compiler(piece, false, options);
    const initDiags = c.diags.length;
    let checkpoints: Checkpoint[] = [];
    stats.mode = 'full';
    stats.from = 0;
    stats.reused = 0;
    const prev = state;
    if (
      prev &&
      Array.isArray(piece.moments) &&
      Array.isArray(prev.piece.moments) &&
      sameSetup(prev.piece, piece)
    ) {
      const { k, t } = firstChange(prev.piece, piece);
      const cps = prev.checkpoints;
      let ci = cps.length - 1;
      while (ci >= 0 && !(cps[ci].t < t || (cps[ci].t === t && cps[ci].i <= k))) ci--;
      if (ci >= 0) {
        restore(c, cps[ci], prev, k);
        // Checkpoint ci is a state of this run too: everything before it is unchanged.
        checkpoints = cps.slice(0, ci + 1);
        stats.mode = 'resume';
        stats.from = cps[ci].t;
        stats.reused = ci;
      }
    }
    state = null; // a throw below leaves no half-updated state
    let since = stats.mode === 'resume' ? 1 : STRIDE;
    c.onMomentEvent = (t, i) => {
      if (since++ < STRIDE) return;
      since = 1;
      checkpoints.push(snapshot(c, t, i, initDiags));
    };
    const score = c.run();
    c.onMomentEvent = null;
    state = {
      piece,
      checkpoints,
      segs: c.voices.map((r) => r.segs),
      lives: c.voices.map((r) => r.lives),
      level: c.voices.map((r) => r.level),
      weights: c.voices.map((r) => r.weights),
      counts: c.voices.map((r) => r.counts),
      pulse: c.voices.map((r) => r.pulse),
      keys: c.keys,
      harmony: c.harmony,
      walkSteps: c.walkSteps,
      diags: c.diags,
      initDiags,
      spanStart: c.spanStart,
      spanEnd: c.spanEnd,
    };
    return score;
  };

  return {
    compile: compileOne,
    reset(): void {
      state = null;
    },
    stats,
  };
}
