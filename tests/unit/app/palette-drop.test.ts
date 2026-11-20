import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/app/editor/actions', () => ({ addMoment: vi.fn() }));
vi.mock('../../../src/app/store', () => ({ currentTime: () => 0, usePlayer: {} }));
vi.mock('../../../src/app/editor/history', () => ({ select: vi.fn(), useEditor: {} }));
vi.mock('../../../src/app/loop', () => ({ onScoreFrame: () => () => undefined }));

import { droppedType, dropTime } from '../../../src/app/palette-drop';
import type { View } from '../../../src/render';

const view = { start: 10, pps: 50 } as View;

describe('palette drop', () => {
  it('maps x to time like the canvas, snapped to the grid', () => {
    expect(dropTime(view, 500)).toBe(20);
    expect(dropTime(view, 525)).toBeCloseTo(20.5);
    expect(dropTime(view, 527, 120)).toBe(20.5); // 20.54 -> nearest half-second beat
    expect(dropTime(view, 0)).toBe(10);
    expect(dropTime(view, -1000)).toBe(0); // never before 0
  });

  it('accepts only palette moment types', () => {
    expect(droppedType('chord')).toBe('chord');
    expect(droppedType('level')).toBe('level');
    expect(droppedType('nope')).toBeNull();
    expect(droppedType('')).toBeNull();
  });
});
