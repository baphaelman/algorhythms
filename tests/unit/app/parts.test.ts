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
import { updateMoment } from '../../../src/app/editor/actions';
import { edit, undo, useEditor } from '../../../src/app/editor/history';
import {
  assignPart,
  common,
  deletePart,
  freePartName,
  hasParts,
  momentsTargeting,
  partNames,
  patchPart,
  renameError,
  renamePart,
  scopeLabel,
  setPartRangeBound,
} from '../../../src/app/editor/parts';
import {
  partPick,
  partTarget,
  pickTarget,
  targetMode,
  togglePart,
} from '../../../src/app/ui/inspector/fields';
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

describe('multi-part targets (revision 10)', () => {
  const withLists = (): Piece => ({
    ...cur(),
    moments: [
      ...cur().moments,
      { ...shift('m3', 6, 'x'), target: { parts: ['Melody', 'Bass'] } },
      { ...shift('m4', 8, 'x'), target: { exceptParts: ['Melody'] } },
    ],
  });

  it('rename rewrites the lists too, as one undo entry', () => {
    loadPiece(withLists());
    edit((p) => renamePart(p, 'Melody', 'Tune'), 'Rename part');
    expect(targetOf(cur(), 'm1')).toEqual({ part: 'Tune' });
    expect(targetOf(cur(), 'm3')).toEqual({ parts: ['Tune', 'Bass'] });
    expect(targetOf(cur(), 'm4')).toEqual({ exceptParts: ['Tune'] });
    undo();
    expect(targetOf(cur(), 'm3')).toEqual({ parts: ['Melody', 'Bass'] });
  });

  it('counts list targets as targeting a part; delete picks the same voices', () => {
    const p = withLists();
    expect(momentsTargeting(p, 'Melody').map((m) => m.id)).toEqual(['m1', 'm3', 'm4']);
    expect(momentsTargeting(p, 'Bass').map((m) => m.id)).toEqual(['m2', 'm3']);
    const q = deletePart(p, 'Melody');
    expect(targetOf(q, 'm3')).toEqual({ voices: ['v1', 'v2', 'v3', 'v4'] });
    expect(targetOf(q, 'm4')).toEqual({ voices: ['v3', 'v4', 'v5'] });
    expect(targetOf(q, 'm2')).toEqual({ part: 'Bass' });
  });

  it('labels a scope', () => {
    expect(scopeLabel({ names: ['Melody'], except: false })).toBe('Melody');
    expect(scopeLabel({ names: ['Melody', ''], except: false })).toBe('Melody, Unassigned');
    expect(scopeLabel({ names: ['Bass'], except: true })).toBe('all but Bass');
  });

  it('the Part chooser: ticks, the switch, and the target each writes', () => {
    const order = ['Melody', 'Bass', 'Pad'];
    expect(partPick(undefined)).toEqual({ ticked: [], except: false });
    expect(partPick({ rank: [0, 1] })).toBeNull();
    expect(partPick({ voices: ['v1'] })).toBeNull();
    expect(partPick({ part: 'Bass' })).toEqual({ ticked: ['Bass'], except: false });
    expect(partPick({ parts: ['Bass', 'Pad'] })).toEqual({
      ticked: ['Bass', 'Pad'],
      except: false,
    });
    expect(partPick({ exceptParts: ['Pad'] })).toEqual({ ticked: ['Pad'], except: true });

    const one = togglePart(partPick(undefined), 'Bass');
    expect(pickTarget(one, order)).toEqual({ part: 'Bass' });
    const two = togglePart(one, 'Melody');
    expect(pickTarget(two, order)).toEqual({ parts: ['Melody', 'Bass'] });
    expect(pickTarget({ ...two, except: true }, order)).toEqual({
      exceptParts: ['Melody', 'Bass'],
    });
    expect(pickTarget({ ticked: ['Bass'], except: true }, order)).toEqual({
      exceptParts: ['Bass'],
    });
    // Unticking the last part is All, and the switch goes off.
    const none = togglePart({ ticked: ['Bass'], except: true }, 'Bass');
    expect(none).toEqual({ ticked: [], except: false });
    expect(pickTarget(none, order)).toBeUndefined();
    expect(pickTarget({ ticked: [], except: true }, order)).toBeUndefined();
    // From Advanced (a pick or rank), a tick starts a fresh pick.
    expect(pickTarget(togglePart(null, 'Pad'), order)).toEqual({ part: 'Pad' });
    for (const t of [{ parts: ['A', 'B'] }, { exceptParts: ['A'] }])
      expect(targetMode(t)).toBe('part');
  });

  it('a chooser change is one undo entry; nothing ticked drops the target', () => {
    const m1 = (): Moment => cur().moments.find((m) => m.id === 'm1')!;
    const pick = (part: string): void => {
      updateMoment(
        'm1',
        { target: pickTarget(togglePart(partPick(m1().target), part), partNames(cur())) },
        'Change part',
      );
    };
    pick('Bass');
    expect(m1().target).toEqual({ parts: ['Melody', 'Bass'] });
    expect(useEditor.getState().undoLabel).toBe('Change part');
    pick('Melody');
    pick('Bass');
    expect('target' in m1()).toBe(false);
    undo();
    expect(m1().target).toEqual({ part: 'Bass' });
    undo();
    undo();
    expect(m1().target).toEqual({ part: 'Melody' });
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
