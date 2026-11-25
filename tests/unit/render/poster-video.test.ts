/**
 * Play the poster (PLAN.md §15 M15 V1): the frame as a window over the poster. Follow keeps the
 * playhead's slice in frame at every poster size, row count and video aspect; row breaks pan,
 * scroll or cut as set; Whole holds the poster; keys ease in poster space. Drawing: stays or
 * travels, the ahead slider, the playhead switch, the end card.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterCameraKey, PosterDoc } from '../../../src/core/types';
import { layoutPoster, posterTimeAt, type PosterLayout, type Rect } from '../../../src/render';
import { EXPORT_LOOK } from '../../../src/render/look';
import {
  ROW_BREAK,
  drawPosterEndCard,
  drawPosterFrame,
  pieceRowBreak,
  pieceVideoFrame,
  posterCameraAt,
  posterKeyFrame,
  posterKeyOfFrame,
  posterPoseAt,
  posterRowAt,
  posterWholeFrame,
  type PosterCameraOptions,
} from '../../../src/render/poster-video';
import { SvgContext, asCtx2D } from '../../../src/render/svg';
import {
  VIDEO_RATIO,
  videoStyle,
  videoWindow,
  type VideoAspect,
  type VideoFrameOptions,
} from '../../../src/render/video';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);

const SIZES = {
  '16:9': { w: 3840, h: 2160 },
  square: { w: 2160, h: 2160 },
  a4: { w: 2480, h: 3508 },
} as const;
const ASPECTS: VideoAspect[] = ['16:9', '9:16', '1:1'];

const lay = (doc?: PosterDoc, rows = 1, size: { w: number; h: number } = SIZES['16:9']) =>
  layoutPoster({
    compiled: KITE_C,
    piece: KITE,
    ...(doc ? { doc } : {}),
    look: { ...EXPORT_LOOK, hud: ['time', 'chord'] },
    base: { rows, size },
  });

const contains = (F: Rect, x: number, y0: number, y1: number, eps = 1e-6) =>
  x >= F.x - eps && x <= F.x + F.w + eps && y0 >= F.y - eps && y1 <= F.y + F.h + eps;

/** Times across the piece, every `step` s. */
const times = (L: PosterLayout, step = 0.5) => {
  const out: number[] = [];
  const a = L.rows[0].start;
  const b = L.rows[L.rows.length - 1].end;
  for (let t = a; t <= b; t += step) out.push(t);
  return out;
};

/** Inside a row break's transition (the pan or scroll leading to row i + 1). */
const inBreak = (L: PosterLayout, t: number) =>
  L.rows.some(
    (row, i) =>
      i > 0 &&
      t > row.start - Math.min(ROW_BREAK, 0.4 * (L.rows[i - 1].end - L.rows[i - 1].start)) &&
      t < row.start,
  );

describe('frames and row breaks of a piece', () => {
  it('Over the poster when the piece has a poster, else One row; a set frame wins', () => {
    expect(pieceVideoFrame({})).toBe('row');
    expect(pieceVideoFrame({ poster: {} })).toBe('poster');
    expect(pieceVideoFrame({ poster: {}, camera: { mode: 'follow', frame: 'row' } })).toBe('row');
    expect(pieceVideoFrame({ camera: { mode: 'follow', frame: 'poster' } })).toBe('poster');
    expect(pieceRowBreak({})).toBe('pan');
    expect(pieceRowBreak({ camera: { mode: 'follow', rowBreak: 'cut' } })).toBe('cut');
    expect(pieceRowBreak({ camera: { mode: 'follow', rowBreak: 'scroll' } })).toBe('scroll');
  });
});

describe('Follow over the poster', () => {
  it('the frame has the video’s aspect and holds the slice, at every poster size, row count and aspect', () => {
    for (const [name, size] of Object.entries(SIZES))
      for (const rows of [1, 2, 4, 6])
        for (const aspect of ASPECTS)
          for (const brk of ['pan', 'scroll', 'cut'] as const) {
            const L = lay(undefined, rows, size);
            const o: PosterCameraOptions = { aspect, mode: 'follow', rowBreak: brk };
            for (const t of times(L, 0.75)) {
              const F = posterCameraAt(L, t, o);
              expect(F.w / F.h).toBeCloseTo(VIDEO_RATIO[aspect], 6);
              if (brk !== 'cut' && inBreak(L, t)) continue;
              const at = posterTimeAt(L, t);
              if (!at) continue;
              expect(
                contains(F, at.x, at.y0, at.y1, 0.5),
                `${name} rows ${rows} ${aspect} ${brk} t ${t}: ${JSON.stringify(F)} vs ${JSON.stringify(at)}`,
              ).toBe(true);
            }
          }
  });

  it('frames one row’s slot by default, and the row it plays', () => {
    const L = lay(undefined, 4);
    for (const t of [1, 40, 80, 110]) {
      const F = posterCameraAt(L, t, { aspect: '16:9', mode: 'follow', rowBreak: 'cut' });
      const row = L.rows[posterRowAt(L, t)];
      expect(F.h).toBeCloseTo(row.rect.h + 10 * L.unit, 6);
      expect(F.y).toBeLessThanOrEqual(row.rect.y + 1e-6);
      expect(F.y + F.h).toBeGreaterThanOrEqual(row.rect.y + row.rect.h - 1e-6);
    }
  });

  it('the Window slider sets the seconds shown, never less than the slice', () => {
    const L = lay(undefined, 4);
    const row = L.rows[0];
    const pps = row.plot.w / (row.end - row.start);
    const F = posterCameraAt(L, 5, { aspect: '16:9', mode: 'follow', window: 30 });
    expect(F.w / pps).toBeCloseTo(videoWindow(30, '16:9'), 6);
    const tiny = posterCameraAt(L, 5, { aspect: '9:16', mode: 'follow', window: 2 });
    expect(tiny.h).toBeGreaterThanOrEqual(row.plot.h);
  });

  it('auto plays as follow; keys without keys too', () => {
    const L = lay(undefined, 3);
    const f = posterCameraAt(L, 30, { aspect: '16:9', mode: 'follow' });
    expect(posterCameraAt(L, 30, { aspect: '16:9', mode: 'auto' })).toEqual(f);
    expect(posterCameraAt(L, 30, { aspect: '16:9', mode: 'keys', keys: [] })).toEqual(f);
  });

  it('holds before the first row and after the last', () => {
    const L = lay(undefined, 3);
    const o: PosterCameraOptions = { aspect: '16:9', mode: 'follow' };
    expect(posterCameraAt(L, -5, o)).toEqual(posterCameraAt(L, 0, o));
    const end = L.rows[L.rows.length - 1].end;
    expect(posterCameraAt(L, end + 9, o)).toEqual(posterCameraAt(L, end, o));
  });
});

describe('row breaks', () => {
  const L = lay(undefined, 3);
  const T = L.rows[1].start;
  const d = Math.min(ROW_BREAK, 0.4 * (L.rows[0].end - L.rows[0].start));
  const at = (t: number, rowBreak: 'pan' | 'scroll' | 'cut') =>
    posterCameraAt(L, t, { aspect: '16:9', mode: 'follow', rowBreak });
  const cut = (t: number) => at(t, 'cut');

  it('a cut changes rows as the next row starts', () => {
    expect(posterRowAt(L, T - 1e-3)).toBe(0);
    const before = cut(T - 1e-3);
    const after = cut(T);
    expect(after.y).toBeGreaterThan(before.y);
    expect(cut(T - d / 2)).toEqual(
      posterCameraAt(L, T - d / 2, { aspect: '16:9', mode: 'follow', rowBreak: 'cut' }),
    );
  });

  it('a pan starts from the row and lands on the next row as it starts, eased', () => {
    const a = cut(T - d);
    const b = cut(T);
    expect(at(T - d, 'pan')).toEqual(a);
    const end = at(T - 1e-9, 'pan');
    expect(end.y).toBeCloseTo(b.y, 3);
    expect(at(T, 'pan')).toEqual(b);
    // Halfway in time is halfway in place (smootherstep is symmetric); a quarter in, less.
    const mid = at(T - d / 2, 'pan');
    const A = cut(T - d / 2);
    expect(mid.y).toBeCloseTo((A.y + b.y) / 2, 6);
    const q = at(T - (3 * d) / 4, 'pan');
    const Aq = cut(T - (3 * d) / 4);
    expect((q.y - Aq.y) / (b.y - Aq.y)).toBeLessThan(0.2);
  });

  it('a scroll moves at an even speed', () => {
    const t = T - (3 * d) / 4;
    const s = at(t, 'scroll');
    const A = cut(t);
    const b = cut(T);
    expect((s.y - A.y) / (b.y - A.y)).toBeCloseTo(0.25, 6);
  });
});

describe('Whole and keys', () => {
  it('Whole holds the whole poster, touching two of its sides', () => {
    for (const size of Object.values(SIZES))
      for (const aspect of ASPECTS) {
        const L = lay(undefined, 2, size);
        const F = posterCameraAt(L, 10, { aspect, mode: 'whole' });
        expect(F).toEqual(posterWholeFrame(L, aspect));
        expect(F.x).toBeLessThanOrEqual(1e-9);
        expect(F.y).toBeLessThanOrEqual(1e-9);
        expect(F.x + F.w).toBeGreaterThanOrEqual(L.width - 1e-9);
        expect(F.y + F.h).toBeGreaterThanOrEqual(L.height - 1e-9);
        expect(Math.min(F.w - L.width, F.h - L.height)).toBeCloseTo(0, 6);
      }
  });

  it('keys hold their frames, ease between them in poster space and hold outside', () => {
    const L = lay(undefined, 2);
    const keys: PosterCameraKey[] = [
      { at: 10, x: 0.3, y: 0.3, h: 0.2, ease: 'linear' },
      { at: 20, x: 0.7, y: 0.6, h: 0.8 },
    ];
    const o: PosterCameraOptions = { aspect: '16:9', mode: 'keys', keys };
    expect(posterCameraAt(L, 0, o)).toEqual(posterKeyFrame(L, keys[0], '16:9'));
    expect(posterCameraAt(L, 10, o)).toEqual(posterKeyFrame(L, keys[0], '16:9'));
    expect(posterCameraAt(L, 30, o)).toEqual(posterKeyFrame(L, keys[1], '16:9'));
    const mid = posterPoseAt(keys, 15)!;
    expect(mid.x).toBeCloseTo(0.5, 9);
    expect(mid.y).toBeCloseTo(0.45, 9);
    // The height zooms geometrically: halfway between 0.2 and 0.8 is 0.4.
    expect(mid.h).toBeCloseTo(0.4, 9);
    // The default ease (smootherstep) is slower at the ends.
    const eased = posterPoseAt([{ ...keys[0], ease: undefined }, keys[1]], 11)!;
    expect(eased.x - 0.3).toBeLessThan(0.04 * 0.1);
  });

  it('a key made from a frame gives that frame back, at any aspect', () => {
    const L = lay(undefined, 2, SIZES.a4);
    for (const aspect of ASPECTS) {
      const F = posterCameraAt(L, 40, { aspect, mode: 'follow' });
      const k = posterKeyOfFrame(L, F, 40, 'cosine');
      expect(k.at).toBe(40);
      expect(k.ease).toBe('cosine');
      const back = posterKeyFrame(L, k, aspect);
      for (const f of ['x', 'y', 'w', 'h'] as const) expect(back[f]).toBeCloseTo(F[f], 6);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Drawing (SVG)
// ---------------------------------------------------------------------------------------------

const style = (o: Partial<Parameters<typeof videoStyle>[0]> = {}) =>
  videoStyle({ theme: 'dark', look: { ...EXPORT_LOOK, ...o.look }, ...o });

function frameOpts(L: PosterLayout, o: Partial<VideoFrameOptions> = {}): VideoFrameOptions {
  return {
    aspect: '16:9',
    size: '720',
    camera: 'follow',
    style: style(),
    frame: 'poster',
    poster: L,
    ...o,
  };
}

function svgOf(L: PosterLayout, t: number, o: Partial<VideoFrameOptions> = {}): string {
  const svg = new SvgContext(1280, 720);
  drawPosterFrame(asCtx2D(svg), KITE_C, frameOpts(L, o), L, t);
  return svg.toSvg();
}

const TITLED: PosterDoc = {
  texts: [{ id: 'title', kind: 'title', text: 'Kite Title' }],
};

describe('drawing over the poster', () => {
  it('a staying title shows only while the frame is over it; a travelling one in every frame', () => {
    const stay = lay(TITLED, 4);
    const go = lay({ texts: [{ ...TITLED.texts![0], travels: true }] }, 4);
    expect(go.objects.find((o) => o.type === 'text')?.travels).toBe(true);
    expect(stay.objects.find((o) => o.type === 'text')?.travels).toBeUndefined();
    // Late in the piece the frame is on the last row, far from the title band at the top.
    const late = stay.rows[3].start + 5;
    expect(svgOf(stay, late)).not.toContain('Kite Title');
    expect(svgOf(go, late)).toContain('Kite Title');
    // The poster in Whole shows the staying title.
    expect(svgOf(stay, late, { camera: 'whole' })).toContain('Kite Title');
  });

  it('HUD readouts travel by default and show the playing time; a readout set to stay does not', () => {
    const L = lay(undefined, 4);
    const hud = L.objects.filter((o) => o.type === 'label' && o.group === 'hud');
    expect(hud.length).toBeGreaterThan(0);
    expect(hud.every((o) => o.travels)).toBe(true);
    const a = svgOf(L, 12);
    expect(a).toMatch(/0:12/);
    const stay = lay({ groups: { hud: { travels: false } } }, 4);
    expect(stay.objects.some((o) => o.type === 'label' && o.group === 'hud' && o.travels)).toBe(
      false,
    );
    const one = lay(
      { groups: { hud: { travels: false } }, members: { hud: { time: { travels: true } } } },
      4,
    );
    const t = one.objects.find((o) => o.type === 'label' && o.member === 'time');
    expect(t?.travels).toBe(true);
  });

  it('the ahead slider: hidden draws less than dimmed, dimmed less than full', () => {
    const L = lay(undefined, 2);
    const at = (future: 'hidden' | 'dimmed' | 'full') =>
      svgOf(L, 20, { camera: 'whole', style: style({ look: { ...EXPORT_LOOK, future } }) });
    const hidden = at('hidden');
    const dimmed = at('dimmed');
    const full = at('full');
    expect(hidden.length).toBeLessThan(dimmed.length);
    expect(dimmed).not.toBe(full);
  });

  it('the playhead switch draws the slice', () => {
    const L = lay(undefined, 2);
    const on = svgOf(L, 20, { playhead: true });
    const off = svgOf(L, 20, { playhead: false });
    expect(on).not.toBe(off);
    expect(on.length).toBeGreaterThan(off.length);
  });

  it('a moved layer lights up in its own place; the camera follows the main group', () => {
    const box = { x: 0.55, y: 0.75, w: 0.3, h: 0.12 };
    const moved = lay({ layers: [{ id: 'part:Melody', box }] }, 2);
    const still = lay(undefined, 2);
    const o: PosterCameraOptions = { aspect: '16:9', mode: 'follow' };
    // The main group's frames are unchanged by the move (and leave the moved box out).
    for (const t of [10, 50, 80]) {
      expect(posterCameraAt(moved, t, o)).toEqual(posterCameraAt(still, t, o));
    }
    // Whole (the 16:9 poster at 16:9: artboard px / 3 on the 1280 canvas): the moved part's own
    // slice, at half alpha, where its box is.
    const by = { y0: (box.y * 2160) / 3, y1: ((box.y + box.h) * 2160) / 3 };
    const slices = (t: number) =>
      [
        ...svgOf(moved, t, { camera: 'whole', playhead: true }).matchAll(
          /<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"[^>]*opacity="0\.5"/g,
        ),
      ].map((m) => m.slice(1).map(Number));
    for (const t of [20, 50]) {
      const mel = posterTimeAt(moved, t)!.layers.find((l) => l.layer === 'part:Melody')!;
      const [x0, y0, x1, y1] = slices(t)[0];
      expect(x0).toBeCloseTo(mel.x / 3, 1);
      expect(x1).toBe(x0);
      expect(y0).toBeLessThan(by.y0 + 1);
      expect(y1).toBeGreaterThan(by.y0);
      expect(y1).toBeLessThan(by.y1 + 3 * moved.unit);
    }
    // At 0 % ahead the part draws itself in its box: more of it later.
    const inBox = (t: number) =>
      [...svgOf(moved, t, { camera: 'whole' }).matchAll(/<path d="M[\d.]+ ([\d.]+)/g)].filter(
        (m) => Number(m[1]) >= by.y0 - 2 && Number(m[1]) <= by.y1 + 2,
      ).length;
    expect(inBox(60)).toBeGreaterThan(inBox(15));
    expect(inBox(15)).toBeGreaterThan(0);
  });

  it('the end card is the finished poster: its texts, no HUD of the playing time', () => {
    const L = lay(TITLED, 3);
    const svg = new SvgContext(1280, 720);
    drawPosterEndCard(asCtx2D(svg), KITE_C, frameOpts(L, { bookends: { credit: 'Made' } }), L);
    const s = svg.toSvg();
    expect(s).toContain('Kite Title');
    expect(s).toContain('Made');
    const end = L.objects.find((o) => o.type === 'label' && o.member === 'time');
    if (end?.type === 'label') expect(s).toContain(end.runs[0].text.replace(/&/g, '&amp;'));
  });
});
