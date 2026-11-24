/**
 * M11.5 acceptance (PLAN.md §15 M11.5) lines the C1–C3 tests didn't pin: Auto opens as the chord
 * widens; video only (posters ignore the camera); a camera changes nothing the audio or MIDI read.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { CameraKey, Piece } from '../../../src/core/types';
import { autoCameraKeys } from '../../../src/render/auto-camera';
import { cameraPoseAt } from '../../../src/render/camera-path';
import { renderPosterSvg, type PosterOptions } from '../../../src/app/poster-export';

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const load = (file: string): Piece => {
  const r = parsePiece(readFileSync(join(EXAMPLES, file), 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
};
const CREASE = 'compositions/crease.algorhythms.json';
const KEYS: CameraKey[] = [
  { at: 0, window: 6, place: 0.2, pitch: 64, range: 24 },
  { at: 6, window: 14, place: 0.6, pitch: 68, range: 30, ease: 'linear' },
];

describe('Auto opens as the chord widens', () => {
  it('Crease: tight at the first note, wider in window and range as the lines spread', () => {
    const c = compile(load(CREASE));
    const keys = autoCameraKeys(c);
    const at = (t: number) => cameraPoseAt(keys, t)!;
    const first = at(keys[0].at);
    // The tuning table (build log C2): 7 s / 14 st at 1 s, 13.5 s / 46 st at 45 s.
    expect(at(45).range).toBeGreaterThan(2.5 * first.range);
    expect(at(45).window).toBeGreaterThan(1.6 * first.window);
    // It only opens up to the ease into the lean at 79.5 s (from the key before it, ~73 s).
    const leanFrom = keys.filter((k) => k.at < 78).at(-1)!.at;
    let prev = first.range;
    for (let t = keys[0].at; t <= leanFrom; t += 0.25) {
      const r = at(t).range;
      expect(r, `range at ${t}`).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
    expect(leanFrom).toBeGreaterThan(60);
  });
});

describe('video only: posters keep Section', () => {
  const opts: PosterOptions = {
    size: { width: 1600, height: 900 },
    theme: 'dark',
    transparent: false,
    title: true,
    thickness: true,
  };
  for (const file of [CREASE, 'compositions/kite-day.algorhythms.json']) {
    it(`${file}: the poster SVG is the same with Follow, Auto or Keys stored`, () => {
      const piece = load(file);
      const plain = renderPosterSvg(piece, opts);
      for (const camera of [
        { mode: 'follow' as const },
        { mode: 'auto' as const },
        { mode: 'keys' as const, keys: KEYS },
      ]) {
        expect(renderPosterSvg({ ...piece, camera }, opts), camera.mode).toBe(plain);
        const section = { start: 10, end: 30 };
        expect(renderPosterSvg({ ...piece, camera }, { ...opts, section })).toBe(
          renderPosterSvg(piece, { ...opts, section }),
        );
      }
    });
  }
});

describe('a camera changes nothing the audio, stems or MIDI read', () => {
  it('the compiled score is the same with or without a camera', () => {
    const piece = load(CREASE);
    expect(compile({ ...piece, camera: { mode: 'keys', keys: KEYS } })).toEqual(compile(piece));
  });
});
