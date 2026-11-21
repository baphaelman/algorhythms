/** The piece key as a fixed key moment at 0:00 (M4.5-39): guards, editing, the load rule. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { compile } from '../../../src/core/compiler/compile';
import type { CompiledScore, Moment, Piece } from '../../../src/core/types';
import {
  addMoment,
  deleteMoments,
  duplicateMoments,
  moveMoments,
  setPieceKey,
} from '../../../src/app/editor/actions';
import { select, undo, useEditor } from '../../../src/app/editor/history';
import { keepKeyCarry, moveKeyCarry, useKeyCarry } from '../../../src/app/editor/key-carry';
import { copyMoments, moveMomentsBy, removeMoments } from '../../../src/app/editor/ops';
import {
  PIECE_KEY_ID,
  foldOpeningKeys,
  withPieceKeyMoment,
  withoutPieceKeyMoment,
} from '../../../src/app/editor/piece-key';
import { loadPiece, usePlayer } from '../../../src/app/store';
import { withStart } from '../core/compiler-fixtures';

function base(): Piece {
  const p = newPiece({ seed: 5, poolSize: 4 });
  for (const v of p.voices) v.range = [36, 96];
  p.key = { tonic: 'C', scale: 'major' };
  p.moments = [
    ...withStart(p, [48, 55, 60, 64], []),
    {
      id: 'deg001',
      type: 'chord',
      at: 4,
      notes: { kind: 'degrees', degrees: [0, 2, 4, 6] },
      voicing: 'even',
      assign: 'ordered',
    },
    {
      id: 'pit001',
      type: 'chord',
      at: 8,
      notes: { kind: 'pitches', pitches: [48, 55, 60, 64] },
      voicing: 'even',
      assign: 'ordered',
    },
    { id: 'key001', type: 'key', at: 10, key: { tonic: 'A', scale: 'minor' } },
    {
      id: 'pit002',
      type: 'chord',
      at: 12,
      notes: { kind: 'pitches', pitches: [45, 52, 57, 60] },
      voicing: 'even',
      assign: 'ordered',
    },
  ] as Moment[];
  return p;
}

const piece = () => usePlayer.getState().piece;
const byId = (id: string) => piece().moments.find((m) => m.id === id)!;
const pitchesOf = (id: string) => {
  const m = byId(id);
  return m.type === 'chord' && m.notes.kind === 'pitches' ? m.notes.pitches : null;
};
const degLabel = (s: CompiledScore) => s.harmony?.find((h) => h.momentId === 'deg001')?.label;

beforeEach(() => {
  loadPiece(base());
  keepKeyCarry();
});

describe('piece key guards', () => {
  it('can be selected, alone or with moments', () => {
    select([PIECE_KEY_ID]);
    expect(useEditor.getState().selection).toEqual([PIECE_KEY_ID]);
    select([PIECE_KEY_ID, 'deg001']);
    expect(useEditor.getState().selection).toEqual([PIECE_KEY_ID, 'deg001']);
  });

  it('is never deleted, moved or copied', () => {
    const p0 = piece();
    expect(deleteMoments([PIECE_KEY_ID])).toBe(false);
    expect(moveMoments([PIECE_KEY_ID], 2)).toBe(false);
    expect(duplicateMoments([PIECE_KEY_ID], 2)).toEqual([]);
    expect(piece()).toBe(p0);
    expect(useEditor.getState().canUndo).toBe(false);
    // The pure recipes (lane drags, Alt-drag copies) leave it alone too.
    expect(removeMoments(p0, [PIECE_KEY_ID])).toBe(p0);
    expect(moveMomentsBy(p0, [PIECE_KEY_ID], 3)).toBe(p0);
    expect(copyMoments(p0, [PIECE_KEY_ID], 3).ids).toEqual([]);
  });

  it('in a group, only the other moments are deleted or moved', () => {
    expect(deleteMoments([PIECE_KEY_ID, 'pit001'])).toBe(true);
    expect(piece().moments.some((m) => m.id === 'pit001')).toBe(false);
    expect(piece().key).toEqual({ tonic: 'C', scale: 'major' });
    expect(moveMoments([PIECE_KEY_ID, 'deg001'], 1)).toBe(true);
    expect(byId('deg001').at).toBe(5);
  });

  it('adding a key at 0 selects the piece key instead', () => {
    const n = piece().moments.length;
    expect(addMoment('key', 0)).toBe(PIECE_KEY_ID);
    expect(addMoment('key', -1)).toBe(PIECE_KEY_ID);
    expect(piece().moments).toHaveLength(n);
    expect(useEditor.getState().selection).toEqual([PIECE_KEY_ID]);
    expect(addMoment('key', 2)).not.toBe(PIECE_KEY_ID);
    expect(piece().moments).toHaveLength(n + 1);
  });
});

describe('editing the piece key', () => {
  it('writes piece.key as one undo entry; degree chords follow', () => {
    const p0 = piece();
    expect(degLabel(usePlayer.getState().compiled)).toMatch(/^C/);
    expect(setPieceKey({ tonic: 'D', scale: 'major' }, 'Change tonic')).toBe(true);
    expect(piece().key).toEqual({ tonic: 'D', scale: 'major' });
    expect(degLabel(compile(piece()))).toMatch(/^D/);
    expect(useEditor.getState().undoLabel).toBe('Change tonic');
    expect(setPieceKey({ tonic: 'D', scale: 'major' })).toBe(false);
    undo();
    expect(piece()).toBe(p0);
  });

  it('offers to carry fixed notes up to the first key change; Move joins the undo entry', () => {
    const p0 = piece();
    setPieceKey({ tonic: 'D', scale: 'major' }, 'Change tonic');
    const prompt = useKeyCarry.getState().prompt;
    expect(prompt?.keyId).toBe(PIECE_KEY_ID);
    expect(prompt?.from).toEqual({ tonic: 'C', scale: 'major' });
    expect(prompt?.until).toBe(10);
    // pit001 holds fixed notes in the span; pit002 is after the key change.
    expect(prompt?.ids).toContain('pit001');
    expect(prompt?.ids).not.toContain('pit002');
    expect(moveKeyCarry()).toBe(true);
    expect(pitchesOf('pit001')).toEqual([50, 57, 62, 66]);
    expect(pitchesOf('pit002')).toEqual([45, 52, 57, 60]);
    expect(piece().moments.some((m) => m.id === PIECE_KEY_ID)).toBe(false);
    expect(piece().key).toEqual({ tonic: 'D', scale: 'major' });
    expect(useEditor.getState().undoLabel).toBe('Change tonic');
    undo();
    expect(piece()).toBe(p0);
  });

  it('the span helpers see the piece key as a key moment first in compile order', () => {
    const p = piece();
    const aug = withPieceKeyMoment(p);
    expect(aug.moments[0]).toMatchObject({ id: PIECE_KEY_ID, type: 'key', at: 0, key: p.key });
    const shape = (s: CompiledScore) => s.voices.map((v) => v.segments.map((x) => [x.t0, x.p1]));
    expect(shape(compile(aug))).toEqual(shape(compile(p)));
    expect(withoutPieceKeyMoment(aug)).toEqual(p);
  });
});

describe('the load rule', () => {
  const key0 = (id: string, tonic: string, muted = false): Moment =>
    ({
      id,
      type: 'key',
      at: 0,
      key: { tonic, scale: 'major' },
      ...(muted ? { muted } : {}),
    }) as Moment;

  it('folds opening key moments at 0 into piece.key, the last one winning', () => {
    const p = base();
    p.moments = [key0('k0a', 'E'), key0('k0b', 'G'), ...p.moments];
    const f = foldOpeningKeys(p);
    expect(f.key).toEqual({ tonic: 'G', scale: 'major' });
    expect(f.moments.map((m) => m.id)).toEqual(base().moments.map((m) => m.id));
    loadPiece(p);
    expect(piece().key).toEqual({ tonic: 'G', scale: 'major' });
    expect(piece().moments.some((m) => m.type === 'key' && m.at === 0)).toBe(false);
  });

  it('keeps a key at 0 that another moment at 0 runs before, and muted ones', () => {
    const p = base();
    p.moments = [key0('k0m', 'E', true), ...p.moments, key0('k0z', 'G')];
    expect(foldOpeningKeys(p)).toBe(p);
  });

  it('is exact: the folded piece compiles the same', () => {
    const p = base();
    p.moments = [key0('k0a', 'E'), ...p.moments];
    const shape = (s: CompiledScore) => s.voices.map((v) => v.segments.map((x) => [x.t0, x.p1]));
    const a = compile(p);
    const b = compile(foldOpeningKeys(p));
    expect(shape(b)).toEqual(shape(a));
    expect(b.harmony?.map((h) => h.label)).toEqual(a.harmony?.map((h) => h.label));
  });
});
