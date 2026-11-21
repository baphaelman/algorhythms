import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = {
    title: '',
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
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
import type { MomentId } from '../../../src/core/types';
import { addMoment, pasteClipAt } from '../../../src/app/editor/actions';
import { clipOf } from '../../../src/app/editor/clipboard';
import { useEditor } from '../../../src/app/editor/history';
import { addTime, playheadEffect } from '../../../src/app/editor/palette-effects';
import { PIECE_KEY_ID, takePieceKeyFocus } from '../../../src/app/editor/piece-key';
import { addAtPlayhead } from '../../../src/app/editor/shortcuts';
import {
  addSuggestion,
  refreshSuggestions,
  useSuggestions,
} from '../../../src/app/editor/suggestions';
import { newPieceNow } from '../../../src/app/persist';
import { previewState, startPreview, stopPreview } from '../../../src/app/preview';
import { loadPiece, seekTo, usePlayer } from '../../../src/app/store';

const piece = () => usePlayer.getState().piece;
const atOf = (id: MomentId) => piece().moments.find((m) => m.id === id)?.at;

/** The ways of adding a moment at `t` (the playhead, a drop time). */
const PATHS: [string, (t: number) => MomentId][] = [
  ['palette click / key (Add at playhead)', () => addAtPlayhead('chord')],
  ['palette drop on the score or lane', (t) => addMoment('unison', t)],
  [
    'Next',
    () => {
      refreshSuggestions(true);
      return addSuggestion(useSuggestions.getState().items[0]);
    },
  ],
];

describe('the first moment goes at 0:00 (owner 2026-11-21)', () => {
  beforeEach(() => {
    loadPiece(newPiece({ seed: 5 }), { source: 'new' });
    seekTo(5);
  });

  for (const [name, add] of PATHS) {
    it(`${name}: first at 0 whatever the playhead, the second where asked`, () => {
      expect(atOf(add(5))).toBe(0);
      seekTo(5);
      const second = add(5);
      if (name === 'Next') expect(atOf(second)).toBeGreaterThan(0);
      else expect(atOf(second)).toBeCloseTo(5);
    });
  }

  it('paste: the first paste lands at 0, the next at the playhead', () => {
    const a = addMoment('chord', 0);
    const clip = clipOf(piece(), [a])!;
    loadPiece(newPiece({ seed: 5 }));
    const [first] = pasteClipAt(clip, 5)!;
    expect(atOf(first)).toBe(0);
    const [second] = pasteClipAt(clip, 5)!;
    expect(atOf(second)).toBe(5);
  });

  it('the palette checks and previews 0:00 until the first moment', () => {
    expect(addTime()).toBe(0);
    expect(playheadEffect('chord').effect).toBe(true);
    expect(startPreview('chord', 5)).toBe(true);
    expect(previewState.from).toBe(0);
    stopPreview();
    addAtPlayhead('chord');
    seekTo(5);
    expect(addTime()).toBe(5);
  });

  it('a key added first is the piece key at 0:00', () => {
    expect(addMoment('key', 5)).toBe(PIECE_KEY_ID);
    expect(piece().moments).toEqual([]);
  });

  it('a first chord fills to the tonic triad', () => {
    addAtPlayhead('chord');
    const score = usePlayer.getState().compiled;
    expect(score.voices.filter((v) => v.lives.length > 0)).toHaveLength(3);
  });
});

describe('New > Empty', () => {
  it('opens with the piece key selected and its Tonic asked for', () => {
    loadPiece(newPiece({ seed: 1 }));
    addMoment('chord', 0);
    newPieceNow();
    expect(piece().moments).toEqual([]);
    expect(useEditor.getState().selection).toEqual([PIECE_KEY_ID]);
    expect(takePieceKeyFocus()).toBe(true);
    expect(takePieceKeyFocus()).toBe(false);
  });
});
