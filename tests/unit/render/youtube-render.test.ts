/**
 * Ready for YouTube render additions (PLAN.md §12): glow, vignette and guide lines at pitches in
 * drawScore, video frames and posters (PNG and SVG); the opening and ending (title card, fades,
 * lead-in, end card); the thumbnail's size.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  END_FADE,
  EXPORT_LOOK,
  GLOW_PASSES,
  TITLE_AT,
  TITLE_HOLD,
  TITLE_IN,
  TITLE_OUT,
  bookendsAt,
  bookendsOn,
  cameraAt,
  cameraScore,
  drawPoster,
  drawScore,
  drawVideoFrame,
  drawVideoMoment,
  endCardCamera,
  lookStyle,
  pieceLook,
  pitchGuideLabel,
  pitchToY,
  posterStyle,
  thumbnailSize,
  titleAlpha,
  videoCamera,
  videoLength,
  videoMarkers,
  videoStyle,
  type Ctx2D,
  type Look,
  type VideoFrameOptions,
} from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

const ROOT = join(import.meta.dirname, '../../..');
function load(file: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const PIECE = load('examples/compositions/kite-day.algorhythms.json');
const SCORE = compile(PIECE);
const CTX = { ...videoMarkers(PIECE), ...pieceLook(PIECE) };
const SIZE = { width: 853, height: 480 };
const T = SCORE.duration * 0.42;

interface Call {
  op: string;
  args: unknown[];
  fill: unknown;
  stroke: unknown;
  alpha: number;
  filter: string;
  comp: string;
  self: object;
}

/**
 * A recording context. `canvas` gives it a size (layers are made at it); calls from every
 * recorder go to `log` in order.
 */
function recorder(log: Call[] = [], canvas?: { width: number; height: number }) {
  const st: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    filter: 'none',
    globalCompositeOperation: 'source-over',
    m: [1, 0, 0, 1, 0, 0],
  };
  if (canvas) st.canvas = canvas;
  const ctx: object = new Proxy(st, {
    get(t, p: string) {
      if (p === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient')
        return (...args: number[]) => ({
          kind: p,
          args,
          stops: [] as unknown[],
          addColorStop() {},
        });
      if (p === 'getTransform')
        return () => {
          const [a, b, c, d, e, f] = t.m as number[];
          return { a, b, c, d, e, f };
        };
      if (p === 'setTransform')
        return (...args: number[]) => {
          t.m = args;
          log.push(call(p, args));
        };
      if (p in t) return t[p];
      return (...args: unknown[]) => log.push(call(p, args));
    },
    set(t, p: string, v: unknown) {
      t[p] = v;
      return true;
    },
  });
  const call = (op: string, args: unknown[]): Call => ({
    op,
    args,
    fill: st.fillStyle,
    stroke: st.strokeStyle,
    alpha: st.globalAlpha as number,
    filter: st.filter as string,
    comp: st.globalCompositeOperation as string,
    self: ctx,
  });
  return { ctx: ctx as Ctx2D, log };
}

const look = (over: Partial<Look>): Look => ({ ...EXPORT_LOOK, future: 'full', ...over });
const styleOf = (over: Partial<Look>) => lookStyle(look(over), CTX);

function drawn(over: Partial<Look>, t = T): Call[] {
  const { ctx, log } = recorder();
  const cam = videoCamera('follow', SCORE, t, { aspect: '16:9', window: 20 });
  drawScore(ctx, SCORE, cam, styleOf(over), t, SIZE, 1);
  return log;
}

const strip = (calls: Call[]) => calls.map(({ self: _s, ...c }) => JSON.stringify(c));

afterEach(() => vi.unstubAllGlobals());

describe('all off draws exactly as before', () => {
  it('the style has no new fields when they are off', () => {
    const base = lookStyle(look({}), CTX);
    for (const over of [
      { glow: 0 },
      { vignette: 0 },
      { pitchGuides: { pitches: [], labels: true } },
      { glow: Number.NaN, vignette: -1 },
    ] as Partial<Look>[]) {
      expect(lookStyle(look(over), CTX)).toEqual(base);
    }
  });
  it('drawScore makes the same calls', () => {
    expect(strip(drawn({ glow: 0, vignette: 0 }))).toEqual(strip(drawn({})));
  });
  it('a video frame with empty bookends is the old frame', () => {
    const style = videoStyle({ theme: 'dark', look: look({}), ...CTX });
    const o: VideoFrameOptions = { aspect: '16:9', size: '720', camera: 'whole', style };
    const a = recorder();
    drawVideoFrame(a.ctx, SCORE, o, 40, 30);
    const b = recorder();
    drawVideoFrame(b.ctx, SCORE, { ...o, bookends: {} }, 40, 30);
    expect(strip(b.log)).toEqual(strip(a.log));
    expect(bookendsOn({ title: { text: '  ' }, endCard: 0 })).toBe(false);
  });
});

describe('guide lines at pitches', () => {
  it('a faint dashed line at each pitch in view, labelled with its note name', () => {
    const calls = drawn({ pitchGuides: { pitches: [64, 69.25, 200], labels: true } });
    const cam = videoCamera('follow', SCORE, T, { aspect: '16:9', window: 20 });
    const style = styleOf({ pitchGuides: { pitches: [64], labels: true } });
    const view = cameraAt(cameraScore(SCORE), cam, T, SIZE, true, 0);
    expect(style.pitchGuides).toBeDefined();
    const y = Math.round(pitchToY(view, 64)) + 0.5;
    const move = calls.findIndex((c) => c.op === 'moveTo' && c.args[0] === 0 && c.args[1] === y);
    expect(move).toBeGreaterThan(0);
    const stroke = calls.slice(move).find((c) => c.op === 'stroke')!;
    expect(stroke.alpha).toBeCloseTo(0.55);
    const labels = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(labels).toContain('E4');
    expect(labels).toContain('A4+25');
    // Before the lines: the guides come before the first line stroke in the guides' colour.
    const lineStroke = calls.findIndex((c, i) => i > move + 2 && c.op === 'stroke');
    expect(lineStroke).toBeGreaterThan(move);
    // Off the plot (200) draws nothing; no labels without `labels`.
    const quiet = drawn({ pitchGuides: { pitches: [64], labels: false } });
    expect(quiet.filter((c) => c.op === 'fillText').map((c) => c.args[0])).not.toContain('E4');
    expect(pitchGuideLabel(61)).toBe('C#4');
    expect(pitchGuideLabel(59.9)).toBe('C4-10');
  });
  it('uses the guides swatch', () => {
    const calls = drawn({
      pitchGuides: { pitches: [64], labels: true },
      colours: { guides: '#ff0000' },
    });
    const label = calls.find((c) => c.op === 'fillText' && c.args[0] === 'E4')!;
    expect(label.fill).toBe('#ff0000');
  });
});

describe('vignette', () => {
  it('one radial fill over the frame after the lines and before the HUD', () => {
    const calls = drawn({ vignette: 0.5 });
    const i = calls.findIndex(
      (c) =>
        c.op === 'fillRect' &&
        (c.fill as { kind?: string }).kind === 'createRadialGradient' &&
        c.args[2] === SIZE.width,
    );
    expect(i).toBeGreaterThan(0);
    const lastLine = calls.map((c) => c.op).lastIndexOf('stroke');
    const hud = calls.findIndex((c, k) => k > i && c.op === 'fillText');
    expect(hud).toBeGreaterThan(i);
    expect(calls.slice(i + 1).some((c) => c.op === 'stroke' && c.args.length === 0)).toBe(
      lastLine > i,
    );
  });
  it('a poster with rows darkens once', () => {
    const style = posterStyle({ theme: 'dark', look: look({ vignette: 1, hud: [] }), ...CTX });
    const { ctx, log } = recorder();
    drawPoster(ctx, SCORE, { name: 'x' }, { size: '16:9', style, title: true, rows: 3 });
    const fills = log.filter(
      (c) => c.op === 'fillRect' && (c.fill as { kind?: string }).kind === 'createRadialGradient',
    );
    expect(fills).toHaveLength(1);
  });
});

describe('glow', () => {
  it('no layer (a test double): wide translucent traces under the lines', () => {
    const off = drawn({});
    const on = drawn({ glow: 1 });
    const strokes = (c: Call[]) => c.filter((x) => x.op === 'stroke' || x.op === 'fill').length;
    expect(strokes(on)).toBeGreaterThan(strokes(off));
    // The first line trace of the glow is wider than the line and translucent.
    const first = on.find((c) => c.op === 'stroke' && c.alpha < 0.5 && c.alpha > 0);
    expect(first).toBeDefined();
  });
  it('the glow colour replaces the line colours in its passes', () => {
    const on = drawn({ glow: 1, colours: { glow: '#00ff00' } });
    expect(on.some((c) => c.op === 'stroke' && c.stroke === '#00ff00')).toBe(true);
    const off = drawn({ glow: 1 });
    expect(off.some((c) => c.stroke === '#00ff00')).toBe(false);
  });
  it('with layers: traced into a small layer, blurred, composited per pass at its share', () => {
    const log: Call[] = [];
    let filterOk = true;
    class FakeCanvas {
      width: number;
      height: number;
      ctx: Ctx2D;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        const r = recorder(log, this);
        this.ctx = r.ctx;
        if (!filterOk) {
          // An engine without canvas `filter`: the property doesn't stick.
          Object.defineProperty(r.ctx, 'filter', { get: () => 'none', set: () => undefined });
        }
      }
      getContext() {
        return this.ctx;
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    for (const ok of [true, false]) {
      filterOk = ok;
      log.length = 0;
      const main = recorder(log, { width: 1920, height: 1080 });
      const cam = videoCamera('follow', SCORE, T, { aspect: '16:9', window: 20 });
      drawScore(main.ctx, SCORE, cam, styleOf({ glow: 0.8 }), T, SIZE, 2.25);
      const composites = log.filter((c) => c.self === main.ctx && c.op === 'drawImage');
      expect(composites.map((c) => c.alpha)).toEqual(
        GLOW_PASSES.map(([, share]) => Math.min(1, 0.8 * share)),
      );
      // Drawn at the canvas's size from a layer at 1.5/2.25 of it.
      expect(composites[0].args.slice(7)).toEqual([1920, 1080]);
      expect(composites[0].args[3]).toBe(1280);
      const blurs = log.filter((c) => c.self !== main.ctx && c.op === 'drawImage');
      if (ok) {
        expect(blurs.map((c) => c.filter)).toEqual(GLOW_PASSES.map(([r]) => `blur(${r * 1.5}px)`));
      } else {
        // Three ring passes of nine taps per glow pass, added up.
        expect(blurs).toHaveLength(GLOW_PASSES.length * 27);
        expect(blurs.every((c) => c.comp === 'lighter' && Math.abs(c.alpha - 1 / 9) < 1e-9)).toBe(
          true,
        );
      }
      // The glow is under the lines: its composites come before the main context's line strokes.
      const firstComposite = log.indexOf(composites[0]);
      const lastMainStroke = log.map((c) => c.self === main.ctx && c.op).lastIndexOf('stroke');
      expect(firstComposite).toBeLessThan(lastMainStroke);
    }
  });
  it('SVG: the lines again under a Gaussian blur filter', () => {
    const style = posterStyle({ theme: 'dark', look: look({ glow: 1, hud: [] }), ...CTX });
    const svg = new SvgContext(3840, 2160);
    drawPoster(asCtx2D(svg), SCORE, { name: 'x' }, { size: '16:9', style, title: false });
    const out = svg.toSvg();
    expect(out).toMatch(/<filter id="f\d+" filterUnits="userSpaceOnUse"[^>]*><feGaussianBlur/);
    // The blurred traces come first; the lines themselves follow, unfiltered.
    const els = out.split('\n').filter((l) => l.includes('fill="url(#g1)"'));
    const firstPlain = els.findIndex((l) => !l.includes('filter='));
    expect(els[0]).toContain('filter="url(#f');
    expect(firstPlain).toBeGreaterThan(0);
    expect(els.slice(firstPlain).some((l) => l.includes('filter='))).toBe(false);
    const flat = new SvgContext(3840, 2160);
    drawPoster(
      asCtx2D(flat),
      SCORE,
      { name: 'x' },
      {
        size: '16:9',
        style: posterStyle({ theme: 'dark', look: look({ hud: [] }), ...CTX }),
        title: false,
      },
    );
    expect(flat.toSvg()).not.toContain('<filter');
  });
  it('SVG vignette and pitch guides', () => {
    const style = posterStyle({
      theme: 'dark',
      look: look({ vignette: 1, pitchGuides: { pitches: [64], labels: true }, hud: [] }),
      ...CTX,
    });
    const svg = new SvgContext(3840, 2160);
    drawPoster(asCtx2D(svg), SCORE, { name: 'x' }, { size: '16:9', style, title: false });
    const out = svg.toSvg();
    expect(out).toContain('<radialGradient');
    expect(out).toContain('stop-opacity="0.7"');
    expect(out).toContain('>E4</text>');
    expect(out).toContain('stroke-dasharray');
  });
});

describe('opening and ending timing', () => {
  const span = { start: 10, end: 40 };
  it('title card: fades in, holds about 4 s, fades out', () => {
    const b = { title: { text: 'Kite Day' } };
    expect(titleAlpha(b, 0)).toBe(0);
    expect(titleAlpha(b, TITLE_AT)).toBe(0);
    expect(titleAlpha(b, TITLE_AT + TITLE_IN / 2)).toBeCloseTo(0.5);
    expect(titleAlpha(b, TITLE_AT + TITLE_IN)).toBe(1);
    expect(titleAlpha(b, TITLE_AT + TITLE_IN + TITLE_HOLD)).toBe(1);
    expect(titleAlpha(b, TITLE_AT + TITLE_IN + TITLE_HOLD + TITLE_OUT / 2)).toBeCloseTo(0.5);
    expect(titleAlpha(b, TITLE_AT + TITLE_IN + TITLE_HOLD + TITLE_OUT)).toBe(0);
    expect(titleAlpha({}, 3)).toBe(0);
    expect(titleAlpha({ title: { text: '' } }, 3)).toBe(0);
  });
  it('lead-in holds the opening frame; the music starts after it', () => {
    const b = { leadIn: 1.5 };
    expect(bookendsAt(b, span, 0).t).toBe(10);
    expect(bookendsAt(b, span, 1.5).t).toBe(10);
    expect(bookendsAt(b, span, 2.5).t).toBeCloseTo(11);
    expect(bookendsAt(b, span, 100).t).toBe(40);
  });
  it('fades: black at the start and the end', () => {
    const b = { fadeIn: 2, fadeOut: 3 };
    const L = 35;
    expect(bookendsAt(b, span, 0, L).black).toBe(1);
    expect(bookendsAt(b, span, 1, L).black).toBeCloseTo(0.5);
    expect(bookendsAt(b, span, 2, L).black).toBe(0);
    expect(bookendsAt(b, span, L - 3, L).black).toBe(0);
    expect(bookendsAt(b, span, L - 1.5, L).black).toBeCloseTo(0.5);
    expect(bookendsAt(b, span, L, L).black).toBe(1);
  });
  it('end card: crossfades over 2 s from the section’s end; the video lasts to its end', () => {
    const b = { leadIn: 1, endCard: 10 };
    const at = 1 + 30;
    expect(bookendsAt(b, span, at).end).toBe(0);
    expect(bookendsAt(b, span, at + END_FADE / 2).end).toBeCloseTo(0.5);
    expect(bookendsAt(b, span, at + END_FADE).end).toBe(1);
    expect(bookendsAt({ leadIn: 1 }, span, at + 5).end).toBe(0);
    // Length: lead-in + music + card, or the audio's ring-out if longer.
    expect(videoLength(b, 30, 33)).toBe(41);
    expect(videoLength({ leadIn: 1, endCard: 5 }, 30, 38)).toBe(39);
    expect(videoLength(undefined, 30, 33)).toBe(33);
    expect(videoLength({ leadIn: 2 }, 30, 33)).toBe(35);
  });
});

describe('frames with an opening and ending', () => {
  const style = videoStyle({ theme: 'dark', look: look({}), ...CTX });
  const base: VideoFrameOptions = {
    aspect: '16:9',
    size: '720',
    camera: 'follow',
    window: 20,
    style,
    section: { start: 20, end: 50 },
    bookends: {
      leadIn: 1,
      fadeIn: 0.5,
      title: { text: 'Kite Day', subtitle: 'a test' },
      endCard: 5,
      fadeOut: 1,
      credit: 'Made with AlgoRhythms',
    },
    length: 36,
  };
  it('lead-in shows the section’s first frame; the title draws in the serif', () => {
    const { ctx, log } = recorder();
    const view = drawVideoMoment(ctx, SCORE, base, 3);
    expect(view.t).toBe(22);
    const title = log.find((c) => c.op === 'fillText' && c.args[0] === 'Kite Day');
    expect(title?.alpha).toBe(1);
    expect(log.some((c) => c.op === 'fillText' && c.args[0] === 'a test')).toBe(true);
    const lead = recorder();
    expect(drawVideoMoment(lead.ctx, SCORE, base, 0.7).t).toBe(20);
  });
  it('black at the very start; nothing over the picture in the middle', () => {
    const start = recorder();
    drawVideoMoment(start.ctx, SCORE, base, 0);
    const last = start.log[start.log.length - 1];
    expect(last.op).toBe('fillRect');
    expect(last.fill).toBe('#000000');
    expect(last.alpha).toBe(1);
    const mid = recorder();
    drawVideoMoment(mid.ctx, SCORE, base, 15);
    expect(mid.log.some((c) => c.fill === '#000000' && c.op === 'fillRect')).toBe(false);
    expect(mid.log.some((c) => c.op === 'fillText' && c.args[0] === 'Kite Day')).toBe(false);
  });
  it('end card: the whole-piece view of the section drawn finished, with the credit', () => {
    const { ctx, log } = recorder();
    const view = drawVideoMoment(ctx, SCORE, base, 1 + 30 + 3);
    const cam = endCardCamera(SCORE, base);
    expect(cam.start).toBe(20);
    expect(cam.window).toBe(30);
    expect(view.start).toBe(20);
    expect(view.window).toBe(30);
    expect(view.t).toBe(SCORE.duration);
    expect(log.some((c) => c.op === 'fillText' && c.args[0] === 'Made with AlgoRhythms')).toBe(
      true,
    );
    // No HUD readouts on the card.
    expect(log.some((c) => c.op === 'fillText' && /^t /.test(String(c.args[0])))).toBe(false);
  });
  it('crossfade: the end card composited at its share over the last frame', () => {
    const log: Call[] = [];
    class FakeCanvas {
      width: number;
      height: number;
      ctx: Ctx2D;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        this.ctx = recorder(log, this).ctx;
      }
      getContext() {
        return this.ctx;
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const main = recorder(log, { width: 1280, height: 720 });
    const view = drawVideoMoment(main.ctx, SCORE, base, 1 + 30 + END_FADE / 2);
    expect(view.t).toBe(50);
    const comp = log.filter((c) => c.self === main.ctx && c.op === 'drawImage');
    expect(comp).toHaveLength(1);
    expect(comp[0].alpha).toBeCloseTo(0.5);
    expect(log.some((c) => c.self !== main.ctx && c.args[0] === 'Made with AlgoRhythms')).toBe(
      true,
    );
  });
  it('drawVideoFrame takes the bookends by frame number', () => {
    const a = recorder();
    const b = recorder();
    drawVideoFrame(a.ctx, SCORE, base, 90, 30);
    drawVideoMoment(b.ctx, SCORE, base, 3);
    expect(strip(a.log)).toEqual(strip(b.log));
  });
});

describe('thumbnail', () => {
  it('YouTube’s 1280×720, and the narrow aspects at theirs', () => {
    expect(thumbnailSize('16:9')).toEqual({ width: 1280, height: 720 });
    expect(thumbnailSize('9:16')).toEqual({ width: 720, height: 1280 });
    expect(thumbnailSize('1:1')).toEqual({ width: 1080, height: 1080 });
  });
});
