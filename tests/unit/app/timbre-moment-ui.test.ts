/**
 * M6-b3: the timbre moment in the editor: its default (a preset the notes don't play), the
 * palette entry and effect check, the Effects lane row (span, label, fade drag) and renaming or
 * deleting the piece's own timbre (moments follow; one undo entry).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
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
import { MOMENT_DEFAULTS, newPiece } from '../../../src/core/defaults';
import { momentEffectAt } from '../../../src/core/effect';
import { parsePiece } from '../../../src/core/schema';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type { Piece, TimbreMoment } from '../../../src/core/types';
import { edit, undo, useEditor } from '../../../src/app/editor/history';
import {
  endDragPatch,
  endEditOf,
  estimateSpan,
  laneItems,
  laneLayout,
  laneRowOf,
} from '../../../src/app/editor/lane';
import { defaultMoment, newTimbrePreset } from '../../../src/app/editor/new-moment';
import { paletteEffects } from '../../../src/app/editor/palette-effects';
import { PALETTE, momentTypeForKey } from '../../../src/app/editor/shortcuts';
import {
  deleteTimbre,
  renameTimbre,
  timbreMoments,
  timbreRenameError,
} from '../../../src/app/editor/timbre-edit';
import { loadPiece, usePlayer } from '../../../src/app/store';

const G = newPiece({ seed: 1, poolSize: 1 }).defaults.glide;

/** Four voices on glass, one sounding C4 from 0; `mine` is the piece's own timbre. */
function base(moments: Piece['moments'] = []): Piece {
  const p = newPiece({ seed: 5, poolSize: 4 });
  return {
    ...p,
    timbres: { ...p.timbres, mine: structuredClone(BUILTIN_TIMBRES.organ) },
    voices: p.voices.map((v) => ({ ...v, timbre: 'glass' })),
    moments: [...p.moments, ...moments],
  };
}

const timbre = (extra: Partial<TimbreMoment> = {}): TimbreMoment => ({
  id: 'tmb',
  type: 'timbre',
  at: 4,
  preset: 'mine',
  fade: 2,
  ...extra,
});

const valid = (p: Piece): void => {
  const r = parsePiece(JSON.parse(JSON.stringify(p)));
  expect(r.ok, r.ok ? '' : r.errors.join('; ')).toBe(true);
};

describe('a new timbre moment', () => {
  it('names a preset no note plays there, with the default fade', () => {
    const p = base();
    const s = compile(p);
    const m = defaultMoment('timbre', 4, 'x', p, s);
    expect(m).toEqual({ id: 'x', type: 'timbre', at: 4, preset: 'mine', fade: 2 });
    expect(m.fade).toBe(MOMENT_DEFAULTS.timbre.fade);
    expect(momentEffectAt(p, s, m).effect).toBe(true);
    // Without own timbres: the first built-in the notes don't play.
    const q = { ...p, timbres: { glass: p.timbres.glass } };
    expect(newTimbrePreset(q, compile(q), 4)).toBe('sine');
  });

  it('reads the timbres in effect at its time, silent notes included', () => {
    // From 2 s every note plays `mine`; v4 plays sine from the start (it never sounds).
    const p0 = base([timbre({ id: 'a', at: 2, fade: 0 })]);
    const p = { ...p0, voices: p0.voices.map((v, i) => (i === 3 ? { ...v, timbre: 'sine' } : v)) };
    const s = compile(p);
    expect(newTimbrePreset(p, s, 1)).toBe('mine');
    // At 2 s the change has happened: glass is free again (v4 is on mine too now).
    const later = newTimbrePreset(p, s, 2);
    expect(later).toBe('glass');
    expect(momentEffectAt(p, s, defaultMoment('timbre', 6, 'x', p, s)).effect).toBe(true);
  });

  it('when every preset is in use, differs from the most common one', () => {
    // One note per built-in, and two more on sine: sine is the most common.
    const names = Object.keys(BUILTIN_TIMBRES);
    const p0 = newPiece({ seed: 1, poolSize: names.length + 2 });
    const timbres = [...names, 'sine', 'sine'];
    const p = {
      ...p0,
      timbres: {},
      voices: p0.voices.map((v, i) => ({ ...v, timbre: timbres[i] })),
    };
    expect(names[0]).toBe('sine');
    expect(newTimbrePreset(p, compile(p), 0)).toBe(names[1]);
  });

  it('is on the palette with the B key, and the palette checks its effect', () => {
    expect(PALETTE.find((e) => e.type === 'timbre')?.key).toBe('B');
    expect(
      momentTypeForKey({
        key: 'b',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe('timbre');
    const p = base();
    expect(paletteEffects(p, compile(p), 4).timbre.effect).toBe(true);
  });
});

describe('the Effects lane row', () => {
  it('puts a timbre change on its own row, labelled with its preset, spanning the fade', () => {
    const p = base([timbre(), timbre({ id: 'b', at: 4.5, preset: 'bell', fade: 3 })]);
    const s = compile(p);
    expect(laneRowOf('timbre')).toBe('effects');
    expect(endEditOf('timbre')).toBe('fade');
    const items = laneItems(p, s.momentSpans).filter((it) => it.type === 'timbre');
    expect(items.map((it) => [it.text, it.start, it.end])).toEqual([
      ['mine', 4, 6],
      ['bell', 4.5, 7.5],
    ]);
    expect(estimateSpan(timbre({ fade: 1.5 }), G)).toEqual([4, 5.5]);
    // A label wins over the preset name.
    expect(laneItems(base([timbre({ label: 'swell' })]), []).at(-1)?.text).toBe('swell');
    // Overlapping changes stack; the main rows don't count them.
    const all = laneItems(p, s.momentSpans);
    const layout = laneLayout(all, 40);
    expect(layout.count.effects).toBe(2);
    expect(layout.lane.filter((r) => r === 'effects')).toHaveLength(2);
    expect(laneLayout(laneItems(base(), []), 40).count.effects).toBe(0);
  });

  it('dragging the end sets the fade, never below 0', () => {
    expect(endDragPatch(timbre(), G, 1.25, false)).toEqual({ fade: 3.25 });
    expect(endDragPatch(timbre(), G, -5, false)).toEqual({ fade: 0 });
    expect(endDragPatch(timbre({ fade: 0 }), G, -1, false)).toBeNull();
  });
});

describe('renaming and deleting the piece’s own timbre', () => {
  it('renames it on the notes and the timbre moments, keeping its place', () => {
    const p0 = base([timbre(), timbre({ id: 'b', at: 6, preset: 'bell' })]);
    const p = { ...p0, voices: p0.voices.map((v, i) => (i === 0 ? { ...v, timbre: 'mine' } : v)) };
    const q = renameTimbre(p, 'mine', '  warm pad ');
    expect(Object.keys(q.timbres)).toEqual(
      Object.keys(p.timbres).map((k) => (k === 'mine' ? 'warm pad' : k)),
    );
    expect(q.timbres['warm pad']).toBe(p.timbres.mine);
    expect(q.voices[0].timbre).toBe('warm pad');
    expect(q.voices[1]).toBe(p.voices[1]);
    expect(timbreMoments(q, 'warm pad')).toEqual(['tmb']);
    expect(timbreMoments(q, 'bell')).toEqual(['b']);
    valid(q);
    expect(compile(q).diagnostics.filter((d) => d.code === 'unknown-timbre')).toEqual([]);
  });

  it('refuses empty and taken names and built-ins', () => {
    const p = base([timbre()]);
    expect(timbreRenameError(p, 'mine', ' ')).toMatch(/needs a name/);
    expect(timbreRenameError(p, 'mine', 'bell')).toMatch(/exists/);
    expect(timbreRenameError(p, 'mine', 'glass')).toMatch(/exists/);
    expect(timbreRenameError(p, 'mine', 'mine')).toBeNull();
    expect(timbreRenameError(p, 'mine', 'toString')).toBeNull();
    for (const [from, to] of [
      ['mine', ''],
      ['mine', 'bell'],
      ['mine', 'mine'],
      ['glass', 'glassy'], // a built-in's copy is not the piece's own
      ['nope', 'x'],
    ]) {
      expect(renameTimbre(p, from, to)).toBe(p);
    }
  });

  it('deletes it only when no note uses it; its moments then name a missing timbre', () => {
    const p = base([timbre()]);
    const q = deleteTimbre(p, 'mine');
    expect(q.timbres.mine).toBeUndefined();
    expect(q.moments).toBe(p.moments);
    const d = compile(q).diagnostics.filter((x) => x.momentId === 'tmb');
    expect(d.map((x) => x.code)).toEqual(['unknown-timbre']);
    const used = { ...p, voices: p.voices.map((v) => ({ ...v, timbre: 'mine' })) };
    expect(deleteTimbre(used, 'mine')).toBe(used);
    expect(deleteTimbre(p, 'glass')).toBe(p);
  });

  describe('in the history', () => {
    beforeEach(() => loadPiece(base([timbre()])));

    it('a rename is one undo entry', () => {
      const start = usePlayer.getState().piece;
      expect(edit((p) => renameTimbre(p, 'mine', 'warm'), 'Rename timbre')).toBe(true);
      const now = usePlayer.getState().piece;
      expect(now.moments.find((m) => m.id === 'tmb')).toMatchObject({ preset: 'warm' });
      expect(now.timbres.warm).toBeDefined();
      expect(useEditor.getState().undoLabel).toBe('Rename timbre');
      expect(undo()).toBe(true);
      expect(usePlayer.getState().piece.moments).toEqual(start.moments);
      expect(usePlayer.getState().piece.timbres).toEqual(start.timbres);
      expect(useEditor.getState().canUndo).toBe(false);
    });
  });
});
