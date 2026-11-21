/**
 * Score selection and grouped note changes (PLAN.md §11.3 revision 7): group-move math, join and
 * split rules, marquee hit testing, line-section owners. Pure.
 */
import { describe, expect, it } from 'vitest';
import { momentArrivals, type ArrivalDot } from '../../../src/app/editor/arrival-points';
import { chordNotes } from '../../../src/app/editor/chord-notes';
import { isDot, pickedIn } from '../../../src/app/editor/dot-selection';
import {
  dotsInRect,
  groupTargets,
  moveDots,
  noteHostAt,
  type MoveEnv,
} from '../../../src/app/editor/group-move';
import { momentText } from '../../../src/app/editor/lane';
import { sectionOwner } from '../../../src/app/editor/section';
import { compile } from '../../../src/core/compiler/compile';
import { noteChanges } from '../../../src/core/moments/note';
import type { Key, NoteMoment, Piece } from '../../../src/core/types';
import { piece } from '../core/compiler-fixtures';

const C: Key = { tonic: 'C', scale: 'major' };
const dot = (t: number, pitch: number, extra: Partial<ArrivalDot> = {}): ArrivalDot => ({
  momentId: 'm',
  type: 'shift',
  t,
  pitch,
  ...extra,
});

describe('groupTargets', () => {
  it('moves every dot by the grabbed dot’s scale steps and time offset', () => {
    const a = dot(1, 60);
    const b = dot(2, 64);
    const c = dot(3, 61); // C♯: off the scale, keeps its offset
    const out = groupTargets([a, b, c], a, 64, 1.5, () => C, false);
    expect(out.map((m) => [m.pitch, m.t])).toEqual([
      [64, 1.5],
      [67, 2.5],
      [65, 3.5], // C (snapped down) up two steps is E, plus the sharp
    ]);
  });

  it('chromatic: the same semitones; a vertical drag keeps every time exactly', () => {
    const a = dot(1, 60);
    const b = dot(2.123456789, 64);
    const out = groupTargets([a, b], a, 61, 1, () => C, true);
    expect(out.map((m) => [m.pitch, m.t])).toEqual([
      [61, 1],
      [65, 2.123456789],
    ]);
  });

  it('a sideways drag keeps every pitch exactly, never before 0, ranges clamp', () => {
    const a = dot(2, 60.3);
    const b = dot(0.5, 64);
    expect(groupTargets([a, b], a, 60.3, 1, () => C, false).map((m) => [m.pitch, m.t])).toEqual([
      [60.3, 1],
      [64, 0],
    ]);
    const up = groupTargets(
      [a, b],
      a,
      72,
      2,
      () => C,
      true,
      () => [36, 70],
    );
    expect(up[1].pitch).toBe(70);
  });
});

describe('dotsInRect', () => {
  it('selects the dots inside, any corner order, edges included', () => {
    const ds = [dot(1, 60), dot(2, 62), dot(3, 64)];
    const x = (t: number) => t * 100;
    const y = (p: number) => 1000 - p * 10;
    expect(dotsInRect(ds, { x0: 250, y0: 350, x1: 100, y1: 400 }, x, y)).toEqual([ds[0], ds[1]]);
    expect(dotsInRect(ds, { x0: 0, y0: 0, x1: 10, y1: 10 }, x, y)).toEqual([]);
  });
});

describe('dot identity', () => {
  it('finds a selected dot by place, else by step or voice', () => {
    const s = dot(3, 60, { voice: 2 });
    expect(isDot(s, dot(3.01, 60.1))).toBe(true);
    expect(isDot(s, dot(4, 62, { voice: 2 }))).toBe(true);
    expect(isDot(s, dot(4, 62, { voice: 1 }))).toBe(false);
    expect(isDot(s, { ...s, momentId: 'x' })).toBe(false);
    expect(pickedIn([s], [dot(4, 62, { voice: 1 }), dot(3, 60, { voice: 5 })])).toEqual([
      false,
      true,
    ]);
  });
});

/** Notes at 2 and 6 on a 4-voice piece, a shift at 10. */
function base(): Piece {
  return piece({
    start: [48, 55, 60, 64],
    key: C,
    glide: { length: 1, jitter: 0, stagger: 0 },
    end: { at: 30, fade: 1 },
    moments: [
      { id: 'a', type: 'note', at: 2, from: 60, to: 62 },
      { id: 'b', type: 'note', at: 6, from: 64, to: 65 },
      { id: 'sh', type: 'shift', at: 10, by: 1, unit: 'scaleSteps' },
    ],
  });
}

function env(p: Piece): MoveEnv {
  const score = compile(p);
  return {
    score,
    chordNotes: (m) => chordNotes(p, score, m),
    keep: false,
    order: undefined,
    ids: ['new1', 'new2', 'new3'],
  };
}

const dotsOf = (p: Piece, id: string) =>
  momentArrivals(
    compile(p),
    p.moments.find((m) => m.id === id)!,
  );
const noteOf = (p: Piece, id: string) => p.moments.find((m) => m.id === id) as NoteMoment;

describe('moveDots: grouped note changes', () => {
  it('a note dot moved onto another note’s time joins it (one Shift moment)', () => {
    const p = base();
    const d = dotsOf(p, 'b')[0];
    const r = moveDots(p, [{ dot: d, pitch: d.pitch, t: d.t - 4 }], env(p));
    expect(r.piece.moments.map((m) => m.id)).toEqual(['a', 'sh']);
    expect(noteChanges(noteOf(r.piece, 'a'))).toEqual([
      { from: 60, to: 62 },
      { from: 64, to: 65 },
    ]);
    expect(r.hosts).toEqual(['a']);
    const s = compile(r.piece);
    expect(s.diagnostics.map((x) => x.code)).toEqual([]);
  });

  it('a lone note moved sideways keeps its id (its time moves, glide kept)', () => {
    const p = base();
    const d = dotsOf(p, 'b')[0];
    const r = moveDots(p, [{ dot: d, pitch: 67, t: d.t + 1.5 }], env(p));
    const b = noteOf(r.piece, 'b');
    expect(b).toMatchObject({ at: 7.5, from: 64, to: 67 });
    expect(r.hosts).toEqual(['b']);
  });

  it('dragging one change of a Shift away splits it into its own moment', () => {
    const p = base();
    const joined = moveDots(p, [{ dot: dotsOf(p, 'b')[0], pitch: 65, t: 3 }], env(p)).piece;
    const [d0, d1] = dotsOf(joined, 'a');
    expect([d0.change, d1.change]).toEqual([0, 1]);
    const r = moveDots(joined, [{ dot: d1, pitch: d1.pitch, t: d1.t + 2 }], env(joined));
    expect(noteOf(r.piece, 'a')).toMatchObject({ at: 2, from: 60, to: 62 });
    expect(noteOf(r.piece, 'a').changes).toBeUndefined();
    expect(noteOf(r.piece, 'new1')).toMatchObject({ at: 4, from: 64, to: 65 });
    expect(r.hosts).toEqual(['new1']);
    // A vertical drag of one change stays in its moment.
    const v = moveDots(joined, [{ dot: d1, pitch: 67, t: d1.t }], env(joined));
    expect(noteChanges(noteOf(v.piece, 'a'))).toEqual([
      { from: 60, to: 62 },
      { from: 64, to: 67 },
    ]);
  });

  it('both changes of a Shift moved together move the moment', () => {
    const p = base();
    const joined = moveDots(p, [{ dot: dotsOf(p, 'b')[0], pitch: 65, t: 3 }], env(p)).piece;
    const ds = dotsOf(joined, 'a');
    const moves = groupTargets(ds, ds[0], ds[0].pitch, ds[0].t + 1, () => C, false);
    const r = moveDots(joined, moves, env(joined));
    expect(noteOf(r.piece, 'a').at).toBe(3);
    expect(noteChanges(noteOf(r.piece, 'a'))).toHaveLength(2);
    expect(r.piece.moments).toHaveLength(2);
  });

  it('overrides on other moments stay overrides; one recipe moves them all', () => {
    const p = base();
    const sh = dotsOf(p, 'sh');
    const a = dotsOf(p, 'a')[0];
    const moves = groupTargets([sh[0], sh[1], a], sh[0], sh[0].pitch + 2, sh[0].t, () => C, true);
    const r = moveDots(p, moves, env(p));
    const shift = r.piece.moments.find((m) => m.id === 'sh')!;
    expect(shift.overrides).toHaveLength(2);
    expect(shift.overrides!.map((o) => o.pitch)).toEqual([sh[0].pitch + 2, sh[1].pitch + 2]);
    expect(noteOf(r.piece, 'a').to).toBe(64);
  });

  it('noteHostAt: an unmuted note at that time', () => {
    const p = base();
    expect(noteHostAt(p, 2 + 5e-5)?.id).toBe('a');
    expect(noteHostAt(p, 2.01)).toBeNull();
    expect(noteHostAt(p, 10)).toBeNull();
  });
});

describe('sectionOwner', () => {
  it('a glide and the hold after it belong to the moment; before any move, none', () => {
    const p = base();
    const s = compile(p);
    expect(sectionOwner(s, 2, 2.5)).toBe('a');
    expect(sectionOwner(s, 2, 5)).toBe('a');
    expect(sectionOwner(s, 2, 1)).toBeNull();
    expect(sectionOwner(s, 2, 10.5)).toBe('sh');
  });
});

describe('lane label', () => {
  it('a note with several changes reads "Shift"', () => {
    const one = { id: 'n', type: 'note', at: 0, from: 60, to: 62 } as NoteMoment;
    expect(momentText(one)).toBe('note');
    const two = {
      id: 'n',
      type: 'note',
      at: 0,
      changes: [
        { from: 60, to: 62 },
        { from: 64, to: 65 },
      ],
    } as NoteMoment;
    expect(momentText(two)).toBe('Shift');
  });
});
