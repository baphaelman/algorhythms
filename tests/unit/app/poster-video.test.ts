/**
 * The poster in the video export (PLAN.md §15 M14 "Colours are shared", M15): a poster layer's
 * colour reaches the video's frames; a piece with a poster plays it (Over the poster); with One
 * row, its place, size, rows and groups leave the frames unchanged, a hidden layer isn't drawn and
 * a travelling text box is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import { frameOptions } from '../../../src/app/video-export';
import { drawVideoFrame } from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const OPTS = {
  aspect: '16:9' as const,
  size: '720' as const,
  fps: 30 as const,
  theme: 'dark' as const,
  hud: true,
  thickness: true,
  camera: 'follow' as const,
};

/** Frame `k` of the video of `poster` on Kite Day, as SVG. */
function frame(poster: PosterDoc | undefined, k: number): string {
  const piece: Piece = poster ? { ...KITE, poster } : KITE;
  const svg = new SvgContext(1280, 720);
  drawVideoFrame(asCtx2D(svg), KITE_C, frameOptions(piece, OPTS, KITE_C), k, 30);
  return svg.toSvg();
}

/** Everything a poster stores except a layer colour. */
const PLACED: PosterDoc = {
  size: { w: 2480, h: 3508 },
  rows: 4,
  margins: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1, linked: true },
  look: { theme: 'light', glow: 0.5, vignette: 0.4 },
  layers: [
    { id: 'part:Melody', box: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } },
    { id: 'part:Bass', hidden: true },
  ],
  texts: [{ id: 'free1', kind: 'free', text: 'Hello', box: { x: 0.2, y: 0.8, w: 0.3, h: 0.05 } }],
  groups: { sectionLabels: { size: 1.5, colour: '#123456' }, sectionLines: { visible: false } },
  rowsBy: 'sections',
};

describe('the poster in the video', () => {
  const ks = [0, 600, 1500];
  const ROW = { ...OPTS, frame: 'row' as const };
  const rowFrame = (poster: PosterDoc | undefined, k: number): string => {
    const piece: Piece = poster ? { ...KITE, poster } : KITE;
    const svg = new SvgContext(1280, 720);
    drawVideoFrame(asCtx2D(svg), KITE_C, frameOptions(piece, ROW, KITE_C), k, 30);
    return svg.toSvg();
  };

  it('a piece with a poster plays it (M15); one without plays One row', () => {
    const o = frameOptions({ ...KITE, poster: PLACED }, OPTS, KITE_C);
    expect(o.frame).toBe('poster');
    expect(o.rowBreak).toBe('pan');
    expect(o.poster?.width).toBe(2480);
    expect(o.poster?.rows.length).toBeGreaterThan(1);
    const plain = frameOptions(KITE, OPTS, KITE_C);
    expect(plain.frame).toBeUndefined();
    expect(plain.poster).toBeUndefined();
    expect(frame(PLACED, 600)).not.toBe(frame(undefined, 600));
  });

  it('One row: place, size, rows, texts that stay and groups leave every frame as it was', () => {
    const shown: PosterDoc = { ...PLACED, layers: [PLACED.layers![0]] };
    for (const k of ks) expect(rowFrame(shown, k), `frame ${k}`).toBe(frame(undefined, k));
  });

  it('One row: a hidden layer is not drawn; a travelling text box is', () => {
    for (const k of ks) expect(rowFrame(PLACED, k)).not.toBe(frame(undefined, k));
    const go: PosterDoc = {
      texts: [{ id: 'free1', kind: 'free', text: 'Hello there', travels: true }],
    };
    expect(rowFrame(go, 600)).toContain('Hello there');
    expect(frame(undefined, 600)).not.toContain('Hello there');
  });

  it('a layer colour colours that part’s lines in the frames, and only those', () => {
    const doc: PosterDoc = { ...PLACED, layers: [{ id: 'part:Melody', colour: '#ff00ff' }] };
    const o = frameOptions({ ...KITE, poster: doc }, OPTS, KITE_C);
    const melody = KITE.voices.map((v) => (v.part ?? '') === 'Melody');
    expect(melody.some(Boolean)).toBe(true);
    expect(o.style.voiceColors?.map((c) => c === '#ff00ff')).toEqual(melody);
    const k = 600;
    const plain = frame(undefined, k);
    const coloured = frame(doc, k);
    expect(plain).not.toContain('#ff00ff');
    expect(coloured).toContain('#ff00ff');
  });
});
