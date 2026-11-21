/**
 * Live engine = offline render = stems, with pulses (R9-3b). The AudioWorkletProcessor runs in
 * Node against stubbed worklet globals, loaded the way the page loads it (a structured clone of
 * the flat score, tables per timbre), and must produce the offline render bit for bit; the voice
 * and FX stems must sum to the mix.
 */

import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_MIX } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { resolveTimbre, tablesFor } from '../../src/audio/timbres';
import { compile } from '../../src/core/compiler/compile';
import { flatten } from '../../src/core/flat';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { pulseChordPiece, pulseDemoPiece } from '../unit/core/pulse-fixtures';
import { dbfs, RATE } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

interface Processor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorClass = new (options: { processorOptions: unknown }) => Processor;

let engineClass: ProcessorClass | null = null;

/** Loads engine.worklet.ts (once) against stub globals and returns its processor class. */
async function loadWorklet(): Promise<ProcessorClass> {
  if (engineClass) return engineClass;
  const g = globalThis as unknown as Record<string, unknown>;
  let registered: ProcessorClass | null = null;
  g.sampleRate = RATE;
  g.currentTime = 0;
  g.currentFrame = 0;
  g.AudioWorkletProcessor = class {
    readonly port = { onmessage: null, postMessage: () => {}, start: () => {}, close: () => {} };
  };
  g.registerProcessor = (_name: string, cls: ProcessorClass) => (registered = cls);
  // A computed path: the worklet's globals are not in the tests' TypeScript lib.
  const path = '../../src/audio/worklet/engine.worklet';
  await import(/* @vite-ignore */ path);
  if (!registered) throw new Error('the worklet did not register a processor');
  engineClass = registered;
  return registered;
}

describe('pulse: live engine, offline render and stems agree', () => {
  it.each([
    ['chord piece (glass)', () => pulseChordPiece('glass'), 11],
    ['demo piece', () => pulseDemoPiece(), 24],
  ] as const)('%s', async (_label, make, seconds) => {
    const p = make();
    const score = compile(p);
    expect(score.voices.some((v) => (v.pulse ?? []).some((r) => r.hit))).toBe(true);
    const flat = flatten(score);
    const frames = Math.ceil((seconds * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const mix = p.mix ?? FIXTURE_MIX;

    // Live: the worklet processor, preloaded as the page preloads it.
    const Engine = await loadWorklet();
    const tables = flat.timbreNames.map((name) => ({
      timbre: name,
      mips: tablesFor(resolveTimbre(name, p.timbres), RATE),
    }));
    const proc = new Engine({
      processorOptions: { preload: { score: structuredClone(flat), mix, tables, playFrom: 0 } },
    });
    const liveL = new Float32Array(frames);
    const liveR = new Float32Array(frames);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    for (let f = 0; f < frames; f += BLOCK_FRAMES) {
      proc.process([], [[l, r]]);
      liveL.set(l, f);
      liveR.set(r, f);
    }

    // Offline (the WAV export's renderer).
    const input = { score: flat, mix, timbres: p.timbres, sampleRate: RATE };
    const gain = new Float32Array(frames);
    const off = renderOffline(input, frames, { kind: 'mix', captureGain: gain });
    let diff = 0;
    let level = 0;
    for (let i = 0; i < frames; i++) {
      diff = Math.max(diff, Math.abs(off.left[i] - liveL[i]), Math.abs(off.right[i] - liveR[i]));
      level = Math.max(level, Math.abs(off.left[i]));
    }
    expect(level).toBeGreaterThan(0.01);
    expect(diff).toBe(0);

    // Stems: Σ voices + FX = mix.
    const sumL = new Float64Array(frames);
    const sumR = new Float64Array(frames);
    const add = (s: { left: Float32Array; right: Float32Array }): void => {
      for (let i = 0; i < frames; i++) {
        sumL[i] += s.left[i];
        sumR[i] += s.right[i];
      }
    };
    for (let v = 0; v < score.voices.length; v++) {
      add(renderOffline(input, frames, { kind: 'voice', index: v, replayGain: gain }));
    }
    add(renderOffline(input, frames, { kind: 'fx', replayGain: gain }));
    let worst = 0;
    for (let i = 0; i < frames; i++) {
      worst = Math.max(worst, Math.abs(sumL[i] - off.left[i]), Math.abs(sumR[i] - off.right[i]));
    }
    console.info(`${_label}: live − offline ${diff}, Σ stems − mix ${dbfs(worst).toFixed(1)} dBFS`);
    expect(dbfs(worst)).toBeLessThan(-90);
  });
});
