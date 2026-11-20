import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { piece } from './compiler-fixtures';

describe('compile smoke', () => {
  it('compiles every moment type without errors', () => {
    const p = piece({
      moments: [
        {
          type: 'split',
          at: 2,
          count: 3,
          notes: { kind: 'chord', symbol: 'Am7' },
          voicing: 'even',
          register: [48, 72],
        },
        { type: 'split', at: 8, count: 6, voicing: 'even' },
        {
          type: 'chord',
          at: 14,
          notes: { kind: 'degrees', degrees: [0, 2, 4, 6] },
          voicing: 'close',
          assign: 'ordered',
          register: [45, 75],
        },
        { type: 'shift', at: 20, by: 2, unit: 'scaleSteps' },
        { type: 'spread', at: 25, factor: 1.5, around: 'mean', snap: 'scale' },
        { type: 'key', at: 29, key: { tonic: 'D', scale: 'aeolian' } },
        {
          type: 'walk',
          at: 30,
          until: 40,
          grid: 0.5,
          density: 0.5,
          steps: [-2, -1, 1, 2],
          stepGlide: 0.3,
          bass: { leap: [5, 12] },
        },
        { type: 'pin', at: 33, voice: 'v2', pitch: 70 },
        { type: 'level', at: 35, gain: 0.5, over: 2 },
        { type: 'unison', at: 42, pitch: 'center', octaves: false },
        { type: 'merge', at: 50, count: 2, which: 'top', fade: 2 },
      ],
    });
    const s = compile(p);
    expect(s.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });
});
