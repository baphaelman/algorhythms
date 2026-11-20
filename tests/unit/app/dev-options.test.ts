/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile as realCompile, type CompileOptions } from '../../../src/core/compiler/compile';
import type { Piece } from '../../../src/core/types';

// Spy on the compiler and stub the audio engine, so the store can run in Node.
vi.mock('../../../src/core/compiler/compile', async (orig) => {
  const mod = await orig<typeof import('../../../src/core/compiler/compile')>();
  return { ...mod, compile: vi.fn((p: Piece, o?: CompileOptions) => mod.compile(p, o)) };
});
vi.mock('../../../src/app/audio', () => ({
  configureAudio: vi.fn(),
  getEngine: () => null,
  loadAudio: vi.fn(async () => undefined),
  mixAudio: vi.fn(async () => undefined),
  primeAudio: vi.fn(async () => undefined),
  resumeAudio: vi.fn(),
  swapAudio: vi.fn(async () => undefined),
  whenReady: vi.fn(async () => null),
}));

import { compileOptions, devEnabled, setAllowCrossings } from '../../../src/app/dev-options';
import { recompileNow, usePlayer } from '../../../src/app/store';
import { generate } from '../../../src/core/generate';

const spy = vi.mocked(realCompile);

beforeEach(() => {
  spy.mockClear();
});
afterEach(() => setAllowCrossings(false));

describe('devEnabled', () => {
  it('is on only when the URL has a dev parameter', () => {
    expect(devEnabled('')).toBe(false);
    expect(devEnabled('?debug=1')).toBe(false);
    expect(devEnabled('?dev')).toBe(true);
    expect(devEnabled('?x=1&dev=1')).toBe(true);
  });
});

describe('compile options', () => {
  it('are empty until the switch is on', () => {
    expect(compileOptions()).toEqual({});
    setAllowCrossings(true);
    expect(compileOptions()).toEqual({ crossings: 'allow' });
    setAllowCrossings(false);
    expect(compileOptions()).toEqual({});
  });

  it('reach the compiler through recompileNow, and never enter the piece', () => {
    usePlayer.setState({ piece: generate(2, { mode: 'dorian', voices: 3 }) });
    const before = JSON.stringify(usePlayer.getState().piece);

    recompileNow();
    expect(spy).toHaveBeenLastCalledWith(usePlayer.getState().piece, {});

    setAllowCrossings(true);
    recompileNow();
    expect(spy).toHaveBeenLastCalledWith(usePlayer.getState().piece, { crossings: 'allow' });

    expect(JSON.stringify(usePlayer.getState().piece)).toBe(before);
    expect(before).not.toContain('crossings');
  });
});
