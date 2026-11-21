import { describe, expect, it } from 'vitest';
import type { CompiledScore, CompiledVoice, Segment } from '../../../src/core/types';
import {
  DIM_ALPHA,
  HIGHLIGHT_WIDTH,
  cameraAt,
  cameraScore,
  drawScore,
  hoverLabel,
  nearestLine,
  noteLabel,
  pitchToY,
  timeToX,
  type CameraState,
  type Ctx2D,
  type ScoreStyle,
} from '../../../src/render';

interface Call {
  op: string;
  args: unknown[];
  stroke: unknown;
  alpha: number;
  width: number;
}

function fakeCtx(): { ctx: Ctx2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, strokeStyle: '', lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({
          op: prop,
          args,
          stroke: target.strokeStyle,
          alpha: target.globalAlpha as number,
          width: target.lineWidth as number,
        });
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls };
}

const seg = (t0: number, t1: number, p0: number, p1: number, momentId?: string): Segment => ({
  t0,
  t1,
  p0,
  p1,
  ease: 'linear',
  momentId,
});

function voice(index: number, segments: Segment[]): CompiledVoice {
  return {
    id: `v${index}`,
    index,
    lives: [{ born: 0, fadeIn: 0 }],
    segments,
    timbre: [{ t: 0, preset: 'sine', fade: 0 }],
    level: [],
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sends: {},
  };
}

// Voice 0 holds 60 then glides to 64 (moment m1) and holds; voice 1 holds 67 throughout (m0).
const v0 = voice(0, [
  seg(0, 10, 60, 60, 'm0'),
  seg(10, 12, 60, 64, 'm1'),
  seg(12, 40, 64, 64, 'm1'),
]);
const v1 = voice(1, [seg(0, 40, 67, 67, 'm0')]);
const SCORE: CompiledScore = {
  duration: 40,
  voices: [v0, v1],
  walkSteps: [],
  momentSpans: [],
  diagnostics: [],
  keys: [{ t: 0, key: { tonic: 'D', scale: 'major' } }],
  referenceHz: 440,
  seed: 1,
};
const RED = '#aa0001';
const BLUE = '#aa0002';
const style = (over: Partial<ScoreStyle> = {}): ScoreStyle => ({
  tokens: {
    paper: '#000001',
    ink: '#000002',
    ink2: '#000003',
    rule: '#000004',
    accent: '#000005',
    panel: '#000006',
  },
  dark: false,
  colors: 'custom',
  oklch: true,
  customColors: [RED, BLUE],
  futureOpacity: 1,
  hud: false,
  heads: false,
  ...over,
});
const SIZE = { width: 1000, height: 600 };
const CAM: CameraState = { window: 40, start: 0 };

const strokes = (calls: Call[], color: string): Call[] =>
  calls.filter((c) => c.op === 'stroke' && c.stroke === color);

describe('selection highlight', () => {
  it('draws nothing extra without a selection', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    drawScore(a.ctx, SCORE, CAM, style(), 20, SIZE, 1);
    drawScore(b.ctx, SCORE, CAM, style({ highlight: new Set() }), 20, SIZE, 1);
    expect(b.calls.map((c) => c.op)).toEqual(a.calls.map((c) => c.op));
    expect(strokes(a.calls, RED).every((c) => c.alpha === 1 && c.width === 1.5)).toBe(true);
  });

  it('dims all lines and redraws the selected segments thick on top', () => {
    const { ctx, calls } = fakeCtx();
    drawScore(ctx, SCORE, CAM, style({ highlight: new Set(['m1']) }), 20, SIZE, 1);
    const red = strokes(calls, RED);
    const blue = strokes(calls, BLUE);
    // Blue (m0 only) is dimmed, never highlighted.
    expect(blue.length).toBeGreaterThan(0);
    expect(blue.every((c) => c.alpha === DIM_ALPHA && c.width === 1.5)).toBe(true);
    // Red: dimmed base passes, then the m1 run (10..40) split at the playhead (20).
    const thick = red.filter((c) => c.width === HIGHLIGHT_WIDTH);
    expect(red.filter((c) => c.width === 1.5).every((c) => c.alpha === DIM_ALPHA)).toBe(true);
    expect(thick).toHaveLength(2);
    expect(thick.map((c) => c.alpha)).toEqual([1, 1]);
    // The highlighted path starts at the glide (t = 10), not at 0.
    const view = cameraAt(cameraScore(SCORE), CAM, 20, SIZE, false);
    const firstMove = calls.find(
      (c, i) =>
        c.op === 'moveTo' &&
        calls.slice(i).find((d) => d.op === 'stroke')?.width === HIGHLIGHT_WIDTH,
    );
    expect(firstMove?.args[0]).toBeCloseTo(timeToX(view, 10), 6);
  });

  it('keeps the future highlight visible when the ghost is off', () => {
    const { ctx, calls } = fakeCtx();
    drawScore(
      ctx,
      SCORE,
      CAM,
      style({ highlight: new Set(['m1']), futureOpacity: 0 }),
      20,
      SIZE,
      1,
    );
    const thick = strokes(calls, RED).filter((c) => c.width === HIGHLIGHT_WIDTH);
    expect(thick.map((c) => c.alpha)).toEqual([1, 0.6]);
  });

  it('returns the view it drew', () => {
    const { ctx } = fakeCtx();
    const view = drawScore(ctx, SCORE, CAM, style(), 20, SIZE, 1);
    expect(view).toEqual(cameraAt(cameraScore(SCORE), CAM, 20, SIZE, false));
  });
});

describe('reveal (Compose for me)', () => {
  it('clips the lines at the reveal time; absent or infinite: no clip', () => {
    const plain = fakeCtx();
    drawScore(plain.ctx, SCORE, CAM, style(), 0, SIZE, 1);
    expect(plain.calls.some((c) => c.op === 'clip')).toBe(false);
    const all = fakeCtx();
    drawScore(all.ctx, SCORE, CAM, style({ reveal: Infinity }), 0, SIZE, 1);
    expect(all.calls.some((c) => c.op === 'clip')).toBe(false);

    const { ctx, calls } = fakeCtx();
    drawScore(ctx, SCORE, CAM, style({ reveal: 10 }), 0, SIZE, 1);
    const view = cameraAt(cameraScore(SCORE), CAM, 0, SIZE, false);
    const clip = calls.findIndex((c) => c.op === 'clip');
    expect(clip).toBeGreaterThan(-1);
    const rect = calls.slice(0, clip).findLast((c) => c.op === 'rect');
    expect(rect?.args).toEqual([0, 0, timeToX(view, 10), SIZE.height]);
    const restore = calls.findIndex((c, i) => i > clip && c.op === 'restore');
    // Every line stroke lies between the clip and its restore.
    const red = calls.flatMap((c, i) => (c.op === 'stroke' && c.stroke === RED ? [i] : []));
    expect(red.length).toBeGreaterThan(0);
    expect(red.every((i) => i > clip && i < restore)).toBe(true);
  });
});

describe('nearestLine', () => {
  const view = cameraAt(cameraScore(SCORE), CAM, 40, SIZE, false);

  it('finds the line under the pointer and its pitch', () => {
    const x = timeToX(view, 5);
    const hit = nearestLine(SCORE, view, x, pitchToY(view, 67) + 2);
    expect(hit?.voice).toBe(1);
    expect(hit?.pitch).toBe(67);
    expect(hit?.dist).toBeLessThanOrEqual(2.01);
  });

  it('picks the nearer of two lines and misses beyond the radius', () => {
    const x = timeToX(view, 30);
    expect(nearestLine(SCORE, view, x, pitchToY(view, 64) - 1)?.voice).toBe(0);
    expect(nearestLine(SCORE, view, x, (pitchToY(view, 64) + pitchToY(view, 67)) / 2)).toBeNull();
  });

  it('finds a steep glide from beside it', () => {
    const fast = voice(0, [seg(0, 10, 50, 50), seg(10, 10.01, 50, 80), seg(10.01, 40, 80, 80)]);
    const s = { ...SCORE, voices: [fast] };
    const vw = cameraAt(cameraScore(s), CAM, 40, SIZE, false);
    const hit = nearestLine(s, vw, timeToX(vw, 10.005) + 3, pitchToY(vw, 65));
    expect(hit?.voice).toBe(0);
    expect(hit?.pitch).toBeGreaterThan(55);
    expect(hit?.pitch).toBeLessThan(75);
  });

  it('ignores future lines unless asked', () => {
    const v = cameraAt(cameraScore(SCORE), CAM, 20, SIZE, false);
    const x = timeToX(v, 30);
    const y = pitchToY(v, 67);
    expect(nearestLine(SCORE, v, x, y)?.voice).toBe(1);
    expect(nearestLine(SCORE, v, x, y, 6, false)).toBeNull();
  });
});

describe('labels', () => {
  it('names notes with octave and cents', () => {
    expect(noteLabel(69)).toBe('A4');
    expect(noteLabel(60)).toBe('C4');
    expect(noteLabel(66)).toBe('F♯4');
    expect(noteLabel(69.12)).toBe('A4 +12¢');
    expect(noteLabel(57.7)).toBe('A♯3 −30¢');
    expect(noteLabel(70, { tonic: 'F', scale: 'major' })).toBe('B♭4');
    expect(noteLabel(60, { tonic: 'C#', scale: 'major' })).toBe('B♯3');
  });

  it('formats voice, note and Hz', () => {
    const hit = { voice: 1, t: 5, pitch: 69, x: 0, y: 0, dist: 0 };
    expect(hoverLabel(SCORE, hit)).toBe('note 2 · A4 · 440.00 Hz');
    expect(hoverLabel(SCORE, { ...hit, pitch: 66 }, 'alto')).toBe('alto · F♯4 · 369.99 Hz');
  });
});
