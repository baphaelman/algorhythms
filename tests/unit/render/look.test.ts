/** The export Look (PLAN.md §12 "Export look"): each switch, lookStyle, HUD readouts and layout. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, Piece } from '../../../src/core/types';
import {
  DEFAULT_FUTURE_OPACITY,
  DEFAULT_HUD,
  EXPORT_LOOK,
  HIT_WIDTH,
  HUD_ITEMS,
  LINE_WIDTH,
  PLAYER_LOOK,
  TITLE_EXTRA,
  drawPoster,
  drawScore,
  drawVideoFrame,
  gapsText,
  hudText,
  lookStyle,
  noteNamesText,
  pieceLook,
  posterLayout,
  posterSize,
  posterStyle,
  soundingPitches,
  tokensOf,
  videoLayout,
  videoMarkers,
  videoSize,
  videoStyle,
  type CameraState,
  type Ctx2D,
  type HudItem,
  type Look,
  type ScoreStyle,
  type View,
} from '../../../src/render';

const ROOT = join(import.meta.dirname, '../../..');
function load(file: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const PIECE = load('examples/compositions/kite-day.algorhythms.json');
const SCORE = compile(PIECE);
const MARKS = videoMarkers(PIECE);

interface Call {
  op: string;
  args: unknown[];
  fill: unknown;
  stroke: unknown;
  alpha: number;
  width: number;
  font: unknown;
  align: unknown;
}

const GRADIENT = { addColorStop() {} };

/** Records every method call with the state that paints it. */
function recorder(): { ctx: Ctx2D; calls: Call[] } {
  const calls: Call[] = [];
  const st: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
  };
  const ctx = new Proxy(st, {
    get(t, p: string) {
      if (p === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (p === 'createLinearGradient') return () => GRADIENT;
      if (p in t) return t[p];
      return (...args: unknown[]) => {
        calls.push({
          op: p,
          args,
          fill: t.fillStyle,
          stroke: t.strokeStyle,
          alpha: t.globalAlpha as number,
          width: t.lineWidth as number,
          font: t.font,
          align: t.textAlign,
        });
      };
    },
    set(t, p: string, v: unknown) {
      t[p] = v;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls };
}

const SIZE = { width: 853, height: 480 };
const T = SCORE.duration * 0.42;
const CAM: CameraState = { start: T - 7, window: 20 };

function draw(
  style: ScoreStyle,
  t = T,
  cam: CameraState = CAM,
  score: CompiledScore = SCORE,
): { calls: Call[]; view: View } {
  const { ctx, calls } = recorder();
  const view = drawScore(ctx, score, cam, style, t, SIZE, 2);
  return { calls, view };
}
const texts = (calls: Call[]): string[] =>
  calls.filter((c) => c.op === 'fillText').map((c) => c.args[0] as string);
const look = (over: Partial<Look>): ScoreStyle =>
  lookStyle({ ...PLAYER_LOOK, ...over }, { ...MARKS, ...pieceLook(PIECE) });
const player = (): ScoreStyle => look({});

describe('lookStyle', () => {
  it('PLAYER_LOOK is the style the player and video drew before the Look', () => {
    const today: ScoreStyle = {
      tokens: tokensOf('light'),
      dark: false,
      colors: 'pitch',
      oklch: true,
      futureOpacity: DEFAULT_FUTURE_OPACITY,
      hud: true,
      heads: true,
      playhead: true,
      thickness: true,
      ...MARKS,
    };
    const style = lookStyle(PLAYER_LOOK, MARKS);
    expect(style).toEqual(today);
    expect(lookStyle()).toEqual({ ...today, labels: undefined, markerTimes: undefined });
    for (const t of [0, T, SCORE.duration * 0.9])
      expect(draw(style, t).calls).toEqual(draw(today, t).calls);
    // And the video's default style is the same Look.
    expect(videoStyle({ theme: 'light', ...MARKS })).toEqual(today);
  });

  it('EXPORT_LOOK: guides and beats off, future hidden; section labels without ticks, the rest as the player', () => {
    expect(EXPORT_LOOK).toEqual({
      ...PLAYER_LOOK,
      guides: false,
      guideLabels: false,
      beats: 'off',
      markers: false,
      sections: true,
      future: 'hidden',
    });
    const s = lookStyle(EXPORT_LOOK);
    expect(s).toMatchObject({
      futureOpacity: 0,
      aheadHidden: true,
      guides: false,
      hud: true,
      markers: false,
    });
    expect(s).not.toHaveProperty('sections');
    expect(s).not.toHaveProperty('bars');
  });

  it('maps future, line width, transparent, beats and hud', () => {
    expect(look({ future: 'full' }).futureOpacity).toBe(1);
    expect(look({ future: 'dimmed', futureOpacity: 0.6 }).futureOpacity).toBe(0.6);
    expect(look({ lineWidth: 'bold' }).lineScale).toBeGreaterThan(1);
    expect(look({ lineWidth: 'thin' }).lineScale).toBeLessThan(1);
    expect(look({ transparent: true }).tokens.paper).toBe('transparent');
    expect(look({ beats: 'auto' }).bars).toEqual(
      PIECE.view.gridBpm !== undefined ? expect.objectContaining({ bpm: PIECE.view.gridBpm }) : {},
    );
    expect(look({ hud: [] }).hud).toBe(false);
    expect(look({ hud: ['spread', 'chord'] }).hud).toEqual(['spread', 'chord']);
  });
});

describe('Look switches (drawing calls absent / present)', () => {
  const hz = (c: Call): boolean => c.op === 'fillText' && /^A\d+ \d+ Hz$/.test(c.args[0] as string);
  const rule = tokensOf('light').rule;

  it('octave guides and their labels', () => {
    const on = draw(player()).calls;
    expect(on.filter(hz).length).toBeGreaterThan(0);
    const unlabelled = draw(look({ guideLabels: false })).calls;
    expect(unlabelled.filter(hz)).toEqual([]);
    const strokesOf = (cs: Call[]): number =>
      cs.filter((c) => c.op === 'stroke' && c.stroke === rule && c.width === 1).length;
    expect(strokesOf(unlabelled)).toBe(strokesOf(on));
    const off = draw(look({ guides: false })).calls;
    expect(off.filter(hz)).toEqual([]);
    expect(strokesOf(off)).toBeLessThan(strokesOf(on));
  });

  it('beat and bar lines', () => {
    const n = (s: ScoreStyle): number =>
      draw(s).calls.filter((c) => c.op === 'stroke' && c.alpha < 1 && c.width === 1).length;
    expect(n(look({ beats: 'auto' }))).toBeGreaterThan(n(player()));
  });

  it('every beat: one full-height line per beat over the view, where auto thins them', () => {
    const whole = { start: 0, window: SCORE.duration };
    const moves = (s: ScoreStyle) => {
      const { calls, view } = draw(s, T, whole);
      return { n: calls.filter((c) => c.op === 'moveTo').length, view };
    };
    const off = moves(look({ future: 'full' }));
    const auto = moves(look({ future: 'full', beats: 'auto' }));
    const every = moves(look({ future: 'full', beats: 'every' }));
    const { view } = every;
    const beat = 60 / (PIECE.view.gridBpm ?? 60);
    // Auto thins at this zoom (beats closer than 8 px).
    expect(beat * view.pps).toBeLessThan(8);
    const k0 = Math.ceil(view.tL / beat - 1e-9);
    const k1 = Math.floor(view.tR / beat + 1e-9);
    expect(every.n - off.n).toBe(k1 - k0 + 1);
    expect(auto.n - off.n).toBeLessThan(every.n - off.n);
    expect(look({ beats: 'every' }).bars).toMatchObject({ every: true });
    expect(look({ beats: 'auto' }).bars).not.toHaveProperty('every');
    // Old stored booleans: true draws as 'auto'.
    expect(look({ beats: true as unknown as 'auto' }).bars).toEqual(look({ beats: 'auto' }).bars);
  });

  it('section labels and moment ticks', () => {
    const labels = Object.values(MARKS.labels).map((l) => l.toUpperCase());
    const shown = (s: ScoreStyle): string[] =>
      texts(draw(s, T, { start: 0, window: SCORE.duration }).calls).filter((x) =>
        labels.includes(x),
      );
    expect(shown(player()).length).toBeGreaterThan(1);
    expect(shown(look({ sections: false }))).toEqual([]);
    const ticks = (s: ScoreStyle): number =>
      draw(s, T, { start: 0, window: SCORE.duration }).calls.filter(
        (c) => c.op === 'stroke' && c.stroke === rule,
      ).length;
    expect(ticks(look({ markers: false }))).toBeLessThan(ticks(player()));
    expect(ticks(look({ markers: false, sections: false, guides: false, playhead: false }))).toBe(
      0,
    );
  });

  it('future hidden: no lines, pulse marks, markers or labels ahead of the playhead', () => {
    const whole = { start: 0, window: SCORE.duration };
    const { calls, view } = draw(look({ future: 'hidden', beats: 'auto' }), T, whole);
    const xs = calls
      .filter((c) => ['moveTo', 'lineTo'].includes(c.op) && c.stroke !== rule)
      .map((c) => c.args[0] as number);
    expect(xs.length).toBeGreaterThan(0);
    // Lines: nothing past the playhead but the round cap and the heads' Hz labels.
    const lineXs = calls
      .filter(
        (c) =>
          (c.op === 'lineTo' || c.op === 'moveTo') && typeof c.stroke !== 'string' && c.alpha > 0,
      )
      .map((c) => c.args[0] as number);
    expect(Math.max(...lineXs)).toBeLessThanOrEqual(view.xHead + 1);
    const labels = Object.values(MARKS.labels).map((l) => l.toUpperCase());
    const afterLabels = calls.filter(
      (c) =>
        c.op === 'fillText' &&
        labels.includes(c.args[0] as string) &&
        (c.args[1] as number) > view.xHead,
    );
    expect(afterLabels).toEqual([]);
    const dimmed = draw(look({ future: 'dimmed' }), T, whole);
    const dimXs = dimmed.calls
      .filter((c) => c.op === 'lineTo' && typeof c.stroke !== 'string')
      .map((c) => c.args[0] as number);
    expect(Math.max(...dimXs)).toBeGreaterThan(view.xHead + 50);
  });

  it('louder voices brighter: off draws every line part at full opacity', () => {
    const alphas = (s: ScoreStyle): number[] =>
      draw(s, T, { start: 0, window: SCORE.duration })
        .calls.filter((c) => c.op === 'fill' || c.op === 'stroke')
        .filter((c) => typeof c.stroke !== 'string' || typeof c.fill !== 'string')
        .map((c) => c.alpha);
    const on = alphas(look({ future: 'full', pulseMarks: false, dots: false }));
    expect(on.some((a) => a < 0.99)).toBe(true);
    const off = alphas(
      look({ future: 'full', levelOpacity: false, pulseMarks: false, dots: false, rings: false }),
    );
    expect(off.every((a) => a === 1)).toBe(true);
  });

  it('pulse hit marks', () => {
    const hits = (s: ScoreStyle): number =>
      draw(s, T, { start: 0, window: SCORE.duration }).calls.filter(
        (c) => c.op === 'stroke' && c.width === HIT_WIDTH,
      ).length;
    expect(hits(player())).toBeGreaterThan(0);
    expect(hits(look({ pulseMarks: false }))).toBe(0);
  });

  it('heads: dots, rings and Hz labels separately; the playhead', () => {
    const arcs = (s: ScoreStyle, r: number): number =>
      draw(s).calls.filter((c) => c.op === 'arc' && c.args[2] === r).length;
    const headHz = (s: ScoreStyle): number =>
      texts(draw(s).calls).filter((x) => /^\d+\.\d\d Hz$/.test(x)).length;
    expect(arcs(player(), 2.6)).toBeGreaterThan(0);
    expect(arcs(look({ dots: false }), 2.6)).toBe(0);
    expect(headHz(look({ dots: false }))).toBe(headHz(player()));
    expect(headHz(player())).toBeGreaterThan(0);
    expect(headHz(look({ hzLabels: false }))).toBe(0);
    expect(arcs(look({ hzLabels: false }), 2.6)).toBe(arcs(player(), 2.6));
    // A moving line's ring: find a time with motion.
    let tm = -1;
    for (let t = 0; t < SCORE.duration && tm < 0; t += 0.25) {
      const { ctx, calls } = recorder();
      drawScore(ctx, SCORE, { start: t - 7, window: 20 }, player(), t, SIZE, 2);
      if (calls.some((c) => c.op === 'arc' && c.args[2] === 6.5)) tm = t;
    }
    expect(tm).toBeGreaterThanOrEqual(0);
    const ringsAt = (s: ScoreStyle): number =>
      draw(s, tm, { start: tm - 7, window: 20 }).calls.filter(
        (c) => c.op === 'arc' && c.args[2] === 6.5,
      ).length;
    expect(ringsAt(look({ rings: false }))).toBe(0);
    const ph = (s: ScoreStyle): number =>
      draw(s).calls.filter(
        (c) =>
          c.op === 'moveTo' &&
          Math.abs((c.args[0] as number) - (Math.round(draw(s).view.xHead) + 0.5)) < 1e-9,
      ).length;
    expect(ph(look({ playhead: false }))).toBeLessThan(ph(player()));
  });

  it('line width and line ink', () => {
    const widths = (s: ScoreStyle): number[] =>
      draw(s)
        .calls.filter((c) => c.op === 'stroke' && c.stroke !== tokensOf('light').rule)
        .map((c) => c.width);
    const flat = { thickness: false, pulseMarks: false, levelOpacity: false };
    expect(widths(look(flat))).toContain(LINE_WIDTH);
    expect(widths(look({ ...flat, lineWidth: 'bold' }))).toContain(LINE_WIDTH * 1.75);
    expect(widths(look({ ...flat, lineWidth: 'bold' }))).not.toContain(LINE_WIDTH);
    const ink = '#ff00aa';
    const s = look({ colors: 'ink', lineInk: ink });
    const strokes = draw(s).calls.filter((c) => c.op === 'stroke' || c.op === 'fill');
    expect(strokes.some((c) => c.stroke === ink || c.fill === ink)).toBe(true);
    // Text keeps the theme's ink.
    expect(
      draw(s)
        .calls.filter((c) => c.op === 'fillText')
        .every((c) => c.fill !== ink),
    ).toBe(true);
  });

  it('a transparent background fills with "transparent"', () => {
    const first = draw(look({ transparent: true })).calls.find((c) => c.op === 'fillRect');
    expect(first?.fill).toBe('transparent');
  });
});

describe('HUD readouts', () => {
  it('note names low to high, repeats counted', () => {
    const key = { tonic: 'C', scale: 'major' } as const;
    expect(noteNamesText([48, 55, 55, 59.02, 64], key)).toBe('C3 G3×2 B3 E4');
    expect(noteNamesText([60, 60.3, 61], { tonic: 'F', scale: 'major' })).toBe('C4×2 D♭4');
    expect(noteNamesText([])).toBe('');
  });

  it('gaps between neighbouring lines, merged lines counted once', () => {
    expect(gapsText([48, 52, 55, 55, 60])).toBe('4 3 5');
    expect(gapsText([48, 50.6])).toBe('2.6');
    expect(gapsText([60])).toBe('');
  });

  it('readouts of a piece mid-way', () => {
    const view = draw(player()).view;
    const ps = soundingPitches(SCORE, T);
    expect(ps.length).toBeGreaterThan(1);
    const text = (it: HudItem): string => hudText(it, SCORE, view, { pieceName: 'Kite Day' });
    expect(text('formula')).toBe('f(n) = 440·2^((n−69)/12)');
    expect(text('notes')).toMatch(/^notes {3}[ \d]\d \/ \d+$/);
    expect(text('time')).toMatch(/^t {7}\d\d:\d\d\.\d \/ \d\d:\d\d\.\d$/);
    expect(text('key')).toMatch(/ · following$/);
    expect(text('hz')).toMatch(/^\d+\.\d–\d+\.\d Hz$/);
    expect(text('spread')).toMatch(/^spread {2}\d+(\.\d)? st( · .+)?$/);
    expect(text('range')).toMatch(/^range {3}\S+ – \S+$/);
    expect(text('names').split(/\s+/).length).toBeGreaterThan(1);
    expect(text('gaps')).toMatch(/^gaps {4}[\d. ]+$/);
    expect(text('title')).toBe('Kite Day');
  });

  it('the default list draws exactly as hud: true', () => {
    const a = draw({ ...player(), hud: true }).calls;
    const b = draw({ ...player(), hud: DEFAULT_HUD }).calls;
    expect(b).toEqual(a);
  });
});

describe('HUD layout with many readouts', () => {
  const all = HUD_ITEMS;

  it('fits every row at 1080p video, each aspect, and grows the bottom band', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const style = videoStyle({
        theme: 'dark',
        look: { ...EXPORT_LOOK, theme: 'dark', hud: all },
        ...MARKS,
        ...pieceLook(PIECE),
      });
      const { ctx, calls } = recorder();
      const k = Math.round(T * 30);
      const view = drawVideoFrame(
        ctx,
        SCORE,
        { aspect, size: '1080', camera: 'follow', window: 20, style },
        k,
        30,
      );
      const hud = calls.filter(
        (c) => c.op === 'fillText' && (c.args[2] as number) > view.height - view.padB,
      );
      const want = all.filter((it) => hudText(it, SCORE, view, style) !== '').length;
      expect(hud.length, aspect).toBe(want);
      const lay = videoLayout(aspect, '1080');
      for (const c of hud) {
        expect(c.args[2] as number).toBeLessThanOrEqual(lay.height - 3);
        expect(c.args[2] as number).toBeGreaterThan(view.height - view.padB + 10);
      }
      // Six rows: the band is taller than the default one, the plot still the larger part.
      expect(view.padB).toBeGreaterThanOrEqual(26 + 14 * 5);
      expect(view.height - view.padT - view.padB).toBeGreaterThan(view.height * 0.5);
      // Columns: left ⌈n/2⌉ readouts left-aligned, the rest right-aligned.
      expect(hud.filter((c) => c.align === 'left').length).toBeLessThanOrEqual(
        Math.ceil(all.length / 2),
      );
      expect(videoSize(aspect, '1080').width).toBeGreaterThan(0);
    }
  });

  it('fits on posters, with the title block below the HUD', () => {
    for (const size of ['16:9', '1:1', 'a4'] as const) {
      for (const title of [false, true]) {
        const style = posterStyle({
          theme: 'light',
          look: { ...EXPORT_LOOK, hud: all },
          title,
          ...MARKS,
          ...pieceLook(PIECE),
        });
        expect(style.hudExtra).toBe(title ? TITLE_EXTRA : undefined);
        const { ctx, calls } = recorder();
        const view = drawPoster(ctx, SCORE, { name: 'Poster' }, { size, style, title });
        const lay = posterLayout(size);
        expect(view.width * lay.dpr).toBeCloseTo(posterSize(size).width, 6);
        const band = calls.filter(
          (c) => c.op === 'fillText' && (c.args[2] as number) > view.height - view.padB,
        );
        const hud = band.filter(
          (c) =>
            !['Poster', 'AlgoRhythms'].includes(c.args[0] as string) &&
            !/^\d+:\d\d · /.test(c.args[0] as string),
        );
        const want = all.filter((it) => hudText(it, SCORE, view, style) !== '').length;
        expect(hud.length, `${size} ${title}`).toBe(want);
        const ys = band.map((c) => c.args[2] as number);
        expect(Math.max(...ys)).toBeLessThanOrEqual(view.height - 3);
        if (title) {
          const name = band.find((c) => c.args[0] === 'Poster')!;
          const lastHud = Math.max(...hud.map((c) => c.args[2] as number));
          expect(name.args[2] as number).toBeGreaterThan(lastHud + 12);
        }
      }
    }
  });

  it('a poster without a Look keeps no HUD; future and playhead are ignored', () => {
    const s = posterStyle({ theme: 'light', look: { ...EXPORT_LOOK, hud: [] } });
    expect(s).toMatchObject({ futureOpacity: 1, playhead: false, heads: false, hud: false });
    expect(s).not.toHaveProperty('aheadHidden');
    expect(posterStyle({ theme: 'light' }).hud).toBe(false);
  });

  it('a long list readout is cut to its column', () => {
    const { calls } = draw({ ...player(), hud: ['names', 'gaps', 'title', 'spread'] }, T, CAM);
    for (const c of calls.filter((x) => x.op === 'fillText' && /^names/.test(x.args[0] as string)))
      expect((c.args[0] as string).length * 6.4).toBeLessThan(SIZE.width / 2);
  });
});
