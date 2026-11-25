import { describe, expect, it } from 'vitest';
import {
  EXPORT_MODE_KEY,
  loadExportMode,
  posterShown,
  saveExportMode,
  useExportSurface,
  workspaceEscape,
} from '../../../src/app/export-surface';
import { artboardFit, linesText, posterLayers } from '../../../src/app/poster-workspace';
import type { VoiceDef } from '../../../src/core/types';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe('export mode memory (Menu → Export opens the last one)', () => {
  it('defaults to Poster, remembers Video and Poster', () => {
    const st = memory();
    expect(loadExportMode(st)).toBe('poster');
    expect(saveExportMode('video', st)).toBe(true);
    expect(st.getItem(EXPORT_MODE_KEY)).toBe('video');
    expect(loadExportMode(st)).toBe('video');
    saveExportMode('poster', st);
    expect(loadExportMode(st)).toBe('poster');
  });

  it('survives missing, invalid or throwing storage', () => {
    expect(loadExportMode(null)).toBe('poster');
    expect(saveExportMode('video', null)).toBe(false);
    const st = memory();
    st.setItem(EXPORT_MODE_KEY, 'audio');
    expect(loadExportMode(st)).toBe('poster');
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(loadExportMode(bad)).toBe('poster');
    expect(saveExportMode('video', bad)).toBe(false);
  });

  it('posterShown follows the surface', () => {
    useExportSurface.setState({ surface: 'poster' });
    expect(posterShown()).toBe(true);
    useExportSurface.setState({ surface: 'video' });
    expect(posterShown()).toBe(false);
    useExportSurface.setState({ surface: null });
    expect(posterShown()).toBe(false);
  });
});

describe('Escape in the workspace', () => {
  const root = { tagName: 'MAIN' };
  const base = {
    key: 'Escape',
    defaultPrevented: false,
    focused: { tagName: 'BODY' },
    root,
    selected: false,
    dialog: false,
  };

  it('leaves with nothing focused (the body, nothing, or the workspace itself)', () => {
    expect(workspaceEscape(base)).toBe('leave');
    expect(workspaceEscape({ ...base, focused: null })).toBe('leave');
    expect(workspaceEscape({ ...base, focused: root })).toBe('leave');
  });

  it('blurs a focused control first', () => {
    expect(workspaceEscape({ ...base, focused: { tagName: 'INPUT' } })).toBe('blur');
    expect(workspaceEscape({ ...base, focused: { tagName: 'BUTTON' } })).toBe('blur');
  });

  it('does nothing with a selection, a dialog, a used key or another key', () => {
    expect(workspaceEscape({ ...base, selected: true })).toBeNull();
    expect(workspaceEscape({ ...base, dialog: true })).toBeNull();
    expect(workspaceEscape({ ...base, defaultPrevented: true })).toBeNull();
    expect(workspaceEscape({ ...base, key: 'Enter' })).toBeNull();
  });
});

describe('artboard fit', () => {
  it('fits the whole poster inside the padding, aspect kept', () => {
    const f = artboardFit({ w: 1048, h: 648 }, { width: 3840, height: 2160 }, 24);
    expect(f.w).toBeLessThanOrEqual(1000);
    expect(f.h).toBeLessThanOrEqual(600);
    expect(Math.min(1000 - f.w, 600 - f.h)).toBeLessThanOrEqual(1);
    expect(f.w / f.h).toBeCloseTo(16 / 9, 2);
  });

  it('a portrait poster is limited by the height', () => {
    const f = artboardFit({ w: 1000, h: 548 }, { width: 2480, height: 3508 }, 24);
    expect(f.h).toBeLessThanOrEqual(500);
    expect(f.h).toBeGreaterThanOrEqual(499);
    expect(f.w).toBe(Math.floor(500 * (2480 / 3508)));
  });

  it('never collapses below a pixel', () => {
    expect(artboardFit({ w: 0, h: 0 }, { width: 3840, height: 2160 })).toEqual({ w: 1, h: 1 });
  });
});

describe('layers', () => {
  const v = (id: string, part?: string, name?: string): VoiceDef =>
    ({ id, part, name, timbre: 'sine', pan: 0, gain: 1, range: [36, 84] }) as VoiceDef;

  it('one layer per part in pool order, with its lines', () => {
    const layers = posterLayers({
      voices: [v('a', 'Melody', 'Lead'), v('b', 'Chords'), v('c', 'Chords'), v('d', 'Melody')],
    });
    expect(layers.map((l) => l.label)).toEqual(['Melody', 'Chords']);
    expect(layers[0].lines).toEqual([
      { id: 'a', label: 'Lead' },
      { id: 'd', label: 'Line 4' },
    ]);
    expect(layers[1].lines.map((l) => l.id)).toEqual(['b', 'c']);
  });

  it('lines with no part form one "Lines" layer', () => {
    const layers = posterLayers({ voices: [v('a'), v('b', ''), v('c', 'Bass')] });
    expect(layers.map((l) => [l.part, l.label, l.lines.length])).toEqual([
      ['', 'Lines', 2],
      ['Bass', 'Bass', 1],
    ]);
  });

  it('counts lines', () => {
    expect(linesText(1)).toBe('1 line');
    expect(linesText(4)).toBe('4 lines');
  });
});
