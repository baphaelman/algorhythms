/**
 * Transport confirmations: an anchor answering an older command must not override the state set
 * by a newer one (play, then a seek before the play's anchor arrives, must stay at the seek).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../../src/audio/engine';
import { DRY_MIX, makeScore } from '../../../src/audio/fixtures/scores';
import type {
  AnchorReason,
  EngineInMessage,
  EngineOutMessage,
} from '../../../src/audio/worklet/engine-protocol';
import { flatten } from '../../../src/core/flat';
import { BLOCK_FRAMES } from '../../../src/dsp/constants';
import { Graph } from '../../../src/dsp/graph';

interface Harness {
  engine: AudioEngine;
  posted: EngineInMessage[];
  ctx: { currentTime: number };
  reply: (msg: EngineOutMessage) => void;
  /** The `seq` of the last posted message of this type. */
  seqOf: (type: 'load' | 'play' | 'pause' | 'seek') => number;
}

async function harness(): Promise<Harness> {
  const posted: EngineInMessage[] = [];
  let port: { onmessage: ((e: { data: EngineOutMessage }) => void) | null } | null = null;
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      readonly port = {
        onmessage: null as ((e: { data: EngineOutMessage }) => void) | null,
        postMessage: (msg: EngineInMessage) => posted.push(msg),
      };
      constructor() {
        port = this.port;
      }
      connect(): void {}
      disconnect(): void {}
    },
  );
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    audioWorklet: { addModule: () => Promise.resolve() },
  };
  const engine = await AudioEngine.create({
    context: ctx as unknown as BaseAudioContext,
    connect: false,
  });
  await engine.load(makeScore([{ id: 'a', start: 69, timbre: 'sine' }], 60), DRY_MIX);
  return {
    engine,
    posted,
    ctx,
    reply: (msg) => port?.onmessage?.({ data: msg }),
    seqOf: (type) => {
      for (let i = posted.length - 1; i >= 0; i--) {
        const m = posted[i];
        if (m.type === type) return m.seq;
      }
      throw new Error(`no ${type} posted`);
    },
  };
}

const anchor = (
  seq: number,
  pieceTime: number,
  playing: boolean,
  reason: AnchorReason,
  contextTime = 0,
): EngineOutMessage => ({ type: 'anchor', seq, pieceTime, playing, reason, contextTime });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AudioEngine: stale transport confirmations', () => {
  it('a late play anchor does not override a newer seek', async () => {
    const h = await harness();
    h.reply(anchor(h.seqOf('load'), 0, false, 'load'));
    h.engine.play(0);
    const playSeq = h.seqOf('play');
    h.engine.seek(5);
    const seekSeq = h.seqOf('seek');
    expect(seekSeq).toBeGreaterThan(playSeq);

    // The worklet applied the play before the seek arrived.
    h.ctx.currentTime = 0.1;
    h.reply(anchor(playSeq, 0, true, 'play', 0.05));
    expect(h.engine.currentTime()).toBe(5);
    expect(h.engine.isPlaying).toBe(true);

    // The seek's anchor takes over and the clock runs from it.
    h.reply(anchor(seekSeq, 5, true, 'seek', 0.1));
    h.ctx.currentTime = 0.3;
    expect(h.engine.currentTime()).toBeCloseTo(5.2, 9);
  });

  it('a late play anchor does not override a newer pause', async () => {
    const h = await harness();
    h.reply(anchor(h.seqOf('load'), 0, false, 'load'));
    h.engine.play(2);
    const playSeq = h.seqOf('play');
    h.engine.pause();
    h.reply(anchor(playSeq, 2, true, 'play'));
    expect(h.engine.isPlaying).toBe(false);
    expect(h.engine.currentTime()).toBe(2);
    h.reply(anchor(h.seqOf('pause'), 2.01, false, 'pause'));
    expect(h.engine.isPlaying).toBe(false);
    expect(h.engine.currentTime()).toBeCloseTo(2.01, 9);
  });

  it('an anchor not tied to the pending command (swap) keeps the optimistic state', async () => {
    const h = await harness();
    h.reply(anchor(h.seqOf('load'), 0, false, 'load'));
    h.engine.seek(3);
    h.reply(anchor(h.seqOf('load'), 0, false, 'swap'));
    expect(h.engine.currentTime()).toBe(3);
    h.reply(anchor(h.seqOf('seek'), 3, false, 'seek'));
    expect(h.engine.currentTime()).toBe(3);
  });

  it('play while already playing posts nothing (no anchor would confirm it)', async () => {
    const h = await harness();
    h.engine.play(0);
    h.reply(anchor(h.seqOf('play'), 0, true, 'play'));
    const n = h.posted.length;
    h.engine.play();
    expect(h.posted.length).toBe(n);
    h.ctx.currentTime = 0.5;
    expect(h.engine.currentTime()).toBeCloseTo(0.5, 9);
  });
});

describe('Graph.transportPending (the worklet echoes a seq only once it is applied)', () => {
  it('is set from a seek until the block that applies it', () => {
    const g = new Graph(48000);
    g.load(flatten(makeScore([{ id: 'a', start: 69, timbre: 'sine' }], 60)), DRY_MIX);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    expect(g.transportPending).toBe(false);
    g.play(0);
    expect(g.transportPending).toBe(true);
    g.process(l, r);
    expect(g.transportPending).toBe(false);
    g.seek(5);
    expect(g.transportPending).toBe(true);
    for (let i = 0; i < 20 && g.transportPending; i++) g.process(l, r);
    expect(g.transportPending).toBe(false);
    expect(g.anchorPieceTime).toBeCloseTo(5, 3);
  });
});
