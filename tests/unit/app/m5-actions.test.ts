/** M5 editor actions (PLAN.md §11.3): piano keys, Freeze, cut and paste, each one undo entry. */
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
// Nothing sounds in unit tests.
vi.mock('../../../src/app/audition', () => ({
  auditionAfterEdit: () => undefined,
  auditionPointsAfterEdit: () => undefined,
  auditionStepAfterEdit: () => undefined,
}));

import {
  clipOfSelection,
  cutMoments,
  freezeMoments,
  pasteClipAt,
  pianoKeyEdit,
} from '../../../src/app/editor/actions';
import { redo, select, undo, useEditor } from '../../../src/app/editor/history';
import { clipboardKey } from '../../../src/app/clipboard';
import { loadPiece, usePlayer } from '../../../src/app/store';
import { compile } from '../../../src/core/compiler/compile';
import type { ChordMoment, Moment, Piece, PinMoment } from '../../../src/core/types';
import { chordAt, piece as fixture } from '../core/compiler-fixtures';

const piece = (): Piece => usePlayer.getState().piece;
const byId = (id: string): Moment => piece().moments.find((m) => m.id === id)!;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const label = () => useEditor.getState().undoLabel;

function open(): void {
  const p = fixture({
    pool: 5,
    start: [48, 55, 60, 64],
    glide: { length: 1, jitter: 0, stagger: 0 },
    moments: [
      {
        id: 'ch',
        type: 'chord',
        at: 2,
        notes: { kind: 'chord', symbol: 'F' },
        voicing: 'nearest',
        assign: 'ordered',
      },
      { id: 'pn', type: 'pin', at: 5, voice: 'v1', pitch: 62 },
      { id: 'sp', type: 'split', at: 8, count: 5, voicing: 'even' },
    ] as Moment[],
  });
  loadPiece(p);
}

beforeEach(open);

describe('piano keys', () => {
  it('adds and removes chord notes (freezing; the count follows), one undo entry each', () => {
    const before = piece();
    const was = sorted(chordAt(compile(before), 4));
    expect(was).toHaveLength(4);
    const add = was.at(-1)! + 5;
    expect(pianoKeyEdit('ch', add)).toEqual({ kind: 'added', pitch: add });
    expect(label()).toBe('Freeze chord and add note');
    const m = byId('ch') as ChordMoment;
    expect(m.frozenFrom).toBeDefined();
    expect(m.count).toBe(5);
    expect(sorted(chordAt(usePlayer.getState().compiled, 4))).toEqual(sorted([...was, add]));
    // A full pool refuses another note; the last note can't go either.
    expect(pianoKeyEdit('ch', add + 2)).toEqual({ kind: 'refused', reason: 'pool-full' });
    expect(pianoKeyEdit('ch', was[0])).toEqual({ kind: 'removed', pitch: was[0] });
    expect(label()).toBe('Remove chord note');
    expect((byId('ch') as ChordMoment).count).toBe(4);
    undo();
    undo();
    expect(piece()).toBe(before);
  });

  it('moves a pin; other moments are left alone', () => {
    expect(pianoKeyEdit('pn', 67)).toEqual({ kind: 'pin', pitch: 67 });
    expect((byId('pn') as PinMoment).pitch).toBe(67);
    expect(label()).toBe('Move pin');
    expect(pianoKeyEdit('sp', 60)).toEqual({ kind: 'none' });
  });
});

describe('Freeze', () => {
  it('freezes the selection in one undo entry', () => {
    const before = piece();
    expect(freezeMoments(['ch', 'pn', 'sp'])).toBe(true);
    expect(label()).toBe('Freeze moments');
    expect((byId('ch') as ChordMoment).frozenFrom).toBeDefined();
    expect(byId('sp').type === 'split' && byId('sp')).toMatchObject({
      notes: { kind: 'pitches' },
    });
    expect(byId('pn')).toEqual(before.moments.find((m) => m.id === 'pn'));
    // Nothing left to freeze: no entry.
    expect(freezeMoments(['ch', 'sp'])).toBe(false);
    undo();
    expect(piece()).toBe(before);
  });
});

describe('copy, cut and paste', () => {
  it('cuts and pastes at a time as single undo entries, selecting the copies', () => {
    select(['pn', 'sp']);
    const clip = clipOfSelection()!;
    expect(clip.moments.map((m) => m.id)).toEqual(['pn', 'sp']);
    const before = piece();
    expect(cutMoments(['pn', 'sp'])).toBe(true);
    expect(label()).toBe('Cut moments');
    expect(piece().moments.some((m) => m.id === 'pn' || m.id === 'sp')).toBe(false);
    const ids = pasteClipAt(clip, 10.3)!;
    expect(label()).toBe('Paste moments');
    expect(useEditor.getState().selection).toEqual(ids);
    expect(ids.map((id) => byId(id).at)).toEqual([10.3, 13.3]);
    undo();
    undo();
    expect(piece()).toBe(before);
    redo();
    redo();
    expect(piece().moments).toHaveLength(before.moments.length);
  });

  it('snaps the paste to a beat when Snap to beats is on', () => {
    const p = piece();
    loadPiece({ ...p, view: { ...p.view, gridBpm: 120 } });
    select(['ch']);
    const clip = clipOfSelection()!;
    const [id] = pasteClipAt(clip, 6.2)!;
    expect(byId(id).at).toBe(6);
    const q = piece();
    loadPiece({ ...q, view: { ...q.view, snapBeats: false } });
    const [id2] = pasteClipAt(clip, 6.2)!;
    expect(byId(id2).at).toBe(6.2);
  });

  it('maps the shortcuts', () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
      clipboardKey({
        key,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...mods,
      });
    expect(k('c', { metaKey: true })).toBe('copy');
    expect(k('X', { ctrlKey: true })).toBe('cut');
    expect(k('v', { metaKey: true })).toBe('paste');
    expect(k('a', { ctrlKey: true })).toBe('all');
    expect(k('c')).toBeNull();
    expect(k('c', { metaKey: true, shiftKey: true })).toBeNull();
    expect(k('v', { metaKey: true, altKey: true })).toBeNull();
  });
});
