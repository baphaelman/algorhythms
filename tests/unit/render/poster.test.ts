/** Poster frames (PLAN.md §12 "Poster export", revision 12): sizes, style, title block, SVG. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  POSTER_CREDIT,
  POSTER_DPR,
  drawPoster,
  drawScore,
  pitchExtent,
  posterCamera,
  posterLayout,
  posterLength,
  posterSize,
  posterStyle,
  tokensOf,
  videoLayout,
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

function svgOf(piece: Piece, size: PosterSize, title: boolean, theme: 'light' | 'dark' = 'light') {
  const compiled = compile(piece);
  const px = posterSize(size);
  const c = new SvgContext(px.width, px.height);
  const style = posterStyle({ theme, title, ...videoMarkers(piece) });
  const view = drawPoster(asCtx2D(c), compiled, { name: piece.meta.title }, { size, style, title });
  return { svg: c.toSvg(), view, compiled };
}

describe('posterSize and posterLayout', () => {
  it('gives the 4K-class sizes', () => {
    expect(posterSize('16:9')).toEqual({ width: 3840, height: 2160 });
    expect(posterSize('1:1')).toEqual({ width: 2160, height: 2160 });
    expect(posterSize('a4')).toEqual({ width: 2480, height: 3508 });
  });

  it('draws every size at one pixel ratio; 16:9 is the video layout at twice its 1080p ratio', () => {
    for (const k of SIZES) {
      const l = posterLayout(k);
      const p = posterSize(k);
      expect(l.dpr).toBe(POSTER_DPR);
      expect(l.width * l.dpr).toBeCloseTo(p.width, 9);
      expect(l.height * l.dpr).toBeCloseTo(p.height, 9);
    }
    const v = videoLayout('16:9', '1080');
    const l = posterLayout('16:9');
    expect(l.width).toBeCloseTo(v.width, 9);
    expect(l.height).toBeCloseTo(v.height, 9);
    expect(l.dpr).toBeCloseTo(v.dpr * 2, 9);
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
    expect(posterStyle({ theme: 'light', title: true }).reserveHud).toBe(true);
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

describe('drawPoster on an SvgContext', () => {
  const piece = load(PIECE);

  it('draws a background, the lines, and section labels as text', () => {
    const { svg } = svgOf(piece, '16:9', false);
    expect(svg).toContain(
      `<rect x="0" y="0" width="3840" height="2160" fill="${tokensOf('light').paper}"/>`,
    );
    const labels = Object.values(videoMarkers(piece).labels).map((l) => l.toUpperCase());
    expect(labels.length).toBeGreaterThan(0);
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(texts.some((t) => labels.includes(t))).toBe(true);
    expect(texts.some((t) => t.endsWith(' Hz'))).toBe(true); // the octave grid's labels
    expect(svg).toContain('<linearGradient');
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(50);
  });

  it('transparent: no background rect', () => {
    const compiled = compile(piece);
    const c = new SvgContext(3840, 2160);
    const style = posterStyle({ theme: 'dark', transparent: true });
    drawPoster(asCtx2D(c), compiled, { name: 'x' }, { size: '16:9', style, title: false });
    expect(c.toSvg()).not.toContain('<rect');
  });

  it('places the title block below the lines and markers, inside the frame', () => {
    for (const size of SIZES) {
      const { svg, view } = svgOf(piece, size, true);
      const px = posterSize(size);
      const bandTop = (view.height - view.padB + 6) * POSTER_DPR;
      const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)];
      const title = texts.filter((m) => Number(m[2]) > bandTop);
      expect(title.map((m) => m[3])).toEqual([
        piece.meta.title,
        expect.stringMatching(/^\d+:\d\d · [A-G][#b]? \w/),
        POSTER_CREDIT,
      ]);
      for (const m of title) expect(Number(m[2])).toBeLessThan(px.height - 20);
      // Every path's points (lines, grid, markers; M and L runs) are above the band.
      let maxY = 0;
      for (const p of svg.matchAll(/<path d="([^"]+)"/g)) {
        for (const run of p[1].matchAll(/[ML]([^A-Za-z]+)/g)) {
          const nums = run[1].trim().split(/\s+/).map(Number);
          for (let i = 1; i < nums.length; i += 2) maxY = Math.max(maxY, nums[i]);
        }
      }
      expect(maxY).toBeLessThanOrEqual(bandTop + 0.01);
    }
  });

  it('cuts a long name with an ellipsis', () => {
    const compiled = compile(piece);
    const c = new SvgContext(2160, 2160);
    const style = posterStyle({ theme: 'light', title: true });
    drawPoster(
      asCtx2D(c),
      compiled,
      { name: 'x'.repeat(400) },
      { size: '1:1', style, title: true },
    );
    expect(c.toSvg()).toMatch(/>x+…<\/text>/);
  });

  it('is independent of what the context drew before', () => {
    const compiled = compile(piece);
    const style = posterStyle({ theme: 'light', title: true, ...videoMarkers(piece) });
    const opts = { size: '16:9' as const, style, title: true };
    const a = new SvgContext(3840, 2160);
    drawPoster(asCtx2D(a), compiled, { name: 'n' }, opts);
    const b = new SvgContext(3840, 2160);
    b.lineCap = 'round';
    b.setLineDash([4, 4]);
    b.textAlign = 'right';
    b.font = '30px serif';
    b.setTransform(3, 0, 0, 3, 7, 7);
    b.fillRect(0, 0, 9, 9);
    drawPoster(asCtx2D(b), compiled, { name: 'n' }, opts);
    expect(b.toSvg()).toBe(a.toSvg());
  });

  it('every bundled piece renders, under 10 MB of SVG at every size', () => {
    const sizes: string[] = [];
    for (const f of BUNDLED) {
      const piece = load(f);
      for (const size of SIZES) {
        const { svg } = svgOf(piece, size, true, 'dark');
        expect(svg.length, `${f} ${size}`).toBeLessThan(10e6);
        if (size === '16:9')
          sizes.push(`${f.replace(/^.*\//, '')}: ${(svg.length / 1e6).toFixed(2)} MB`);
      }
    }
    console.log(`poster SVG sizes (16:9, title, dark):\n${sizes.join('\n')}`);
  });
});
