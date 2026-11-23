/** HUD placement (PLAN.md §12 "Exports you can shape"): anchoring math and the drawn boxes. */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import type { Piece } from '../../../src/core/types';
import {
  DEFAULT_HUD,
  EXPORT_LOOK,
  HUD_BASELINE,
  HUD_BOX_H,
  POSTER_DPR,
  clampBox,
  drawPoster,
  drawScore,
  drawVideoFrameAt,
  freeSpot,
  hudPlacement,
  hudPosText,
  parseHudPos,
  placeBox,
  posOfBox,
  posterHudPlacement,
  posterStyle,
  snapBox,
  videoLayout,
  videoStyle,
  type Ctx2D,
  type HudLayout,
  type HudPos,
  type ScoreStyle,
} from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';
import { piece } from '../core/compiler-fixtures';

const F169 = { width: 853, height: 480 };
const F916 = { width: 400, height: 711 };

describe('anchoring', () => {
  it('picks the anchor nearest the box (thirds of the frame) and round-trips', () => {
    const cases: [number, number, string][] = [
      [10, 10, 'tl'],
      [400, 10, 't'],
      [800, 10, 'tr'],
      [10, 230, 'l'],
      [400, 230, 'c'],
      [800, 230, 'r'],
      [10, 450, 'bl'],
      [400, 450, 'b'],
      [800, 450, 'br'],
    ];
    for (const [x, y, a] of cases) {
      const pos = posOfBox(x, y, 40, 14, F169);
      expect(pos.anchor).toBe(a);
      const back = placeBox(pos, 40, 14, F169);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('carries across aspects: a corner readout stays on its corner, an edge one on its edge', () => {
    // 20 px in from the bottom-right at 16:9.
    const br = posOfBox(853 - 20 - 60, 480 - 20 - 14, 60, 14, F169);
    expect(br.anchor).toBe('br');
    const at = placeBox(br, 60, 14, F916);
    // Right and bottom edges keep the same fraction of the frame from the corner.
    expect(400 - (at.x + 60)).toBeCloseTo((20 / 853) * 400, 6);
    expect(711 - (at.y + 14)).toBeCloseTo((20 / 480) * 711, 6);
    expect(posOfBox(at.x, at.y, 60, 14, F916).anchor).toBe('br');
    // Top edge, centred.
    const top = posOfBox(853 / 2 - 30, 25, 60, 14, F169);
    expect(top).toEqual({ anchor: 't', x: 0, y: 25 / 480 });
    const t2 = placeBox(top, 60, 14, F916);
    expect(t2.x + 30).toBeCloseTo(200, 9);
  });

  it('clamps text inside the frame', () => {
    expect(clampBox(-5, 900, 60, 14, F916)).toEqual({ x: 0, y: 711 - 14 });
    expect(clampBox(390, -3, 60, 14, F916)).toEqual({ x: 340, y: 0 });
    // A position near the right edge at 16:9 with a wide box still fits at 9:16.
    expect(placeBox({ anchor: 'tl', x: 0.95, y: 0.99 }, 120, 14, F916)).toEqual({
      x: 280,
      y: 697,
    });
    // posOfBox clamps first.
    expect(placeBox(posOfBox(-50, -50, 40, 14, F169), 40, 14, F169)).toEqual({ x: 0, y: 0 });
  });

  it('parses stored positions, dropping bad ones', () => {
    expect(parseHudPos({ anchor: 'br', x: -0.02, y: -0.04 })).toEqual({
      anchor: 'br',
      x: -0.02,
      y: -0.04,
    });
    expect(parseHudPos({ anchor: 'zz', x: 0, y: 0 })).toBeUndefined();
    expect(parseHudPos({ anchor: 'tl', x: NaN, y: 0 })).toBeUndefined();
    expect(parseHudPos({ anchor: 'tl', x: '1', y: 0 })).toBeUndefined();
    expect(parseHudPos(null)).toBeUndefined();
    expect(parseHudPos({ anchor: 'tl', x: 7, y: -9 })).toEqual({ anchor: 'tl', x: 1, y: -1 });
  });

  it('describes a position in words', () => {
    expect(hudPosText({ anchor: 'br', x: -0.03, y: -0.04 })).toBe(
      'bottom right, 3 % from the right, 4 % from the bottom',
    );
    expect(hudPosText({ anchor: 't', x: 0, y: 0.05 })).toBe('top, 5 % from the top');
    expect(hudPosText({ anchor: 'c', x: 0.1, y: 0 })).toBe('centre, 10 % right of centre');
  });
});

describe('snapping', () => {
  const box = { x: 0, y: 0, w: 60, h: 14 };
  it('snaps to the margins, centre lines and other readouts’ edges within the tolerance', () => {
    expect(snapBox({ ...box, x: 24, y: 300 }, F169, 21, [], 6)).toEqual({
      x: 21,
      y: 300,
      guides: { x: 21 },
    });
    const r = snapBox({ ...box, x: 853 - 21 - 60 + 4, y: 480 - 21 - 14 - 3 }, F169, 21, [], 6);
    expect(r).toEqual({ x: 853 - 81, y: 480 - 35, guides: { x: 853 - 21, y: 480 - 21 } });
    const c = snapBox({ ...box, x: 853 / 2 - 30 + 5, y: 240 - 7 - 2 }, F169, 21, [], 6);
    expect(c.x).toBeCloseTo(853 / 2 - 30, 9);
    expect(c.y).toBeCloseTo(233, 9);
    expect(c.guides).toEqual({ x: 853 / 2, y: 240 });
    // Another readout: left edges line up, and this one sits just below it.
    const other = { x: 300, y: 100, w: 80, h: 14 };
    expect(snapBox({ ...box, x: 303, y: 117 }, F169, 21, [other], 6)).toEqual({
      x: 300,
      y: 114,
      guides: { x: 300, y: 114 },
    });
    // Right edges line up.
    expect(snapBox({ ...box, x: 318, y: 200 }, F169, 21, [other], 6).x).toBe(320);
    // Out of reach: unchanged, no guides.
    expect(snapBox({ ...box, x: 150, y: 150 }, F169, 21, [other], 6)).toEqual({
      x: 150,
      y: 150,
      guides: {},
    });
  });

  it('finds a free spot: the bottom-left margin corner, then stacked above, then other corners', () => {
    const first = freeSpot(60, 14, F169, 21, []);
    expect(placeBox(first, 60, 14, F169)).toEqual({ x: 21, y: 480 - 21 - 14 });
    const taken = [{ x: 21, y: 445, w: 100, h: 14 }];
    expect(placeBox(freeSpot(60, 14, F169, 21, taken), 60, 14, F169)).toEqual({ x: 21, y: 431 });
  });
});

/** Records fillText calls with position, alignment and font. */
function textCtx(): { ctx: Ctx2D; texts: { text: string; x: number; y: number; align: string }[] } {
  const texts: { text: string; x: number; y: number; align: string }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', textAlign: 'left' };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 7 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'fillText')
        return (text: string, x: number, y: number) =>
          texts.push({ text, x, y, align: target.textAlign as string });
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, texts };
}

const score = compile(
  piece({
    start: [48, 55, 64, 72],
    key: { tonic: 'C', scale: 'major' },
    moments: [
      {
        type: 'chord',
        at: 4,
        notes: { kind: 'chord', symbol: 'ii7' },
        voicing: 'even',
        assign: 'ordered',
      },
    ],
  }),
);
const CHORD = 'ii7 · Dm7';

const base = (hud: ScoreStyle['hud'], hudLayout?: HudLayout): ScoreStyle =>
  ({
    tokens: { paper: '#1', ink: '#2', ink2: '#3', rule: '#4', accent: '#5', panel: '#6' },
    dark: false,
    colors: 'ink',
    oklch: true,
    futureOpacity: 0,
    hud,
    ...(hudLayout ? { hudLayout } : {}),
  }) as ScoreStyle;

describe('placed HUD drawing', () => {
  const size = { width: 1000, height: 600 };
  const draw = (style: ScoreStyle) => {
    const f = textCtx();
    drawScore(f.ctx, score, { window: 20, start: 0 }, style, 6, size, 1);
    return f.texts;
  };

  it('an empty layout draws today’s two columns', () => {
    const legacy = draw(base(DEFAULT_HUD as ScoreStyle['hud']));
    const placed = draw(base(DEFAULT_HUD as ScoreStyle['hud'], {}));
    expect(placed.length).toBeGreaterThanOrEqual(6);
    const key = (t: { text: string; x: number; y: number; align: string }) =>
      `${t.text}|${t.x.toFixed(6)}|${t.y.toFixed(6)}|${t.align}`;
    expect(placed.map(key).sort()).toEqual(legacy.map(key).sort());
  });

  it('draws a readout at its stored box, text aligned to the anchor side', () => {
    const tl: HudPos = { anchor: 'tl', x: 0.1, y: 0.2 };
    const br: HudPos = { anchor: 'br', x: -0.05, y: -0.1 };
    const c: HudPos = { anchor: 'c', x: 0, y: 0 };
    const t = draw(base(['chord', 'time', 'key'], { chord: tl, time: br, key: c }));
    expect(t.find((x) => x.text === CHORD)).toEqual({
      text: CHORD,
      x: 100,
      y: 120 + HUD_BASELINE,
      align: 'left',
    });
    const time = t.find((x) => x.text.startsWith('t '))!;
    expect(time.align).toBe('right');
    expect(time.x).toBeCloseTo(950, 9);
    expect(time.y).toBeCloseTo(540 - HUD_BOX_H + HUD_BASELINE, 9);
    const key = t.find((x) => x.text.startsWith('c major'))!;
    expect(key).toMatchObject({ align: 'center', x: 500 });
    expect(key.y).toBeCloseTo(300 - HUD_BOX_H / 2 + HUD_BASELINE, 9);
  });

  it('keeps a readout inside the frame', () => {
    const t = draw(base(['chord'], { chord: { anchor: 'br', x: 0.5, y: 0.5 } }));
    const chord = t.find((x) => x.text === CHORD)!;
    expect(chord).toMatchObject({ align: 'right', x: 1000, y: 600 - HUD_BOX_H + HUD_BASELINE });
  });

  it('hudPlacement reports the boxes drawScore drew', () => {
    const style = base(['chord'], { chord: { anchor: 'tl', x: 0.1, y: 0.2 } });
    const f = textCtx();
    const view = drawScore(f.ctx, score, { window: 20, start: 0 }, style, 6, size, 1);
    const p = hudPlacement(f.ctx, score, style, view);
    expect(p).toMatchObject({ width: 1000, height: 600, margin: 25 });
    expect(p.boxes).toEqual([
      { item: 'chord', text: CHORD, anchor: 'tl', x: 100, y: 120, w: CHORD.length * 7, h: 14 },
    ]);
  });
});

describe('placed HUD in exports', () => {
  const chordAt: HudLayout = { chord: { anchor: 'tr', x: -0.1, y: 0.05 } };
  const look = { ...EXPORT_LOOK, hud: ['chord' as const], hudLayout: chordAt };

  it('lands at its box in a video frame, at the export’s pixel scale', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const lay = videoLayout(aspect, '1080');
      const f = textCtx();
      const sets: number[][] = [];
      const ctx = new Proxy(f.ctx as object, {
        get(target, prop: string) {
          if (prop === 'setTransform') return (...a: number[]) => sets.push(a);
          return (target as Record<string, unknown>)[prop];
        },
        set(target, prop: string, v: unknown) {
          (target as Record<string, unknown>)[prop] = v;
          return true;
        },
      }) as unknown as Ctx2D;
      const style = videoStyle({ theme: 'light', look });
      drawVideoFrameAt(ctx, score, { aspect, size: '1080', camera: 'whole', style }, 6);
      const chord = f.texts.find((x) => x.text === CHORD)!;
      // Right edge at 90 % of the width, top at 5 % of the height (layout px).
      expect(chord.align).toBe('right');
      expect(chord.x).toBeCloseTo(lay.width * 0.9, 6);
      expect(chord.y).toBeCloseTo(lay.height * 0.05 + HUD_BASELINE, 6);
      // Drawn at the export's pixel ratio.
      expect(sets.at(-1)?.[0]).toBeCloseTo(lay.dpr, 9);
    }
  });

  it('lands at its box in an SVG poster (device px)', () => {
    const p: Piece = piece({ start: [48, 55, 64, 72], key: { tonic: 'C', scale: 'major' } });
    const compiled = compile(p);
    const c = new SvgContext(3840, 2160);
    const style = posterStyle({
      theme: 'light',
      look: { ...look, hud: ['title'], hudLayout: { title: { anchor: 'tl', x: 0.25, y: 0.5 } } },
      pieceName: 'Kite',
    });
    const opts = { size: { width: 3840, height: 2160 }, style, title: false };
    const view = drawPoster(asCtx2D(c), compiled, { name: 'Kite' }, opts);
    const svg = c.toSvg();
    const m = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>Kite<\/text>/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(3840 * 0.25, 1);
    expect(Number(m![2])).toBeCloseTo((view.height * 0.5 + HUD_BASELINE) * POSTER_DPR, 1);
    // The placement the dialog overlays is the same box.
    const pl = posterHudPlacement(asCtx2D(c), compiled, opts, view);
    expect(pl.boxes[0]).toMatchObject({
      item: 'title',
      x: view.width * 0.25,
      y: view.height * 0.5,
    });
  });
});
