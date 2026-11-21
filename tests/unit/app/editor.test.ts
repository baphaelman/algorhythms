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

import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { momentSeed } from '../../../src/core/rng';
import { parsePiece } from '../../../src/core/schema';
import { activeAt, pitchAt } from '../../../src/core/query';
import type { ChordMoment, MomentType, Piece } from '../../../src/core/types';
import {
  addMoment,
  deleteMoments,
  duplicateMoments,
  moveMoments,
  reroll,
  updateMoment,
} from '../../../src/app/editor/actions';
import {
  HISTORY_CAP,
  beginGesture,
  cancelGesture,
  edit,
  endGesture,
  redo,
  select,
  undo,
  updateGesture,
  useEditor,
} from '../../../src/app/editor/history';
import { defaultMoment, withChordFill } from '../../../src/app/editor/new-moment';
import { copyMoments, moveMomentsBy, newMomentIds } from '../../../src/app/editor/ops';
import { loadPiece, usePlayer } from '../../../src/app/store';
import example from '../../../examples/tidewater-hymn.algorhythms.json';

const TYPES: MomentType[] = [
  'chord',
  'unison',
  'split',
  'merge',
  'shift',
  'spread',
  'walk',
  'pin',
  'key',
  'level',
  'pulse',
  'tune',
];

const piece = (): Piece => usePlayer.getState().piece;
const ids = (): string[] => piece().moments.map((m) => m.id);
const ed = () => useEditor.getState();

function examplePiece(): Piece {
  const r = parsePiece(example);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

beforeEach(() => {
  // Without the opening chord, so `moments` holds only what each test adds.
  loadPiece({ ...newPiece({ seed: 7 }), moments: [] });
});

/** Runs `action`, then checks that undo restores the piece before it and redo the piece after. */
function roundTrip(action: () => void): void {
  const before = piece();
  action();
  const after = piece();
  expect(after).not.toBe(before);
  expect(undo()).toBe(true);
  expect(piece()).toBe(before);
  expect(redo()).toBe(true);
  expect(piece()).toBe(after);
}

describe('actions undo and redo', () => {
  it('addMoment', () => {
    roundTrip(() => addMoment('chord', 1));
    expect(piece().moments).toHaveLength(1);
    expect(ed().selection).toEqual(ids());
  });

  it('updateMoment, including removing a field', () => {
    const id = addMoment('level', 2);
    roundTrip(() => updateMoment(id, { gain: 0.25, label: 'fade' }));
    expect(piece().moments[0]).toMatchObject({ gain: 0.25, label: 'fade' });
    roundTrip(() => updateMoment(id, { label: undefined }));
    expect('label' in piece().moments[0]).toBe(false);
    expect(updateMoment(id, { gain: 0.25 })).toBe(false);
    expect(updateMoment('nope00', { gain: 1 })).toBe(false);
  });

  it('moveMoments clamps a group at 0 and moves a walk region', () => {
    const a = addMoment('walk', 4);
    const b = addMoment('chord', 10);
    roundTrip(() => moveMoments([a, b], -6));
    const [w, c] = piece().moments;
    expect(w).toMatchObject({ id: a, at: 0, until: 16 });
    expect(c).toMatchObject({ id: b, at: 6 });
    expect(moveMoments([a], -1)).toBe(false);
  });

  it('keeps moments sorted by at, stably', () => {
    const a = addMoment('chord', 5);
    const b = addMoment('shift', 2);
    const c = addMoment('level', 5);
    expect(ids()).toEqual([b, a, c]);
    moveMoments([b], 3); // ties keep their previous order
    expect(ids()).toEqual([b, a, c]);
    moveMoments([b], 1);
    expect(ids()).toEqual([a, c, b]);
  });

  it('deleteMoments prunes the selection', () => {
    const a = addMoment('chord', 1);
    const b = addMoment('unison', 2);
    select([a, b]);
    roundTrip(() => deleteMoments([a]));
    expect(ids()).toEqual([b]);
    expect(ed().selection).toEqual([b]);
  });

  it('duplicateMoments keeps the effective seed', () => {
    const a = addMoment('walk', 1);
    const b = addMoment('chord', 3);
    updateMoment(b, { seed: 1234 });
    let copies: string[] = [];
    roundTrip(() => {
      copies = duplicateMoments([a, b], 20);
    });
    expect(copies).toHaveLength(2);
    expect(ed().selection).toEqual(copies);
    const byId = new Map(piece().moments.map((m) => [m.id, m]));
    expect(byId.get(copies[0])).toMatchObject({
      type: 'walk',
      at: 21,
      until: 37,
      seed: momentSeed(piece().seed, a),
    });
    expect(byId.get(copies[1])).toMatchObject({ type: 'chord', at: 23, seed: 1234 });
    expect(byId.get(a)!.seed).toBeUndefined();
  });

  it('reroll sets a new explicit seed', () => {
    const a = addMoment('walk', 1);
    let seed: number | null = null;
    roundTrip(() => {
      seed = reroll(a);
    });
    expect(piece().moments[0].seed).toBe(seed);
    expect(reroll('nope00')).toBeNull();
  });

  it('redo is cleared by a new edit; labels follow', () => {
    addMoment('chord', 1);
    expect(ed().undoLabel).toBe('Add chord');
    undo();
    expect(ed()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'Add chord' });
    addMoment('unison', 1);
    expect(ed().canRedo).toBe(false);
    expect(redo()).toBe(false);
  });

  it('undo and redo restore the selection; it never names a missing moment', () => {
    const a = addMoment('chord', 1);
    const b = addMoment('unison', 2);
    select([a, b]);
    deleteMoments([a, b]);
    expect(ed().selection).toEqual([]);
    undo();
    expect(ed().selection).toEqual([a, b]);
    undo(); // the unison add: back to the selection before it
    expect(ed().selection).toEqual([a]);
    redo();
    expect(ed().selection).toEqual([a, b]);
  });
});

describe('history', () => {
  it('a gesture is one entry, applied to the start piece', () => {
    const a = addMoment('chord', 1);
    const start = piece();
    beginGesture('Move moment');
    for (let i = 1; i <= 10; i++) updateGesture((p) => moveMomentsBy(p, [a], i));
    expect(piece().moments[0].at).toBe(11);
    endGesture();
    expect(ed().undoLabel).toBe('Move moment');
    undo();
    expect(piece()).toBe(start);
    undo();
    expect(piece().moments).toHaveLength(0);
    expect(ed().canUndo).toBe(false);
  });

  it('an unchanged gesture records nothing', () => {
    addMoment('chord', 1);
    beginGesture();
    updateGesture((p) => p);
    endGesture();
    undo();
    expect(piece().moments).toHaveLength(0);
  });

  it('cancelGesture restores the start piece; undo during a gesture cancels it', () => {
    const a = addMoment('chord', 1);
    const start = piece();
    beginGesture();
    updateGesture((p) => moveMomentsBy(p, [a], 5));
    cancelGesture();
    expect(piece()).toBe(start);
    beginGesture();
    updateGesture((p) => moveMomentsBy(p, [a], 5));
    undo();
    expect(piece()).toBe(start);
    expect(ed().undoLabel).toBe('Add chord');
  });

  it('an Alt-drag duplicate reuses its ids on every frame', () => {
    const a = addMoment('walk', 1);
    const fresh = newMomentIds(piece(), 1);
    beginGesture('Duplicate moment');
    for (let i = 1; i <= 3; i++) updateGesture((p) => copyMoments(p, [a], i, fresh).piece);
    endGesture();
    expect(ids()).toEqual([a, fresh[0]]);
    expect(piece().moments[1].at).toBe(4);
  });

  it(`is capped at ${HISTORY_CAP} entries`, () => {
    const a = addMoment('chord', 0);
    for (let i = 0; i < HISTORY_CAP + 20; i++) moveMoments([a], 1);
    let n = 0;
    while (undo()) n++;
    expect(n).toBe(HISTORY_CAP);
    expect(piece().moments[0].at).toBe(20);
  });

  it('loadPiece clears history and selection', () => {
    const a = addMoment('chord', 1);
    select([a]);
    loadPiece(newPiece({ seed: 8 }));
    expect(ed()).toMatchObject({ canUndo: false, canRedo: false, selection: [] });
    expect(undo()).toBe(false);
  });

  it('a no-op edit records nothing', () => {
    expect(edit((p) => p)).toBe(false);
    expect(ed().canUndo).toBe(false);
  });
});

describe('ids', () => {
  it('are 6 base62 characters, unique even when the generator repeats', () => {
    let k = 0;
    const seq = [5, 5, 5, 9, 9, 11];
    const p = newPiece({ seed: 1 });
    const fresh = newMomentIds(p, 3, () => seq[k++]);
    expect(new Set(fresh).size).toBe(3);
    for (const id of fresh) expect(id).toMatch(/^[0-9A-Za-z]{6}$/);
    const withOne = { ...p, moments: [{ id: fresh[0], type: 'level', at: 0, gain: 1, over: 1 }] };
    k = 0;
    expect(newMomentIds(withOne as Piece, 1, () => seq[k++])).not.toContain(fresh[0]);
  });

  it('stay unique across many adds', () => {
    for (let i = 0; i < 50; i++) addMoment('level', i);
    expect(new Set(ids()).size).toBe(50);
  });
});

describe('default moments', () => {
  const pieces: [string, () => Piece][] = [
    ['the empty piece', () => newPiece({ seed: 3 })],
    ['an example', examplePiece],
  ];
  for (const [name, make] of pieces) {
    for (const type of TYPES) {
      it(`${type} compiles without errors on ${name}`, () => {
        const p = make();
        const at = p.moments.length > 0 ? 30 : 2;
        const m = defaultMoment(type, at, 'zzzzzz', p, compile(p));
        const r = parsePiece({ ...p, moments: [...p.moments, m] });
        expect(r.ok).toBe(true);
        const score = compile({ ...p, moments: [...p.moments, m] });
        const errors = score.diagnostics.filter((d) => d.level === 'error');
        expect(errors).toEqual([]);
      });
    }
  }

  it('a new tune walks up and back down the scale from the lowest note, a beat a note', () => {
    const p = examplePiece();
    const s = compile(p);
    const m = defaultMoment('tune', 30, 'zzzzzz', p, s);
    expect(m.notes).toHaveLength(4);
    const bpm = p.view?.gridBpm;
    const len = typeof bpm === 'number' && bpm > 0 ? 60 / bpm : 0.5;
    for (const n of m.notes) expect(n.len).toBeCloseTo(len, 12);
    const ps = m.notes.map((n) => n.pitch);
    expect(ps[1]).toBeGreaterThan(ps[0]);
    expect(ps[2]).toBeGreaterThan(ps[1]);
    expect(ps[3]).toBe(ps[1]);
  });

  it('a chord on the empty piece moves the voice', () => {
    const p = newPiece({ seed: 3 });
    const m = defaultMoment('chord', 1, 'zzzzzz', p, compile(p));
    const score = compile({ ...p, moments: [...p.moments, m] });
    expect(score.voices[0].segments.some((s) => s.p0 !== s.p1)).toBe(true);
  });

  it('a chord on a silent piece brings its notes in, with no glide (M4.5-27)', () => {
    const p = { ...newPiece({ seed: 3 }), moments: [] };
    const m = defaultMoment('chord', 1, 'zzzzzz', p, compile(p));
    const score = compile({ ...p, moments: [m] });
    const sounding = score.voices.filter((v) => v.lives.length > 0);
    expect(sounding).toHaveLength(3); // the tonic triad
    for (const v of sounding) {
      expect(v.lives[0]).toMatchObject({ born: 1, fadeIn: 0 });
      expect(v.segments.every((s) => s.p0 === s.p1)).toBe(true);
    }
  });

  it('a chord on the one-note opening brings in its extra notes: count 3, three lines', () => {
    const p = newPiece({ seed: 3 });
    const m = defaultMoment('chord', 5, 'zzzzzz', p, compile(p));
    expect(m.count).toBe(3);
    const score = compile({ ...p, moments: [...p.moments, m] });
    expect(activeAt(score, 10)).toHaveLength(3);
    expect(new Set(activeAt(score, 10).map((i) => pitchAt(score.voices[i], 10))).size).toBe(3);
    expect(score.diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
  });

  it('a chord where at least as many lines sound keeps the line count (no count)', () => {
    const p = examplePiece();
    const s = compile(p);
    const at = 30;
    expect(activeAt(s, at).length).toBeGreaterThanOrEqual(3);
    expect(defaultMoment('chord', at, 'zzzzzz', p, s).count).toBeUndefined();
  });

  it('withChordFill: only chords without count or voice target; at most the pool', () => {
    const p = newPiece({ seed: 3 });
    const s = compile(p);
    const seventh: ChordMoment = {
      id: 'zzzzzz',
      type: 'chord',
      at: 5,
      notes: { kind: 'degrees', degrees: [0, 2, 4, 6] },
      voicing: 'even',
      assign: 'ordered',
    };
    expect(withChordFill(seventh, p, s, 5).count).toBe(4);
    expect(withChordFill({ ...seventh, count: 2 }, p, s, 5).count).toBe(2);
    const listed = { ...seventh, target: { voices: ['v1'] } };
    expect(withChordFill(listed, p, s, 5)).toBe(listed);
    const small = { ...p, voices: p.voices.slice(0, 2) };
    expect(withChordFill(seventh, small, compile(small), 5).count).toBe(2);
    const current: ChordMoment = { ...seventh, notes: { kind: 'current' } };
    expect(withChordFill(current, p, s, 5)).toBe(current);
    const unison = defaultMoment('unison', 5, 'zzzzzz', p, s);
    expect(withChordFill(unison, p, s, 5)).toBe(unison);
    // From silence the chord establishes one voice per note itself.
    const silent = { ...p, moments: [] };
    expect(withChordFill(seventh, silent, compile(silent), 5)).toBe(seventh);
  });
});
