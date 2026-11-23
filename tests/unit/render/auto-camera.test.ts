/**
 * The Auto camera (PLAN.md §15 M11.5 C2): keys made from the piece. Tight on the first note,
 * the whole piece at the end, smooth, every drawn note in frame except where it leans in, a lean
 * at Crease's crossing, valid keys for every example and composition.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPiece } from '../../../src/core/canonical';
import { compile } from '../../../src/core/compiler/compile';
import { evalSegment } from '../../../src/core/segment';
import { parsePiece } from '../../../src/core/schema';
import type { CameraKey, CompiledScore, Piece } from '../../../src/core/types';
import {
  AUTO_WINDOW,
  MAX_PAN_RATE,
  MAX_PLACE_RATE,
  MAX_PULL_RATE,
  MAX_ZOOM_RATE,
  MIN_RANGE,
  autoCameraKeys,
  autoCameraPlan,
  pieceCameraPath,
} from '../../../src/render/auto-camera';
import { cameraPathAt, cameraPoseAt } from '../../../src/render/camera-path';
import { opacityAt } from '../../../src/render/level';
import { VIDEO_RATIO, endCardCamera, videoCamera } from '../../../src/render/video';
import { frameOptions } from '../../../src/app/video-export';

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const files = [
  ...readdirSync(EXAMPLES).filter((f) => f.endsWith('.algorhythms.json')),
  ...readdirSync(join(EXAMPLES, 'compositions'))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => `compositions/${f}`),
];

function load(file: string): Piece {
  const r = parsePiece(readFileSync(join(EXAMPLES, file), 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

const scores = new Map<string, CompiledScore>();
const score = (file: string): CompiledScore => {
  let c = scores.get(file);
  if (!c) scores.set(file, (c = compile(load(file))));
  return c;
};
const CREASE = 'compositions/crease.algorhythms.json';

/** Drawn pitches (opacity ≥ 0.1, as the camera reads them) at t. */
function drawn(c: CompiledScore, t: number): number[] {
  const out: number[] = [];
  for (const v of c.voices) {
    if (opacityAt(v, t) < 0.1) continue;
    const s = v.segments.find((x) => x.t0 <= t && t <= x.t1);
    if (s) out.push(evalSegment(s, t));
  }
  return out;
}

const inside = (t: number, spans: { start: number; end: number }[]) =>
  spans.some((s) => t >= s.start && t <= s.end);

describe('autoCameraPlan', () => {
  it('is deterministic: the same keys from a fresh compile', () => {
    const a = autoCameraPlan(compile(load(CREASE)));
    const b = autoCameraPlan(compile(load(CREASE)));
    expect(a).toEqual(b);
  });

  it('opens tight on the first note: half the widest window, 14 st about it', () => {
    const c = score(CREASE);
    const [k0] = autoCameraPlan(c).keys;
    const first = c.voices.flatMap((v) => v.segments).reduce((x, y) => (y.t0 < x.t0 ? y : x));
    expect(k0.at).toBeCloseTo(first.t0, 1);
    expect(k0.window).toBe(AUTO_WINDOW / 2);
    expect(k0.range).toBe(MIN_RANGE);
    expect(Math.abs(k0.pitch - first.p0)).toBeLessThan(k0.range / 4);
    // At 0 the view starts before 0: blank paper, the first note at the playhead's place.
    expect(cameraPathAt(autoCameraPlan(c).keys, 0)!.start).toBeLessThan(0);
  });

  it('ends on the whole piece: the end card camera, at any aspect', () => {
    for (const file of [CREASE, 'kite-day.algorhythms.json'].map((f) =>
      f.startsWith('compositions') ? f : `compositions/${f}`,
    )) {
      const c = score(file);
      for (const aspect of ['16:9', '9:16', '1:1'] as const) {
        const keys = autoCameraKeys(c, { aspect: VIDEO_RATIO[aspect] });
        const cam = videoCamera('auto', c, c.duration, { aspect, keys });
        const end = endCardCamera(c, { aspect, size: '720', camera: 'auto', style: {} as never });
        expect(cam.start, `${file} ${aspect}`).toBeCloseTo(end.start, 2);
        expect(cam.window).toBeCloseTo(end.window, 2);
        expect(cam.pitchRange![0]).toBeCloseTo(end.pitchRange![0], 5);
        expect(cam.pitchRange![1]).toBeCloseTo(end.pitchRange![1], 5);
      }
    }
  });

  it('leans in at Crease’s crossing (every line on D4 at 79.5 s), then opens again', () => {
    const c = score(CREASE);
    const plan = autoCameraPlan(c);
    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0]).toBeCloseTo(79.5, 0);
    const at = (t: number) => cameraPoseAt(plan.keys, t)!;
    const x = plan.crossings[0];
    expect(at(x).window).toBeLessThan(0.7 * at(x - 8).window);
    expect(at(x).range).toBeLessThan(0.85 * at(x - 8).range);
    expect(at(x + 8).window).toBeGreaterThan(1.4 * at(x).window);
    // The meeting point (D4) is in frame.
    expect(Math.abs(at(x).pitch - 62)).toBeLessThan(at(x).range / 2 - 2);
  });

  it('a section frames its own span: tight on its first notes, its whole at the end', () => {
    const c = score(CREASE);
    const span = { start: 30, end: 60 };
    const keys = autoCameraKeys(c, { span });
    expect(keys[0].at).toBeCloseTo(30, 6);
    const last = keys[keys.length - 1];
    expect(last.at).toBe(60);
    expect(last.window).toBe(30);
    expect(last.place).toBe(1);
  });

  for (const file of files) {
    describe(file, () => {
      const plan = () => autoCameraPlan(score(file));

      it('valid keys: few, sorted, stored as is (schema, canonical numbers)', () => {
        const c = score(file);
        const { keys } = plan();
        expect(keys.length).toBeGreaterThanOrEqual(2);
        expect(keys.length).toBeLessThanOrEqual(6 + c.duration / 8);
        for (let i = 1; i < keys.length; i++) expect(keys[i].at).toBeGreaterThan(keys[i - 1].at);
        const piece = { ...load(file), camera: { mode: 'keys' as const, keys: [...keys] } };
        const r = parsePiece(JSON.parse(JSON.stringify(piece)));
        expect(r.ok, r.ok ? '' : r.errors.join('; ')).toBe(true);
        expect(canonicalPiece(piece).camera).toEqual(piece.camera);
      });

      it('smooth: zoom, pan and place rates within the bounds (the pull-back its own)', () => {
        const c = score(file);
        const { keys, pullBack } = plan();
        const dt = 0.05;
        let worst = { zoom: 0, pan: 0, place: 0, pull: 0 };
        for (let t = 0; t < c.duration - dt; t += dt) {
          const a = cameraPoseAt(keys, t)!;
          const b = cameraPoseAt(keys, t + dt)!;
          const zoom =
            Math.max(
              Math.abs(Math.log(b.window / a.window)),
              Math.abs(Math.log(b.range / a.range)),
            ) / dt;
          const pan = Math.abs(b.pitch - a.pitch) / Math.min(a.range, b.range) / dt;
          const place = Math.abs(b.place - a.place) / dt;
          if (t >= pullBack.start - 1e-9) worst.pull = Math.max(worst.pull, zoom);
          else
            worst = {
              ...worst,
              zoom: Math.max(worst.zoom, zoom),
              pan: Math.max(worst.pan, pan),
              place: Math.max(worst.place, place),
            };
        }
        expect(worst.zoom).toBeLessThanOrEqual(MAX_ZOOM_RATE * 1.01);
        expect(worst.pan).toBeLessThanOrEqual(MAX_PAN_RATE * 1.01);
        expect(worst.place).toBeLessThanOrEqual(MAX_PLACE_RATE * 1.01);
        expect(worst.pull).toBeLessThanOrEqual(MAX_PULL_RATE * 1.01);
      });

      it('every drawn note is in frame, except where it leans in and pulls back', () => {
        const c = score(file);
        const { keys, leans, pullBack } = plan();
        const out: string[] = [];
        for (let t = 0; t < pullBack.start; t += 0.25) {
          if (inside(t, leans)) continue;
          const cam = cameraPathAt(keys, t)!;
          const [lo, hi] = cam.pitchRange!;
          for (const p of drawn(c, t)) {
            if (p < lo || p > hi)
              out.push(`${t.toFixed(2)}: ${p.toFixed(1)} ∉ [${lo.toFixed(1)}, ${hi.toFixed(1)}]`);
          }
        }
        expect(out.slice(0, 5)).toEqual([]);
      });
    });
  }
});

describe('wiring', () => {
  const base = {
    aspect: '16:9' as const,
    size: '720' as const,
    fps: 30 as const,
    theme: 'dark' as const,
    hud: true,
    thickness: true,
  };

  it("frameOptions: Auto takes the piece's auto keys (memoised), Keys the stored ones", () => {
    const piece = load(CREASE);
    const c = compile(piece);
    const auto = frameOptions(piece, { ...base, camera: 'auto' }, c);
    expect(auto.keys).toBe(autoCameraKeys(c, { aspect: 16 / 9 }));
    expect(frameOptions(piece, { ...base, camera: 'auto' }, c).keys).toBe(auto.keys);
    // A section and an aspect make their own.
    const tall = frameOptions(piece, { ...base, aspect: '9:16', camera: 'auto' }, c).keys!;
    expect(tall[tall.length - 1].window).toBeCloseTo((c.duration * 16) / 9 / (9 / 16), 2);
    const stored: CameraKey[] = [{ at: 0, window: 9, place: 0.5, pitch: 60, range: 20 }];
    const withKeys = { ...piece, camera: { mode: 'keys' as const, keys: stored } };
    expect(frameOptions(withKeys, { ...base, camera: 'keys' }, c).keys).toEqual(stored);
    // Auto ignores stored keys; Follow takes none.
    expect(frameOptions(withKeys, { ...base, camera: 'auto' }, c).keys).toBe(auto.keys);
    expect(frameOptions(withKeys, { ...base, camera: 'follow' }, c).keys).toBeUndefined();
  });

  it('pieceCameraPath: stored keys for Keys, auto keys for Auto, null for Follow', () => {
    const piece = load(CREASE);
    const c = compile(piece);
    const stored: CameraKey[] = [{ at: 0, window: 9, place: 0.5, pitch: 60, range: 20 }];
    expect(pieceCameraPath(piece, c)).toBeNull();
    expect(pieceCameraPath({ camera: { mode: 'follow' } }, c)).toBeNull();
    expect(pieceCameraPath({ camera: { mode: 'keys', keys: stored } }, c)).toBe(stored);
    expect(pieceCameraPath({ camera: { mode: 'auto' } }, c)).toBe(autoCameraKeys(c));
  });

  it('Auto differs from Follow', () => {
    const piece = load(CREASE);
    const c = compile(piece);
    const fo = frameOptions(piece, { ...base, camera: 'auto', window: 20 }, c);
    const a = videoCamera('auto', c, 40, fo);
    const f = videoCamera('follow', c, 40, { ...fo, keys: undefined });
    expect(Math.abs(a.window - f.window) + Math.abs(a.start - f.start)).toBeGreaterThan(1);
  });
});
