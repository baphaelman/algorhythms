/** Posters (PLAN.md §12 "Poster export", §15 M14): sizes, style, the laid-out poster as SVG. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  drawPosterLayout,
  drawScore,
  layoutPoster,
  pitchExtent,
  posterCamera,
  posterLength,
  posterSize,
  posterStyle,
  tokensOf,
  videoMarkers,
  type PosterSize,
  type ScoreStyle,
} from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';
import { pathCtx } from './path-ctx';

const ROOT = join(import.meta.dirname, '../../..');
const SIZES: PosterSize[] = ['16:9', '1:1', 'a4'];

function load(file: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const BUNDLED = [
  ...readdirSync(join(ROOT, 'examples'))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => `examples/${f}`),
  ...['songs', 'experiments'].flatMap((d) =>
    readdirSync(join(ROOT, 'examples', d))
      .filter((f) => f.endsWith('.algorhythms.json'))
      .map((f) => `examples/${d}/${f}`),
  ),
];
const PIECE = 'examples/songs/tide-pools.algorhythms.json';

/** The default poster of `piece` laid out at `size`, as SVG; `pre` draws on the context first. */
function svgOf(
  piece: Piece,
  size: PosterSize,
  doc: Piece['poster'] = {},
  pre?: (c: SvgContext) => void,
): string {
  const compiled = compile(piece);
  const px = posterSize(size);
  const L = layoutPoster({ compiled, piece, doc, base: { size: { w: px.width, h: px.height } } });
  const c = new SvgContext(px.width, px.height);
  pre?.(c);
  drawPosterLayout(asCtx2D(c), compiled, L);
  return c.toSvg();
}

describe('posterSize', () => {
  it('gives the 4K-class sizes', () => {
    expect(posterSize('16:9')).toEqual({ width: 3840, height: 2160 });
    expect(posterSize('1:1')).toEqual({ width: 2160, height: 2160 });
    expect(posterSize('a4')).toEqual({ width: 2480, height: 3508 });
  });

  it('posterLength rounds to m:ss', () => {
    expect(posterLength(0)).toBe('0:00');
    expect(posterLength(59.6)).toBe('1:00');
    expect(posterLength(187.2)).toBe('3:07');
  });
});

describe('posterStyle and posterCamera', () => {
  it('is the finished piece: no ghost, heads, playhead or HUD; thickness on', () => {
    const s = posterStyle({ theme: 'dark' });
    expect(s).toMatchObject({
      dark: true,
      futureOpacity: 1,
      hud: false,
      heads: false,
      playhead: false,
      thickness: true,
      colors: 'pitch',
    });
    expect(s.reserveHud).toBeUndefined();
    expect(s.tokens).toEqual(tokensOf('dark'));
    expect(posterStyle({ theme: 'light', transparent: true }).tokens.paper).toBe('transparent');
    expect(posterStyle({ theme: 'light', thickness: false }).thickness).toBe(false);
  });

  it('frames the whole piece with the fitted pitch range', () => {
    const compiled = compile(load(PIECE));
    expect(posterCamera(compiled)).toEqual({
      start: 0,
      window: compiled.duration,
      pitchRange: pitchExtent(compiled),
    });
  });
});

describe('ScoreStyle.reserveHud', () => {
  const compiled = compile(load(PIECE));
  const base: ScoreStyle = { ...posterStyle({ theme: 'light' }), hud: true };
  const draw = (style: ScoreStyle) => {
    const r = pathCtx();
    const view = drawScore(
      r.ctx,
      compiled,
      posterCamera(compiled),
      style,
      30,
      { width: 800, height: 400 },
      1,
    );
    return { r, view };
  };

  it('defaults leave drawScore unchanged', () => {
    for (const hud of [true, false]) {
      const a = draw({ ...base, hud });
      const b = draw({ ...base, hud, reserveHud: false });
      expect(b.view).toEqual(a.view);
      // Gradients are new objects per frame: compared by kind.
      const plain = (shapes: typeof a.r.strokes) =>
        shapes.map((x) => ({ ...x, style: typeof x.style === 'string' ? x.style : 'gradient' }));
      expect(plain(b.r.strokes)).toEqual(plain(a.r.strokes));
      expect(plain(b.r.fills)).toEqual(plain(a.r.fills));
    }
  });

  it('keeps the HUD padding without drawing the HUD', () => {
    const withHud = draw(base).view;
    const reserved = draw({ ...base, hud: false, reserveHud: true }).view;
    const none = draw({ ...base, hud: false }).view;
    expect(reserved.padB).toBe(withHud.padB);
    expect(none.padB).toBeLessThan(withHud.padB);
  });
});

describe('a laid-out poster on an SvgContext', () => {
  const piece = load(PIECE);

  it('draws a background, the lines, the title and section labels as text', () => {
    const svg = svgOf(piece, '16:9');
    expect(svg).toContain(
      `<rect x="0" y="0" width="3840" height="2160" fill="${tokensOf('light').paper}"/>`,
    );
    const labels = Object.values(videoMarkers(piece).labels).map((l) => l.toUpperCase());
    expect(labels.length).toBeGreaterThan(0);
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(texts).toContain(piece.meta.title);
    expect(texts.some((t) => labels.includes(t))).toBe(true);
    expect(svg).toContain('<linearGradient');
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(50);
  });

  it('transparent: no background rect', () => {
    expect(svgOf(piece, '16:9', { look: { transparent: true } })).not.toContain('<rect');
  });

  it('is independent of what the context drew before', () => {
    const a = svgOf(piece, '16:9');
    const b = svgOf(piece, '16:9', {}, (c) => {
      c.lineCap = 'round';
      c.setLineDash([4, 4]);
      c.textAlign = 'right';
      c.font = '30px serif';
      c.setTransform(3, 0, 0, 3, 7, 7);
      c.fillRect(0, 0, 9, 9);
    });
    expect(b).toBe(a);
  });

  it('every bundled piece renders, under 10 MB of SVG at every size', () => {
    const sizes: string[] = [];
    for (const f of BUNDLED) {
      const piece = load(f);
      for (const size of SIZES) {
        const svg = svgOf(piece, size);
        expect(svg.length, `${f} ${size}`).toBeLessThan(10e6);
        if (size === '16:9')
          sizes.push(`${f.replace(/^.*\//, '')}: ${(svg.length / 1e6).toFixed(2)} MB`);
      }
    }
    console.log(`poster SVG sizes (16:9, default poster):\n${sizes.join('\n')}`);
  }, 30_000);
});
