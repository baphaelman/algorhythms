/**
 * Drawing a laid-out poster (PLAN.md §15 M14 P1): the SVG draws what the layout lists, stretched
 * layers keep their line widths, and drawScore's new switches (voices, voice colours, section
 * lines, pads) leave everything else as before.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import {
  EXPORT_LOOK,
  SvgContext,
  asCtx2D,
  drawPosterLayout,
  drawScore,
  layerStyle,
  layoutPoster,
  lookStyle,
  posterCamera,
  videoMarkers,
  type ScoreStyle,
} from '../../../src/render';
import { pathCtx } from './path-ctx';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const lay = (doc?: PosterDoc, rows = 1) =>
  layoutPoster({ compiled: KITE_C, piece: KITE, ...(doc ? { doc } : {}), base: { rows } });

function svgOf(doc?: PosterDoc, rows = 1): string {
  const L = lay(doc, rows);
  const c = new SvgContext(L.width, L.height);
  drawPosterLayout(asCtx2D(c), KITE_C, L);
  return c.toSvg();
}

describe('drawPosterLayout', () => {
  it('draws the text boxes and labels the layout lists', () => {
    const svg = svgOf(undefined, 2);
    expect(svg).toContain('>Kite Day</text>');
    expect(svg).toContain('>1:48 · C pentatonic major · AlgoRhythms</text>');
    expect(svg).toContain('>INTRO</text>');
    expect(svg).toContain('>0:55</text>');
    const none = svgOf({ texts: [] });
    expect(none).not.toContain('Kite Day');
  });

  it('draws nothing for a hidden layer', () => {
    const all = svgOf();
    const hidden = svgOf({
      layers: ['Melody', 'Chords', 'Bass', 'Sparkle'].map((p) => ({
        id: `part:${p}`,
        hidden: true,
      })),
    });
    expect(hidden.length).toBeLessThan(all.length / 4);
  });

  it('a stretched layer keeps its line widths (points move, the context does not scale)', () => {
    const only: PosterDoc = {
      texts: [],
      groups: { sectionLines: { visible: false }, sectionLabels: { visible: false } },
      layers: ['Chords', 'Bass', 'Sparkle'].map((p) => ({ id: `part:${p}`, hidden: true })),
    };
    const draw = (doc: PosterDoc) => {
      const c = pathCtx();
      const scales: number[][] = [];
      const widths: number[] = [];
      const ctx = new Proxy(c.ctx, {
        get(t, k) {
          if (k === 'setTransform') return (...a: number[]) => scales.push([a[0], a[3]]);
          return Reflect.get(t, k) as unknown;
        },
        set(t, k, v) {
          if (k === 'lineWidth') widths.push(v as number);
          return Reflect.set(t, k, v);
        },
      });
      drawPosterLayout(ctx, KITE_C, lay(doc));
      return { ...c, scales, widths };
    };
    const plain = draw(only);
    const melody = lay(only).layers.find((l) => l.id === 'part:Melody')!.box;
    const stretched = draw({
      ...only,
      layers: [
        ...only.layers!,
        {
          id: 'part:Melody',
          box: {
            x: melody.x / 3840,
            y: melody.y / 2160,
            w: (melody.w * 2) / 3840,
            h: (melody.h * 0.5) / 2160,
          },
        },
      ],
    });
    // Every transform is a uniform scale (the type unit), and the same line widths are set.
    for (const [a, d] of stretched.scales) expect(a).toBe(d);
    expect(stretched.scales).toEqual(plain.scales);
    expect(stretched.widths).toEqual(plain.widths);
    // The points stretch instead: twice as wide, half as tall.
    const shapes = (c: typeof plain) => [...c.strokes, ...c.fills].flatMap((s) => s.pts);
    const ext = (pts: [number, number][], i: 0 | 1) =>
      Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i]));
    expect(shapes(plain).length).toBeGreaterThan(0);
    expect(ext(shapes(stretched), 0) / ext(shapes(plain), 0)).toBeCloseTo(2, 1);
    expect(ext(shapes(stretched), 1) / ext(shapes(plain), 1)).toBeCloseTo(0.5, 1);
  });

  it('each layer draws only its voices, transparent, its plot filling the frame', () => {
    const L = lay({ layers: [{ id: 'part:Bass', colour: '#ff0000' }] });
    const bass = L.layers.find((l) => l.id === 'part:Bass')!;
    const s = layerStyle(L, bass);
    expect([...s.voices!]).toEqual(bass.voices);
    expect(s.pads).toEqual({ top: 0, bottom: 0 });
    expect(s.tokens.paper).toBe('transparent');
    expect(s.hud).toBe(false);
    expect(bass.voices.every((v) => s.voiceColors![v] === '#ff0000')).toBe(true);
  });
});

describe('drawScore’s poster switches', () => {
  const base: ScoreStyle = {
    ...lookStyle({ ...EXPORT_LOOK, future: 'full', playhead: false }, videoMarkers(KITE)),
    heads: false,
  };
  const cam = posterCamera(KITE_C);
  const draw = (style: ScoreStyle) => {
    const c = pathCtx();
    const view = drawScore(
      c.ctx,
      KITE_C,
      cam,
      style,
      KITE_C.duration,
      { width: 800, height: 400 },
      1,
    );
    return { ...c, view };
  };

  it('voices: only those lines; voiceColors beat the palette', () => {
    const all = draw(base).strokes.length;
    const one = draw({
      ...base,
      voices: new Set([5]),
      voiceColors: [...Array<undefined>(5), '#abcdef'],
    });
    expect(one.strokes.length).toBeGreaterThan(0);
    expect(one.strokes.length).toBeLessThan(all / 3);
    const lines = one.strokes.filter((s) => s.style !== base.tokens.rule);
    expect(lines.every((s) => s.style === '#abcdef')).toBe(true);
  });

  it('sectionLines false keeps the labels without their lines', () => {
    const withLines = draw(base).strokes.filter((s) => s.style === base.tokens.rule).length;
    const without = draw({ ...base, sectionLines: false }).strokes.filter(
      (s) => s.style === base.tokens.rule,
    ).length;
    expect(withLines).toBeGreaterThan(0);
    expect(without).toBe(0);
  });

  it('pads replace the plot paddings', () => {
    const v = draw({ ...base, pads: { top: 0, bottom: 0 } }).view;
    expect(v.padT).toBe(0);
    expect(v.padB).toBe(0);
    expect(draw(base).view.padT).toBeGreaterThan(0);
  });
});
