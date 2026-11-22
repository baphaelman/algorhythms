/**
 * Main-thread bridge to the engine worklet (PLAN.md §8.1–§8.3, §8.7, §8.11).
 *
 * - **Loading.** `load` flattens the score, builds each timbre's wavetables in a worker, and posts
 *   the score, mix and tables to the worklet (typed arrays in the transfer list, §8.2).
 * - **Clock.** The worklet posts an `anchor { contextTime, pieceTime }` on play, pause, seek,
 *   loop wrap and swap. `currentTime()` extrapolates from the newest anchor using the *heard*
 *   context time: `getOutputTimestamp()` where available, else currentTime − output latency.
 *   Loop-wrap anchors are scheduled ahead of what is heard, so they take effect only once the
 *   heard time reaches them; until then the bridge wraps the playhead itself. `pos` messages only
 *   correct drift (§8.3).
 * - **Latency.** A context created here uses `latencyHint: 'playback'` (§8.3); pass a context, or
 *   `latencyHint: 'interactive'`, for live mode.
 *
 * The worklet module URL comes from Vite's `?worker&url` (see docs/build-log.md, M0).
 */

import { flatten, transferList, type FlatScore } from '../core/flat';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import { MAX_TIMBRE_SLOTS } from '../dsp/constants';
import type { ParamValue } from '../dsp/mix';
import { buildWavetables, wavetableTransferList, type WavetableSet } from '../dsp/wavetable';
import { TableBuilder } from './tables';
import { resolveTimbre, timbreKey } from './timbres';
import engineWorkletUrl from './worklet/engine.worklet.ts?worker&url';
import {
  ENGINE_PROCESSOR,
  type AnchorReason,
  type EngineInMessage,
  type EngineOutMessage,
  type EngineProcessorOptions,
} from './worklet/engine-protocol';

export { ENGINE_PROCESSOR, engineWorkletUrl };

/** Post-limiter levels (linear). */
export interface Meter {
  peakL: number;
  peakR: number;
  rms: number;
}

interface Anchor {
  contextTime: number;
  pieceTime: number;
  playing: boolean;
  reason: AnchorReason;
}

/** Options for `AudioEngine.create`. */
export interface AudioEngineOptions {
  /** Use this context (e.g. an OfflineAudioContext, or one made in a click handler). */
  context?: BaseAudioContext;
  /** Latency hint for a context created here. @default 'playback' */
  latencyHint?: AudioContextLatencyCategory | number;
  /** Connect the node to the context's destination. @default true */
  connect?: boolean;
  /** Worklet message intervals. */
  processor?: Omit<EngineProcessorOptions, 'preload'>;
  /**
   * Load this score (and start playing from `playFrom`, if given) inside the processor's
   * constructor, before its first block. Needed for OfflineAudioContext renders, which may start
   * before port messages arrive.
   */
  preload?: {
    score: CompiledScore;
    mix: MixSettings;
    timbres?: Record<string, Timbre>;
    playFrom?: number;
  };
}

export class AudioEngine {
  /** The audio context the engine renders in. */
  readonly context: BaseAudioContext;
  /** The engine's AudioWorkletNode (stereo out); connect analysers here. */
  readonly node: AudioWorkletNode;

  /** Called with post-limiter levels about every 50 ms. */
  onMeter: ((meter: Meter) => void) | null = null;
  /** Called when playback reaches the end of the piece. */
  onEnded: (() => void) | null = null;
  /** Called on worklet errors. */
  onError: ((message: string) => void) | null = null;
  /** Live mode: message `seq` applied at context frame `frame`, live time `time` (§9). */
  onLiveApplied: ((seq: number, frame: number, time: number) => void) | null = null;

  private readonly tables = new TableBuilder();
  /**
   * Timbre definition key last sent per name, so unchanged tables are not rebuilt: exactly the
   * names whose slots the worklet holds, least recently used first. Past MAX_TIMBRE_SLOTS names
   * the oldest unneeded ones are evicted (a `forget` message), so a name that comes back gets
   * its tables resent.
   */
  private readonly sent = new Map<string, string>();
  /** Timbre names of the score the worklet plays, and of the last loaded or swapped score. */
  private workletNames: readonly string[] = [];
  private realNames: readonly string[] = [];
  private anchors: Anchor[] = [];
  /**
   * Piece time to show until the worklet confirms the transport command that set it: an anchor
   * whose `seq` is at least `seq` (older anchors answer overtaken commands and leave it).
   */
  private optimistic: { time: number; playing: boolean; seq: number } | null = null;
  /** `seq` of the newest transport command posted. */
  private seq = 0;
  private loopRange: { start: number; end: number } | null = null;
  private durationValue = 0;
  private playingValue = false;
  private timbresValue: Record<string, Timbre> | undefined;
  /** The last score given to `load` or `swap` (restored after an audition). */
  private real: CompiledScore | null = null;
  /** An audition holds the worklet's score (see `audition`). */
  private auditioning = false;

  private constructor(context: BaseAudioContext, node: AudioWorkletNode) {
    this.context = context;
    this.node = node;
    node.port.onmessage = (e: MessageEvent<EngineOutMessage>) => this.receive(e.data);
  }

  /**
   * Creates an engine. On Safari, call it (or at least create the AudioContext) from a user
   * gesture; `play()` also resumes a suspended context.
   */
  static async create(options: AudioEngineOptions = {}): Promise<AudioEngine> {
    const context =
      options.context ?? new AudioContext({ latencyHint: options.latencyHint ?? 'playback' });
    await context.audioWorklet.addModule(engineWorkletUrl);
    const processorOptions: EngineProcessorOptions = { ...options.processor };
    const pre = options.preload;
    if (pre) {
      const flat = flatten(pre.score);
      processorOptions.preload = {
        score: flat,
        mix: pre.mix,
        tables: flat.timbreNames.map((name) => ({
          timbre: name,
          mips: buildWavetables(resolveTimbre(name, pre.timbres), context.sampleRate),
        })),
        playFrom: pre.playFrom,
      };
    }
    const node = new AudioWorkletNode(context, ENGINE_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions,
    });
    if (options.connect !== false) node.connect(context.destination);
    const engine = new AudioEngine(context, node);
    if (pre) {
      engine.durationValue = pre.score.duration;
      engine.timbresValue = pre.timbres;
      const names = processorOptions.preload?.score.timbreNames ?? [];
      for (const name of names) {
        engine.sent.set(name, timbreKey(resolveTimbre(name, pre.timbres), context.sampleRate));
      }
      engine.workletNames = engine.realNames = names;
    }
    return engine;
  }

  /** Duration of the loaded score, in seconds. */
  get duration(): number {
    return this.durationValue;
  }

  /** Whether the transport is playing (as last confirmed or requested). */
  get isPlaying(): boolean {
    return this.optimistic ? this.optimistic.playing : this.playingValue;
  }

  /** Loads a score, mix and timbres; resolves once everything has been posted. Stops playback. */
  async load(
    score: CompiledScore,
    mix: MixSettings,
    timbres?: Record<string, Timbre>,
  ): Promise<void> {
    const flat = flatten(score);
    this.timbresValue = timbres;
    this.real = score;
    const build = this.prepareTables(flat, timbres, true);
    this.realNames = flat.timbreNames;
    const sets = await build;
    this.auditioning = false;
    this.durationValue = score.duration;
    this.anchors = [];
    const seq = this.expect(0, false);
    this.playingValue = false;
    this.loopRange = null;
    this.workletNames = flat.timbreNames;
    this.post({ type: 'load', seq, score: flat, mix: structuredClone(mix) }, transferList(flat));
    this.postTables(sets);
  }

  /**
   * Hot-swaps the score (after an edit) without stopping; new timbres are built first. During an
   * audition the score is kept and sent when the audition ends.
   */
  swap(score: CompiledScore, timbres?: Record<string, Timbre>): Promise<void> {
    const flat = flatten(score);
    if (timbres) this.timbresValue = timbres;
    this.real = score;
    const pending = this.tablesToBuild(flat, this.timbresValue, false);
    this.realNames = flat.timbreNames;
    if (pending.length === 0) {
      // Nothing to build (the usual edit): post now.
      this.durationValue = score.duration;
      if (!this.auditioning) this.postSwap(flat);
      return Promise.resolve();
    }
    return this.buildTables(pending).then((sets) => {
      this.postTables(sets);
      this.durationValue = score.duration;
      if (this.real !== score) return;
      if (!this.auditioning) this.postSwap(flat);
    });
  }

  /**
   * Auditions `score` (a few held notes on the real voice path, PLAN.md §11.3 "Drag preview and
   * auditioning"): swaps it in and plays it from 0, replacing any audition already sounding. The
   * loop range and `ended` are suspended until `endAudition`, which pauses and swaps the last
   * loaded score back. Resolves false (and does nothing) while the transport is playing.
   */
  async audition(score: CompiledScore, timbres?: Record<string, Timbre>): Promise<boolean> {
    if (!this.auditioning && this.isPlaying) return false;
    const flat = flatten(score);
    const sets = await this.prepareTables(flat, timbres ?? this.timbresValue, false);
    // Marked sent, so posted even when the audition is refused.
    this.postTables(sets);
    if (!this.auditioning && this.isPlaying) return false;
    if (!this.auditioning) {
      this.auditioning = true;
      this.post({ type: 'loop', range: null });
    }
    const ctx = this.context;
    if (ctx instanceof AudioContext && ctx.state !== 'running') void ctx.resume();
    this.postSwap(flat);
    this.post({ type: 'play', seq: this.expect(0, true), from: 0 });
    return true;
  }

  /** True while an audition holds the engine. */
  get isAuditioning(): boolean {
    return this.auditioning;
  }

  /** Ends the audition (if any): pauses, then restores the real score and the loop range. */
  endAudition(): void {
    if (!this.auditioning) return;
    this.auditioning = false;
    this.post({ type: 'pause', seq: this.expect(0, false) });
    if (this.real) this.postSwap(flatten(this.real));
    this.post({ type: 'loop', range: this.loopRange });
  }

  /** Starts playback, from `from` seconds if given (from 0 after the end). */
  play(from?: number): void {
    this.endAudition();
    const ctx = this.context;
    if (ctx instanceof AudioContext && ctx.state !== 'running') void ctx.resume();
    let start = from;
    if (start === undefined && this.currentTime() >= this.durationValue - 1e-3) start = 0;
    // Already playing: the worklet would post no anchor, so nothing would confirm the command.
    if (start === undefined && this.isPlaying) return;
    const seq = this.expect(start ?? this.currentTime(), true);
    this.post({ type: 'play', seq, from: start });
  }

  /** Pauses; the FX tail keeps ringing. */
  pause(): void {
    this.endAudition();
    this.post({ type: 'pause', seq: this.expect(this.currentTime(), false) });
  }

  /** Moves the playhead (crossfading if playing). */
  seek(to: number): void {
    this.endAudition();
    const t = Math.max(0, to);
    this.post({ type: 'seek', seq: this.expect(t, this.isPlaying), to: t });
  }

  /** Loops [start, end) seconds, or stops looping with null. */
  loop(range: { start: number; end: number } | null): void {
    // Re-anchor at the time heard now, so the old anchor is not wrapped by the new range (a
    // region set ahead of or behind the playhead must not move it).
    const a = this.anchors[0];
    if (!this.auditioning && !this.optimistic && a?.playing) {
      const pieceTime = this.currentTime();
      this.anchors = [
        { contextTime: this.heardContextTime(), pieceTime, playing: true, reason: 'pos' },
      ];
    }
    this.loopRange = range && range.end > range.start ? { ...range } : null;
    if (this.auditioning) return;
    this.post({ type: 'loop', range: this.loopRange });
  }

  /** Sets one mix or voice parameter (paths in dsp/mix.ts). */
  param(path: string, value: ParamValue): void {
    this.post({ type: 'param', path, value });
  }

  /**
   * Live mode (§9; LiveEngine): the loaded score's first `voices` voices become live voices and
   * the transport plays from 0. `onLiveApplied` then reports seq 0 at the first block.
   */
  startLive(voices: number): void {
    this.post({ type: 'liveStart', voices });
  }

  /** Posts live moves (`moves` is transferred: it is detached afterwards). */
  postLive(
    seq: number,
    moves: Float64Array<ArrayBuffer>,
    n: number,
    gain: number,
    over: number,
    press = 0,
  ): void {
    this.post({ type: 'live', seq, moves, n, gain, over, press }, [moves.buffer]);
  }

  /** Live pitch bend, semitones. */
  bendLive(semitones: number): void {
    this.post({ type: 'liveBend', semitones });
  }

  /** Replaces the whole mix. */
  setMix(mix: MixSettings): void {
    this.post({ type: 'mix', mix: structuredClone(mix) });
  }

  /**
   * The piece time being heard now, in seconds: anchor.pieceTime + (heard context time −
   * anchor.contextTime), wrapped at the loop end and clamped to the piece.
   */
  currentTime(): number {
    if (this.optimistic) return this.optimistic.time;
    const heard = this.heardContextTime();
    while (this.anchors.length > 1 && this.anchors[1].contextTime <= heard) this.anchors.shift();
    const a = this.anchors[0];
    if (!a) return 0;
    if (!a.playing) return a.pieceTime;
    let t = a.pieceTime + Math.max(0, heard - a.contextTime);
    const loop = this.loopRange;
    if (loop && a.pieceTime < loop.end && t >= loop.end) {
      t = loop.start + ((t - loop.end) % (loop.end - loop.start));
    }
    return Math.min(t, Math.max(this.durationValue, loop ? loop.end : 0));
  }

  /** Disconnects and closes; the engine cannot be used afterwards. */
  async dispose(): Promise<void> {
    this.tables.dispose();
    this.node.port.onmessage = null;
    this.node.disconnect();
    const ctx = this.context;
    if (ctx instanceof AudioContext && ctx.state !== 'closed') await ctx.close();
  }

  // -------------------------------------------------------------------------------------------

  /** Shows `time`/`playing` until the worklet confirms the next transport command; its seq. */
  private expect(time: number, playing: boolean): number {
    const seq = ++this.seq;
    this.optimistic = { time, playing, seq };
    return seq;
  }

  private post(msg: EngineInMessage, transfer: Transferable[] = []): void {
    this.node.port.postMessage(msg, transfer);
  }

  private postSwap(flat: FlatScore): void {
    this.workletNames = flat.timbreNames;
    this.post({ type: 'swap', score: flat }, transferList(flat));
  }

  /** The context time of the sample now leaving the speakers. */
  private heardContextTime(): number {
    const ctx = this.context;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (
        ts &&
        ts.contextTime !== undefined &&
        ts.performanceTime !== undefined &&
        ts.performanceTime > 0
      ) {
        const t = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        return Math.min(t, ctx.currentTime);
      }
      return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    }
    return ctx.currentTime;
  }

  private receive(msg: EngineOutMessage): void {
    switch (msg.type) {
      case 'anchor': {
        const a: Anchor = {
          contextTime: msg.contextTime,
          pieceTime: msg.pieceTime,
          playing: msg.playing,
          reason: msg.reason,
        };
        this.playingValue = msg.playing;
        const confirms = this.optimistic !== null && msg.seq >= this.optimistic.seq;
        if (msg.reason === 'loop' && !confirms) {
          // Heard only after the output latency: keep the current anchor until then.
          this.anchors.push(a);
        } else {
          this.anchors = [a];
          if (confirms) this.optimistic = null;
        }
        break;
      }
      case 'pos': {
        if (this.optimistic || this.anchors.length !== 1) break;
        const a = this.anchors[0];
        if (!a.playing) break;
        const ctxTime = msg.frame / this.context.sampleRate;
        const predicted = a.pieceTime + (ctxTime - a.contextTime);
        const loop = this.loopRange;
        const wrapped = loop && predicted >= loop.end;
        if (!wrapped && Math.abs(predicted - msg.time) > 0.005) {
          this.anchors = [
            { contextTime: ctxTime, pieceTime: msg.time, playing: true, reason: 'pos' },
          ];
        }
        break;
      }
      case 'ended':
        this.playingValue = false;
        if (this.auditioning) break;
        this.onEnded?.();
        break;
      case 'meter':
        this.onMeter?.({ peakL: msg.peakL, peakR: msg.peakR, rms: msg.rms });
        break;
      case 'error':
        this.onError?.(msg.message);
        break;
      case 'liveApplied':
        this.onLiveApplied?.(msg.seq, msg.frame, msg.time);
        break;
    }
  }

  /** Builds tables for every timbre of `flat` whose definition the worklet doesn't have yet. */
  private prepareTables(
    flat: FlatScore,
    timbres: Record<string, Timbre> | undefined,
    all: boolean,
  ): Promise<{ name: string; set: WavetableSet }[]> {
    return this.buildTables(this.tablesToBuild(flat, timbres, all));
  }

  /**
   * The timbres whose tables must be built and sent (all, or those changed); marks them sent,
   * most recently used, after evicting old names to make room.
   */
  private tablesToBuild(
    flat: FlatScore,
    timbres: Record<string, Timbre> | undefined,
    all: boolean,
  ): { name: string; timbre: Timbre }[] {
    this.makeRoom(flat.timbreNames);
    const rate = this.context.sampleRate;
    const out: { name: string; timbre: Timbre }[] = [];
    for (const name of flat.timbreNames) {
      const timbre = resolveTimbre(name, timbres);
      const key = timbreKey(timbre, rate);
      const had = this.sent.get(name);
      this.sent.delete(name);
      this.sent.set(name, key);
      if (!all && had === key) continue;
      out.push({ name, timbre });
    }
    return out;
  }

  /**
   * Keeps the worklet's slots for at most MAX_TIMBRE_SLOTS names once `names` arrive: evicts the
   * least recently used names that neither `names`, the worklet's current score nor the last
   * real score uses, and tells the worklet before anything new is posted.
   */
  private makeRoom(names: readonly string[]): void {
    let incoming = 0;
    for (const name of new Set(names)) if (!this.sent.has(name)) incoming++;
    let over = this.sent.size + incoming - MAX_TIMBRE_SLOTS;
    if (over <= 0) return;
    const keep = new Set([...names, ...this.workletNames, ...this.realNames]);
    const evict: string[] = [];
    for (const name of this.sent.keys()) {
      if (over <= 0) break;
      if (keep.has(name)) continue;
      evict.push(name);
      over--;
    }
    if (evict.length === 0) return;
    for (const name of evict) this.sent.delete(name);
    this.post({ type: 'forget', timbres: evict });
  }

  private async buildTables(
    todo: readonly { name: string; timbre: Timbre }[],
  ): Promise<{ name: string; set: WavetableSet }[]> {
    const rate = this.context.sampleRate;
    return Promise.all(
      todo.map(async ({ name, timbre }) => {
        let set: WavetableSet;
        try {
          set = await this.tables.build(timbre, rate);
        } catch {
          set = buildWavetables(timbre, rate);
        }
        return { name, set };
      }),
    );
  }

  private postTables(sets: { name: string; set: WavetableSet }[]): void {
    for (const { name, set } of sets) {
      this.post({ type: 'tables', timbre: name, mips: set }, wavetableTransferList(set));
    }
  }
}
