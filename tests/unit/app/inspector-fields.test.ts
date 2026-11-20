import { describe, expect, it } from 'vitest';
import {
  chordFeedback,
  degreeCells,
  easePath,
  formatNum,
  formatPitch,
  formatPitchList,
  formatTime,
  keyAt,
  parseIntList,
  parseNum,
  parsePitch,
  parsePitchList,
  toggleDegree,
} from '../../../src/app/ui/inspector/fields';
import type { Key } from '../../../src/core/types';

const C: Key = { tonic: 'C', scale: 'major' };
const Ddor: Key = { tonic: 'D', scale: 'dorian' };

describe('inspector fields', () => {
  it('formats and parses numbers', () => {
    expect(formatNum(3)).toBe('3');
    expect(formatNum(0.25)).toBe('0.25');
    expect(formatNum(1 / 3)).toBe('0.333');
    expect(formatNum(-1.5, 1)).toBe('-1.5');
    expect(parseNum(' 2.5 ')).toBe(2.5);
    expect(parseNum('1,5')).toBe(1.5);
    expect(parseNum('−2')).toBe(-2);
    expect(parseNum('abc')).toBeNull();
    expect(parseNum('')).toBeNull();
    expect(parseNum('5', 0, 4)).toBeNull();
  });

  it('formats times', () => {
    expect(formatTime(42.31)).toBe('0:42.3');
    expect(formatTime(61)).toBe('1:01.0');
    expect(formatTime(59.97)).toBe('1:00.0');
  });

  it('parses pitches as numbers or note names', () => {
    expect(parsePitch('60')).toBe(60);
    expect(parsePitch('60.5')).toBe(60.5);
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('F#3')).toBe(54);
    expect(parsePitch('Bb2')).toBe(46);
    expect(parsePitch('a4+50')).toBe(69.5);
    expect(parsePitch('Cb4')).toBe(59);
    expect(parsePitch('H4')).toBeNull();
    expect(parsePitch('200')).toBeNull();
    expect(formatPitch(61)).toBe('C#4');
    expect(formatPitch(61.25)).toBe('61.25');
  });

  it('round-trips pitch and integer lists', () => {
    expect(parsePitchList('C4, E4 67')).toEqual([60, 64, 67]);
    expect(parsePitchList('C4 X')).toBeNull();
    expect(parsePitchList('  ')).toBeNull();
    expect(formatPitchList([60, 64, 67.5])).toBe('C4 E4 67.5');
    expect(parseIntList('-2, -1 1 2')).toEqual([-2, -1, 1, 2]);
    expect(parseIntList('1.5')).toBeNull();
  });

  it('finds the key in effect', () => {
    const keys = [
      { t: 0, key: C },
      { t: 10, key: Ddor },
    ];
    expect(keyAt({ keys }, 5, Ddor)).toBe(C);
    expect(keyAt({ keys }, 10, C)).toBe(Ddor);
    expect(keyAt({ keys: [] }, 3, Ddor)).toBe(Ddor);
  });

  it('gives chord feedback', () => {
    expect(chordFeedback('Am7', C)).toEqual({ ok: true, text: 'A C E G' });
    expect(chordFeedback('ii7', C)).toEqual({ ok: true, text: 'D F A C' });
    expect(chordFeedback('Bb', { tonic: 'F', scale: 'major' })).toEqual({
      ok: true,
      text: 'Bb D F',
    });
    const bad = chordFeedback('Xq', C);
    expect(bad.ok).toBe(false);
    expect(bad.text.length).toBeGreaterThan(0);
  });

  it('builds degree cells and toggles degrees', () => {
    const cells = degreeCells(Ddor, [0, 2, 4]);
    expect(cells).toHaveLength(14);
    expect(cells[0]).toEqual({ degree: 0, label: '1', note: 'D' });
    expect(cells[2].note).toBe('F');
    expect(degreeCells(C, [-1, 20]).map((c) => c.degree)[0]).toBe(-1);
    expect(degreeCells(C, [20]).at(-1)?.degree).toBe(20);
    expect(toggleDegree([0, 4], 2)).toEqual([0, 2, 4]);
    expect(toggleDegree([0, 2, 4], 2)).toEqual([0, 4]);
  });

  it('draws ease paths inside the box', () => {
    const lin = easePath('linear', 100, 50, 4);
    expect(lin).toBe('M0 50 L25 37.5 L50 25 L75 12.5 L100 0');
    const over = easePath({ kind: 'bezier', x1: 0.3, y1: 1.6, x2: 0.7, y2: -0.6 }, 100, 50);
    for (const m of over.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
      expect(Number(m[2])).toBeGreaterThanOrEqual(0);
      expect(Number(m[2])).toBeLessThanOrEqual(50);
    }
  });
});
