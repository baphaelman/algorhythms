/** Note point helpers (PLAN.md §11.3 Note points, revision 6). */
import { describe, expect, it } from 'vitest';
import {
  DOUBLE_MS,
  isDoublePress,
  noteArrival,
  noteFrom,
  noteHarmony,
  stepNoteTo,
} from '../../../src/app/editor/note-points';
import { compile } from '../../../src/core/compiler/compile';
import type { Key, NoteMoment } from '../../../src/core/types';
import { piece } from '../core/compiler-fixtures';

const C_MAJOR: Key = { tonic: 'C', scale: 'major' };
const note: NoteMoment = { id: 'n', type: 'note', at: 2, from: 64, to: 65 };
const base = (m: NoteMoment = note) =>
  piece({
    start: [48, 55, 60, 64],
    key: C_MAJOR,
    glide: { length: 1, jitter: 0, stagger: 0 },
    moments: [m],
  });

describe('note points', () => {
  it('detects a double press close in time and place', () => {
    const a = { x: 10, y: 10, time: 1000 };
    expect(isDoublePress(null, a)).toBe(false);
    expect(isDoublePress(a, { x: 12, y: 11, time: 1200 })).toBe(true);
    expect(isDoublePress(a, { x: 30, y: 10, time: 1200 })).toBe(false);
    expect(isDoublePress(a, { x: 10, y: 10, time: 1000 + DOUBLE_MS + 1 })).toBe(false);
  });

  it('takes `from` from the clicked voice, else the nearest sounding line', () => {
    const s = compile(base());
    expect(noteFrom(s, 2, 1, 60)).toBe(60);
    // Voice 7 never sounds: the nearest line to 54.6 is 55.
    expect(noteFrom(s, 7, 1, 54.6)).toBe(55);
  });

  it('steps `to` by a scale step in the key', () => {
    expect(stepNoteTo(64, 1, C_MAJOR)).toBe(65);
    expect(stepNoteTo(65, -1, C_MAJOR)).toBe(64);
    expect(stepNoteTo(61, 1, C_MAJOR)).toBe(62);
    expect(stepNoteTo(127, 1, C_MAJOR)).toBe(127);
  });

  it('places the dot where `to` arrives, not at the return', () => {
    const back = { ...note, back: 2 };
    expect(noteArrival(compile(base(back)), back)).toBeCloseTo(3, 6);
    // No effect: at the moment's time.
    const off = { ...note, from: 70, to: 71 };
    expect(noteArrival(compile(base(off)), off)).toBe(2);
  });

  it('names the chord before and after', () => {
    const h = noteHarmony(compile(base()), note);
    expect(h.after).not.toBeNull();
    expect(h.after).not.toBe(h.before);
    // from = to: no new harmony; before = after.
    const same = { ...note, to: 64 };
    const k = noteHarmony(compile(base(same)), same);
    expect(k.after).toBe(k.before);
  });
});
