import { describe, expect, it, vi } from 'vitest';

// Browser globals and the audio module, stubbed before the store loads. Idle never fires here, so
// the load queued by `loadPiece` stays pending until Play flushes it.
const audio = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = () => 0;
  g.requestIdleCallback = () => 0;
  return { loads: [] as number[], swaps: [] as number[] };
});
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({ play: () => undefined });
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    isLiveAudio: () => false,
    loadAudio: (c: { duration: number }) => {
      audio.loads.push(c.duration);
      return ok();
    },
    loopAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: (c: { duration: number }) => {
      audio.swaps.push(c.duration);
      return ok();
    },
    whenReady: ok,
  };
});

import { generate } from '../../../src/core/generate';
import { newPiece } from '../../../src/core/defaults';
import { loadPiece, play, recompileNow, setPiece, usePlayer } from '../../../src/app/store';

describe('a load still waiting for idle', () => {
  it('carries the latest edit, so Play never loads the old score over it', () => {
    const first = newPiece({ seed: 5, poolSize: 3 });
    loadPiece(first);
    const loaded = usePlayer.getState().compiled.duration;
    const longer = generate(5);
    setPiece(longer, { now: true });
    recompileNow();
    const latest = usePlayer.getState().compiled.duration;
    expect(latest).toBeGreaterThan(loaded);
    play();
    expect(audio.swaps).toEqual([]);
    expect(audio.loads).toEqual([latest]);
  });
});
