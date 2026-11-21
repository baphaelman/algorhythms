import { describe, expect, it, vi } from 'vitest';

// The serial audio queue (src/app/audio.ts): with the engine created and nothing queued, a swap is
// posted before `swapAudio` returns; behind a running job it waits its turn.
const log = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.AudioContext = class {};
  return [] as string[];
});
const gate = vi.hoisted(() => ({ open: (): void => undefined }));
vi.mock('../../../src/audio/engine', () => ({
  AudioEngine: {
    create: () =>
      Promise.resolve({
        swap: () => {
          log.push('swap');
          return Promise.resolve();
        },
        load: () =>
          new Promise<void>((resolve) => {
            log.push('load start');
            gate.open = () => {
              log.push('load done');
              resolve();
            };
          }),
      }),
  },
}));

import { loadAudio, primeAudio, swapAudio, whenReady } from '../../../src/app/audio';
import type { CompiledScore, MixSettings } from '../../../src/core/types';

const score = {} as CompiledScore;

describe('audio queue', () => {
  it('posts a swap synchronously when idle, and in order behind a pending load', async () => {
    await primeAudio();
    await whenReady();
    await whenReady();
    log.length = 0;

    void swapAudio(score, {});
    expect(log).toEqual(['swap']);
    await whenReady();

    log.length = 0;
    void loadAudio(score, {} as MixSettings, {});
    await Promise.resolve();
    await Promise.resolve();
    void swapAudio(score, {});
    await Promise.resolve();
    expect(log).toEqual(['load start']);
    gate.open();
    await whenReady();
    expect(log).toEqual(['load start', 'load done', 'swap']);
  });
});
