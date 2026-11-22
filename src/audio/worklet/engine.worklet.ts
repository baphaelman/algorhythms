/**
 * The engine AudioWorkletProcessor (PLAN.md §8.1–§8.3): runs the pure-TS DSP graph, one
 * 128-frame block per `process()` call. Message handlers copy what they need into the graph's
 * pending state and return; the graph applies it at the next block boundary. `process()` itself
 * does not allocate, apart from the small, preallocated messages it posts.
 */

import { Graph, GraphEvent } from '../../dsp/graph';
import { BLOCK_FRAMES } from '../../dsp/constants';
import {
  ANCHOR_REASONS,
  ENGINE_PROCESSOR,
  type EngineInMessage,
  type EngineOutMessage,
  type EngineProcessorOptions,
} from './engine-protocol';

class EngineProcessor extends AudioWorkletProcessor {
  private readonly graph = new Graph(sampleRate);
  private readonly scratch = new Float32Array(BLOCK_FRAMES);
  private readonly meterEvery: number;
  private readonly posEvery: number;
  private sinceMeter = 0;
  private sincePos = 0;
  private failed = false;
  private wasPlaying = false;
  // Preallocated outgoing messages (mutated, then posted).
  private readonly anchorMsg = {
    type: 'anchor' as const,
    contextTime: 0,
    pieceTime: 0,
    playing: false,
    reason: ANCHOR_REASONS[0],
  };
  private readonly meterMsg = { type: 'meter' as const, peakL: 0, peakR: 0, rms: 0 };
  private readonly posMsg = { type: 'pos' as const, frame: 0, time: 0 };
  private readonly endedMsg = { type: 'ended' as const };

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const o = (options?.processorOptions ?? {}) as EngineProcessorOptions;
    this.meterEvery = Math.max(BLOCK_FRAMES, Math.round((o.meterInterval ?? 0.05) * sampleRate));
    this.posEvery = Math.max(BLOCK_FRAMES, Math.round((o.posInterval ?? 0.25) * sampleRate));
    this.port.onmessage = (event: MessageEvent) => this.handle(event.data as EngineInMessage);
    const pre = o.preload;
    if (pre) {
      this.handle({ type: 'load', score: pre.score, mix: pre.mix });
      for (const t of pre.tables) this.handle({ type: 'tables', timbre: t.timbre, mips: t.mips });
      if (pre.playFrom !== undefined) this.handle({ type: 'play', from: pre.playFrom });
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
          g.play(msg.from);
          break;
        case 'pause':
          g.pause();
          break;
        case 'seek':
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
    this.port.postMessage(a);
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
    try {
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
    return true;
  }
}

registerProcessor(ENGINE_PROCESSOR, EngineProcessor);
