import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/app/editor/actions', () => ({ addMoment: vi.fn() }));
vi.mock('../../../src/app/store', () => ({ currentTime: () => 0, usePlayer: {} }));
vi.mock('../../../src/app/editor/history', () => ({ select: vi.fn(), useEditor: {} }));
vi.mock('../../../src/app/loop', () => ({ onScoreFrame: () => () => undefined }));
vi.mock('../../../src/app/preview', () => ({
  previewState: { drag: false },
  startPreview: vi.fn(),
  stopPreview: vi.fn(),
}));

import { droppedType, dropTime } from '../../../src/app/palette-drop';
import type { View } from '../../../src/render';

const view = { start: 10, pps: 50 } as View;

describe('palette drop', () => {
  it('maps x to time like the canvas, snapped to a note change within 8 px', () => {
    const none = { points: [] };
    expect(dropTime(view, 500, none)).toBe(20);
    expect(dropTime(view, 525, none)).toBeCloseTo(20.5);
    const near = { points: [{ t: 20.6 }] };
    expect(dropTime(view, 527, near)).toBe(20.6); // 20.54: 3 px from the change
    expect(dropTime(view, 515, near)).toBe(20.3); // 15 px away: free
    expect(dropTime(view, 0, none)).toBe(10);
    expect(dropTime(view, -1000, none)).toBe(0); // never before 0
  });

  it('accepts only palette moment types', () => {
    expect(droppedType('chord')).toBe('chord');
    expect(droppedType('level')).toBe('level');
    expect(droppedType('nope')).toBeNull();
    expect(droppedType('')).toBeNull();
  });
});
