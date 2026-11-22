/**
 * The live instrument's engine path (PLAN.md §9, §8.3): the API the input builders (musical
 * typing, Web MIDI, the piano ruler), the Live drawer and recording call. docs/build-log.md
 * "M7a" describes it.
 *
 * - `enter` creates an AudioContext with latencyHint 'interactive' (synchronously, so it can run in
 *   a gesture handler), loads the engine worklet with a live score for the given voices, timbres
 *   and mix (src/audio/live-setup.ts) and starts the live transport. `exit` closes that context.
 * - Each change of the held set H (`noteOn`, `noteOff`, sustain, `allNotesOff`) runs core's
 *   `liveUpdate` on the main thread's mirror of the live voices at "now", and posts the moves as
 *   `live { segments }` at once (no debounce: a chord pressed within 15 ms re-targets through the
 *   interruption rule, which carries velocity). The worklet applies them before its next block and
 *   reports the stamped frame (`liveApplied`); the mirror then applies the same records at the
 *   same time with the same code (dsp/live.ts `LiveTracks`), so it equals the worklet's state.
 *   Moves posted but not yet stamped are applied to a predicted copy at their estimated time.
 * - Every `noteOn`/`noteOff` returns a `LiveNoteEvent`: the call's `performance.now()`, the
 *   context time then, and (once applied) the frame its glide started at.
 * - Presses (§9 merge window): a change of H within MERGE_WINDOW of its press's first change is
 *   decided again on the state the first one saw and posted with `press` = that change's seq. The
 *   worklet rewinds to where the first one applied and plays the press from there as one change
 *   (dsp/live.ts `rewind`), so a chord pressed key by key glides as the one chord a take records.
 * - Staggered release (core/live.ts ReleaseGrace): a release that leaves keys down posts nothing
 *   for RELEASE_GRACE; all keys up within it is one release of the chord as held, otherwise a
 *   timer (or the next change of H) re-targets to the keys still down at the grace's expiry.
 * - `changes` logs every posted change since `enter` (held set, settings, seed, update, stamp):
 *   recording reads it (src/app/live.ts, core/live-take.ts).
 */

import {
  clampBend,
  DEFAULT_LIVE_SETTINGS,
  glideFromModWheel,
  LiveKeys,
  mergeLiveSettings,
  ReleaseGrace,
  type LiveSettings,
  type LiveUpdate,
} from '../core/live';
import type { MixSettings, Pitch, Seconds } from '../core/types';
import type { LiveTracks } from '../dsp/live';
import { AudioEngine } from './engine';
import { decideLive, encodeMoves, mirrorTracks, type LivePress } from './live-mirror';
import { liveGains, liveScore, type LiveSetup, type LiveVoiceSetup } from './live-setup';

/** Changes the warm-up at `enter` decides and applies on a scratch mirror (`warmUp`). */
const WARM_UP_CHANGES = 120;

/** When a live message took effect. */
export interface LiveStamp {
  seq: number;
  /** Context frame of the block its glides start on. */
  frame: number;
  /** frame / sampleRate. */
  contextTime: number;
  /** Live time there (seconds since live mode started). */
  liveTime: number;
  /** First frame of the worklet's next block when the message arrived (= `frame`: no wait). */
  receivedFrame: number;
  /** The device callback period in frames, as the worklet measured it (blocks per callback). */
  callbackFrames: number;
}

/** A key event, stamped for the latency test and for recording. */
export interface LiveNoteEvent {
  kind: 'on' | 'off';
  pitch: Pitch;
  velocity: number;
  /** performance.now() at the call. */
  at: number;
  /** The context's currentTime at the call. */
  contextTime: number;
  /** Estimated live time of the decision. */
  liveTime: Seconds;
  /** Held set after the event. */
  held: Pitch[];
  /** Seq of the live message posted, or −1 when the event changed nothing. */
  seq: number;
  /** ms from the call to the message's post (NaN: nothing posted), and of it deciding (`decideLive`). */
  postMs: number;
  planMs: number;
  /** Filled when the message is applied (also `applied`'s value). */
  stamp: LiveStamp | null;
  /** Resolves when the worklet applied it (null: nothing posted, or live mode ended first). */
  applied: Promise<LiveStamp | null>;
}

/** One live voice now. */
export interface LiveVoiceSnapshot {
  index: number;
  id: string;
  /** Sounding pitch, bend included. */
  pitch: Pitch;
  /** Where it is heading (without bend). */
  dest: Pitch;
  gliding: boolean;
  level: number;
}

/** The live state now, for drawing live lines. */
export interface LiveSnapshot {
  /** Live time (seconds since live mode started) the snapshot is taken at. */
  time: Seconds;
  held: Pitch[];
  sustain: boolean;
  bend: number;
  voices: LiveVoiceSnapshot[];
}

/** A decided change, before posting. */
interface Change {
  update: LiveUpdate;
  /** Decision time (a re-planned press: its first change's). */
  t: Seconds;
  /** The press it re-plans (its first seq), or 0. */
  press: number;
  seed: number;
  at: number;
}

/** Options for `LiveEngine.enter`. */
export interface LiveEnterOptions {
  setup: LiveSetup;
  /** An 'interactive' context made by the caller; by default one is created here. */
  context?: AudioContext;
  settings?: Partial<LiveSettings>;
}

/** One posted change of the live state (recording reads these). */
export interface LiveChange {
  seq: number;
  /** Seq of its press's first change (its own seq for a first change). */
  press: number;
  held: Pitch[];
  settings: Readonly<LiveSettings>;
  /** Seed of the stagger-order draws. */
  seed: number;
  update: LiveUpdate;
  /** performance.now() at the change. */
  at: number;
  /** Filled when the worklet applied it. */
  stamp: LiveStamp | null;
}

interface Pending {
  seq: number;
  /** Its press's first seq when re-planning a press (applies at that one's time), else 0. */
  press: number;
  moves: Float64Array;
  n: number;
  gain: number;
  over: number;
  /** Estimated time it applies at. */
  t: Seconds;
}

/** The live instrument (§9). One instance can enter and exit live mode any number of times. */
export class LiveEngine {
  /** Every key event since `enter`, in order (for recording). */
  readonly events: LiveNoteEvent[] = [];
  /** Every posted change since `enter`, in order (for recording). */
  readonly changes: LiveChange[] = [];

  private engineValue: AudioEngine | null = null;
  private settingsValue: LiveSettings = mergeLiveSettings(DEFAULT_LIVE_SETTINGS, {});
  private voices: LiveVoiceSetup[] = [];
  private setup: LiveSetup | null = null;
  /** Static gain per live voice as last sent (`setMix` re-sends those a new mix changes). */
  private gains: number[] = [];
  private readonly keys = new LiveKeys();
  private readonly grace = new ReleaseGrace();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmed: LiveTracks | null = null;
  private predicted: LiveTracks | null = null;
  private pending: Pending[] = [];
  private waiting = new Map<number, (s: LiveStamp | null) => void>();
  private seq = 0;
  private seed = 0;
  private bendValue = 0;
  /** Context time − live time, once the worklet reported its first live block. */
  private offset: number | null = null;
  private lastApplied = 0;
  private press: LivePress | null = null;
  /** Logged changes waiting for their stamp. */
  private readonly logged = new Map<number, LiveChange>();
  /** Live time each recent seq was applied at (presses re-plan from their first one's). */
  private readonly appliedAt = new Map<number, Seconds>();
  private readonly listeners = new Set<(s: LiveSnapshot) => void>();
  /** `settled()` callers waiting for every posted change to be applied. */
  private settledWaiters: (() => void)[] = [];

  /** Whether live mode is on (entered, not exited). */
  get active(): boolean {
    return this.engineValue !== null;
  }

  /** The interactive engine while live (connect analysers to `engine.node`). */
  get engine(): AudioEngine | null {
    return this.engineValue;
  }

  get context(): AudioContext | null {
    return (this.engineValue?.context as AudioContext | undefined) ?? null;
  }

  get settings(): Readonly<LiveSettings> {
    return this.settingsValue;
  }

  /** The held set H, sorted. */
  get held(): Pitch[] {
    return this.keys.held;
  }

  /**
   * Enters live mode: an 'interactive' AudioContext (created synchronously, before any await),
   * the engine worklet loaded with the live voices, and the live transport running. Exits first
   * if already live. Resolves once the worklet runs the live score.
   */
  async enter(opts: LiveEnterOptions): Promise<void> {
    const context = opts.context ?? new AudioContext({ latencyHint: 'interactive' });
    if (context.state !== 'running') void context.resume();
    {
      await this.exit();
      this.settingsValue = mergeLiveSettings(this.settingsValue, {
        key: opts.setup.key,
        ...opts.settings,
      });
      const setup = opts.setup;
      const score = liveScore(setup);
      let engine: AudioEngine;
      try {
        engine = await AudioEngine.create({ context });
        await engine.load(score, setup.mix, setup.timbres);
      } catch (e) {
        if (context.state !== 'closed') await context.close();
        throw e;
      }
      this.voices = setup.voices;
      this.setup = setup;
      this.gains = setup.voices.map((v) => v.gain);
      this.seed = setup.seed >>> 0;
      this.confirmed = mirrorTracks(setup);
      this.predicted = this.confirmed.clone();
      this.pending = [];
      this.offset = null;
      this.lastApplied = 0;
      this.seq = 0;
      this.bendValue = 0;
      this.keys.allOff();
      this.endGrace();
      this.events.length = 0;
      this.changes.length = 0;
      this.press = null;
      this.appliedAt.clear();
      const started = new Promise<void>((resolve) => this.waiting.set(0, () => resolve()));
      engine.onLiveApplied = (seq, frame, time, received, callback) =>
        this.onApplied(seq, frame, time, received, callback);
      this.engineValue = engine;
      engine.startLive(setup.voices.length);
      // While the worklet starts its live score.
      this.warmUp();
      await started;
      this.notify();
    }
  }

  /**
   * Runs the press path (decideLive with presses and re-plans, encodeMoves, the mirror's apply
   * and clone) on a scratch copy of the mirror, so the first keys run optimised code: cold, a
   * press took 10–15 ms from call to post at 6× CPU throttling (build log, live main thread).
   * Silent and pure: nothing is posted and no state changes (seeds are hashes of seqs).
   */
  private warmUp(): void {
    const voices = this.voices;
    if (voices.length === 0 || !this.confirmed) return;
    const [lo, hi] = voices[0].range;
    const mid = Math.round((lo + hi) / 2);
    const chords: Pitch[][] = [
      [mid],
      [mid + 4],
      [mid - 5],
      [mid, mid + 4, mid + 7],
      [mid - 3, mid + 2],
      [mid - 7, mid, mid + 5, mid + 9],
      [mid + 2],
      [],
    ];
    const base = this.settingsValue;
    const variants: LiveSettings[] = [
      base,
      mergeLiveSettings(base, { release: 'tonic', stagger: 0.03, order: 'random' }),
      mergeLiveSettings(base, {
        release: 'fade',
        assign: base.assign === 'free' ? 'ordered' : 'free',
      }),
    ];
    const tracks = this.confirmed.clone();
    let press: LivePress | null = null;
    let t = 0;
    for (let k = 0; k < WARM_UP_CHANGES; k++) {
      const settings = variants[Math.floor(k / chords.length) % variants.length];
      const held = chords[k % chords.length];
      // Every third change falls within the merge window of the one before (a re-plan).
      t += k % 3 === 2 ? 0.005 : 0.15;
      const d = decideLive(press, tracks, voices, held, settings, this.seed, k + 1, t, t);
      press = d.next;
      const n = d.update.moves.length;
      const moves = encodeMoves(d.update.moves);
      const gain = d.update.level ? d.update.level.gain : NaN;
      const over = d.update.level ? d.update.level.over : 0;
      tracks.apply(moves.slice(), 0, n, gain, over, d.t, null, d.press > 0);
      if (k % chords.length === 0) tracks.clone();
    }
    // A live message's structured clone (the first post took ~0.3 ms more).
    const ch = new MessageChannel();
    const m = encodeMoves([]);
    ch.port1.postMessage({ type: 'live', seq: 0, moves: m, n: 0, gain: NaN, over: 0, press: 0 }, [
      m.buffer,
    ]);
    ch.port1.close();
    ch.port2.close();
  }

  /** Resolves once every posted change is applied (stamped), or live mode ended. */
  settled(): Promise<void> {
    if (this.pending.length === 0 || !this.active) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  private releaseSettled(): void {
    const waiters = this.settledWaiters;
    this.settledWaiters = [];
    for (const w of waiters) w();
  }

  /** Leaves live mode: releases everything and closes the interactive context. */
  async exit(): Promise<void> {
    const engine = this.engineValue;
    if (!engine) return;
    this.engineValue = null;
    engine.onLiveApplied = null;
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    this.logged.clear();
    this.press = null;
    this.pending = [];
    this.releaseSettled();
    this.keys.allOff();
    this.endGrace();
    await engine.dispose();
    this.notify();
  }

  /** Key down (MIDI pitch; velocity 0..1 is recorded, not yet voiced). Never delayed. */
  noteOn(pitch: Pitch, velocity = 1): LiveNoteEvent {
    const ev = this.event('on', pitch, velocity);
    this.flushGrace(ev.at);
    if (this.active && this.keys.noteOn(pitch)) {
      this.endGrace();
      const c = this.change(ev.at);
      ev.planMs = performance.now() - ev.at;
      this.post(c, ev);
    } else this.settle(ev);
    return ev;
  }

  /** Key up. One that leaves keys down waits for the release grace (`seq` −1). */
  noteOff(pitch: Pitch): LiveNoteEvent {
    const ev = this.event('off', pitch, 0);
    this.flushGrace(ev.at);
    if (!this.active || !this.keys.noteOff(pitch)) this.settle(ev);
    else if (this.grace.release(ev.at / 1000, this.keys.held)) {
      this.settle(ev);
      this.armGrace();
    } else {
      this.endGrace();
      const c = this.change(ev.at);
      ev.planMs = performance.now() - ev.at;
      this.post(c, ev);
    }
    return ev;
  }

  /** Releases every key and the pedal (the release setting applies). */
  allNotesOff(): void {
    const at = performance.now();
    this.flushGrace(at);
    if (this.keys.allOff() && this.active) {
      this.endGrace();
      this.post(this.change(at), null);
    }
  }

  /** Sustain pedal (CC64): released keys stay held while it is down. */
  sustain(on: boolean): void {
    const at = performance.now();
    this.flushGrace(at);
    if (this.keys.setSustain(on) && this.active) {
      this.endGrace();
      this.post(this.change(at), null);
    }
  }

  /** Pitch bend in semitones, clamped to ±bendRange, applied to every voice continuously. */
  bend(semitones: number): void {
    this.bendValue = clampBend(semitones, this.settingsValue.bendRange);
    this.engineValue?.bendLive(this.bendValue);
    this.notify();
  }

  /** Glide length in seconds (the next change uses it). */
  setGlide(seconds: Seconds): void {
    this.setSettings({ glide: seconds });
  }

  /** Mod wheel (CC1, 0..127) sets the glide length (`glideFromModWheel`). */
  modWheel(cc: number): void {
    this.setGlide(glideFromModWheel(cc));
  }

  /** Changes settings; unusable fields are ignored. Applies from the next change of H. */
  setSettings(partial: Partial<LiveSettings>): void {
    this.settingsValue = mergeLiveSettings(this.settingsValue, partial);
    if (partial.bendRange !== undefined && this.bendValue !== 0) this.bend(this.bendValue);
    this.notify();
  }

  /**
   * Replaces the master mix while live. A `normalise` change also re-sends each voice's static
   * gain: the per-part correction `liveSetupFrom` applied depends on it (`liveGains`).
   */
  setMix(mix: MixSettings): void {
    const engine = this.engineValue;
    if (!engine || !this.setup) return;
    engine.setMix(mix);
    const gains = liveGains(this.setup, mix);
    for (let i = 0; i < gains.length; i++) {
      if (gains[i] !== this.gains[i]) engine.param(`voices.${i}.gain`, gains[i]);
    }
    this.gains = gains;
  }

  /** The live voices' ids, in live voice order. */
  get voiceIds(): string[] {
    return this.voices.map((v) => v.id);
  }

  /** The current pitch bend (semitones). */
  get bendSemitones(): number {
    return this.bendValue;
  }

  /** Calls `fn` with a snapshot after every change; returns the unsubscribe function. */
  subscribe(fn: (s: LiveSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Live time now, on the render side (where the next block starts): context time − offset. 0
   * before the worklet's first live block.
   */
  now(): Seconds {
    const ctx = this.engineValue?.context;
    if (!ctx || this.offset === null) return this.lastApplied;
    return Math.max(this.lastApplied, ctx.currentTime - this.offset);
  }

  /** Live time being heard now (getOutputTimestamp, else currentTime − output latency). */
  heardTime(): Seconds {
    const ctx = this.context;
    if (!ctx || this.offset === null) return 0;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    let c = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    if (ts?.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0)
      c = Math.min(
        ctx.currentTime,
        ts.contextTime + (performance.now() - ts.performanceTime) / 1000,
      );
    return Math.max(0, c - this.offset);
  }

  /** Voice `index`'s pitch at live time t (the mirror; bend not included). */
  pitchAt(index: number, t: Seconds): Pitch {
    return this.predicted ? this.predicted.pitchAt(index, t) : NaN;
  }

  /** The live state at live time t (default: now). */
  snapshot(t: Seconds = this.now()): LiveSnapshot {
    const tr = this.predicted;
    return {
      time: t,
      held: this.keys.held,
      sustain: this.keys.sustain,
      bend: this.bendValue,
      voices: tr
        ? this.voices.map((v, i) => ({
            index: i,
            id: v.id,
            pitch: tr.pitchAt(i, t) + this.bendValue,
            dest: tr.dest(i),
            gliding: tr.glidingAt(i, t),
            level: tr.levelAt(i, t),
          }))
        : [],
    };
  }

  /** The mirror's tracks with every posted move (tests, drawing). */
  get tracks(): LiveTracks | null {
    return this.predicted;
  }

  // -------------------------------------------------------------------------------------------

  private event(kind: 'on' | 'off', pitch: Pitch, velocity: number): LiveNoteEvent {
    const ctx = this.engineValue?.context;
    const ev: LiveNoteEvent = {
      kind,
      pitch,
      velocity,
      at: performance.now(),
      contextTime: ctx ? ctx.currentTime : 0,
      liveTime: this.now(),
      held: [],
      seq: -1,
      postMs: NaN,
      planMs: NaN,
      stamp: null,
      applied: Promise.resolve(null),
    };
    if (this.active) this.events.push(ev);
    return ev;
  }

  private settle(ev: LiveNoteEvent): void {
    ev.held = this.keys.held;
  }

  /**
   * The update for the current H (`at`: performance.now() of the change). Within MERGE_WINDOW of
   * the current press's first change (and with notes held) it re-plans the press from the state
   * that change saw; otherwise it decides on the mirror at now and starts a press.
   */
  private change(at: number): Change {
    const d = decideLive(
      this.press,
      this.predicted as LiveTracks,
      this.voices,
      this.keys.held,
      this.settingsValue,
      this.seed,
      this.seq + 1,
      at / 1000,
      this.decisionTime(),
    );
    this.press = d.next;
    return { update: d.update, t: d.t, press: d.press, seed: d.seed, at };
  }

  /** A grace that ran out by `at` (performance.now()) re-targets to the keys still down. */
  private flushGrace(at: number): void {
    if (!this.grace.due(at / 1000)) return;
    this.endGrace();
    if (this.active) this.post(this.change(at), null);
  }

  /** Times the grace's expiry (it is also checked at the next change of H). */
  private armGrace(): void {
    if (this.graceTimer !== null) return;
    const fire = (): void => {
      this.graceTimer = null;
      if (!this.grace.waiting) return;
      const at = performance.now();
      if (this.grace.due(at / 1000)) this.flushGrace(at);
      else this.graceTimer = setTimeout(fire, Math.max(1, this.grace.until * 1000 - at + 0.5));
    };
    this.graceTimer = setTimeout(fire, this.grace.until * 1000 - performance.now() + 0.5);
  }

  private endGrace(): void {
    this.grace.end();
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** Live time message `seq` applies at: its stamp, else its estimate. */
  private timeOf(seq: number, fallback: Seconds): Seconds {
    const a = this.appliedAt.get(seq);
    if (a !== undefined) return a;
    const p = this.pending.find((q) => q.seq === seq);
    return p ? p.t : fallback;
  }

  /** Not before anything already posted. */
  private decisionTime(): Seconds {
    let t = this.now();
    for (const p of this.pending) if (p.t > t) t = p.t;
    return t;
  }

  /**
   * Posts a decided change. The message goes first: the mirror's bookkeeping (pending, the
   * predicted tracks, the log) runs after it, off the key's path to the worklet.
   */
  private post(change: Change, ev: LiveNoteEvent | null): void {
    const { update, press } = change;
    const engine = this.engineValue;
    // A re-planned press always posts: it rewinds the press even when it moves nothing.
    if (!engine || (press === 0 && update.moves.length === 0 && update.level === null)) {
      if (press === 0) this.press = null;
      if (ev) this.settle(ev);
      return;
    }
    const seq = ++this.seq;
    const n = update.moves.length;
    const moves = encodeMoves(update.moves);
    const kept = moves.slice(); // `moves` is transferred
    const gain = update.level ? update.level.gain : NaN;
    const over = update.level ? update.level.over : 0;
    engine.postLive(seq, moves, n, gain, over, press);
    if (ev) ev.postMs = performance.now() - ev.at;
    const t = press > 0 ? this.timeOf(press, change.t) : change.t;
    const p: Pending = { seq, press, moves: kept, n, gain, over, t };
    this.pending.push(p);
    (this.predicted as LiveTracks).apply(kept, 0, n, gain, over, t, null, press > 0);
    const logged: LiveChange = {
      seq,
      press: press > 0 ? press : seq,
      held: this.keys.held,
      settings: this.settingsValue,
      seed: change.seed,
      update,
      at: change.at,
      stamp: null,
    };
    this.changes.push(logged);
    if (ev) {
      ev.held = this.keys.held;
      ev.seq = seq;
      ev.applied = new Promise<LiveStamp | null>((resolve) =>
        this.waiting.set(seq, (s) => {
          ev.stamp = s;
          resolve(s);
        }),
      );
    }
    this.logged.set(seq, logged);
    this.notify();
  }

  private onApplied(
    seq: number,
    frame: number,
    time: number,
    received: number,
    callback: number,
  ): void {
    const engine = this.engineValue;
    if (!engine) return;
    const rate = engine.context.sampleRate;
    this.offset = frame / rate - time;
    if (time > this.lastApplied) this.lastApplied = time;
    if (seq > 0) {
      this.appliedAt.set(seq, time);
      if (this.appliedAt.size > 64) {
        for (const k of this.appliedAt.keys()) if (k < seq - 32) this.appliedAt.delete(k);
      }
      const k = this.pending.findIndex((p) => p.seq === seq);
      if (k >= 0) {
        const [p] = this.pending.splice(k, 1);
        // As the worklet: a re-planned press applies at its first change's time, rewinding.
        const at = p.press > 0 ? this.appliedAt.get(p.press) : undefined;
        const tA = at ?? time;
        (this.confirmed as LiveTracks).apply(
          p.moves,
          0,
          p.n,
          p.gain,
          p.over,
          tA,
          null,
          at !== undefined,
        );
      }
      const tr = (this.confirmed as LiveTracks).clone();
      for (const q of this.pending) {
        const tq = q.press > 0 ? this.timeOf(q.press, q.t) : Math.max(q.t, time);
        tr.apply(q.moves, 0, q.n, q.gain, q.over, tq, null, q.press > 0);
      }
      this.predicted = tr;
      if (this.pending.length === 0) this.releaseSettled();
    }
    const stamp: LiveStamp = {
      seq,
      frame,
      contextTime: frame / rate,
      liveTime: time,
      receivedFrame: received,
      callbackFrames: callback,
    };
    const logged = this.logged.get(seq);
    if (logged) {
      logged.stamp = stamp;
      this.logged.delete(seq);
    }
    const resolve = this.waiting.get(seq);
    this.waiting.delete(seq);
    resolve?.(stamp);
    if (seq > 0) this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}
