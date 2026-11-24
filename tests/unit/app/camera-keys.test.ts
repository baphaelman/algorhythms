/** Camera key editing (PLAN.md §15 M11.5 C3): the piece's mode and the key recipes. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KEY_GAP,
  addKey,
  cameraModeOf,
  deleteKey,
  keyStep,
  moveKey,
  panKey,
  viewKeysOf,
  withCameraKeys,
  withCameraMode,
  zoomKey,
} from '../../../src/app/editor/camera-keys';
import { cameraChoice } from '../../../src/app/export-options';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { CameraKey, Piece } from '../../../src/core/types';
import { autoCameraKeys, pieceCameraPath } from '../../../src/render/auto-camera';
import { cameraPathAt, keyOfCamera } from '../../../src/render/camera-path';

const piece = (): Piece => {
  const r = parsePiece(
    readFileSync(
      join(import.meta.dirname, '../../../examples/tidewater-hymn.algorhythms.json'),
      'utf8',
    ),
  );
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
};

const KEYS: CameraKey[] = [
  { at: 0, window: 8, place: 0.25, pitch: 60, range: 12 },
  { at: 10, window: 32, place: 0.5, pitch: 66, range: 24 },
  { at: 20, window: 16, place: 0.75, pitch: 62, range: 16 },
];

describe('camera mode', () => {
  it('a piece without camera is Auto; the dialog shows Whole piece only as its own choice', () => {
    const p = piece();
    expect(cameraModeOf(p)).toBe('auto');
    expect(cameraChoice({ videoCamera: 'follow' }, p)).toBe('auto');
    expect(cameraChoice({ videoCamera: 'whole' }, p)).toBe('whole');
    expect(cameraChoice({ videoCamera: 'auto' }, withCameraMode(p, 'follow'))).toBe('follow');
  });

  it('switching mode keeps the keys; the same mode is no change', () => {
    const p = withCameraKeys(piece(), KEYS);
    expect(p.camera).toEqual({ mode: 'keys', keys: KEYS });
    const f = withCameraMode(p, 'follow');
    expect(f.camera).toEqual({ mode: 'follow', keys: KEYS });
    expect(withCameraMode(f, 'follow')).toBe(f);
    expect(withCameraMode(piece(), 'auto').camera).toEqual({ mode: 'auto' });
  });

  it('the editor follows Keys, Auto (C2’s keys, as a 16:9 whole-piece video) and Follow', () => {
    const p = piece();
    const c = compile(p);
    expect(viewKeysOf(withCameraKeys(p, KEYS), c)).toEqual(KEYS);
    expect(viewKeysOf(withCameraMode(withCameraKeys(p, KEYS), 'follow'), c)).toBeNull();
    const auto = autoCameraKeys(c, { aspect: 16 / 9 });
    expect(auto.length).toBeGreaterThan(1);
    expect(viewKeysOf(p, c)).toEqual(auto);
    expect(viewKeysOf(withCameraMode(withCameraKeys(p, KEYS), 'auto'), c)).toEqual(auto);
    expect(viewKeysOf(withCameraMode(p, 'auto'), c)).toEqual(
      pieceCameraPath({ camera: { mode: 'auto' } }, c),
    );
    expect(viewKeysOf({ camera: { mode: 'keys', keys: [] } }, c)).toBeNull();
  });
});

describe('key recipes', () => {
  it('add inserts in time order; a key at the same time is replaced', () => {
    const k = { at: 5, window: 10, place: 0.4, pitch: 64, range: 20 };
    expect(addKey(KEYS, k)).toEqual({ keys: [KEYS[0], k, KEYS[1], KEYS[2]], index: 1 });
    expect(addKey(KEYS, { ...k, at: 30 }).index).toBe(3);
    const same = addKey(KEYS, { ...k, at: 10.01 });
    expect(same.index).toBe(1);
    expect(same.keys).toHaveLength(3);
    expect(same.keys[1]).toEqual({ ...k, at: 10 });
    expect(addKey([], { ...k, at: -1 }).keys[0].at).toBe(0);
  });

  it('a key added from the view it is seen in leaves the path there unchanged', () => {
    const t = 4;
    const cam = cameraPathAt(KEYS, t)!;
    const { keys } = addKey(KEYS, keyOfCamera({ ...cam, pitchRange: cam.pitchRange! }, t));
    const after = cameraPathAt(keys, t)!;
    expect(after.start).toBeCloseTo(cam.start, 9);
    expect(after.window).toBeCloseTo(cam.window, 9);
    expect(after.pitchRange![0]).toBeCloseTo(cam.pitchRange![0], 9);
  });

  it('move stops short of its neighbours and at 0; delete removes one', () => {
    expect(moveKey(KEYS, 1, 12)[1].at).toBe(12);
    expect(moveKey(KEYS, 1, 30)[1].at).toBe(20 - KEY_GAP);
    expect(moveKey(KEYS, 1, -5)[1].at).toBe(KEY_GAP);
    expect(moveKey(KEYS, 0, -5)[0].at).toBe(0);
    expect(moveKey(KEYS, 2, 99)[2].at).toBe(99);
    expect(deleteKey(KEYS, 1)).toEqual([KEYS[0], KEYS[2]]);
  });

  it('pan follows the pointer; zoom keeps the limits', () => {
    const k = KEYS[1];
    expect(panKey(k, 0.1, 0.25)).toEqual({ ...k, place: 0.6, pitch: 72 });
    expect(panKey(k, 2, 0).place).toBe(1);
    expect(zoomKey(k, 2, 'window').window).toBe(64);
    expect(zoomKey(k, 0.001, 'window').window).toBe(2);
    expect(zoomKey(k, 0.5, 'range').range).toBe(12);
    expect(zoomKey(k, 0.001, 'range').range).toBe(1);
    expect(zoomKey(k, NaN, 'range')).toBe(k);
  });

  it('marker keys: arrows move a second, Shift ten, Alt a tenth', () => {
    expect(keyStep('ArrowRight', { shift: false, alt: false })).toBe(1);
    expect(keyStep('ArrowLeft', { shift: true, alt: false })).toBe(-10);
    expect(keyStep('ArrowRight', { shift: false, alt: true })).toBe(0.1);
    expect(keyStep('ArrowUp', { shift: false, alt: false })).toBeNull();
  });
});
