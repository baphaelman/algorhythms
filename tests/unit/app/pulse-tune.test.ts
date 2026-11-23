/**
 * R9-7: editing the pulse and tune moments: note-list and pattern helpers, lane spans, end drags
 * and bar drawing, moving regions, defaults and the palette's effect checks.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { withOpening } from '../opened-piece';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import { decodeSharePayload, encodeSharePayload } from '../../../src/app/share';
import type { Glide, Key, Piece, PulseMoment, TuneMoment } from '../../../src/core/types';
import {
  endDragPatch,
  endEditOf,
  estimateSpan,
  laneArt,
  laneItems,
  landsAtMarker,
} from '../../../src/app/editor/lane';
import { atPatch, moveMomentsBy } from '../../../src/app/editor/ops';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { paletteEffects } from '../../../src/app/editor/palette-effects';
import { PALETTE, momentTypeForKey } from '../../../src/app/editor/shortcuts';
import {
  BEAT_VALUES,
  MAX_PATTERN,
  accentAtY,
  addStep,
  beatSeconds,
  beatValueOf,
  cycleShare,
  patternSvg,
  removeStep,
  roundAccent,
  setAccent,
} from '../../../src/app/editor/pulse';
import {
  MIN_TUNE_LEN,
  addTuneNote,
  lenFromShown,
  lenShown,
  removeTuneNote,
  setTuneLen,
  stepTuneNote,
  tuneBeat,
  tuneEnd,
  tuneEndDrag,
  tuneNoteStarts,
} from '../../../src/app/editor/tune';

const G: Glide = { length: 2, jitter: 0, stagger: 0.5, order: 'random', ease: 'smoothstep' };
const C: Key = { tonic: 'C', scale: 'major' };

const pulse = (extra: Partial<PulseMoment> = {}): PulseMoment => ({
  id: 'pls',
  type: 'pulse',
  at: 4,
  until: 8,
  step: 0.5,
  pattern: [1, 0.5],
  decay: 0.3,
  floor: 0,
  mode: 'together',
  ...extra,
});

const tune = (extra: Partial<TuneMoment> = {}): TuneMoment => ({
  id: 'tun',
  type: 'tune',
  at: 4,
  notes: [
    { pitch: 60, len: 1 },
    { pitch: 64, len: 0.5 },
    { pitch: 62, len: 1.5 },
  ],
  ...extra,
});

/** One voice on C4 from 0 and four in the pool (so tunes and pulses have something to act on). */
function sounding(extra: Piece['moments'] = []): Piece {
  const p = withOpening(newPiece({ seed: 3 }));
  return { ...p, end: { at: 20, fade: 1 }, moments: [...p.moments, ...extra] };
}

describe('tune helpers', () => {
  it('note starts and end follow the lengths', () => {
    expect(tuneNoteStarts(tune())).toEqual([4, 5, 5.5, 7]);
    expect(tuneEnd(tune())).toBe(7);
    expect(tuneEnd(tune({ notes: [] }))).toBe(4);
  });

  it('lengths show in beats with a tempo, in seconds without', () => {
    expect(tuneBeat({ gridBpm: 120 })).toBe(0.5);
    expect(tuneBeat({})).toBeNull();
    expect(tuneBeat(undefined)).toBeNull();
    expect(lenShown(0.75, 0.5)).toBe(1.5);
    expect(lenShown(0.75, null)).toBe(0.75);
    expect(lenFromShown(1.5, 0.5)).toBe(0.75);
    expect(lenFromShown(0.2, null)).toBe(0.2);
    expect(lenFromShown(0, 0.5)).toBe(MIN_TUNE_LEN);
  });

  it('▲/▼ move one note by a scale step; others stay', () => {
    const n = tune().notes;
    expect(stepTuneNote(n, 0, 1, C)?.map((x) => x.pitch)).toEqual([62, 64, 62]);
    expect(stepTuneNote(n, 1, -1, C)?.map((x) => x.pitch)).toEqual([60, 62, 62]);
    // E → F is a semitone in C major; an off-scale note goes to its nearest step first.
    expect(stepTuneNote(n, 1, 1, C)?.[1].pitch).toBe(65);
    expect(stepTuneNote([{ pitch: 61, len: 1 }], 0, 1, C)?.[0].pitch).toBe(62);
    expect(stepTuneNote([{ pitch: 61, len: 1 }], 0, -1, C)?.[0].pitch).toBe(60);
    expect(stepTuneNote(n, 5, 1, C)).toBeNull();
    expect(stepTuneNote([{ pitch: 127, len: 1 }], 0, 1, C)).toBeNull();
  });

  it('lengths, add and remove', () => {
    const n = tune().notes;
    expect(setTuneLen(n, 1, 2)?.[1].len).toBe(2);
    expect(setTuneLen(n, 1, 0.5)).toBeNull();
    expect(setTuneLen(n, 1, 0)?.[1].len).toBe(MIN_TUNE_LEN);
    expect(setTuneLen(n, 1, NaN)).toBeNull();
    const added = addTuneNote(n, C, 60, null);
    expect(added).toHaveLength(4);
    expect(added[3]).toEqual({ pitch: 64, len: 1.5 });
    expect(addTuneNote([], C, 55.2, 0.5)).toEqual([{ pitch: 55, len: 0.5 }]);
    expect(addTuneNote([], C, 60, null)).toEqual([{ pitch: 60, len: 0.5 }]);
    expect(removeTuneNote(n, 0)?.map((x) => x.pitch)).toEqual([64, 62]);
    expect(removeTuneNote(n, 3)).toBeNull();
    expect(n).toHaveLength(3); // never mutated
  });

  it('the lane end drag changes the last note only', () => {
    expect(tuneEndDrag(tune(), 0.5)?.map((x) => x.len)).toEqual([1, 0.5, 2]);
    expect(tuneEndDrag(tune(), -5)?.at(-1)?.len).toBe(MIN_TUNE_LEN);
    expect(tuneEndDrag(tune({ notes: [] }), 1)).toBeNull();
  });
});

describe('pulse helpers', () => {
  it('beat values with a tempo', () => {
    expect(beatValueOf(0.25, 0.5)).toBe(0.5);
    expect(beatValueOf(0.5 / 3, 0.5)).toBe(1 / 3);
    expect(beatValueOf(0.3, 0.5)).toBeNull();
    expect(beatValueOf(0.25, null)).toBeNull();
    expect(beatSeconds(1 / 3, 0.5)).toBe(0.166667);
    expect(BEAT_VALUES.map(([, l]) => l)).toContain('1/16');
  });

  it('accents: set, round, from a pointer height', () => {
    expect(setAccent([1, 0.5], 1, 0.73)).toEqual([1, 0.75]);
    expect(setAccent([1, 0.5], 1, 0.5)).toBeNull();
    expect(setAccent([1, 0.5], 2, 1)).toBeNull();
    expect(setAccent([1, 0.5], 0, -1)).toEqual([0, 0.5]);
    expect(roundAccent(1.4)).toBe(1);
    expect(accentAtY(0, 36)).toBe(1);
    expect(accentAtY(36, 36)).toBe(0);
    expect(accentAtY(18, 36)).toBe(0.5);
    expect(accentAtY(5, 0)).toBe(0);
  });

  it('steps: add up to the cap, never remove the last', () => {
    expect(addStep([1])).toEqual([1, 0.5]);
    expect(addStep(new Array<number>(MAX_PATTERN).fill(1))).toBeNull();
    expect(removeStep([1, 0.5])).toEqual([1]);
    expect(removeStep([1])).toBeNull();
  });

  it('the lane mask: one bar per sounding step, the cycle as a share of the region', () => {
    const svg = patternSvg([1, 0, 0.5]);
    expect(svg.match(/<rect/g)).toHaveLength(2);
    expect(svg).toContain('viewBox="0 0 30 12"');
    expect(cycleShare(0.5, 2, 4)).toBe(25);
    expect(cycleShare(1, 4, 2)).toBe(200);
    expect(cycleShare(0, 4, 2)).toBe(100);
  });
});

describe('lane items for regions', () => {
  it('pulse and tune spans: estimate matches the compile', () => {
    const p = sounding([pulse(), tune({ id: 'tun', at: 9 })]);
    const s = compile(p);
    const errors = s.diagnostics.filter((d) => d.level === 'error');
    expect(errors).toEqual([]);
    const items = laneItems(p, s.momentSpans);
    const pi = items.find((x) => x.id === 'pls')!;
    const ti = items.find((x) => x.id === 'tun')!;
    expect([pi.start, pi.end]).toEqual([4, 8]);
    expect(ti.start).toBe(9);
    expect(ti.end).toBeCloseTo(12, 6);
    expect(estimateSpan(pulse(), G)).toEqual([4, 8]);
    expect(estimateSpan(tune({ at: 9 }), G)).toEqual([9, 12]);
    // Muted: estimated, the same region.
    const muted = laneItems({ ...p, moments: p.moments.map((m) => ({ ...m, muted: true })) }, []);
    expect(muted.find((x) => x.id === 'tun')).toMatchObject({ start: 9, end: 12 });
  });

  it('a tune that lands leads in by its own glide (0.1 s), not the piece glide', () => {
    const [start, end] = estimateSpan(tune({ glide: { land: true } }), G);
    expect(start).toBeCloseTo(3.9, 9);
    expect(end).toBe(7);
  });

  it('neither lands at the marker; their end handles edit the region and the last note', () => {
    const land: Glide = { ...G, land: true };
    expect(landsAtMarker(pulse(), land)).toBe(false);
    expect(landsAtMarker(tune(), land)).toBe(false);
    expect(endEditOf('pulse')).toBe('until');
    expect(endEditOf('tune')).toBe('notes');
    expect(endDragPatch(pulse(), G, 1.5, false)).toEqual({ until: 9.5 });
    expect(endDragPatch(pulse(), G, -10, false)).toEqual({ until: 4.5 });
    expect(endDragPatch(pulse(), G, 0, false)).toBeNull();
    expect(endDragPatch(tune(), G, 0.5, false)).toEqual({
      notes: [
        { pitch: 60, len: 1 },
        { pitch: 64, len: 0.5 },
        { pitch: 62, len: 2 },
      ],
    });
  });

  it('bar art: a pulse cycle share, tune dashes by time and pitch', () => {
    const a = laneArt(pulse(), 4, 8);
    expect(a).toMatchObject({ kind: 'pulse', share: 25 });
    // A restarting pulse: one cycle per restart, its first steps' accents.
    expect(laneArt(pulse({ restart: 2, pattern: [1] }), 4, 8)).toMatchObject({
      share: 50,
      svg: patternSvg([1, 1, 1, 1]),
    });
    const t = laneArt(tune(), 4, 7);
    expect(t?.kind).toBe('tune');
    if (t?.kind !== 'tune') return;
    expect(t.notes.map((n) => Math.round(n.left))).toEqual([0, 33, 50]);
    expect(t.notes.map((n) => Math.round(n.width))).toEqual([33, 17, 50]);
    // Highest note (64) on top, lowest (60) at the bottom.
    expect(t.notes.map((n) => n.top)).toEqual([100, 0, 50]);
    expect(laneArt(tune({ notes: [] }), 4, 4)).toBeUndefined();
    expect(laneArt(pulse(), 4, 4)).toBeUndefined();
  });
});

describe('moving regions', () => {
  it('a lane move carries a pulse’s until; the Time field keeps the region length', () => {
    const p = sounding([pulse()]);
    const moved = moveMomentsBy(p, ['pls'], 2).moments.find((m) => m.id === 'pls') as PulseMoment;
    expect([moved.at, moved.until]).toEqual([6, 10]);
    expect(atPatch(pulse(), 1)).toEqual({ at: 1, until: 5 });
    expect(atPatch(tune(), 1)).toEqual({ at: 1 });
  });
});

describe('defaults and the palette', () => {
  it('the palette lists pulse (R) and tune (E)', () => {
    expect(PALETTE.map((e) => e.type)).toEqual(expect.arrayContaining(['pulse', 'tune']));
    expect(
      momentTypeForKey({
        key: 'r',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe('pulse');
    expect(
      momentTypeForKey({
        key: 'e',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe('tune');
  });

  it('a new pulse: eighths for two bars with a tempo, 0.5 s for 4 s without', () => {
    const p = sounding();
    const s = compile(p);
    const free = defaultMoment('pulse', 2, 'zz', p, s);
    expect([free.step, free.until]).toEqual([0.5, 6]);
    const timed = { ...p, view: { ...p.view, gridBpm: 120, meter: 3 } };
    const m = defaultMoment('pulse', 2, 'zz', timed, compile(timed));
    expect(m.step).toBe(0.25);
    expect(m.until).toBe(5);
    expect(m.pattern.every((a) => a > 0 && a <= 1)).toBe(true);
  });

  it('greys pulse and tune out from silence, with the reason; enabled over a sounding note', () => {
    const silent: Piece = { ...newPiece({ seed: 3 }), moments: [] };
    const fx = paletteEffects(silent, compile(silent), 1);
    expect(fx.pulse.effect).toBe(false);
    expect(fx.tune.effect).toBe(false);
    expect(fx.tune.reason).toBeTruthy();
    const p = sounding();
    const on = paletteEffects(p, compile(p), 2);
    expect(on.pulse.effect).toBe(true);
    expect(on.tune.effect).toBe(true);
  });
});

describe('saving', () => {
  it('every field the inspector edits survives the file text (autosave) and a share link', async () => {
    const edited = sounding([
      pulse({ pattern: [1, 0, 0.35], mode: 'updown', strike: false, floor: 0.2, decay: 0.15 }),
      tune({ glide: { length: 0.04, land: true } }),
    ]);
    const back = parsePiece(JSON.parse(serializePiece(edited)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const shared = parsePiece(await decodeSharePayload(await encodeSharePayload(edited)));
    for (const p of [back.piece, shared.ok ? shared.piece : null]) {
      expect(p?.moments.find((m) => m.id === 'pls')).toEqual(edited.moments.at(-2));
      expect(p?.moments.find((m) => m.id === 'tun')).toEqual(edited.moments.at(-1));
    }
  });
});
