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
  processor?: EngineProcessorOptions;
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

  private readonly tables = new TableBuilder();
  /** Timbre definition key last sent per name, so unchanged tables are not rebuilt. */
  private readonly sent = new Map<string, string>();
  private anchors: Anchor[] = [];
  /** Piece time to show until the worklet confirms a command with an anchor. */
  private optimistic: { time: number; playing: boolean } | null = null;
  private loopRange: { start: number; end: number } | null = null;
  private durationValue = 0;
  private playingValue = false;
  private timbresValue: Record<string, Timbre> | undefined;

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
    const node = new AudioWorkletNode(context, ENGINE_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: options.processor ?? {},
    });
    if (options.connect !== false) node.connect(context.destination);
    return new AudioEngine(context, node);
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
  async load(score: CompiledScore, mix: MixSettings, timbres?: Record<string, Timbre>): Promise<void> {
    const flat = flatten(score);
    this.timbresValue = timbres;
    const sets = await this.prepareTables(flat, timbres, true);
    this.durationValue = score.duration;
    this.anchors = [];
    this.optimistic = { time: 0, playing: false };
    this.playingValue = false;
    this.loopRange = null;
    this.post({ type: 'load', score: flat, mix: structuredClone(mix) }, transferList(flat));
    this.postTables(sets);
  }

  /** Hot-swaps the score (after an edit) without stopping; new timbres are built first. */
  async swap(score: CompiledScore, timbres?: Record<string, Timbre>): Promise<void> {
    const flat = flatten(score);
    if (timbres) this.timbresValue = timbres;
    const sets = await this.prepareTables(flat, this.timbresValue, false);
    this.postTables(sets);
    this.durationValue = score.duration;
    this.post({ type: 'swap', score: flat }, transferList(flat));
  }

  /** Starts playback, from `from` seconds if given (from 0 after the end). */
  play(from?: number): void {
    const ctx = this.context;
    if (ctx instanceof AudioContext && ctx.state !== 'running') void ctx.resume();
    let start = from;
    if (start === undefined && this.currentTime() >= this.durationValue - 1e-3) start = 0;
    this.optimistic = { time: start ?? this.currentTime(), playing: true };
    this.post({ type: 'play', from: start });
  }

  /** Pauses; the FX tail keeps ringing. */
  pause(): void {
    this.optimistic = { time: this.currentTime(), playing: false };
    this.post({ type: 'pause' });
  }

  /** Moves the playhead (crossfading if playing). */
  seek(to: number): void {
    const t = Math.max(0, to);
    this.optimistic = { time: t, playing: this.isPlaying };
    this.post({ type: 'seek', to: t });
  }

  /** Loops [start, end) seconds, or stops looping with null. */
  loop(range: { start: number; end: number } | null): void {
    this.loopRange = range && range.end > range.start ? { ...range } : null;
    this.post({ type: 'loop', range: this.loopRange });
  }

  /** Sets one mix or voice parameter (paths in dsp/mix.ts). */
  param(path: string, value: ParamValue): void {
    this.post({ type: 'param', path, value });
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

  private post(msg: EngineInMessage, transfer: Transferable[] = []): void {
    this.node.port.postMessage(msg, transfer);
  }

  /** The context time of the sample now leaving the speakers. */
  private heardContextTime(): number {
    const ctx = this.context;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
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
        const a: Anchor = { ...msg };
        this.playingValue = msg.playing;
        if (msg.reason === 'loop') {
          // Heard only after the output latency: keep the current anchor until then.
          this.anchors.push(a);
        } else {
          this.anchors = [a];
          this.optimistic = null;
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
          this.anchors = [{ contextTime: ctxTime, pieceTime: msg.time, playing: true, reason: 'pos' }];
        }
        break;
      }
      case 'ended':
        this.playingValue = false;
        this.onEnded?.();
        break;
      case 'meter':
        this.onMeter?.({ peakL: msg.peakL, peakR: msg.peakR, rms: msg.rms });
        break;
      case 'error':
        this.onError?.(msg.message);
        break;
    }
  }

  /** Builds tables for every timbre of `flat` whose definition the worklet doesn't have yet. */
  private async prepareTables(
    flat: FlatScore,
    timbres: Record<string, Timbre> | undefined,
    all: boolean,
  ): Promise<{ name: string; set: WavetableSet }[]> {
    const rate = this.context.sampleRate;
    const jobs = flat.timbreNames.map(async (name) => {
      const timbre = resolveTimbre(name, timbres);
      const key = timbreKey(timbre, rate);
      if (!all && this.sent.get(name) === key) return null;
      this.sent.set(name, key);
      let set: WavetableSet;
      try {
        set = await this.tables.build(timbre, rate);
      } catch {
        set = buildWavetables(timbre, rate);
      }
      return { name, set };
    });
    const done = await Promise.all(jobs);
    return done.filter((d): d is { name: string; set: WavetableSet } => d !== null);
  }

  private postTables(sets: { name: string; set: WavetableSet }[]): void {
    for (const { name, set } of sets) {
      this.post({ type: 'tables', timbre: name, mips: set }, wavetableTransferList(set));
    }
  }
}
