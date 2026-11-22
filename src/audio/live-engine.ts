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
 */

import {
  clampBend,
  DEFAULT_LIVE_SETTINGS,
  glideFromModWheel,
  LiveKeys,
  liveUpdate,
  mergeLiveSettings,
  type LiveSettings,
  type LiveUpdate,
} from '../core/live';
import { hash32 } from '../core/rng';
import type { MixSettings, Pitch, Seconds } from '../core/types';
import type { LiveTracks } from '../dsp/live';
import { AudioEngine } from './engine';
import { encodeMoves, liveView, mirrorTracks } from './live-mirror';
import { liveGains, liveScore, type LiveSetup, type LiveVoiceSetup } from './live-setup';

/** When a live message took effect. */
export interface LiveStamp {
  seq: number;
  /** Context frame of the block its glides start on. */
  frame: number;
  /** frame / sampleRate. */
  contextTime: number;
  /** Live time there (seconds since live mode started). */
  liveTime: number;
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

/** Options for `LiveEngine.enter`. */
export interface LiveEnterOptions {
  setup: LiveSetup;
  /** An 'interactive' context made by the caller; by default one is created here. */
  context?: AudioContext;
  settings?: Partial<LiveSettings>;
}

interface Pending {
  seq: number;
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

  private engineValue: AudioEngine | null = null;
  private settingsValue: LiveSettings = mergeLiveSettings(DEFAULT_LIVE_SETTINGS, {});
  private voices: LiveVoiceSetup[] = [];
  private setup: LiveSetup | null = null;
  /** Static gain per live voice as last sent (`setMix` re-sends those a new mix changes). */
  private gains: number[] = [];
  private readonly keys = new LiveKeys();
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
  private readonly listeners = new Set<(s: LiveSnapshot) => void>();

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
      this.events.length = 0;
      const started = new Promise<void>((resolve) => this.waiting.set(0, () => resolve()));
      engine.onLiveApplied = (seq, frame, time) => this.onApplied(seq, frame, time);
      this.engineValue = engine;
      engine.startLive(setup.voices.length);
      await started;
      this.notify();
    }
  }

  /** Leaves live mode: releases everything and closes the interactive context. */
  async exit(): Promise<void> {
    const engine = this.engineValue;
    if (!engine) return;
    this.engineValue = null;
    engine.onLiveApplied = null;
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    this.pending = [];
    this.keys.allOff();
    await engine.dispose();
    this.notify();
  }

  /** Key down (MIDI pitch; velocity 0..1 is recorded, not yet voiced). */
  noteOn(pitch: Pitch, velocity = 1): LiveNoteEvent {
    const ev = this.event('on', pitch, velocity);
    if (this.active && this.keys.noteOn(pitch)) this.post(this.change(), ev);
    else this.settle(ev);
    return ev;
  }

  /** Key up. */
  noteOff(pitch: Pitch): LiveNoteEvent {
    const ev = this.event('off', pitch, 0);
    if (this.active && this.keys.noteOff(pitch)) this.post(this.change(), ev);
    else this.settle(ev);
    return ev;
  }

  /** Releases every key and the pedal (the release setting applies). */
  allNotesOff(): void {
    if (this.keys.allOff() && this.active) this.post(this.change(), null);
  }

  /** Sustain pedal (CC64): released keys stay held while it is down. */
  sustain(on: boolean): void {
    if (this.keys.setSustain(on) && this.active) this.post(this.change(), null);
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
      stamp: null,
      applied: Promise.resolve(null),
    };
    if (this.active) this.events.push(ev);
    return ev;
  }

  private settle(ev: LiveNoteEvent): void {
    ev.held = this.keys.held;
  }

  /** The update for the current H, decided on the mirror at now. */
  private change(): { update: LiveUpdate; t: Seconds } {
    const t = this.decisionTime();
    const view = liveView(this.predicted as LiveTracks, this.voices, t);
    const update = liveUpdate(
      view,
      this.keys.held,
      this.settingsValue,
      hash32(this.seed, this.seq + 1),
    );
    return { update, t };
  }

  /** Not before anything already posted. */
  private decisionTime(): Seconds {
    let t = this.now();
    for (const p of this.pending) if (p.t > t) t = p.t;
    return t;
  }

  private post({ update, t }: { update: LiveUpdate; t: Seconds }, ev: LiveNoteEvent | null): void {
    const engine = this.engineValue;
    if (ev) ev.held = this.keys.held;
    if (!engine || (update.moves.length === 0 && update.level === null)) {
      if (ev) this.settle(ev);
      return;
    }
    const seq = ++this.seq;
    const n = update.moves.length;
    const moves = encodeMoves(update.moves);
    const gain = update.level ? update.level.gain : NaN;
    const over = update.level ? update.level.over : 0;
    const p: Pending = { seq, moves: moves.slice(), n, gain, over, t };
    this.pending.push(p);
    (this.predicted as LiveTracks).apply(p.moves, 0, n, gain, over, t);
    if (ev) {
      ev.seq = seq;
      ev.applied = new Promise<LiveStamp | null>((resolve) =>
        this.waiting.set(seq, (s) => {
          ev.stamp = s;
          resolve(s);
        }),
      );
    }
    engine.postLive(seq, moves, n, gain, over);
    this.notify();
  }

  private onApplied(seq: number, frame: number, time: number): void {
    const engine = this.engineValue;
    if (!engine) return;
    const rate = engine.context.sampleRate;
    this.offset = frame / rate - time;
    if (time > this.lastApplied) this.lastApplied = time;
    if (seq > 0) {
      const k = this.pending.findIndex((p) => p.seq === seq);
      if (k >= 0) {
        const [p] = this.pending.splice(k, 1);
        (this.confirmed as LiveTracks).apply(p.moves, 0, p.n, p.gain, p.over, time);
      }
      const tr = (this.confirmed as LiveTracks).clone();
      for (const q of this.pending) tr.apply(q.moves, 0, q.n, q.gain, q.over, Math.max(q.t, time));
      this.predicted = tr;
    }
    const resolve = this.waiting.get(seq);
    this.waiting.delete(seq);
    resolve?.({ seq, frame, contextTime: frame / rate, liveTime: time });
    if (seq > 0) this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}
