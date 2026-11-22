/**
 * Timbre slot bookkeeping between `AudioEngine` and the worklet's `Graph` (MAX_TIMBRE_SLOTS = 64).
 * The engine skips tables it has already sent, so its record must match the slots the graph
 * holds: past 64 names it evicts the least recently used (a `forget` message) and resends a name
 * that comes back. Driven through the real engine with a fake worklet node that hands every
 * message to a Graph, as engine.worklet.ts does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { DRY_MIX, makeScore } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { tablesFor } from '../../src/audio/timbres';
import type { EngineInMessage } from '../../src/audio/worklet/engine-protocol';
import { flatten } from '../../src/core/flat';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { Timbre } from '../../src/core/types';
import { BLOCK_FRAMES, MAX_TIMBRE_SLOTS } from '../../src/dsp/constants';
import { Graph } from '../../src/dsp/graph';
import { RATE, rms } from './helpers';
import { toneAmp } from './spectrum';

/** The worklet side: a Graph fed every posted message. */
class FakeWorklet {
  readonly graph = new Graph(RATE);
  readonly posted: EngineInMessage[] = [];
  private readonly bl = new Float32Array(BLOCK_FRAMES);
  private readonly br = new Float32Array(BLOCK_FRAMES);

  handle(msg: EngineInMessage): void {
    this.posted.push(msg);
    const g = this.graph;
    if (msg.type === 'load') g.load(msg.score, msg.mix);
    else if (msg.type === 'tables') g.setTables(msg.timbre, msg.mips);
    else if (msg.type === 'forget') g.forget(msg.timbres);
    else if (msg.type === 'swap') g.swap(msg.score);
    else if (msg.type === 'play') g.play(msg.from);
  }

  /** Renders `seconds` (whole blocks); returns the left channel. */
  run(seconds: number): Float32Array {
    const n = Math.ceil((seconds * RATE) / BLOCK_FRAMES);
    const out = new Float32Array(n * BLOCK_FRAMES);
    for (let b = 0; b < n; b++) {
      this.graph.process(this.bl, this.br);
      out.set(this.bl, b * BLOCK_FRAMES);
    }
    return out;
  }
}

async function engineWith(worklet: FakeWorklet): Promise<AudioEngine> {
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      readonly port = {
        onmessage: null,
        postMessage: (msg: EngineInMessage) => worklet.handle(msg),
      };
      connect(): void {}
      disconnect(): void {}
    },
  );
  const context = {
    sampleRate: RATE,
    currentTime: 0,
    audioWorklet: { addModule: () => Promise.resolve() },
  } as unknown as BaseAudioContext;
  return AudioEngine.create({ context, connect: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** t0 has a strong 7th harmonic; every other name a 2nd. */
const NAMES = Array.from({ length: MAX_TIMBRE_SLOTS + 6 }, (_, i) => `t${i}`);
const TIMBRES: Record<string, Timbre> = Object.fromEntries(
  NAMES.map((n, i) => [
    n,
    { ...BUILTIN_TIMBRES.sine, harmonics: i === 0 ? [1, 0, 0, 0, 0, 0, 0.8] : [1, 0.8] },
  ]),
);
const scoreOf = (name: string) => makeScore([{ id: 'a', start: 69, timbre: name }], 60);

/** 7th- and 2nd-harmonic amplitudes relative to the fundamental (A4) over the last 0.2 s. */
function signature(x: Float32Array): { h7: number; h2: number; h1: number } {
  const n = Math.round(0.2 * RATE);
  const from = x.length - n;
  const h1 = toneAmp(x, 440, RATE, from, n);
  return {
    h1,
    h2: toneAmp(x, 880, RATE, from, n) / h1,
    h7: toneAmp(x, 3080, RATE, from, n) / h1,
  };
}

describe('timbre slots: engine bookkeeping past 64 names', () => {
  it('evicts the least recently used names, resends one that returns, and it sounds as itself', async () => {
    const worklet = new FakeWorklet();
    const recycle = vi.spyOn(
      Graph.prototype as unknown as { recycleSlot: (u: Uint8Array) => number },
      'recycleSlot',
    );
    const engine = await engineWith(worklet);
    await engine.load(scoreOf('t0'), DRY_MIX, TIMBRES);
    engine.play(0);
    worklet.run(0.1);
    for (const name of NAMES.slice(1)) {
      await engine.swap(scoreOf(name), TIMBRES);
      worklet.run(0.05);
    }
    // t0 went first; the graph never had to recycle a slot behind the engine's back.
    const forgotten = worklet.posted.flatMap((m) => (m.type === 'forget' ? m.timbres : []));
    expect(forgotten).toEqual(NAMES.slice(0, NAMES.length - MAX_TIMBRE_SLOTS));
    expect(worklet.graph.timbreSlotOf('t0')).toBe(-1);
    expect(recycle).not.toHaveBeenCalled();

    const mark = worklet.posted.length;
    await engine.swap(scoreOf('t0'), TIMBRES);
    const after = worklet.posted.slice(mark);
    expect(after.some((m) => m.type === 'tables' && m.timbre === 't0')).toBe(true);
    // Making room for t0 evicts the oldest name still held (t6), never one the scores use.
    expect(after.find((m) => m.type === 'forget')).toEqual({ type: 'forget', timbres: ['t6'] });
    expect(worklet.graph.timbreSlotOf('t0')).toBeGreaterThanOrEqual(0);
    const heard = signature(worklet.run(0.5));

    const ref = renderOffline(
      { score: scoreOf('t0'), mix: DRY_MIX, timbres: TIMBRES, sampleRate: RATE },
      Math.ceil((1.2 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES,
    );
    const want = signature(ref.left);
    expect(want.h7).toBeGreaterThan(0.3);
    expect(Math.abs(heard.h7 / want.h7 - 1)).toBeLessThan(0.1);
    expect(heard.h2).toBeLessThan(0.05);
    expect(Math.abs(20 * Math.log10(heard.h1 / want.h1))).toBeLessThan(1);
    expect(recycle).not.toHaveBeenCalled();
    await engine.dispose();
  });

  it('Graph.forget frees the slot but keeps its tables until the slot is reused', () => {
    const w = new FakeWorklet();
    const g = w.graph;
    g.load(flatten(scoreOf('t1')), DRY_MIX);
    g.setTables('t1', tablesFor(TIMBRES.t1, RATE));
    const slot = g.timbreSlotOf('t1');
    g.play(0);
    w.run(0.1);
    g.forget(['t1', 'unknown']);
    expect(g.timbreSlotOf('t1')).toBe(-1);
    // The playing voice still uses the freed slot: it keeps sounding, and a new name takes
    // another free slot.
    expect(rms(w.run(0.1))).toBeGreaterThan(0.01);
    g.setTables('t2', tablesFor(TIMBRES.t2, RATE));
    expect(g.timbreSlotOf('t2')).toBeGreaterThanOrEqual(0);
    expect(g.timbreSlotOf('t2')).not.toBe(slot);
  });
});
