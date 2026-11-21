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
import type { Moment, Piece } from '../../../src/core/types';
import { edit, undo, useEditor } from '../../../src/app/editor/history';
import {
  assignPart,
  common,
  deletePart,
  freePartName,
  hasParts,
  partNames,
  patchPart,
  renameError,
  renamePart,
  setPartRangeBound,
} from '../../../src/app/editor/parts';
import { partTarget, targetMode } from '../../../src/app/ui/inspector/fields';
import { loadPiece, usePlayer } from '../../../src/app/store';

const cur = (): Piece => usePlayer.getState().piece;

const shift = (id: string, at: number, part: string): Moment =>
  ({ id, type: 'shift', at, by: 2, unit: 'semitones', target: { part } }) as Moment;

/** Five notes: v1, v2 in Melody; v3, v4 in Bass; v5 unassigned; a moment on each part. */
function withParts(): Piece {
  let p = newPiece({ seed: 3, poolSize: 5 });
  for (const id of ['v1', 'v2']) p = assignPart(p, id, 'Melody');
  for (const id of ['v3', 'v4']) p = assignPart(p, id, 'Bass');
  return { ...p, moments: [...p.moments, shift('m1', 2, 'Melody'), shift('m2', 4, 'Bass')] };
}

const targetOf = (p: Piece, id: string) => p.moments.find((m) => m.id === id)?.target;

beforeEach(() => {
  loadPiece(withParts());
});

describe('parts', () => {
  it('lists parts in pool order; new pieces have none', () => {
    expect(hasParts(newPiece({ seed: 1 }))).toBe(false);
    expect(partNames(cur())).toEqual(['Melody', 'Bass']);
    expect(freePartName(cur())).toBe('Part 1');
  });

  it('rename rewrites voices and { part } targets as one undo entry', () => {
    const before = cur();
    expect(edit((p) => renamePart(p, 'Melody', 'Tune'), 'Rename part')).toBe(true);
    const after = cur();
    expect(partNames(after)).toEqual(['Tune', 'Bass']);
    expect(targetOf(after, 'm1')).toEqual({ part: 'Tune' });
    expect(targetOf(after, 'm2')).toEqual({ part: 'Bass' });
    expect(useEditor.getState().undoLabel).toBe('Rename part');
    undo();
    expect(cur()).toEqual(before);
  });

  it('refuses an empty or taken name', () => {
    expect(renameError(cur(), 'Melody', ' ')).not.toBeNull();
    expect(renameError(cur(), 'Melody', 'Bass')).toMatch(/exists/);
    expect(renameError(cur(), 'Melody', 'Melody')).toBeNull();
    expect(renamePart(cur(), 'Melody', 'Bass')).toBe(cur());
  });

  it('whole-part set touches only that part, as one entry; common() reads Mixed', () => {
    edit((p) => patchPart(p, 'Bass', { timbre: 'organ', gain: 0.5 }), 'Part timbre');
    const v = cur().voices;
    expect(v.filter((x) => x.part === 'Bass').every((x) => x.timbre === 'organ')).toBe(true);
    expect(v.filter((x) => x.part !== 'Bass').some((x) => x.timbre === 'organ')).toBe(false);
    expect(common(v, (x) => x.timbre)).toBeUndefined();
    expect(common(v.slice(2, 4), (x) => x.gain)).toBe(0.5);
    expect(useEditor.getState().undoLabel).toBe('Part timbre');
    undo();
    expect(cur().voices.some((x) => x.timbre === 'organ')).toBe(false);
    expect(patchPart(cur(), 'Nobody', { gain: 0 })).toBe(cur());
  });

  it('a range bound keeps each note its other bound', () => {
    const p0 = cur();
    const p: Piece = {
      ...p0,
      voices: p0.voices.map((v, i) => (i === 1 ? { ...v, range: [40, 90] } : v)),
    };
    const out = setPartRangeBound(p, 'Melody', 0, 50);
    expect(out.voices[0].range).toEqual([50, p.voices[0].range[1]]);
    expect(out.voices[1].range).toEqual([50, 90]);
    expect(out.voices[2]).toBe(p.voices[2]);
  });

  it('moves a note between parts and out of them', () => {
    let p = assignPart(cur(), 'v2', 'Bass');
    expect(p.voices[1].part).toBe('Bass');
    p = assignPart(p, 'v2', '');
    expect('part' in p.voices[1]).toBe(false);
    expect(assignPart(p, 'v2', undefined)).toBe(p);
    expect(assignPart(p, 'nope', 'Bass')).toBe(p);
  });

  it('delete unassigns its notes and retargets its moments by pick', () => {
    const p = deletePart(cur(), 'Melody');
    expect(partNames(p)).toEqual(['Bass']);
    expect(targetOf(p, 'm1')).toEqual({ voices: ['v1', 'v2'] });
    expect(targetOf(p, 'm2')).toEqual({ part: 'Bass' });
    // An unknown part's moments fall back to the default target.
    const q: Piece = { ...cur(), moments: [...cur().moments, shift('m3', 6, 'Gone')] };
    expect(targetOf(deletePart(q, 'Gone'), 'm3')).toBeUndefined();
  });
});

describe('target mode', () => {
  it('round-trips the Part chooser', () => {
    expect(targetMode(partTarget('Melody'))).toBe('part');
    expect(partTarget('Melody')).toEqual({ part: 'Melody' });
    expect(targetMode(partTarget(''))).toBe('all');
    expect(targetMode({ rank: [0, 1] })).toBe('rank');
    expect(targetMode({ voices: ['v1'] })).toBe('pick');
    expect(targetMode('all')).toBe('all');
  });
});
