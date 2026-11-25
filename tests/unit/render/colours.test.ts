/** Export colours (PLAN.md §12 "Exports you can shape" → Colours) in drawScore, video and poster. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  PLAYER_LOOK,
  drawPosterLayout,
  layoutPoster,
  drawScore,
  drawVideoFrame,
  lookStyle,
  pieceLook,
  videoMarkers,
  videoStyle,
  type Ctx2D,
  type Look,
  type ScoreStyle,
} from '../../../src/render';
import { mixHex, stopsAt, stylePaint, type LookColours } from '../../../src/render/colours';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

const ROOT = join(import.meta.dirname, '../../..');
function load(file: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const PIECE = load('examples/songs/kite-day.algorhythms.json');
const SCORE = compile(PIECE);
const MARKS = videoMarkers(PIECE);
const CTX = { ...MARKS, ...pieceLook(PIECE) };

interface Call {
  op: string;
  args: unknown[];
  fill: unknown;
  stroke: unknown;
}
interface Grad {
  kind: string;
  args: number[];
  stops: [number, string][];
}

function recorder(): { ctx: Ctx2D; calls: Call[]; grads: Grad[] } {
  const calls: Call[] = [];
  const grads: Grad[] = [];
  const st: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1 };
  const grad =
    (kind: string) =>
    (...args: number[]) => {
      const g: Grad = { kind, args, stops: [] };
      grads.push(g);
      return { addColorStop: (at: number, c: string) => g.stops.push([at, c]), g };
    };
  const ctx = new Proxy(st, {
    get(t, p: string) {
      if (p === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (p === 'createLinearGradient') return grad('linear');
      if (p === 'createRadialGradient') return grad('radial');
      if (p in t) return t[p];
      return (...args: unknown[]) => {
        calls.push({ op: p, args, fill: t.fillStyle, stroke: t.strokeStyle });
      };
    },
    set(t, p: string, v: unknown) {
      t[p] = v;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls, grads };
}

const SIZE = { width: 853, height: 480 };
const T = SCORE.duration * 0.42;
const style = (over: Partial<Look>): ScoreStyle =>
  lookStyle({ ...PLAYER_LOOK, beats: 'every', ...over }, CTX);
function draw(s: ScoreStyle) {
  const r = recorder();
  drawScore(r.ctx, SCORE, { start: 0, window: SCORE.duration }, s, T, SIZE, 2);
  return r;
}
const strokes = (calls: Call[]) =>
  new Set(calls.filter((c) => c.op === 'stroke').map((c) => c.stroke));
/** Line paint: strokes, and fills of variable-width outlines. */
const paints = (calls: Call[]) =>
  new Set(calls.flatMap((c) => (c.op === 'stroke' ? [c.stroke] : c.op === 'fill' ? [c.fill] : [])));
const textFills = (calls: Call[]) =>
  new Set(calls.filter((c) => c.op === 'fillText').map((c) => c.fill));

const ALL: LookColours = {
  heads: '#a10001',
  playhead: '#a10002',
  hud: '#a10003',
  markers: '#a10004',
  labels: '#a10005',
  guides: '#a10006',
  beats: '#a10007',
  title: '#a10008',
};

describe('export colours in the renderer', () => {
  it('no colours (or empty ones): the style is exactly as before', () => {
    const before = style({});
    expect(before.paint).toBeUndefined();
    expect(style({ colours: {} })).toEqual(before);
    expect(stylePaint({}, false)).toBeUndefined();
    // Transparent wins over a background.
    expect(stylePaint({ background: { kind: 'solid', color: '#000000' } }, true)).toBeUndefined();
  });

  it('a solid background is the first fill', () => {
    const { calls } = draw(style({ colours: { background: { kind: 'solid', color: '#123456' } } }));
    const first = calls.find((c) => c.op === 'fillRect')!;
    expect(first.fill).toBe('#123456');
    expect(first.args).toEqual([0, 0, 853, 480]);
  });

  it('gradients: vertical, horizontal and radial over the frame', () => {
    const bg = (dir: 'vertical' | 'horizontal' | 'radial') =>
      draw(
        style({
          colours: { background: { kind: 'gradient', from: '#000000', to: '#ffffff', dir } },
        }),
      ).grads[0];
    expect(bg('vertical')).toMatchObject({ kind: 'linear', args: [0, 0, 0, 480] });
    expect(bg('horizontal')).toMatchObject({ kind: 'linear', args: [0, 0, 853, 0] });
    const r = bg('radial');
    expect(r.kind).toBe('radial');
    expect(r.args.slice(0, 5)).toEqual([426.5, 240, 0, 426.5, 240]);
    expect(r.args[5]).toBeCloseTo(Math.hypot(853, 480) / 2, 9);
    expect(r.stops).toEqual([
      [0, '#000000'],
      [1, '#ffffff'],
    ]);
  });

  it('each element draws with its own colour', () => {
    const { calls } = draw(style({ colours: ALL, colors: 'ink' }));
    const s = strokes(calls);
    for (const k of ['playhead', 'markers', 'guides', 'beats'] as const)
      expect(s, k).toContain(ALL[k]);
    const f = textFills(calls);
    for (const k of ['hud', 'labels', 'guides', 'heads'] as const) expect(f, k).toContain(ALL[k]);
    // Heads: dots filled and rings stroked in the heads colour (not the line colour or accent).
    const arcs = calls.filter(
      (c) => c.op === 'fill' || (c.op === 'stroke' && c.stroke === ALL.heads),
    );
    expect(arcs.some((c) => c.fill === ALL.heads)).toBe(true);
    // Nothing is left in the theme's rule or secondary ink.
    const old = new Set(['#D2D8DF', '#5E6876']);
    expect([...s].filter((x) => old.has(x as string))).toEqual([]);
    expect([...f].filter((x) => old.has(x as string))).toEqual([]);
  });

  it('lines: own pitch stops, one colour and per part; voice colours win', () => {
    const custom = ['#00aa00'];
    const pitch = lookStyle(
      {
        ...PLAYER_LOOK,
        colours: { lines: { kind: 'pitch', stops: ['#000000', '#ff0000', '#ffffff'] } },
      },
      { ...CTX, customColors: custom },
    );
    expect(pitch).toMatchObject({ colors: 'pitch', paint: { voiceFirst: true } });
    const r = draw(pitch);
    const lineGrad = r.grads.find((g) => g.stops.length === 3)!;
    expect(lineGrad.stops).toEqual([
      [0, '#000000'],
      [0.5, '#ff0000'],
      [1, '#ffffff'],
    ]);
    expect(paints(r.calls)).toContain('#00aa00');
    const one = lookStyle(
      { ...PLAYER_LOOK, colours: { lines: { kind: 'one', color: '#0000ff' } } },
      CTX,
    );
    expect(one).toMatchObject({ colors: 'custom', lineInk: '#0000ff' });
    expect(paints(draw(one).calls)).toContain('#0000ff');
    const part = lookStyle(
      { ...PLAYER_LOOK, colours: { lines: { kind: 'part', colors: ['#111111', '#222222'] } } },
      { ...CTX, customColors: [undefined, '#999999'] },
    );
    expect(part.customColors).toEqual(['#111111', '#999999']);
  });

  it('by-pitch interpolation (heads) mixes neighbouring stops in sRGB', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(stopsAt(['#000000', '#ff0000', '#ffffff'], 0.25)).toBe('#800000');
    expect(stopsAt(['#000000', '#ff0000', '#ffffff'], 1)).toBe('#ffffff');
    expect(stopsAt(['#000000', '#ff0000'], -1)).toBe('#000000');
  });

  it('a video frame draws the background and HUD colours', () => {
    const look: Look = {
      ...PLAYER_LOOK,
      colours: { background: { kind: 'solid', color: '#202122' }, hud: '#f0f1f2' },
    };
    const s = videoStyle({ theme: 'light', look, ...MARKS });
    const { ctx, calls } = recorder();
    drawVideoFrame(
      ctx,
      SCORE,
      { aspect: '16:9', size: '720', camera: 'follow', window: 12, style: s },
      90,
      30,
    );
    expect(calls.find((c) => c.op === 'fillRect')!.fill).toBe('#202122');
    expect(textFills(calls)).toContain('#f0f1f2');
  });

  it('SVG poster: gradients as SVG gradients, title and labels in their colours', () => {
    const svgOf = (colours: LookColours, rows = 1) => {
      const look: Look = { ...PLAYER_LOOK, hud: ['chord'], colours };
      const L = layoutPoster({ compiled: SCORE, piece: PIECE, look, base: { rows } });
      const c = new SvgContext(L.width, L.height);
      drawPosterLayout(asCtx2D(c), SCORE, L);
      return c.toSvg();
    };
    const lin = svgOf({
      background: { kind: 'gradient', from: '#010203', to: '#a0b0c0', dir: 'vertical' },
      title: '#fedcba',
      hud: '#abcdef',
      labels: '#123123',
    });
    expect(lin).toMatch(
      /<linearGradient id="(g\d+)"[^>]*y2="2160"><stop offset="0" stop-color="#010203"\/><stop offset="1" stop-color="#a0b0c0"\/>/,
    );
    expect(lin).toMatch(/<rect x="0" y="0" width="3840" height="2160" fill="url\(#g\d+\)"/);
    expect(lin).toContain('fill="#fedcba"');
    expect(lin).toContain('fill="#abcdef"');
    expect(lin).toContain('fill="#123123"');
    const rad = svgOf({
      background: { kind: 'gradient', from: '#010203', to: '#a0b0c0', dir: 'radial' },
    });
    expect(rad).toMatch(
      /<radialGradient id="g\d+" gradientUnits="userSpaceOnUse" cx="1920" cy="1080" r="2202\.9\d*" fx="1920" fy="1080">/,
    );
    // Rows: one background over the whole poster, none per row.
    const rows = svgOf(
      { background: { kind: 'gradient', from: '#010203', to: '#a0b0c0', dir: 'vertical' } },
      3,
    );
    expect(rows.match(/<rect [^>]*fill="url\(/g)).toHaveLength(1);
  });
});
