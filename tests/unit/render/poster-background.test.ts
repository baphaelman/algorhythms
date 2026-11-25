/** Backgrounds (M14 P5): placed gradients, M11's gradients mapped onto them, and pictures. */

import { describe, expect, it } from 'vitest';
import {
  backgroundColour,
  backgroundSamples,
  fillBackground,
  gradientLine,
  pictureRects,
  placedGradient,
  setPictureImage,
  stopColorAt,
  withPicture,
  type BackgroundPaint,
  type BackgroundPicture,
} from '../../../src/render/background';
import { mixHex } from '../../../src/render/colours';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

type Call = [string, ...unknown[]];

/** A recording context: gradient creation and stops, fills, images, alpha. */
function rec() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '' };
  const g = new Proxy(state, {
    get(t, prop: string) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return (...a: number[]) => {
          calls.push([prop, ...a]);
          return { addColorStop: (at: number, c: string) => calls.push(['stop', at, c]) };
        };
      if (prop in t) return t[prop];
      return (...a: unknown[]) => {
        calls.push(
          prop === 'fillRect' ? [prop, state.globalAlpha, ...a] : [prop, ...a.slice(1, 5)],
        );
      };
    },
    set(t, prop: string, v) {
      t[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { g, calls };
}

/** The calls M11's `backgroundGradient` made for a two-colour gradient (W × H). */
function m11Calls(dir: 'vertical' | 'horizontal' | 'radial', W: number, H: number): Call[] {
  const make: Call =
    dir === 'radial'
      ? ['createRadialGradient', W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2]
      : dir === 'horizontal'
        ? ['createLinearGradient', 0, 0, W, 0]
        : ['createLinearGradient', 0, 0, 0, H];
  return [make, ['stop', 0, '#101820'], ['stop', 1, '#f0e0d0'], ['fillRect', 1, 0, 0, W, H]];
}

describe('gradients', () => {
  for (const dir of ['vertical', 'horizontal', 'radial'] as const) {
    for (const [W, H] of [
      [3840, 2160],
      [2480, 3508],
      [1001, 999],
    ]) {
      it(`M11's ${dir} gradient draws exactly as before at ${W}×${H}, as itself and mapped`, () => {
        const old: BackgroundPaint = { kind: 'gradient', from: '#101820', to: '#f0e0d0', dir };
        for (const bg of [old, placedGradient(old)]) {
          const { g, calls } = rec();
          fillBackground(g, '#ffffff', { background: bg }, W, H);
          expect(calls).toEqual(m11Calls(dir, W, H));
        }
      });
    }
  }

  it('maps the two colours onto stops, an angle, a centre and a radius', () => {
    expect(placedGradient({ from: '#000000', to: '#ffffff', dir: 'vertical' })).toEqual({
      kind: 'linear',
      stops: [
        { color: '#000000', at: 0 },
        { color: '#ffffff', at: 1 },
      ],
      angle: 180,
    });
    expect(placedGradient({ from: '#000000', to: '#ffffff', dir: 'horizontal' })).toMatchObject({
      angle: 90,
    });
    expect(placedGradient({ from: '#000000', to: '#ffffff', dir: 'radial' })).toMatchObject({
      kind: 'radial',
      cx: 0.5,
      cy: 0.5,
      r: 1,
    });
  });

  it('a linear gradient at any angle runs through the centre, corner to corner', () => {
    const l = gradientLine(45, 400, 200);
    // Midpoint at the centre; the line's half-length reaches the far corners' projection.
    expect((l.x0 + l.x1) / 2).toBeCloseTo(200, 9);
    expect((l.y0 + l.y1) / 2).toBeCloseTo(100, 9);
    const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0);
    expect(len).toBeCloseTo((400 + 200) * Math.SQRT1_2, 6);
    // 45°: towards the top right.
    expect(l.x1).toBeGreaterThan(l.x0);
    expect(l.y1).toBeLessThan(l.y0);
    expect(gradientLine(0, 400, 200)).toEqual({ x0: 0, y0: 200, x1: 0, y1: 0 });
    expect(gradientLine(270, 400, 200)).toEqual({ x0: 400, y0: 0, x1: 0, y1: 0 });
  });

  it('draws stops in position order, with a placed centre and radius', () => {
    const { g, calls } = rec();
    fillBackground(
      g,
      '#fff',
      {
        background: {
          kind: 'radial',
          stops: [
            { color: '#ff0000', at: 1 },
            { color: '#00ff00', at: 0 },
            { color: '#0000ff', at: 0.3 },
          ],
          cx: 0.25,
          cy: 0.75,
          r: 0.5,
        },
      },
      400,
      300,
    );
    expect(calls.slice(0, 4)).toEqual([
      ['createRadialGradient', 100, 225, 0, 100, 225, 0.5 * 250],
      ['stop', 0, '#00ff00'],
      ['stop', 0.3, '#0000ff'],
      ['stop', 1, '#ff0000'],
    ]);
  });

  it('samples positioned stops as a canvas does (M11 gradients: as before)', () => {
    const stops = [
      { color: '#000000', at: 0.2 },
      { color: '#ffffff', at: 0.6 },
    ];
    expect(stopColorAt(stops, 0)).toBe('#000000');
    expect(stopColorAt(stops, 0.4)).toBe(mixHex('#000000', '#ffffff', 0.5));
    expect(stopColorAt(stops, 1)).toBe('#ffffff');
    const old: BackgroundPaint = {
      kind: 'gradient',
      from: '#203040',
      to: '#c0d0e0',
      dir: 'radial',
    };
    const before: string[] = [];
    for (let i = 0; i <= 8; i++) before.push(mixHex('#203040', '#c0d0e0', i / 8));
    expect(backgroundSamples(old, '#fff')).toEqual(before);
    expect(backgroundSamples(placedGradient(old), '#fff')).toEqual(before);
    expect(backgroundColour(old, '#fff')).toBe('#203040');
    expect(backgroundColour(placedGradient(old), '#fff')).toBe('#203040');
  });
});

const PIC: BackgroundPicture = {
  src: 'data:image/png;base64,AAAA',
  w: 400,
  h: 200,
  fit: 'cover',
  x: 0.5,
  y: 0.5,
  dim: 0,
};

describe('pictures', () => {
  it('cover fills the frame, contain fits inside it, both placed by x and y', () => {
    expect(pictureRects(PIC, 300, 300)).toEqual([{ x: -150, y: 0, w: 600, h: 300 }]);
    expect(pictureRects({ ...PIC, x: 0 }, 300, 300)).toEqual([{ x: 0, y: 0, w: 600, h: 300 }]);
    expect(pictureRects({ ...PIC, fit: 'contain' }, 300, 300)).toEqual([
      { x: 0, y: 75, w: 300, h: 150 },
    ]);
    expect(pictureRects({ ...PIC, fit: 'contain', y: 1 }, 300, 300)).toEqual([
      { x: 0, y: 150, w: 300, h: 150 },
    ]);
  });

  it('tile covers the frame with whole tiles at the picture size, shifted by x and y', () => {
    const tiles = pictureRects({ ...PIC, fit: 'tile', x: 0, y: 0 }, 1000, 500);
    expect(tiles.every((t) => t.w === 400 && t.h === 200)).toBe(true);
    expect(tiles[0]).toMatchObject({ x: 0, y: 0 });
    const area = (x: number, y: number) =>
      tiles.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h);
    for (const [x, y] of [
      [0, 0],
      [999, 499],
      [500, 250],
    ])
      expect(area(x, y)).toBe(true);
    // A tiny picture tiles no smaller than 1/48 of the shorter side.
    const small = pictureRects({ ...PIC, w: 2, h: 2, fit: 'tile' }, 4800, 4800);
    expect(small[0].w).toBe(100);
    expect(small.length).toBeLessThanOrEqual(49 * 49);
  });

  it('draws the background, the picture clipped to the frame, then the dimming wash', () => {
    const img = { width: 400, height: 200 } as unknown as CanvasImageSource;
    setPictureImage(PIC.src, img);
    const { g, calls } = rec();
    const bg = withPicture({ kind: 'solid', color: '#223344' }, { ...PIC, dim: 0.4 });
    fillBackground(g, '#ffffff', { background: bg }, 300, 300);
    const names = calls.map((c) => c[0]);
    expect(names).toEqual([
      'fillRect',
      'save',
      'beginPath',
      'rect',
      'clip',
      'drawImage',
      'restore',
      'fillRect',
    ]);
    expect(calls[0]).toEqual(['fillRect', 1, 0, 0, 300, 300]);
    expect(calls[5]).toEqual(['drawImage', -150, 0, 600, 300]);
    expect(calls[7]).toEqual(['fillRect', 0.4, 0, 0, 300, 300]);
    setPictureImage(PIC.src, null);
    // Not decoded yet: only the background.
    const r = rec();
    fillBackground(r.g, '#ffffff', { background: bg }, 300, 300);
    expect(r.calls.map((c) => c[0])).toEqual(['fillRect', 'fillRect']);
  });

  it('a transparent poster draws the picture alone', () => {
    setPictureImage(PIC.src, { width: 1, height: 1 } as unknown as CanvasImageSource);
    const { g, calls } = rec();
    fillBackground(
      g,
      'transparent',
      { background: withPicture(undefined, { ...PIC, dim: 0.5 }) },
      10,
      10,
    );
    expect(calls.filter((c) => c[0] === 'drawImage')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'fillRect')).toHaveLength(1);
    setPictureImage(PIC.src, null);
  });

  it('SVG writes the image once and a <use> per tile', () => {
    const svg = new SvgContext(1000, 500);
    const bg = withPicture({ kind: 'solid', color: '#000000' }, { ...PIC, fit: 'tile' });
    fillBackground(asCtx2D(svg), '#fff', { background: bg }, 1000, 500);
    const out = svg.toSvg();
    expect(out.match(/<image /g)).toHaveLength(1);
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out).toContain(`xlink:href="${PIC.src}"`);
    expect((out.match(/<use /g) ?? []).length).toBe(
      pictureRects({ ...PIC, fit: 'tile' }, 1000, 500).length,
    );
    expect(out).toContain('clip-path=');
  });

  it('withPicture keeps the background under it and fills the defaults', () => {
    const bg = withPicture({ kind: 'solid', color: '#123456' }, { src: PIC.src, w: 4, h: 3 });
    expect(bg).toEqual({
      kind: 'picture',
      picture: { src: PIC.src, w: 4, h: 3, fit: 'cover', x: 0.5, y: 0.5, dim: 0 },
      under: { kind: 'solid', color: '#123456' },
    });
    expect(withPicture({ kind: 'solid', color: '#123456' }, undefined)).toEqual({
      kind: 'solid',
      color: '#123456',
    });
    expect(backgroundSamples(bg, '#fff')).toEqual(['#123456']);
  });
});
