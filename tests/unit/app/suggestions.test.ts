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

import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { Moment, Piece } from '../../../src/core/types';
import { select, useEditor } from '../../../src/app/editor/history';
import {
  addSuggestion,
  appendMoment,
  refreshSuggestions,
  suggestionsAt,
  suggestionTime,
  useSuggestions,
} from '../../../src/app/editor/suggestions';
import { loadPiece, seekTo, usePlayer } from '../../../src/app/store';

/** Split at 0, a level ramp 1 → 6 s, a unison at 2 s (ends ~2.5 s): the latest end is 6 s. */
function piece(end?: number): Piece {
  const p = newPiece({ seed: 7 });
  const moments = [
    { id: 'spl001', type: 'split', at: 0, count: 4, voicing: 'even' },
    { id: 'lvl001', type: 'level', at: 1, gain: 0.8, over: 5 },
    {
      id: 'uni001',
      type: 'unison',
      at: 2,
      pitch: 'center',
      octaves: false,
      glide: { length: 0.5, stagger: 0 },
    },
  ] as unknown as Moment[];
  const out: Piece = { ...p, moments: [...p.moments, ...moments], end: { ...p.end } };
  if (end === undefined) delete out.end.at;
  else out.end.at = end;
  return out;
}

describe('Next at the end (revision 7)', () => {
  beforeEach(() => {
    loadPiece(piece());
    select([]);
  });

  it('is the latest end of any unmuted moment, whatever the playhead or selection', () => {
    const { piece: p, compiled } = usePlayer.getState();
    expect(suggestionTime(p, compiled)).toBe(6);
    seekTo(1);
    select(['spl001']);
    refreshSuggestions(true);
    expect(useSuggestions.getState().t).toBe(6);
    const muted = {
      ...p,
      moments: p.moments.map((m) => (m.id === 'lvl001' ? { ...m, muted: true } : m)),
    };
    const unisonEnd = suggestionTime(muted, compile(muted));
    expect(unisonEnd).toBeGreaterThan(2.4);
    expect(unisonEnd).toBeLessThan(6);
    const empty = { ...p, moments: [] };
    expect(suggestionTime(empty, compile(empty))).toBe(0);
  });

  it('Snap to beats: the next beat at or after the last end (revision 9)', () => {
    const { piece: p, compiled } = usePlayer.getState();
    // 6 s on a 70 bpm grid (0.857 s beats) is not on a beat: the next one is 7 × 0.857 = 6.
    const grid = (bpm: number, extra: object = {}): Piece => ({
      ...p,
      view: { ...p.view, gridBpm: bpm, ...extra },
    });
    expect(suggestionTime(grid(70), compiled)).toBe(6);
    expect(suggestionTime(grid(100), compiled)).toBe(6); // 6 s = 10 beats at 100 bpm
    expect(suggestionTime(grid(64), compiled)).toBe(6.563); // 0.9375 s beats: 7 × 0.9375, to the ms
    expect(suggestionTime(grid(64, { snapBeats: false }), compiled)).toBe(6);
    expect(suggestionTime(p, compiled)).toBe(6);
  });

  it('appends a suggestion at the end, one undo entry, selected', () => {
    seekTo(1);
    refreshSuggestions(true);
    const { items, t } = useSuggestions.getState();
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const s of items) expect(s.moment.at).toBe(t);
    const id = addSuggestion(items[0]);
    const added = usePlayer.getState().piece.moments.find((m) => m.id === id);
    expect(added?.at).toBe(6);
    expect(useEditor.getState().selection).toEqual([id]);
    expect(useEditor.getState().undoLabel).toBe(items[0].label);
  });

  it('extends an explicit end that the appended moment would pass', () => {
    // end.at 7: a 1 s tail after the last end; the new moment's span + 4 s must fit.
    loadPiece(piece(7));
    refreshSuggestions(true);
    const [s] = useSuggestions.getState().items;
    addSuggestion(s);
    const p = usePlayer.getState().piece;
    expect(p.end.at).toBeGreaterThanOrEqual(6 + 4);
    const diags = usePlayer.getState().compiled.diagnostics;
    expect(diags.some((d) => d.code === 'after-end')).toBe(false);
  });

  it('leaves an end with room alone; no end stays automatic', () => {
    const m = { id: 'x', type: 'level', at: 6, gain: 0.5, over: 1 } as Moment;
    const p = piece(30);
    expect(appendMoment(p, m).end.at).toBe(30);
    // 1 s after the moment's end (7 s) < 4 s: the end moves to 7 + 4.
    expect(appendMoment(piece(8), m).end.at).toBe(11);
    expect(appendMoment(piece(), m).end.at).toBeUndefined();
  });

  it('reads the state before an explicit end that comes first; moves go at the end', () => {
    const p = piece(4);
    const score = compile(p);
    const t = suggestionTime(p, score);
    const out = suggestionsAt(p, score, t);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const s of out) {
      expect(s.moment.at).toBe(t);
      if (s.moment.type === 'walk') expect(s.moment.until).toBeGreaterThan(t);
    }
  });
});

describe('suggested chords on fewer lines (mouse-only gaps)', () => {
  it('bring in their extra notes: count is the chord size', () => {
    const p0 = newPiece({ seed: 7 });
    const split = { id: 'spl001', type: 'split', at: 0.5, count: 2, voicing: 'even' } as Moment;
    const p = { ...p0, moments: [...p0.moments, split] };
    const s = compile(p);
    const items = suggestionsAt(p, s, suggestionTime(p, s));
    const chords = items.filter((i) => i.moment.type === 'chord');
    expect(chords.length).toBeGreaterThan(0);
    for (const { moment } of chords) {
      if (moment.type !== 'chord' || moment.notes.kind !== 'degrees') continue;
      expect(moment.count).toBe(Math.min(p.voices.length, moment.notes.degrees.length));
    }
  });
});
