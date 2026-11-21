/** Key changes carry forward (PLAN.md §6.2 `key`, owner 2026-11-21): the prompt and `amend`. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { Moment, Piece } from '../../../src/core/types';
import { addMoment, updateMoment } from '../../../src/app/editor/actions';
import { amend, edit, lastEntry, select, undo, useEditor } from '../../../src/app/editor/history';
import {
  keepKeyCarry,
  moveKeyCarry,
  offerKeyCarry,
  useKeyCarry,
} from '../../../src/app/editor/key-carry';
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
    {
      id: 'nam001',
      type: 'chord',
      at: 12,
      notes: { kind: 'chord', symbol: 'F' },
      voicing: 'even',
      assign: 'ordered',
    },
  ] as Moment[];
  return p;
}

const piece = () => usePlayer.getState().piece;
const byId = (id: string) => piece().moments.find((m) => m.id === id)!;

beforeEach(() => {
  loadPiece(base());
  keepKeyCarry();
});

describe('amend', () => {
  it('joins the newest entry, so one undo reverts both', () => {
    const p0 = piece();
    edit((p) => ({ ...p, seed: 9 }), 'A');
    const e = lastEntry();
    expect(amend(e, (p) => ({ ...p, seed: 10 }))).toBe(true);
    expect(useEditor.getState().undoLabel).toBe('A');
    undo();
    expect(piece()).toBe(p0);
  });

  it('is its own entry when the entry is no longer the newest', () => {
    edit((p) => ({ ...p, seed: 9 }), 'A');
    const e = lastEntry();
    edit((p) => ({ ...p, seed: 11 }), 'B');
    amend(e, (p) => ({ ...p, seed: 12 }), 'C');
    expect(useEditor.getState().undoLabel).toBe('C');
    undo();
    expect(piece().seed).toBe(11);
  });
});

describe('key carry prompt', () => {
  it('asks after a key is added, moves fixed notes in one undo with it', () => {
    const before = piece();
    const id = addMoment('key', 2); // default: a fifth up, G major
    const k = byId(id);
    expect(k.type === 'key' && k.key).toEqual({ tonic: 'G', scale: 'major' });
    const pr = useKeyCarry.getState().prompt!;
    expect(pr.ids).toEqual(['pit001', 'nam001']);
    expect(pr.until).toBeNull();
    expect(moveKeyCarry()).toBe(true);
    expect(useKeyCarry.getState().prompt).toBeNull();
    // G is a fourth down (the shorter way).
    expect(byId('pit001')).toMatchObject({ notes: { pitches: [43, 50, 55, 59] } });
    expect(byId('nam001')).toMatchObject({ notes: { symbol: 'C' } });
    expect(byId('deg001')).toBe(before.moments[1]);
    undo();
    expect(piece()).toBe(before);
  });

  it('turns a named chord into the pitches it voices when the scale changes', () => {
    const id = addMoment('key', 2);
    keepKeyCarry();
    expect(useKeyCarry.getState().prompt).toBeNull();
    const old = byId(id);
    updateMoment(id, { key: { tonic: 'G', scale: 'minor' } });
    offerKeyCarry(id, old.type === 'key' ? old.key : piece().key);
    moveKeyCarry();
    const nam = byId('nam001');
    expect(nam.type === 'chord' && nam.notes.kind).toBe('pitches');
  });

  it('keeps the original key while unanswered, and closes on selection change or undo', () => {
    const id = addMoment('key', 2);
    const k0 = byId(id);
    updateMoment(id, { key: { tonic: 'A', scale: 'major' } });
    offerKeyCarry(id, k0.type === 'key' ? k0.key : piece().key);
    expect(useKeyCarry.getState().prompt?.from).toEqual({ tonic: 'C', scale: 'major' });
    select([]);
    expect(useKeyCarry.getState().prompt).toBeNull();

    select([id]);
    updateMoment(id, { key: { tonic: 'D', scale: 'major' } });
    offerKeyCarry(id, { tonic: 'A', scale: 'major' });
    expect(useKeyCarry.getState().prompt).not.toBeNull();
    undo();
    expect(useKeyCarry.getState().prompt).toBeNull();
  });

  it('does not ask when the span has no fixed notes', () => {
    loadPiece({ ...base(), moments: base().moments.slice(0, 2) });
    addMoment('key', 2);
    expect(useKeyCarry.getState().prompt).toBeNull();
  });
});
