/** M5 editor completion helpers (PLAN.md §11.3): selection, clipboard, Freeze, piano ruler. */
import { describe, expect, it } from 'vitest';
import {
  CLIP_FORMAT,
  clipOf,
  clipText,
  parseClip,
  pasteAnchor,
  pasteClip,
} from '../../../src/app/editor/clipboard';
import { canFreeze, freezeAll, freezePatch, isFrozen } from '../../../src/app/editor/freeze';
import { patchMoment } from '../../../src/app/editor/ops';
import { frozenPatch } from '../../../src/app/editor/chord-notes';
import { isBlackKey, keyRole, pianoKeys, toggledNotes } from '../../../src/app/editor/piano';
import {
  allMomentIds,
  idsInRect,
  marqueeSelection,
  rectOf,
  toggleId,
} from '../../../src/app/editor/selection';
import { compile } from '../../../src/core/compiler/compile';
import { momentSeed } from '../../../src/core/rng';
import type { ChordMoment, Moment, Piece, SplitMoment, WalkMoment } from '../../../src/core/types';
import { chordAt, piece } from '../core/compiler-fixtures';

const C_MAJOR = { tonic: 'C', scale: 'major' } as const;

/** Four voices; a chord at 1, a split at 4 ('current', to six notes), a walk 8–12. */
function sample(): Piece {
  return piece({
    pool: 8,
    start: [48, 55, 60, 64],
    glide: { length: 1, jitter: 0.2, stagger: 0.1 },
    key: C_MAJOR,
    moments: [
      {
        id: 'ch',
        type: 'chord',
        at: 1,
        notes: { kind: 'chord', symbol: 'Am' },
        voicing: 'nearest',
        assign: 'ordered',
      },
      { id: 'sp', type: 'split', at: 4, count: 6, voicing: 'even' },
      {
        id: 'wk',
        type: 'walk',
        at: 8,
        until: 12,
        grid: 0.5,
        density: 0.6,
        steps: [-1, 1],
        stepGlide: 0.1,
      },
    ] as Moment[],
  });
}

const byId = (p: Piece, id: string): Moment => p.moments.find((m) => m.id === id)!;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

describe('selection helpers', () => {
  it('toggles, selects all and keeps marquee order', () => {
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleId(['a'], 'c')).toEqual(['a', 'c']);
    const p = sample();
    expect(allMomentIds(p)).toEqual(p.moments.map((m) => m.id));
    expect(marqueeSelection(['a', 'b'], ['b', 'c'], true)).toEqual(['a', 'b', 'c']);
    expect(marqueeSelection(['a', 'b'], ['c'], false)).toEqual(['c']);
  });

  it('finds the boxes a rectangle touches, from corners in any order', () => {
    const r = rectOf(50, 40, 10, 0);
    expect(r).toEqual({ left: 10, top: 0, right: 50, bottom: 40 });
    const boxes = [
      { id: 'in', left: 20, top: 10, right: 30, bottom: 20 },
      { id: 'edge', left: 50, top: 40, right: 60, bottom: 50 },
      { id: 'out', left: 51, top: 0, right: 60, bottom: 10 },
      { id: 'below', left: 20, top: 41, right: 30, bottom: 50 },
    ];
    expect(idsInRect(boxes, r)).toEqual(['in', 'edge']);
  });
});

describe('clipboard', () => {
  it('copies relative times with explicit seeds, in piece order', () => {
    const p = sample();
    const clip = clipOf(p, ['wk', 'sp', 'nope'])!;
    expect(clip.format).toBe(CLIP_FORMAT);
    expect(clip.moments.map((m) => m.id)).toEqual(['sp', 'wk']);
    expect(clip.moments.map((m) => m.at)).toEqual([0, 4]);
    expect((clip.moments[1] as WalkMoment).until).toBe(8);
    expect(clip.moments[0].seed).toBe(momentSeed(p.seed, 'sp', undefined));
    expect(clipOf(p, ['nope'])).toBeNull();
  });

  it('reads back its own text and refuses anything else', () => {
    const clip = clipOf(sample(), ['ch'])!;
    expect(parseClip(clipText(clip))).toEqual(clip);
    expect(parseClip('hello')).toBeNull();
    expect(parseClip('')).toBeNull();
    expect(parseClip('{not json')).toBeNull();
    expect(parseClip(JSON.stringify({ ...clip, format: 'algorhythms' }))).toBeNull();
    expect(parseClip(JSON.stringify({ ...clip, moments: [] }))).toBeNull();
    expect(parseClip(JSON.stringify({ ...clip, version: 99 }))).toBeNull();
    expect(parseClip(JSON.stringify({ ...clip, moments: [{ type: 'chord' }] }))).toBeNull();
  });

  it('pastes at the anchor with fresh ids, keeping relative times', () => {
    const p = sample();
    const clip = clipOf(p, ['sp', 'wk'])!;
    const r = pasteClip(p, clip, 20)!;
    expect(r.ids).toHaveLength(2);
    for (const id of r.ids) expect(p.moments.some((m) => m.id === id)).toBe(false);
    const [a, b] = r.ids.map((id) => byId(r.piece, id));
    expect(a.at).toBe(20);
    expect(b.at).toBe(24);
    expect((b as WalkMoment).until).toBe(28);
    // Same moment apart from id and time, so it draws the same (explicit seed).
    expect({ ...a, id: 'sp', at: 4 }).toEqual({
      ...byId(p, 'sp'),
      seed: momentSeed(p.seed, 'sp', undefined),
    });
    expect(r.piece.moments.length).toBe(p.moments.length + 2);
    // Pasting twice gives distinct ids again.
    const again = pasteClip(r.piece, clip, 30)!;
    expect(new Set(again.piece.moments.map((m) => m.id)).size).toBe(again.piece.moments.length);
  });

  it('snaps the anchor to a beat only when given one', () => {
    expect(pasteAnchor(2.26, 0.5)).toBe(2.5);
    expect(pasteAnchor(2.24, 0.5)).toBe(2);
    expect(pasteAnchor(2.2345678, null)).toBe(2.234568);
    expect(pasteAnchor(-1, null)).toBe(0);
  });

  it('refuses moments the schema refuses', () => {
    const p = sample();
    const clip = clipOf(p, ['ch'])!;
    const bad = {
      ...clip,
      moments: [{ ...clip.moments[0], voicing: 'sideways' } as unknown as Moment],
    };
    expect(pasteClip(p, bad, 3)).toBeNull();
  });
});

describe('Freeze', () => {
  it('applies to chords, splits and walks only, once', () => {
    const p = sample();
    expect(p.moments.filter(canFreeze).map((m) => m.id)).toEqual(['start0', 'ch', 'sp', 'wk']);
    expect(canFreeze({ id: 'x', type: 'shift', at: 0, by: 1, unit: 'semitones' })).toBe(false);
    const s = compile(p);
    for (const id of ['ch', 'sp', 'wk']) {
      const m = byId(p, id);
      expect(isFrozen(m)).toBe(false);
      const patch = freezePatch(p, s, m)!;
      const f = byId(patchMoment(p, id, patch), id);
      expect(isFrozen(f)).toBe(true);
      expect(f.seed).toBe(momentSeed(p.seed, id, undefined));
      expect(freezePatch(p, s, f)).toBeNull();
    }
  });

  it('keeps the sound, and edits to earlier moments no longer change a frozen one', () => {
    const p = sample();
    const before = compile(p);
    const frozen = freezeAll(p, ['ch', 'sp', 'wk'], compile);
    const after = compile(frozen);
    expect(sorted(chordAt(after, 3))).toEqual(sorted(chordAt(before, 3)));
    expect(sorted(chordAt(after, 7))).toEqual(sorted(chordAt(before, 7)));
    expect(after.walkSteps.map((w) => [w.t, w.to])).toEqual(
      before.walkSteps.map((w) => [w.t, w.to]),
    );
    expect((byId(frozen, 'ch') as ChordMoment).frozenFrom?.notes).toEqual({
      kind: 'chord',
      symbol: 'Am',
    });
    expect((byId(frozen, 'sp') as SplitMoment).notes?.kind).toBe('pitches');
    expect((byId(frozen, 'wk') as WalkMoment).fixed?.length).toBe(before.walkSteps.length);

    // Change the chord to G: the unfrozen split ('current') follows, the frozen one keeps
    // its notes.
    const lift = (x: Piece) =>
      patchMoment(x, 'ch', { notes: { kind: 'pitches', pitches: [55, 59, 62, 67] } });
    const loose = compile(lift(p));
    const fixed = compile(lift(freezeAll(p, ['sp'], compile)));
    expect(sorted(chordAt(loose, 7))).not.toEqual(sorted(chordAt(before, 7)));
    expect(sorted(chordAt(fixed, 7))).toEqual(sorted(chordAt(before, 7)));
  });
});

describe('piano ruler', () => {
  it('lists keys, black keys and key roles', () => {
    expect(pianoKeys(59.6, 62.4)).toEqual([60, 61, 62]);
    expect(pianoKeys(-3, 1)).toEqual([0, 1]);
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlackKey)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(keyRole(60, C_MAJOR)).toBe('tonic');
    expect(keyRole(72, C_MAJOR)).toBe('tonic');
    expect(keyRole(62, C_MAJOR)).toBe('scale');
    expect(keyRole(61, C_MAJOR)).toBe('out');
    expect(keyRole(57, { tonic: 'A', scale: 'minor' })).toBe('tonic');
  });

  it('toggles a chord note, keeping one note and the pool size', () => {
    expect(toggledNotes([60, 64, 67], 72, 4)).toEqual({ notes: [60, 64, 67, 72], added: true });
    expect(toggledNotes([60, 64, 67], 64.2, 4)).toEqual({ notes: [60, 67], added: false });
    expect(toggledNotes([60], 60, 4)).toEqual({ refused: 'last-note' });
    expect(toggledNotes([60, 64, 67, 71], 74, 4)).toEqual({ refused: 'pool-full' });
  });

  it('a toggled frozen chord with its count sounds the new notes', () => {
    const p = sample();
    const m = byId(p, 'ch') as ChordMoment;
    for (const notes of [
      [45, 52, 57, 60, 64],
      [45, 57, 64],
    ]) {
      const next = patchMoment(p, 'ch', { ...frozenPatch(m, notes, true), count: notes.length });
      expect(sorted(chordAt(compile(next), 3))).toEqual(notes);
    }
  });
});
