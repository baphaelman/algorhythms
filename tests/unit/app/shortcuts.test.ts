import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  // Recompile synchronously so `compiled` follows every edit at once.
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
import { useEditor } from '../../../src/app/editor/history';
import {
  PALETTE,
  addAtPlayhead,
  clearSelection,
  deleteSelection,
  editorKey,
  momentTypeForKey,
  snapToGrid,
  takesText,
} from '../../../src/app/editor/shortcuts';
import { loadPiece, seekTo, usePlayer } from '../../../src/app/store';
import {
  playheadEffect,
  refreshPaletteEffects,
  usePaletteEffects,
} from '../../../src/app/editor/palette-effects';

const key = (k: string, mods: Record<string, unknown> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('key mapping', () => {
  it('maps the ten letters of §11.3', () => {
    const expected = {
      c: 'chord',
      u: 'unison',
      s: 'split',
      m: 'merge',
      t: 'shift',
      p: 'spread',
      w: 'walk',
      i: 'pin',
      k: 'key',
      l: 'level',
    };
    for (const [k, type] of Object.entries(expected)) {
      expect(momentTypeForKey(key(k))).toBe(type);
      expect(editorKey(key(k))).toEqual({ kind: 'add', type });
    }
    expect(PALETTE).toHaveLength(11);
    const keyed = PALETTE.filter((e) => e.key);
    expect(keyed).toHaveLength(10);
    expect(new Set(keyed.map((e) => e.key)).size).toBe(10);
    // The palette's note point has no letter: N + click adds one on a line (§11.3).
    expect(PALETTE.find((e) => e.type === 'note')?.key).toBeUndefined();
    expect(momentTypeForKey(key('n'))).toBeNull();
    expect(momentTypeForKey(key('x'))).toBeNull();
  });

  it('ignores modified, shifted and repeated letters', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'repeat']) {
      expect(editorKey(key('c', { [mod]: true }))).toBeNull();
    }
    expect(editorKey(key('C', { shiftKey: true }))).toBeNull();
  });

  it('maps Delete, Backspace and Escape, not with ⌘/Ctrl/Alt', () => {
    expect(editorKey(key('Delete'))).toEqual({ kind: 'delete' });
    expect(editorKey(key('Backspace'))).toEqual({ kind: 'delete' });
    expect(editorKey(key('Escape'))).toEqual({ kind: 'escape' });
    expect(editorKey(key('Backspace', { metaKey: true }))).toBeNull();
    expect(editorKey(key('Escape', { ctrlKey: true }))).toBeNull();
  });

  it('maps \\ to the loop toggle, not with ⌘/Ctrl/Alt', () => {
    expect(editorKey(key('\\'))).toEqual({ kind: 'loop' });
    expect(editorKey(key('\\', { metaKey: true }))).toBeNull();
    expect(editorKey({ ...key('\\'), target: { tagName: 'INPUT', type: 'text' } })).toBeNull();
  });

  it('leaves text fields alone, not buttons or sliders', () => {
    const text = [
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ];
    for (const target of text) {
      expect(takesText(target)).toBe(true);
      expect(editorKey(key('c', { target }))).toBeNull();
      expect(editorKey(key('Backspace', { target }))).toBeNull();
    }
    for (const target of [{ tagName: 'BUTTON' }, { tagName: 'INPUT', type: 'range' }, null]) {
      expect(takesText(target)).toBe(false);
      expect(editorKey(key('c', { target }))).toEqual({ kind: 'add', type: 'chord' });
    }
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest beat, or leaves time alone with no grid', () => {
    expect(snapToGrid(1.3)).toBe(1.3);
    expect(snapToGrid(1.3, 120)).toBe(1.5);
    expect(snapToGrid(1.2, 120)).toBe(1);
    expect(snapToGrid(-2, 120)).toBe(0);
    expect(snapToGrid(1.3, 0)).toBe(1.3);
  });
});

describe('actions at the playhead', () => {
  beforeEach(() => {
    loadPiece(newPiece({ seed: 7 }));
  });

  it('adds exactly at the playhead, also when the piece has a grid (revision 7)', () => {
    seekTo(3.3);
    const a = addAtPlayhead('chord');
    const p = usePlayer.getState().piece;
    expect(p.moments.find((m) => m.id === a)?.at).toBeCloseTo(3.3);
    expect(useEditor.getState().selection).toEqual([a]);

    loadPiece({ ...p, moments: [], view: { ...p.view, gridBpm: 60 } });
    seekTo(3.3);
    const b = addAtPlayhead('level');
    const m = usePlayer.getState().piece.moments.find((x) => x.id === b);
    expect(m).toMatchObject({ type: 'level', at: 3.3 });
  });

  it('deletes and clears the selection', () => {
    expect(deleteSelection()).toBe(false);
    expect(clearSelection()).toBe(false);
    addAtPlayhead('walk');
    expect(clearSelection()).toBe(true);
    expect(useEditor.getState().selection).toEqual([]);
    addAtPlayhead('pin');
    expect(deleteSelection()).toBe(true);
    expect(usePlayer.getState().piece.moments).toHaveLength(1);
  });
});

describe('palette effects at the playhead (revision 6)', () => {
  beforeEach(() => {
    loadPiece(newPiece({ seed: 7 }));
  });

  it('greys merge out on a unison, with a reason; chord stays enabled', () => {
    seekTo(0.5);
    addAtPlayhead('split');
    seekTo(1);
    addAtPlayhead('unison');
    seekTo(8);
    const merge = playheadEffect('merge');
    expect(merge.effect).toBe(false);
    // The unison made one line, and merge counts lines (owner, 2026-11-21).
    expect(merge.reason).toBe('only one note is sounding');
    expect(playheadEffect('chord').effect).toBe(true);
    refreshPaletteEffects(true);
    const s = usePaletteEffects.getState();
    expect(s.t).toBeCloseTo(8);
    expect(s.effects?.merge.effect).toBe(false);
    expect(s.effects?.chord.effect).toBe(true);
  });
});
