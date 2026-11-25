/**
 * One row is today's video (PLAN.md §15 M15 *Accept when*): with no poster, frames drawn after M15
 * are exactly the frames drawn before it. The hashes were taken from the SVG of each frame at the
 * M15 V1 contract commit (a3a68ec), before the poster renderer.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameOptions, type VideoOptions } from '../../../src/app/video-export';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import { EXPORT_LOOK } from '../../../src/render/look';
import { SvgContext, asCtx2D } from '../../../src/render/svg';
import {
  drawThumbnail,
  drawVideoFrame,
  drawVideoMoment,
  videoSize,
} from '../../../src/render/video';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
function song(name: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(SONGS, `${name}.algorhythms.json`), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const KITE = song('kite-day');
const KITE_C = compile(KITE);

const BASE: VideoOptions = {
  aspect: '16:9',
  size: '720',
  fps: 30,
  theme: 'dark',
  hud: true,
  thickness: true,
  camera: 'follow',
  window: 20,
};

const CASES: Record<string, VideoOptions> = {
  follow: BASE,
  whole: { ...BASE, camera: 'whole' },
  auto: { ...BASE, camera: 'auto' },
  portrait: { ...BASE, aspect: '9:16', theme: 'light' },
  square: { ...BASE, aspect: '1:1', followAt: 0.5 },
  keys: {
    ...BASE,
    camera: 'keys',
    keys: [
      { at: 0, window: 10, place: 0.3, pitch: 60, range: 30 },
      { at: 40, window: 30, place: 0.5, pitch: 64, range: 40 },
    ],
  },
  section: { ...BASE, section: { start: 20, end: 60 } },
  look: { ...BASE, look: { ...EXPORT_LOOK, glow: 0.5, vignette: 0.4, future: 'dimmed' } },
  bookends: {
    ...BASE,
    bookends: { fadeIn: 1, leadIn: 1, title: { text: 'Kite Day' }, endCard: 5, credit: 'Made' },
  },
};

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

function frameHash(o: VideoOptions, k: number): string {
  const px = videoSize(o.aspect, o.size);
  const svg = new SvgContext(px.width, px.height);
  drawVideoFrame(asCtx2D(svg), KITE_C, frameOptions(KITE, o, KITE_C), k, o.fps);
  return hash(svg.toSvg());
}

const FRAMES = [0, 900, 2400, 5000];

/** SVG hashes at a3a68ec, per case, for FRAMES. */
const GOLDEN: Record<string, string[]> = {
  follow: ['16f7b49048d2477d', '9a7f0cecb1a5e183', '8685f9f4d0f13d96', '94cadd3bcd32f77b'],
  whole: ['418737a68089b011', '9f24a9e836c4fd79', 'b161968f2aefbdc9', '6767c5260ca2981d'],
  auto: ['4022c9223089aa8e', '1d3e6494b55d7ef7', '78af1b5e016059d5', '6767c5260ca2981d'],
  portrait: ['b7f1aade26b4693b', 'f2cab17c9ccb1822', '9da377a7f3243510', '399aa202591528af'],
  square: ['c8ffec80815888df', 'f9c2b6736465deec', 'd9b6f61f0689947e', '48cf2cbd4c2409ec'],
  keys: ['b26141a1157a3685', '5ba6d20266a39c5f', '5adc836892029bcf', '2b7374d3f080a326'],
  section: ['1a4d94bf2785ba9b', '093e6336781ab90f', '4d4030657791bc63', '4d4030657791bc63'],
  look: ['c4842af18d1c2f00', '4116685640127022', '386bf3377497e704', '69a8f42cfb730fd4'],
  bookends: ['26c50ceaade178f6', '18648e7e661804fa', 'e5ab86d2195e6116', 'cc6efe3725360e6a'],
};
const THUMB = '522a1bb57e85a117';
const END = 'cc6efe3725360e6a';

describe('One row draws today’s frames', () => {
  it('with no poster, every case is the same SVG as before M15', () => {
    for (const [name, o] of Object.entries(CASES))
      expect(
        FRAMES.map((k) => frameHash(o, k)),
        name,
      ).toEqual(GOLDEN[name]);
  });

  it('frame row, set or by default, on a piece without a poster', () => {
    for (const name of ['follow', 'bookends'])
      expect(FRAMES.map((k) => frameHash({ ...CASES[name], frame: 'row' }, k))).toEqual(
        GOLDEN[name],
      );
  });

  it('the thumbnail and the end card', () => {
    const fo = frameOptions(KITE, BASE, KITE_C);
    const svg = new SvgContext(1280, 720);
    drawThumbnail(asCtx2D(svg), KITE_C, fo, { at: 'whole', title: { text: 'Kite' } });
    expect(hash(svg.toSvg())).toBe(THUMB);
    const b = frameOptions(KITE, CASES.bookends, KITE_C);
    const svg2 = new SvgContext(1280, 720);
    drawVideoMoment(asCtx2D(svg2), KITE_C, b, (b.length ?? 0) - 1);
    expect(hash(svg2.toSvg())).toBe(END);
  });
});
