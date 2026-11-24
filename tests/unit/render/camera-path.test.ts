/** The camera path (PLAN.md §15 M11.5 C1): keys eased, held outside, a start before 0. */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { crossfadePiece } from '../core/crossfade-fixtures';
import type { CameraKey, Piece } from '../../../src/core/types';
import {
  DEFAULT_KEY_EASE,
  cameraOfPose,
  cameraPathAt,
  cameraPoseAt,
  keyOfCamera,
  pieceCameraKeys,
} from '../../../src/render/camera-path';
import {
  MIN_WINDOW,
  cameraAt,
  cameraScore,
  drawScore,
  drawVideoFrameAt,
  timeToX,
  videoCamera,
  videoStyle,
} from '../../../src/render';
import { frameOptions } from '../../../src/app/video-export';
import { pathCtx } from './path-ctx';

const KEYS: CameraKey[] = [
  { at: 0, window: 8, place: 0.25, pitch: 60, range: 12 },
  { at: 10, window: 32, place: 0.5, pitch: 66, range: 24, ease: 'linear' },
  { at: 20, window: 16, place: 0.75, pitch: 62, range: 16 },
];

describe('cameraPoseAt', () => {
  it('is each key exactly at its time', () => {
    for (const k of KEYS) {
      expect(cameraPoseAt(KEYS, k.at)).toEqual({
        window: k.window,
        place: k.place,
        pitch: k.pitch,
        range: k.range,
      });
    }
  });

  it('holds the first key before it and the last after it', () => {
    const first = { window: 8, place: 0.25, pitch: 60, range: 12 };
    const last = { window: 16, place: 0.75, pitch: 62, range: 16 };
    const later = KEYS.map((k) => ({ ...k, at: k.at + 5 }));
    expect(cameraPoseAt(later, 0)).toEqual(first);
    expect(cameraPoseAt(later, -3)).toEqual(first);
    expect(cameraPoseAt(KEYS, 25)).toEqual(last);
    expect(cameraPoseAt(KEYS, 1e6)).toEqual(last);
  });

  it("eases with the earlier key's ease: linear, and smootherstep by default", () => {
    // Key 1 → 2 is linear: halfway is halfway (pitch, place, range), the window geometric.
    const mid = cameraPoseAt(KEYS, 15)!;
    expect(mid.pitch).toBeCloseTo(64, 12);
    expect(mid.place).toBeCloseTo(0.625, 12);
    expect(mid.range).toBeCloseTo(20, 12);
    expect(mid.window).toBeCloseTo(Math.sqrt(32 * 16), 9);
    // Key 0 → 1 has none: smootherstep, e(0.25) = 0.103515625.
    expect(DEFAULT_KEY_EASE).toBe('smootherstep');
    const e = 0.103515625;
    const q = cameraPoseAt(KEYS, 2.5)!;
    expect(q.pitch).toBeCloseTo(60 + 6 * e, 9);
    expect(q.window).toBeCloseTo(8 * Math.pow(4, e), 9);
    // Symmetric: halfway is the midpoint.
    expect(cameraPoseAt(KEYS, 5)!.pitch).toBeCloseTo(63, 12);
  });

  it('follows a bézier ease', () => {
    const keys: CameraKey[] = [
      {
        at: 0,
        window: 10,
        place: 0,
        pitch: 60,
        range: 12,
        ease: { kind: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      { at: 10, window: 10, place: 1, pitch: 70, range: 12 },
    ];
    expect(cameraPoseAt(keys, 3)!.pitch).toBeCloseTo(63, 6);
  });

  it('is continuous across keys and with equal times takes the later key', () => {
    for (const k of KEYS) {
      const a = cameraPoseAt(KEYS, k.at - 1e-9)!;
      const b = cameraPoseAt(KEYS, k.at)!;
      expect(a.pitch).toBeCloseTo(b.pitch, 6);
      expect(a.window).toBeCloseTo(b.window, 6);
    }
    const jump: CameraKey[] = [
      { at: 5, window: 10, place: 0.5, pitch: 60, range: 12 },
      { at: 5, window: 20, place: 0.5, pitch: 70, range: 12 },
    ];
    expect(cameraPoseAt(jump, 5)!.pitch).toBe(70);
    expect(cameraPoseAt(jump, 4)!.pitch).toBe(60);
  });

  it('sanitises a key (window ≥ 2 s, place 0..1, range ≥ 1) and is null without keys', () => {
    expect(cameraPoseAt([{ at: 0, window: 0.5, place: 3, pitch: 60, range: 0 }], 0)).toEqual({
      window: MIN_WINDOW,
      place: 1,
      pitch: 60,
      range: 1,
    });
    expect(cameraPoseAt([], 3)).toBeNull();
    expect(cameraPathAt([], 3)).toBeNull();
  });
});

describe('cameraPathAt', () => {
  it('puts the playhead at the place, the pitch range around the centre', () => {
    const cam = cameraPathAt(KEYS, 20)!;
    expect(cam.window).toBe(16);
    expect(cam.start).toBeCloseTo(20 - 0.75 * 16, 12);
    expect(cam.pitchRange).toEqual([54, 70]);
    expect(cam.free).toBe(true);
  });

  it('starts before 0 on an opening, and cameraAt keeps that start', () => {
    const cam = cameraPathAt([{ at: 0, window: 8, place: 0.25, pitch: 60, range: 12 }], 0)!;
    expect(cam.start).toBe(-2);
    const score = compile(crossfadePiece());
    const view = cameraAt(cameraScore(score), cam, 0, { width: 800, height: 400 });
    expect(view.start).toBe(-2);
    expect(view.tL).toBe(-2);
    expect(view.xHead).toBeCloseTo(200, 9);
    // Without `free` the start is clamped to 0, as before.
    const { free: _f, ...clamped } = cam;
    expect(cameraAt(cameraScore(score), clamped, 0, { width: 800, height: 400 }).start).toBe(0);
  });

  it('is a pure function of t, view-agnostic, and inverts with keyOfCamera', () => {
    const a = cameraPathAt(KEYS, 7.3);
    cameraPathAt(KEYS, 19);
    expect(cameraPathAt(KEYS, 7.3)).toEqual(a);
    const k = keyOfCamera(
      a as { start: number; window: number; pitchRange: [number, number] },
      7.3,
      'linear',
    );
    const back = cameraOfPose(k, 7.3);
    expect(back.start).toBeCloseTo(a!.start, 9);
    expect(back.window).toBeCloseTo(a!.window, 9);
    expect(back.pitchRange![0]).toBeCloseTo(a!.pitchRange![0], 9);
    expect(back.pitchRange![1]).toBeCloseTo(a!.pitchRange![1], 9);
    expect(k.ease).toBe('linear');
  });
});

describe('pieceCameraKeys', () => {
  it("is the keys only in mode 'keys' with keys", () => {
    expect(pieceCameraKeys({})).toBeNull();
    expect(pieceCameraKeys({ camera: { mode: 'follow', keys: KEYS } })).toBeNull();
    expect(pieceCameraKeys({ camera: { mode: 'keys' } })).toBeNull();
    expect(pieceCameraKeys({ camera: { mode: 'keys', keys: [] } })).toBeNull();
    expect(pieceCameraKeys({ camera: { mode: 'keys', keys: KEYS } })).toBe(KEYS);
    // TODO(C2): auto makes keys.
    expect(pieceCameraKeys({ camera: { mode: 'auto' } })).toBeNull();
  });
});

/** A short piece whose lines sound from 0. */
const opening = (): Piece => crossfadePiece();

describe('video frames on the camera path', () => {
  const piece = opening();
  const score = compile(piece);

  it('videoCamera keys = the path; without keys, Follow; other modes unchanged', () => {
    const opts = { aspect: '16:9' as const, window: 10, keys: KEYS };
    expect(videoCamera('keys', score, 15, opts)).toEqual(cameraPathAt(KEYS, 15));
    expect(videoCamera('auto', score, 15, opts)).toEqual(cameraPathAt(KEYS, 15));
    const { keys: _k, ...none } = opts;
    expect(videoCamera('keys', score, 6, none)).toEqual(videoCamera('follow', score, 6, none));
    expect(videoCamera('follow', score, 6, opts)).toEqual(videoCamera('follow', score, 6, none));
    expect(videoCamera('whole', score, 6, opts)).toEqual(videoCamera('whole', score, 6, none));
  });

  it('frameOptions takes the piece’s keys for Keys only, Auto’s from the options; a piece without camera has none', () => {
    const base = {
      aspect: '16:9' as const,
      size: '720' as const,
      fps: 30 as const,
      theme: 'light' as const,
      hud: true,
      thickness: true,
    };
    const withKeys: Piece = { ...piece, camera: { mode: 'keys', keys: KEYS } };
    expect(frameOptions(withKeys, { ...base, camera: 'keys' }).keys).toBe(KEYS);
    // Auto's keys are made from the score and come in the options (C3); the piece's are Keys'.
    expect(frameOptions(withKeys, { ...base, camera: 'auto' })).not.toHaveProperty('keys');
    expect(frameOptions(piece, { ...base, camera: 'auto', keys: KEYS }).keys).toBe(KEYS);
    expect(frameOptions(withKeys, { ...base, camera: 'follow' })).not.toHaveProperty('keys');
    expect(frameOptions(piece, { ...base, camera: 'keys' })).not.toHaveProperty('keys');
    // The camera field changes nothing for Follow and Whole.
    for (const camera of ['follow', 'whole'] as const) {
      expect(frameOptions(withKeys, { ...base, camera, window: 10 })).toEqual(
        frameOptions(piece, { ...base, camera, window: 10 }),
      );
    }
  });

  it('draws an opening at −2 s: blank paper before 0 (no lines, no bars), the playhead at its place', () => {
    const keys: CameraKey[] = [{ at: 0, window: 8, place: 0.25, pitch: 64, range: 24 }];
    const style = videoStyle({ theme: 'light', hud: false });
    const { ctx, strokes } = pathCtx();
    const opts = {
      aspect: '16:9' as const,
      size: '720' as const,
      camera: 'keys' as const,
      keys,
      style: { ...style, bars: { bpm: 120 }, futureOpacity: 1 },
    };
    const view = drawVideoFrameAt(ctx, score, opts, 0);
    expect(view.start).toBe(-2);
    const x0 = timeToX(view, 0);
    expect(x0).toBeCloseTo(view.width * 0.25, 9);
    expect(view.xHead).toBeCloseTo(x0, 9);
    // Every stroke but the horizontal guides lies at or right of x(0).
    let drawn = 0;
    for (const s of strokes) {
      const horizontal = s.pts.length === 2 && s.pts[0][1] === s.pts[1][1];
      if (horizontal) continue;
      for (const [x] of s.pts) {
        expect(x).toBeGreaterThanOrEqual(x0 - 1);
        drawn++;
      }
    }
    expect(drawn).toBeGreaterThan(10);
  });

  it('a piece without camera draws exactly as before (same strokes as a plain drawScore)', () => {
    const style = videoStyle({ theme: 'dark' });
    const a = pathCtx();
    const b = pathCtx();
    const fo = {
      aspect: '16:9' as const,
      size: '720' as const,
      camera: 'follow' as const,
      window: 6,
      style,
    };
    const view = drawVideoFrameAt(a.ctx, score, fo, 4);
    const cam = videoCamera('follow', score, 4, fo);
    expect(cam).not.toHaveProperty('free');
    drawScore(
      b.ctx,
      score,
      cam,
      style,
      4,
      { width: view.width, height: view.height },
      1280 / view.width,
    );
    expect(a.strokes).toEqual(b.strokes);
  });
});
