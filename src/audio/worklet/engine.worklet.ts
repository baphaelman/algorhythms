/**
 * The engine AudioWorkletProcessor (PLAN.md §8.1–§8.3): runs the pure-TS DSP graph, one
 * 128-frame block per `process()` call. Message handlers copy what they need into the graph's
 * pending state and return; the graph applies it at the next block boundary. `process()` itself
 * does not allocate, apart from the small, preallocated messages it posts.
 */

import { Graph, GraphEvent } from '../../dsp/graph';
import { BLOCK_FRAMES } from '../../dsp/constants';
import { LiveInput } from '../../dsp/live';
import {
  ANCHOR_REASONS,
  ENGINE_PROCESSOR,
  type EngineInMessage,
  type EngineOutMessage,
  type EngineProcessorOptions,
} from './engine-protocol';

const EMPTY = new Float64Array(0);
/**
 * A block that starts ≥ this many ms (Date.now) after the previous one starts a new device
 * callback; blocks of one callback are rendered back to back (well under 1 ms apart). The
 * shortest callback (one block, 128 frames at 48 kHz) is 2.7 ms.
 */
const CALLBACK_GAP_MS = 2;
/** Device callbacks the reported period is the median of (robust to a stalled or merged one). */
const CALLBACK_HISTORY = 15;

class EngineProcessor extends AudioWorkletProcessor {
  private readonly graph = new Graph(sampleRate);
  private readonly scratch = new Float32Array(BLOCK_FRAMES);
  private readonly meterEvery: number;
  private readonly posEvery: number;
  private sinceMeter = 0;
  private sincePos = 0;
  private failed = false;
  private wasPlaying = false;
  /** `seq` of the newest transport command received, and of the newest one the graph applied. */
  private seqReceived = 0;
  private seqApplied = 0;
  // Preallocated outgoing messages (mutated, then posted).
  private readonly anchorMsg = {
    type: 'anchor' as const,
    contextTime: 0,
    pieceTime: 0,
    playing: false,
    reason: ANCHOR_REASONS[0],
    seq: 0,
  };
  private readonly meterMsg = { type: 'meter' as const, peakL: 0, peakR: 0, rms: 0 };
  private readonly posMsg = { type: 'pos' as const, frame: 0, time: 0 };
  private readonly endedMsg = { type: 'ended' as const };
  private readonly liveMsg = {
    type: 'liveApplied' as const,
    seq: 0,
    frame: 0,
    time: 0,
    received: 0,
    callback: 0,
  };
  /** Live mode (§9), from `liveStart` on. */
  private live: LiveInput | null = null;
  /** First frame of the next block (set after each block). */
  private nextFrame = 0;
  /** `nextFrame` when the newest live message arrived. */
  private liveReceived = 0;
  // Device callbacks while live (latency stamps): the wall clock of the previous block, the first
  // frame of the callback in progress, and the lengths (frames) of the last completed ones.
  private lastWall = 0;
  private callbackStart = 0;
  private callbackCount = 0;
  private readonly callbacks = new Float64Array(CALLBACK_HISTORY);
  private readonly callbackSorted = new Float64Array(CALLBACK_HISTORY);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const o = (options?.processorOptions ?? {}) as EngineProcessorOptions;
    this.meterEvery = Math.max(BLOCK_FRAMES, Math.round((o.meterInterval ?? 0.05) * sampleRate));
    this.posEvery = Math.max(BLOCK_FRAMES, Math.round((o.posInterval ?? 0.25) * sampleRate));
    this.port.onmessage = (event: MessageEvent) => this.handle(event.data as EngineInMessage);
    const pre = o.preload;
    if (pre) {
      this.handle({ type: 'load', seq: 0, score: pre.score, mix: pre.mix });
      for (const t of pre.tables) this.handle({ type: 'tables', timbre: t.timbre, mips: t.mips });
      if (pre.playFrom !== undefined) this.handle({ type: 'play', seq: 0, from: pre.playFrom });
    }
  }

  private post(msg: EngineOutMessage): void {
    this.port.postMessage(msg);
  }

  private handle(msg: EngineInMessage): void {
    try {
      const g = this.graph;
      switch (msg.type) {
        case 'load':
          this.seqReceived = msg.seq;
          g.load(msg.score, msg.mix);
          this.failed = false;
          this.postAnchor(currentTime);
          break;
        case 'tables':
          g.setTables(msg.timbre, msg.mips);
          break;
        case 'forget':
          g.forget(msg.timbres);
          break;
        case 'play':
          this.seqReceived = msg.seq;
          g.play(msg.from);
          break;
        case 'pause':
          this.seqReceived = msg.seq;
          g.pause();
          break;
        case 'seek':
          this.seqReceived = msg.seq;
          g.seek(msg.to);
          break;
        case 'loop':
          if (msg.range) g.setLoop(msg.range.start, msg.range.end);
          else g.clearLoop();
          break;
        case 'swap':
          g.swap(msg.score);
          break;
        case 'param':
          if (!g.setParam(msg.path, msg.value)) {
            this.post({ type: 'error', message: `unknown param ${msg.path}` });
          }
          break;
        case 'mix':
          g.setMix(msg.mix);
          break;
        case 'liveStart':
          this.live = new LiveInput(g, msg.voices);
          g.clearLoop();
          g.play(0);
          this.live.queue(0, EMPTY, 0, NaN, 0);
          break;
        case 'live':
          this.liveReceived = this.nextFrame;
          if (
            this.live &&
            !this.live.queue(msg.seq, msg.moves, msg.n, msg.gain, msg.over, msg.press ?? 0)
          ) {
            this.post({ type: 'error', message: 'live queue full' });
          }
          break;
        case 'liveBend':
          this.live?.setBend(msg.semitones);
          break;
        case 'liveTimbre':
          this.live?.setTimbre(msg.voice, g.slotFor(msg.timbre), msg.fade);
          break;
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private postAnchor(contextTime: number): void {
    const g = this.graph;
    const a = this.anchorMsg;
    a.contextTime = contextTime;
    a.pieceTime = g.anchorPieceTime;
    a.playing = g.anchorPlaying;
    a.reason = ANCHOR_REASONS[g.anchorReason] ?? 'seek';
    // A transport command still pending (e.g. a seek waiting for its fade-out) is not reflected.
    if (!g.transportPending) this.seqApplied = this.seqReceived;
    a.seq = this.seqApplied;
    this.port.postMessage(a);
  }

  /** Median length of the recent device callbacks, in frames (0 before the first one ends). */
  private callbackPeriod(): number {
    const n = this.callbackCount < CALLBACK_HISTORY ? this.callbackCount : CALLBACK_HISTORY;
    const a = this.callbackSorted;
    for (let i = 0; i < n; i++) {
      const x = this.callbacks[i];
      let j = i;
      for (; j > 0 && a[j - 1] > x; j--) a[j] = a[j - 1];
      a[j] = x;
    }
    return n === 0 ? 0 : a[n >> 1];
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out === undefined || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : this.scratch;
    if (this.failed || left.length !== BLOCK_FRAMES) {
      left.fill(0);
      right.fill(0);
      return true;
    }
    const g = this.graph;
    const live = this.live;
    if (live !== null) {
      const wall = Date.now();
      if (wall - this.lastWall >= CALLBACK_GAP_MS) {
        if (this.lastWall > 0)
          this.callbacks[this.callbackCount++ % CALLBACK_HISTORY] =
            currentFrame - this.callbackStart;
        this.callbackStart = currentFrame;
      }
      this.lastWall = wall;
    }
    try {
      if (live !== null) live.beforeBlock(currentFrame);
      g.process(left, right);
    } catch (e) {
      this.failed = true;
      left.fill(0);
      right.fill(0);
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      return true;
    }
    if (out.length === 1)
      for (let i = 0; i < BLOCK_FRAMES; i++) left[i] = 0.5 * (left[i] + right[i]);

    if (live !== null && live.appliedCount > 0) {
      const m = this.liveMsg;
      m.frame = live.appliedFrame;
      m.time = live.appliedTime;
      m.received = this.liveReceived;
      m.callback = this.callbackPeriod();
      for (let k = 0; k < live.appliedCount; k++) {
        m.seq = live.appliedSeq[k];
        this.port.postMessage(m);
      }
    }
    if ((g.events & GraphEvent.Anchor) !== 0) this.postAnchor(currentTime);
    if ((g.events & GraphEvent.Ended) !== 0) this.port.postMessage(this.endedMsg);

    this.sinceMeter += BLOCK_FRAMES;
    if (this.sinceMeter >= this.meterEvery) {
      const m = this.meterMsg;
      m.peakL = g.meterPeakL;
      m.peakR = g.meterPeakR;
      m.rms = Math.sqrt(g.meterSumSq / Math.max(1, 2 * g.meterFrames));
      g.resetMeter();
      this.sinceMeter = 0;
      this.port.postMessage(m);
    }
    const playing = g.isPlaying;
    if (playing) {
      this.sincePos += BLOCK_FRAMES;
      if (this.sincePos >= this.posEvery || !this.wasPlaying) {
        // The piece time at the first frame of the next block.
        const p = this.posMsg;
        p.frame = currentFrame + BLOCK_FRAMES;
        p.time = g.position;
        this.sincePos = 0;
        this.port.postMessage(p);
      }
    }
    this.wasPlaying = playing;
    this.nextFrame = currentFrame + BLOCK_FRAMES;
    return true;
  }
}

registerProcessor(ENGINE_PROCESSOR, EngineProcessor);
