/** Snapping to note changes (PLAN.md §11.3 revision 7 "Snapping and bars"). */
import { describe, expect, it } from 'vitest';
import { momentArrivals } from '../../../src/app/editor/arrival-points';
import { edgePitch, inRange } from '../../../src/app/editor/drag-edge';
import {
  SNAP_PX,
  changePoints,
  dotSnaps,
  nearestPoint,
  ofMoments,
  ofVoice,
  snapTime,
  type ChangePoint,
} from '../../../src/app/editor/snap';
import { compile } from '../../../src/core/compiler/compile';
import type { Moment, Piece } from '../../../src/core/types';
import { yToPitch, type View } from '../../../src/render';
import { piece } from '../core/compiler-fixtures';

const make = (): Piece =>
  piece({
    start: [48, 55, 60, 64],
    key: { tonic: 'C', scale: 'major' },
    glide: { length: 2, jitter: 0, stagger: 0 },
    end: { at: 40, fade: 1 },
    moments: [
      { id: 'sh', type: 'shift', at: 1, by: 2, unit: 'semitones' },
      {
        id: 'w',
        type: 'walk',
        at: 10,
        until: 14,
        grid: 1,
        density: 1,
        steps: [-1, 1],
        stepGlide: 0.25,
      },
      { id: 'n', type: 'note', at: 20, from: 62, to: 64 },
    ],
  });
const byId = (p: Piece, id: string): Moment => p.moments.find((m) => m.id === id)!;

describe('snap to note changes', () => {
  const pts: ChangePoint[] = [
    { t: 1, momentId: 'a' },
    { t: 3, momentId: 'a', voice: 0 },
    { t: 3.05, momentId: 'b', voice: 1 },
    { t: 7 },
  ];

  it('snaps within 8 px at the current zoom; zoomed in, the time stays free', () => {
    // 10 px/s: reach 0.8 s.
    expect(snapTime(3.5, { points: pts }, 10)).toBe(3.05);
    expect(snapTime(6.3, { points: pts }, 10)).toBe(7);
    expect(snapTime(5, { points: pts }, 10)).toBe(5);
    // 1000 px/s: reach 8 ms.
    expect(snapTime(3.02, { points: pts }, 1000)).toBe(3.02);
    expect(snapTime(3.045, { points: pts }, 1000)).toBe(3.05);
    // Just inside the threshold still snaps.
    expect(snapTime(7 + (SNAP_PX - 0.5) / 100, { points: pts }, 100)).toBe(7);
  });

  it('Alt leaves it free (to the ms, never below 0)', () => {
    expect(snapTime(3.0004, { points: pts }, 10, true)).toBe(3);
    expect(snapTime(-1, { points: pts }, 10, true)).toBe(0);
    expect(snapTime(-1, { points: [] }, 10)).toBe(0);
  });

  it('skips the dragged item’s own points', () => {
    expect(nearestPoint(3, pts, 0.1)).toBe(3);
    expect(nearestPoint(3, pts, 0.1, ofMoments(['a']))).toBe(3.05);
    expect(nearestPoint(3, pts, 0.1, ofVoice('b', 1))).toBe(3);
    expect(nearestPoint(1, pts, 0.1, ofVoice('a', 5))).toBeNull(); // the moment's own time
    expect(nearestPoint(3, pts, 0.1, ofVoice('a', 1))).toBe(3); // another voice's point stays
  });

  it('tries preferred times first (a walk step’s sibling steps)', () => {
    expect(snapTime(3.04, { points: pts, prefer: [2.5] }, 10)).toBe(2.5);
    expect(snapTime(3.04, { points: pts, prefer: [1.5] }, 10)).toBe(3.05);
  });

  it('collects moving segments’ ends and moment times from the score, sorted', () => {
    const p = make();
    const s = compile(p);
    const c = changePoints(s, p);
    expect(c).toBe(changePoints(s, p)); // cached
    for (let i = 1; i < c.length; i++) expect(c[i].t).toBeGreaterThanOrEqual(c[i - 1].t);
    const ts = new Set(c.map((x) => Math.round(x.t * 1000) / 1000));
    expect(ts.has(1)).toBe(true); // shift starts
    expect(ts.has(3)).toBe(true); // and arrives
    expect(ts.has(20)).toBe(true); // note point
    for (const st of s.walkSteps) expect(ts.has(Math.round(st.t * 1000) / 1000)).toBe(true);
    // A hold (p0 === p1) is not a change.
    expect(c.some((x) => x.t > 4 && x.t < 10)).toBe(false);
  });

  it('a walk step prefers its walk’s other steps and ignores the walk’s points otherwise', () => {
    const p = make();
    const s = compile(p);
    const dots = momentArrivals(s, byId(p, 'w'));
    const set = dotSnaps(s, p, dots[0]);
    expect(set.prefer).toHaveLength(dots.length - 1);
    const own = set.points.filter((x) => x.momentId === 'w');
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((x) => set.exclude!(x))).toBe(true);
    // Another dot: only its own voice's points in its moment are skipped.
    const sh = momentArrivals(s, byId(p, 'sh'))[0];
    const ex = dotSnaps(s, p, sh).exclude!;
    expect(ex({ t: 3, momentId: 'sh', voice: sh.voice })).toBe(true);
    expect(ex({ t: 3, momentId: 'sh', voice: (sh.voice ?? 0) + 1 })).toBe(false);
  });
});

describe('drag past the view edge', () => {
  const view = { padT: 20, padB: 40, height: 300, pLo: 48, pHi: 72 } as View;

  it('clamps the pointer to the plot area, so the pitch stops at the edge', () => {
    expect(edgePitch(view, 1000)).toBe(48);
    expect(edgePitch(view, -500)).toBe(72);
    expect(edgePitch(view, 150)).toBeCloseTo(yToPitch(view, 150), 9);
  });

  it('clamps to the voice range without folding', () => {
    expect(inRange(20, [36, 96])).toBe(36);
    expect(inRange(100, [36, 96])).toBe(96);
    expect(inRange(50.5, [36, 96])).toBe(50.5);
    expect(inRange(200)).toBe(127);
  });
});
