import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
});
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
  };
});

import { newPiece } from '../../../src/core/defaults';
import { edit, undo, useEditor } from '../../../src/app/editor/history';
import { commonTimbre, patchVoice, setAllTimbres } from '../../../src/app/editor/voices';
import { loadPiece, usePlayer } from '../../../src/app/store';

beforeEach(() => {
  loadPiece(newPiece({ seed: 3, poolSize: 5 }));
});

describe('All notes timbre', () => {
  it('sets every voice as one undo entry', () => {
    edit((p) => patchVoice(p, 'v1', { timbre: 'organ' }), 'Note timbre');
    const mixed = usePlayer.getState().piece;
    expect(commonTimbre(mixed.voices)).toBeUndefined();
    edit((p) => setAllTimbres(p, 'reed'), 'All notes timbre');
    const after = usePlayer.getState().piece;
    expect(after.voices.every((v) => v.timbre === 'reed')).toBe(true);
    expect(commonTimbre(after.voices)).toBe('reed');
    expect(useEditor.getState().undoLabel).toBe('All notes timbre');
    expect(undo()).toBe(true);
    expect(usePlayer.getState().piece.voices).toEqual(mixed.voices);
    expect(useEditor.getState().undoLabel).toBe('Note timbre');
  });
});
