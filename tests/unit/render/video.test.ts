/** Video frames (PLAN.md §12 "Video export", revision 11): sizes, camera, style, frame count. */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import type { CompiledScore } from '../../../src/core/types';
import {
  DEFAULT_FUTURE_OPACITY,
  LINE_WIDTH,
  SMOOTH_X,
  drawScore,
  drawVideoFrame,
  pitchExtent,
  pitchToY,
  videoCamera,
  videoFrameCount,
  videoFrameTime,
  videoLayout,
  videoMarkers,
  videoSize,
  videoStyle,
  videoWindow,
  type ScoreStyle,
  type VideoAspect,
} from '../../../src/render';
import { widthUnits } from '../../../src/render/strands';
import { crossfadePiece } from '../core/crossfade-fixtures';
import { pathCtx, type Shape } from './path-ctx';

const ASPECTS: VideoAspect[] = ['16:9', '9:16', '1:1'];

/** A score of the given duration (the camera reads only duration and segments). */
function bare(duration: number): CompiledScore {
  return {
    duration,
    voices: [
      {
        id: 'v0',
        index: 0,
        lives: [{ born: 0, fadeIn: 0 }],
        segments: [{ t0: 0, t1: duration, p0: 60, p1: 67, ease: 'linear' }],
        timbre: [{ t: 0, preset: 'sine', fade: 0 }],
        level: [],
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sends: {},
      },
    ],
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'C', scale: 'major' } }],
    referenceHz: 440,
    seed: 1,
  };
}

describe('videoSize', () => {
  it('gives the 1080- and 720-class pixel sizes', () => {
    expect(videoSize('16:9', '1080')).toEqual({ width: 1920, height: 1080 });
    expect(videoSize('9:16', '1080')).toEqual({ width: 1080, height: 1920 });
    expect(videoSize('1:1', '1080')).toEqual({ width: 1080, height: 1080 });
    expect(videoSize('16:9', '720')).toEqual({ width: 1280, height: 720 });
    expect(videoSize('9:16', '720')).toEqual({ width: 720, height: 1280 });
    expect(videoSize('1:1', '720')).toEqual({ width: 720, height: 720 });
  });

  it('lays 720p out exactly as 1080p, at two thirds the pixel ratio', () => {
    for (const a of ASPECTS) {
      const hi = videoLayout(a, '1080');
      const lo = videoLayout(a, '720');
      expect(lo.width).toBeCloseTo(hi.width, 9);
      expect(lo.height).toBeCloseTo(hi.height, 9);
      expect(lo.dpr / hi.dpr).toBeCloseTo(2 / 3, 9);
      const px = videoSize(a, '1080');
      expect(hi.width * hi.dpr).toBeCloseTo(px.width, 9);
      expect(hi.height * hi.dpr).toBeCloseTo(px.height, 9);
      expect(hi.dpr).toBeGreaterThanOrEqual(2); // text at least twice the player's size
    }
  });
});

describe('videoCamera', () => {
  const s = bare(100);
  const opts = { aspect: '16:9' as const, window: 20 };

  it('follows with the playhead at 35 %, clamped at the start and the end', () => {
    expect(videoCamera('follow', s, 0, opts).start).toBe(0);
    expect(videoCamera('follow', s, 5, opts).start).toBe(0);
    const mid = videoCamera('follow', s, 50, opts);
    expect(mid.window).toBe(20);
    expect((50 - mid.start) / mid.window).toBeCloseTo(SMOOTH_X, 12);
    expect(videoCamera('follow', s, 95, opts).start).toBe(80);
    expect(videoCamera('follow', s, 100, opts).start).toBe(80);
    expect(videoCamera('follow', s, 130, opts).start).toBe(80); // the tail holds the end
  });

  it('followAt puts the playhead there, clamped at the ends; 0.35 is the default', () => {
    const at = { ...opts, followAt: 0.8 };
    const mid = videoCamera('follow', s, 50, at);
    expect((50 - mid.start) / mid.window).toBeCloseTo(0.8, 12);
    expect(videoCamera('follow', s, 10, at).start).toBe(0);
    expect(videoCamera('follow', s, 99, at).start).toBe(80);
    expect(videoCamera('follow', s, 130, at).start).toBe(80);
    for (const t of [0, 5, 50, 95, 130]) {
      expect(videoCamera('follow', s, t, { ...opts, followAt: SMOOTH_X }).start).toBeCloseTo(
        videoCamera('follow', s, t, opts).start,
        12,
      );
    }
    expect(videoCamera('whole', s, 50, at).start).toBe(0);
  });

  it('whole piece: the fitted piece at every t', () => {
    for (const t of [0, 33, 100]) {
      expect(videoCamera('whole', s, t, opts)).toMatchObject({ start: 0, window: 100 });
    }
  });

  it('keeps layout px per second across aspects: narrower frames show less time', () => {
    expect(videoWindow(20, '16:9')).toBe(20);
    const tall = videoWindow(20, '9:16');
    const sq = videoWindow(20, '1:1');
    expect(tall).toBeLessThan(sq);
    expect(sq).toBeLessThan(20);
    const pps = (a: VideoAspect) => videoLayout(a, '1080').width / videoWindow(20, a);
    expect(pps('9:16')).toBeCloseTo(pps('16:9'), 9);
    expect(pps('1:1')).toBeCloseTo(pps('16:9'), 9);
    expect(videoWindow(2, '9:16')).toBe(2); // never under the 2 s minimum
    for (const a of ASPECTS) {
      const c = videoCamera('follow', s, 50, { aspect: a, window: 20 });
      expect(c.window).toBeCloseTo(videoWindow(20, a), 12);
      expect((50 - c.start) / c.window).toBeCloseTo(SMOOTH_X, 12);
    }
  });

  it('a window wider than the piece fits it', () => {
    expect(videoCamera('follow', s, 50, { aspect: '16:9', window: 500 })).toMatchObject({
      start: 0,
      window: 100,
    });
  });

  it('fixes the vertical framing for the whole video', () => {
    const range = pitchExtent(s);
    for (const mode of ['follow', 'whole'] as const)
      for (const t of [0, 10, 50, 99])
        expect(videoCamera(mode, s, t, opts).pitchRange).toEqual(range);
    expect(videoCamera('follow', s, 3, { ...opts, pitchRange: [40, 80] }).pitchRange).toEqual([
      40, 80,
    ]);
  });

  it('is a pure function of t: same camera whatever the call order', () => {
    const ts = [0, 12.5, 50, 99, 3, 77.25];
    const forward = ts.map((t) => videoCamera('follow', s, t, opts));
    const backward = [...ts].reverse().map((t) => videoCamera('follow', s, t, opts));
    expect(backward.reverse()).toEqual(forward);
  });
});

describe('videoFrameCount and the tail', () => {
  it('covers the audio: ends within one frame after it', () => {
    expect(videoFrameCount(10, 30)).toBe(300);
    expect(videoFrameCount(10.01, 30)).toBe(301);
    expect(videoFrameCount(181.3333, 60)).toBe(10880);
    for (const d of [0.5, 3.7, 61.04, 200.0001]) {
      for (const fps of [30, 60]) {
        const n = videoFrameCount(d, fps);
        expect(n / fps).toBeGreaterThanOrEqual(d - 1e-6);
        expect(n / fps - d).toBeLessThan(1 / fps);
      }
    }
    expect(videoFrameCount(0, 30)).toBe(1);
  });

  it('frame k is at k / fps, held at the piece end through the ring-out', () => {
    expect(videoFrameTime(0, 30, 10)).toBe(0);
    expect(videoFrameTime(45, 30, 10)).toBe(1.5);
    expect(videoFrameTime(300, 30, 10)).toBe(10);
    expect(videoFrameTime(360, 30, 10)).toBe(10);
  });
});

describe('videoStyle', () => {
  it('player look: heads, canvas playhead, ghost 0.35, no editor overlays', () => {
    const st = videoStyle({ theme: 'dark' });
    expect(st).toMatchObject({
      dark: true,
      colors: 'pitch',
      hud: true,
      heads: true,
      playhead: true,
      thickness: true,
      futureOpacity: DEFAULT_FUTURE_OPACITY,
    });
    for (const k of ['highlight', 'highlightVoices', 'traces', 'bars', 'preview', 'reveal'])
      expect(st).not.toHaveProperty(k);
    expect(videoStyle({ theme: 'light', hud: false, thickness: false })).toMatchObject({
      dark: false,
      hud: false,
      thickness: false,
    });
  });

  it('section labels and marker times as the player shows them', () => {
    const m = videoMarkers({
      moments: [
        { id: 'a', type: 'chord', at: 1, label: 'Intro' },
        { id: 'b', type: 'chord', at: 4 },
      ] as never,
    });
    expect(m).toEqual({ labels: { a: 'Intro' }, markerTimes: { a: 1, b: 4 } });
  });
});

const TOKENS = {
  paper: '#000001',
  ink: '#000002',
  ink2: '#000003',
  rule: '#000004',
  accent: '#000005',
  panel: '#000006',
};
const plain = (over: Partial<ScoreStyle> = {}): ScoreStyle => ({
  tokens: TOKENS,
  dark: false,
  colors: 'ink',
  oklch: true,
  futureOpacity: 1,
  hud: false,
  heads: false,
  ...over,
});

/** The ink-coloured shapes: the lines (ink colouring). */
function lineShapes(shapes: Shape[]): Shape[] {
  return shapes.filter((x) => x.style === TOKENS.ink);
}

describe('thickness', () => {
  const s = compile(crossfadePiece());
  const SIZE = { width: 1000, height: 600 };
  const cam = { start: 0, window: s.duration };

  it('default (absent) draws exactly as thickness on', () => {
    for (const t of [0.5, 3, 7, 11, 15]) {
      const a = pathCtx();
      const b = pathCtx();
      drawScore(a.ctx, s, cam, plain(), t, SIZE, 1);
      drawScore(b.ctx, s, cam, plain({ thickness: true }), t, SIZE, 1);
      expect(b.strokes).toEqual(a.strokes);
      expect(b.fills).toEqual(a.fills);
    }
  });

  it('on: the weight-4 unison is a rope √4 wide; off: every line at the base width', () => {
    // From 0 s four lines sound as one line of weight 4 on 60 (points at its start, x = 0).
    const on = pathCtx();
    const view = drawScore(on.ctx, s, cam, plain(), 16, SIZE, 1);
    const y60 = pitchToY(view, 60);
    const x = (t: number) => ((t - view.start) * view.pps) | 0;
    const halfAt = (shapes: Shape[], px: number) =>
      Math.max(
        ...shapes
          .flatMap((f) => f.pts)
          .filter(([ax, ay]) => Math.abs(ax - px) < 2 && Math.abs(ay - y60) < 10)
          .map(([, ay]) => Math.abs(ay - y60)),
      );
    const ropeHalf = halfAt(lineShapes(on.fills), x(0));
    expect(ropeHalf).toBeCloseTo((widthUnits(4) * LINE_WIDTH) / 2, 6);

    const off = pathCtx();
    drawScore(off.ctx, s, cam, plain({ thickness: false }), 16, SIZE, 1);
    // No line is wider than the base: strokes at LINE_WIDTH, fills at most half of it each side.
    for (const st of lineShapes(off.strokes)) expect(st.width).toBe(LINE_WIDTH);
    const offFills = lineShapes(off.fills);
    const offHalf = halfAt([...offFills, ...lineShapes(off.strokes)], x(0));
    expect(offHalf).toBeLessThanOrEqual(LINE_WIDTH / 2 + 1e-6);
  });

  it('off: no strand offsets, so lines sit on their pitch through a merge', () => {
    const off = pathCtx();
    const view = drawScore(off.ctx, s, cam, plain({ thickness: false }), 16, SIZE, 1);
    // Every drawn point is within the base half width of one of the voices' pitches at its time.
    const pts = [...lineShapes(off.fills), ...lineShapes(off.strokes)].flatMap((f) => f.pts);
    expect(pts.length).toBeGreaterThan(0);
    const toT = (px: number) => view.start + px / view.pps;
    let worst = 0;
    for (const [px, py] of pts) {
      const t = toT(px);
      let best = Infinity;
      for (const v of s.voices) {
        for (const seg of v.segments) {
          if (t < seg.t0 - 0.05 || t > seg.t1 + 0.05) continue;
          for (const p of [seg.p0, seg.p1]) {
            const d = Math.abs(py - pitchToY(view, p));
            if (d < best) best = d;
          }
          // Inside a glide: anywhere between the ends.
          const ya = pitchToY(view, seg.p0);
          const yb = pitchToY(view, seg.p1);
          if (py >= Math.min(ya, yb) - 1 && py <= Math.max(ya, yb) + 1) best = 0;
        }
      }
      if (best > worst) worst = best;
    }
    expect(worst).toBeLessThanOrEqual(LINE_WIDTH / 2 + 1e-6);
  });
});

describe('drawVideoFrame', () => {
  const s = compile(crossfadePiece());
  const style = videoStyle({ theme: 'light', colors: 'ink' });

  it('draws frame k at t = k / fps in the video layout, playhead in the canvas', () => {
    const p = pathCtx();
    const view = drawVideoFrame(
      p.ctx,
      s,
      { aspect: '16:9', size: '1080', camera: 'whole', style },
      90,
      30,
    );
    expect(view.t).toBe(3);
    expect(view.width).toBeCloseTo(videoLayout('16:9', '1080').width, 9);
    // The playhead: a vertical rule-coloured stroke at the head's x.
    const head = p.strokes.filter(
      (x) =>
        x.style === style.tokens.rule &&
        x.pts.length === 2 &&
        x.pts[0][0] === x.pts[1][0] &&
        Math.abs(x.pts[0][0] - (Math.round(view.xHead) + 0.5)) < 1e-9,
    );
    expect(head.length).toBeGreaterThan(0);
  });

  it('is the same frame whatever was drawn before', () => {
    const o = {
      aspect: '9:16' as const,
      size: '720' as const,
      camera: 'follow' as const,
      window: 6,
      style,
    };
    const a = pathCtx();
    drawVideoFrame(a.ctx, s, o, 200, 30);
    const b = pathCtx();
    drawVideoFrame(b.ctx, s, o, 10, 30);
    drawVideoFrame(b.ctx, s, { ...o, aspect: '1:1' }, 400, 30);
    const c = pathCtx();
    drawVideoFrame(c.ctx, s, o, 200, 30);
    expect(c.strokes).toEqual(a.strokes);
    expect(c.fills).toEqual(a.fills);
  });
});
