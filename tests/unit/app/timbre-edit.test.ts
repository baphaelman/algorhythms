import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  // Animation frames run when the test says so (`frames()`), to see the drag coalescing.
  const queue: ((t: number) => void)[] = [];
  g.requestAnimationFrame = (cb: (t: number) => void) => queue.push(cb);
  g.__frames = () => {
    while (queue.length > 0) queue.shift()!(0);
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
import { parsePiece, TimbreSchema } from '../../../src/core/schema';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type { Piece } from '../../../src/core/types';
import { edit, undo, useEditor } from '../../../src/app/editor/history';
import {
  addPartial,
  beginTimbreDrag,
  dragTimbre,
  duplicateTimbre,
  editTimbre,
  editedName,
  endTimbreDrag,
  freeTimbreName,
  isModified,
  loadPreset,
  MAX_PARTIALS,
  PARTIAL_CONTROL,
  positionOf,
  removePartial,
  revertTimbre,
  setAt,
  setFmOn,
  setHarmonic,
  setNoiseOn,
  setStrike,
  SLIDER_STEPS,
  strikeOf,
  TIMBRE_CONTROLS,
  timbreIn,
  timbreRecipe,
  valueAt,
  valueOf,
} from '../../../src/app/editor/timbre-edit';
import { loadPiece, usePlayer } from '../../../src/app/store';

const frames = (globalThis as unknown as { __frames: () => void }).__frames;
const BUILTIN_JSON = JSON.stringify(BUILTIN_TIMBRES);

/** A pool of 4 voices: v1, v2 on reed, v3 on bell, v4 on glass (stored in the piece). */
function base(): Piece {
  const p = newPiece({ seed: 3, poolSize: 4 });
  return {
    ...p,
    voices: p.voices.map((v, i) => ({ ...v, timbre: ['reed', 'reed', 'bell', 'glass'][i] })),
  };
}

const valid = (p: Piece): void => {
  const r = parsePiece(JSON.parse(JSON.stringify(p)));
  expect(r.ok, r.ok ? '' : r.errors.join('; ')).toBe(true);
};

describe('editing timbres', () => {
  it('stores an edited copy of a built-in; the built-in is never touched', () => {
    const p = base();
    expect(p.timbres.reed).toBeUndefined();
    const q = editTimbre(p, 'reed', setAt(['vibrato', 'depthCents'], 20));
    expect(q.timbres.reed.vibrato.depthCents).toBe(20);
    expect(q.timbres.reed.harmonics).toEqual(BUILTIN_TIMBRES.reed.harmonics);
    // Nothing shared with the built-in, which keeps its values.
    expect(q.timbres.reed.harmonics).not.toBe(BUILTIN_TIMBRES.reed.harmonics);
    expect(q.timbres.reed.drift).not.toBe(BUILTIN_TIMBRES.reed.drift);
    expect(JSON.stringify(BUILTIN_TIMBRES)).toBe(BUILTIN_JSON);
    expect(isModified(q, 'reed')).toBe(true);
    expect(timbreIn(q, 'reed').vibrato.depthCents).toBe(20);
    valid(q);
    // A no-op edit is the same piece (no undo entry).
    expect(editTimbre(p, 'reed', setAt(['vibrato', 'depthCents'], 8))).toBe(p);
    expect(editTimbre(q, 'reed', setAt(['vibrato', 'depthCents'], 20))).toBe(q);
  });

  it('revert puts the built-in values back; the copy stays in the piece', () => {
    const q = editTimbre(base(), 'glass', setHarmonic(0, 0.5));
    expect(isModified(q, 'glass')).toBe(true);
    const r = revertTimbre(q, 'glass');
    expect(r.timbres.glass).toEqual(BUILTIN_TIMBRES.glass);
    expect(r.timbres.glass).not.toBe(BUILTIN_TIMBRES.glass);
    expect(isModified(r, 'glass')).toBe(false);
    expect(revertTimbre(r, 'glass')).toBe(r);
  });

  it('sets partials, adds and removes them within 1..32', () => {
    let t = BUILTIN_TIMBRES.sine;
    t = setHarmonic(0, 0.7)(t);
    expect(t.harmonics).toEqual([0.7]);
    expect(setHarmonic(3, 1)(t)).toBe(t); // out of range
    expect(removePartial(t)).toBe(t); // keeps one
    for (let i = 0; i < 40; i++) t = addPartial(t);
    expect(t.harmonics.length).toBe(MAX_PARTIALS);
    expect(t.harmonics.slice(1).every((a) => a === 0)).toBe(true);
    expect(removePartial(t).harmonics.length).toBe(MAX_PARTIALS - 1);
  });

  it('switches FM and noise on and off, and sets the strike', () => {
    const t = BUILTIN_TIMBRES.organ;
    const fm = setFmOn(true)(t);
    expect(fm.fm).toEqual({ ratio: 2, index: 1, indexTrack: 0.5 });
    expect(setFmOn(true)(fm)).toBe(fm);
    expect('fm' in setFmOn(false)(fm)).toBe(false);
    expect(setAt(['fm', 'ratio'], 3)(t)).toBe(t); // section off: sliders do nothing
    expect(valueAt(setAt(['fm', 'ratio'], 3)(fm), ['fm', 'ratio'])).toBe(3);
    const n = setNoiseOn(true)(t);
    expect(n.noise).toEqual({ level: 0.1, bandwidth: 0.5 });
    expect('noise' in setNoiseOn(false)(n)).toBe(false);
    expect(strikeOf(t)).toBe('auto');
    expect(setStrike('crisp')(t).articulation.crisp).toBe(true);
    expect(setStrike('soft')(t).articulation.crisp).toBe(false);
    expect('crisp' in setStrike('auto')(setStrike('soft')(t)).articulation).toBe(false);
    for (const x of [fm, n, setStrike('soft')(t)])
      expect(TimbreSchema.safeParse(x).success).toBe(true);
  });

  it('duplicates under a free name', () => {
    const p = base();
    expect(freeTimbreName(p, 'mine')).toBe('mine');
    expect(freeTimbreName(p, 'bell')).toBe('bell 2');
    const d = duplicateTimbre(p, 'bell');
    expect(d.name).toBe('bell 2');
    expect(d.piece.timbres['bell 2']).toEqual(BUILTIN_TIMBRES.bell);
    expect(freeTimbreName(d.piece, 'bell 2')).toBe('bell 3');
    expect(d.piece.voices).toBe(p.voices);
  });

  it('follows the first note until a timbre is chosen, and drops a choice that is gone', () => {
    const p = base();
    expect(editedName(p, null)).toBe('reed');
    expect(editedName(p, 'bell')).toBe('bell');
    expect(editedName(p, 'gone')).toBe('reed');
  });
});

describe('loading presets', () => {
  const custom = { ...BUILTIN_TIMBRES.flute, accent: 0.9 };

  it('gives the preset to the notes using the edited timbre, keeping its name', () => {
    const p = base();
    const r = loadPreset(p, { name: 'airy', timbre: custom }, 'users', 'reed');
    expect(r.name).toBe('airy');
    expect(r.piece.timbres.airy).toEqual(custom);
    expect(r.piece.voices.map((v) => v.timbre)).toEqual(['airy', 'airy', 'bell', 'glass']);
    valid(r.piece);
  });

  it('renames on a clash with a different timbre, reuses an identical one', () => {
    const p = base();
    const clash = loadPreset(p, { name: 'bell', timbre: custom }, 'all', 'reed');
    expect(clash.name).toBe('bell 2');
    expect(clash.piece.timbres.bell).toBeUndefined();
    expect(clash.piece.voices.every((v) => v.timbre === 'bell 2')).toBe(true);
    const same = loadPreset(
      p,
      { name: 'bell', timbre: { ...BUILTIN_TIMBRES.bell } },
      'all',
      'reed',
    );
    expect(same.name).toBe('bell');
    expect(same.piece.timbres).toBe(p.timbres);
  });

  it('targets one voice, or no notes', () => {
    const p = base();
    const one = loadPreset(p, { name: 'airy', timbre: custom }, { voice: 'v3' }, 'reed');
    expect(one.piece.voices.map((v) => v.timbre)).toEqual(['reed', 'reed', 'airy', 'glass']);
    const none = loadPreset(p, { name: 'airy', timbre: custom }, 'none', 'reed');
    expect(none.piece.voices).toBe(p.voices);
    expect(none.piece.timbres.airy).toEqual(custom);
  });
});

describe('sliders', () => {
  it('every range lies inside the schema bounds, at both ends', () => {
    const on = setNoiseOn(true)(setFmOn(true)(BUILTIN_TIMBRES.reed));
    for (const ctl of [...TIMBRE_CONTROLS, PARTIAL_CONTROL]) {
      for (const pos of [0, SLIDER_STEPS / 2, SLIDER_STEPS]) {
        const x = valueOf(ctl, pos);
        expect(x, ctl.id).toBeGreaterThanOrEqual(ctl.min);
        expect(x, ctl.id).toBeLessThanOrEqual(ctl.max);
        const t = ctl === PARTIAL_CONTROL ? setHarmonic(0, x)(on) : setAt(ctl.path, x)(on);
        if (ctl !== PARTIAL_CONTROL) expect(valueAt(t, ctl.path), ctl.id).toBe(x);
        const r = TimbreSchema.safeParse(t);
        expect(r.success, `${ctl.id} = ${x}`).toBe(true);
      }
    }
  });

  it('positions and values round-trip, with clean numbers', () => {
    for (const ctl of [...TIMBRE_CONTROLS, PARTIAL_CONTROL]) {
      for (let pos = 0; pos <= SLIDER_STEPS; pos += 37) {
        const x = valueOf(ctl, pos);
        expect(Math.abs(positionOf(ctl, x) - pos), `${ctl.id} @${pos}`).toBeLessThanOrEqual(
          ctl.curve === 'lin' ? SLIDER_STEPS * (ctl.step / (ctl.max - ctl.min)) : 6,
        );
        expect(String(x).length, `${ctl.id} ${x}`).toBeLessThan(9);
      }
    }
    // Every built-in value shows inside its slider.
    for (const t of Object.values(BUILTIN_TIMBRES)) {
      for (const ctl of TIMBRE_CONTROLS) {
        const v = valueAt(t, ctl.path);
        if (v === undefined) continue;
        expect(v, ctl.id).toBeGreaterThanOrEqual(ctl.min);
        expect(v, ctl.id).toBeLessThanOrEqual(ctl.max);
      }
    }
  });
});

describe('a slider drag is one undo entry', () => {
  beforeEach(() => {
    loadPiece(base());
    frames();
  });

  it('coalesces updates to one per frame and records one entry', () => {
    const start = usePlayer.getState().piece;
    let applied = 0;
    const unsub = usePlayer.subscribe((s, prev) => {
      if (s.piece !== prev.piece) applied++;
    });
    beginTimbreDrag('Vibrato depth');
    for (const x of [10, 12, 14]) {
      dragTimbre(timbreRecipe('reed', setAt(['vibrato', 'depthCents'], x)));
    }
    frames();
    expect(applied).toBe(1);
    expect(usePlayer.getState().piece.timbres.reed.vibrato.depthCents).toBe(14);
    dragTimbre(timbreRecipe('reed', setAt(['vibrato', 'depthCents'], 30)));
    // Released before the next frame: the last value still lands.
    endTimbreDrag();
    unsub();
    expect(usePlayer.getState().piece.timbres.reed.vibrato.depthCents).toBe(30);
    expect(useEditor.getState().undoLabel).toBe('Vibrato depth');
    expect(undo()).toBe(true);
    expect(usePlayer.getState().piece.timbres).toEqual(start.timbres);
    expect(useEditor.getState().canUndo).toBe(false);
    expect(JSON.stringify(BUILTIN_TIMBRES)).toBe(BUILTIN_JSON);
  });

  it('keyboard steps are one entry each', () => {
    edit(timbreRecipe('bell', setAt(['accent'], 0.2)), 'Accent');
    edit(timbreRecipe('bell', setAt(['accent'], 0.3)), 'Accent');
    expect(usePlayer.getState().piece.timbres.bell.accent).toBe(0.3);
    undo();
    expect(usePlayer.getState().piece.timbres.bell.accent).toBe(0.2);
    undo();
    expect(usePlayer.getState().piece.timbres.bell).toBeUndefined();
  });
});
