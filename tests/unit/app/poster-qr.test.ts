/**
 * The poster's QR code (M17): the encoder wrapper (byte mode, M or L, the public watch link),
 * the length limit and the too-long state, storage (schema, canonical, share packing), the
 * layout (default place, square boxes, labels avoid it, the hint hides first), editing, and the
 * drawn SVG decoded back by jsQR at the export size and downscaled, on light and dark posters.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { canonicalPiece } from '../../../src/core/canonical';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import {
  encodeQr,
  exampleIdOf,
  noteQrSeed,
  qrFits,
  qrLinkLength,
  qrLinkOf,
  qrReady,
} from '../../../src/app/poster-qr';
import { loadInfo } from '../../../src/app/store';
import { nudgeDoc, placeRect, qrObject, selectionAt } from '../../../src/app/poster-select';
import {
  decodeShareLink,
  encodeShareLink,
  packPiece,
  shareablePiece,
} from '../../../src/app/share';
import { SITE_URL } from '../../../src/app/youtube-description';
import {
  POSTER_HINT_ID,
  SvgContext,
  asCtx2D,
  drawPosterLayout,
  layoutPoster,
  posterIssues,
  qrBoxFor,
  refitPoster,
  removeQr,
  setQr,
  type PosterLayout,
  type QrObject,
} from '../../../src/render';
import { EXPORT_LOOK, type Look } from '../../../src/render/look';
import {
  QR_DEFAULT_MAX,
  QR_DEFAULT_MIN,
  QR_MAX_CHARS,
  QR_MIN_MODULE_PX,
  qrDefaultSide,
  qrMinModule,
  qrContrast,
  qrModulePx,
  qrReadable,
  type QrInput,
} from '../../../src/render/poster-qr';
import { withOpening } from '../opened-piece';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const KITE = parsed(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
const withQr = (p: Piece, qr: NonNullable<PosterDoc['qr']> = {}, doc: PosterDoc = {}): Piece =>
  parsed(JSON.parse(JSON.stringify({ ...p, poster: { ...p.poster, ...doc, qr } })));

const lay = (piece: Piece, o: { qr?: QrInput; look?: Look; doc?: PosterDoc } = {}): PosterLayout =>
  layoutPoster({
    compiled: compile(piece),
    piece,
    ...(o.doc ? { doc: o.doc } : {}),
    ...(o.look ? { look: o.look } : {}),
    ...(o.qr ? { qr: o.qr } : {}),
  });
const qrOf = (L: PosterLayout): QrObject => {
  const o = qrObject(L);
  if (!o) throw new Error('no QR object');
  return o;
};

/** A piece whose watch link is long: free text boxes of noise that deflate can't shrink. */
function longPiece(): Piece {
  let x = 7;
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const noise = () => {
    let text = '';
    for (let i = 0; i < 1000; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      text += abc[(x >> 8) % abc.length];
    }
    return text;
  };
  return withQr(
    KITE,
    {},
    {
      texts: [
        { id: 'n1', kind: 'free', text: noise() },
        { id: 'n2', kind: 'free', text: noise() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Rasterising the drawn SVG and decoding it
// ---------------------------------------------------------------------------------------------

const hexRgb = (h: string): [number, number, number] => {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) throw new Error(`not a hex colour: ${h}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
};

/**
 * The poster's QR code as the SVG draws it: the background, the card (`<rect>` just before the
 * crisp path) and the modules from the path data under its matrix, as a colour at a poster point.
 */
function svgQr(svg: string): {
  at: (x: number, y: number) => [number, number, number];
  card: { x: number; y: number; w: number };
} {
  const bg = /<rect x="0" y="0" width="\d+" height="\d+" fill="(#[0-9a-f]{6})"/i.exec(svg);
  const path =
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="[\d.]+" fill="(#[0-9a-f]{6})"\/>\n<path d="([^"]+)" transform="matrix\(([^)]+)\)" fill="(#[0-9a-f]{6})" shape-rendering="crispEdges"\/>/i.exec(
      svg,
    );
  if (!bg || !path) throw new Error('no QR code in the SVG');
  const card = { x: Number(path[1]), y: Number(path[2]), w: Number(path[3]) };
  const [a, , , d, e, f] = path[6].split(' ').map(Number);
  const dark = new Set<string>();
  for (const m of path[5].matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let c = 0; c < Number(m[3]); c++) dark.add(`${Number(m[1]) + c},${m[2]}`);
  }
  const paper = hexRgb(bg[1]);
  const cardRgb = hexRgb(path[4]);
  const ink = hexRgb(path[7]);
  return {
    card,
    at: (x, y) => {
      if (x < card.x || y < card.y || x >= card.x + card.w || y >= card.y + card.w) return paper;
      const c = Math.floor((x - e) / a);
      const r = Math.floor((y - f) / d);
      return dark.has(`${c},${r}`) ? ink : cardRgb;
    },
  };
}

/**
 * The region round the card (with `pad` poster px of paper), `scale` image px per poster px:
 * point samples at 1:1, else a tent filter over two image px (a camera's blur, roughly).
 */
function raster(
  q: ReturnType<typeof svgQr>,
  scale: number,
  pad = 40,
): { data: Uint8ClampedArray; w: number; h: number } {
  const x0 = q.card.x - pad;
  const y0 = q.card.y - pad;
  const side = q.card.w + 2 * pad;
  const w = Math.round(side * scale);
  const data = new Uint8ClampedArray(w * w * 4);
  const ss = scale === 1 ? 1 : 6;
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let a = 0; a < ss; a++) {
        for (let b = 0; b < ss; b++) {
          const u = ss === 1 ? 0 : -1 + (2 * (a + 0.5)) / ss;
          const v = ss === 1 ? 0 : -1 + (2 * (b + 0.5)) / ss;
          const wt = (1 - Math.abs(u)) * (1 - Math.abs(v));
          const c = q.at(x0 + (i + 0.5 + u) / scale, y0 + (j + 0.5 + v) / scale);
          for (let k = 0; k < 3; k++) acc[k] += wt * c[k];
          n += wt;
        }
      }
      const p = (j * w + i) * 4;
      for (let k = 0; k < 3; k++) data[p + k] = acc[k] / n;
      data[p + 3] = 255;
    }
  }
  return { data, w, h: w };
}

const drawnSvg = (piece: Piece, L: PosterLayout): string => {
  const c = new SvgContext(L.width, L.height);
  drawPosterLayout(asCtx2D(c), compile(piece), L);
  return c.toSvg();
};

/** jsQR's reading of the code drawn in the SVG, `scale` image px per poster px. */
function decodeDrawn(svg: string, scale: number): string | null {
  const img = raster(svgQr(svg), scale);
  return jsQR(img.data, img.w, img.h)?.data ?? null;
}

// ---------------------------------------------------------------------------------------------

describe('the encoder wrapper', () => {
  it('byte mode, M while the code stays small, else L; the modules read back', async () => {
    const short = `${SITE_URL}#w&p=2.abc`;
    const s = await encodeQr(short);
    expect(s.level).toBe('M');
    expect(s.bits.length).toBe(s.n * s.n);
    const long = `${SITE_URL}#w&p=2.${'x7Q-'.repeat(330)}`;
    const l = await encodeQr(long);
    expect(l.level).toBe('L');
    expect(l.n).toBeGreaterThan(105);
    for (const [link, m] of [
      [short, s],
      [long, l],
    ] as const) {
      // Drawn at 3 px a module with its quiet zone, it reads back as the link.
      const span = m.n + 8;
      const w = span * 3;
      const data = new Uint8ClampedArray(w * w * 4).fill(255);
      for (let r = 0; r < m.n; r++)
        for (let c = 0; c < m.n; c++)
          if (m.bits[r * m.n + c] === '1')
            for (let y = 0; y < 3; y++)
              for (let x = 0; x < 3; x++) {
                const p = ((r + 4) * 3 + y) * w * 4 + ((c + 4) * 3 + x) * 4;
                data[p] = data[p + 1] = data[p + 2] = 0;
              }
      expect(jsQR(data, w, w)?.data).toBe(link);
    }
  });

  it("holds the piece's watch link on the public site, which opens the piece", async () => {
    const piece = withQr(KITE);
    const q = await qrReady(piece);
    expect(q.link.startsWith(`${SITE_URL}#w&p=2.`)).toBe(true);
    expect(q.tooLong).toBeUndefined();
    expect(q.matrix).toBeDefined();
    expect(q.link).toBe(await qrLinkOf(piece));
    expect(parsed(await decodeShareLink(q.link))).toEqual(shareablePiece(piece));
    // Made once per piece.
    expect(await qrReady(piece)).toBe(q);
  });

  it('the limit: links over 1,500 characters are not encoded (too long)', async () => {
    expect(qrFits('x'.repeat(QR_MAX_CHARS))).toBe(true);
    expect(qrFits('x'.repeat(QR_MAX_CHARS + 1))).toBe(false);
    const piece = longPiece();
    const q = await qrReady(piece);
    expect(q.link.length).toBeGreaterThan(QR_MAX_CHARS);
    expect(q.tooLong).toBe(true);
    expect(q.matrix).toBeUndefined();
    // The toolbar's length: the link with a code at its default place.
    expect(await qrLinkLength(KITE)).toBe((await qrLinkOf(withQr(KITE))).length);
    expect(await qrLinkLength(KITE)).toBeLessThan(QR_MAX_CHARS);
  });
});

describe('storage', () => {
  const box = { x: 0.712345678, y: 0.61, w: 0.2, h: 0.35555555 };
  it('schema: reads a code, refuses a bad one', () => {
    const p = withQr(KITE, { box, colour: '#112233', card: '#fafafa' });
    expect(p.poster?.qr?.colour).toBe('#112233');
    const bad = { ...KITE, poster: { qr: { box: { x: 0, y: 0, w: -1, h: 1 } } } };
    expect(parsePiece(JSON.parse(JSON.stringify(bad))).ok).toBe(false);
  });

  it('canonical: the box to 4 significant digits', () => {
    const p = canonicalPiece({ ...KITE, poster: { qr: { box } } });
    expect(p.poster?.qr?.box).toEqual({ x: 0.7123, y: 0.61, w: 0.2, h: 0.3556 });
  });

  it('share links: round trip, a code with only a box packs as its box, `{}` stays', async () => {
    for (const qr of [{}, { box: { x: 0.7, y: 0.6, w: 0.2, h: 0.36 } }, { colour: '#222222' }]) {
      const p = withQr(KITE, qr);
      expect(parsed(await decodeShareLink(await encodeShareLink(p, 'https://x/')))).toEqual(p);
    }
    const packed = packPiece(withQr(KITE, { box: { x: 0.7, y: 0.6, w: 0.2, h: 0.36 } }));
    expect((packed?.poster as Record<string, unknown>).qr).toEqual([0.7, 0.6, 0.2, 0.36]);
    // A code adds little to the link.
    const plain = (await encodeShareLink(KITE, 'https://x/')).length;
    expect((await encodeShareLink(withQr(KITE), 'https://x/')).length - plain).toBeLessThan(25);
  });
});

describe('layout', () => {
  const piece = withQr(KITE);
  const ready = async (p: Piece) => ({ qr: await qrReady(p) });

  it('none without a code; pending while encoding; too long', async () => {
    expect(qrObject(lay(KITE))).toBeUndefined();
    expect(qrOf(lay(piece)).state).toBe('pending');
    const long = longPiece();
    expect(qrOf(lay(long, await ready(long))).state).toBe('long');
    expect(qrOf(lay(piece, await ready(piece))).state).toBe('ok');
  });

  it('default: bottom right inside the margins, square, whole px per module', async () => {
    const L = lay(piece, await ready(piece));
    const o = qrOf(L);
    const c = L.content;
    expect(o.box.w).toBe(o.box.h);
    expect(o.box.x + o.box.w).toBeLessThanOrEqual(c.x + c.w + 0.5);
    expect(o.box.x + o.box.w).toBeGreaterThan(c.x + c.w - qrModulePx(o.box.w, o.matrix) - 1);
    expect(o.box.y + o.box.h).toBeLessThanOrEqual(c.y + c.h + 0.5);
    expect(o.box.y).toBeGreaterThan(L.band ? L.band.y + L.band.h : c.y);
    expect(Number.isInteger(qrModulePx(o.box.w, o.matrix))).toBe(true);
    expect(Number.isInteger(o.box.x) && Number.isInteger(o.box.y)).toBe(true);
    expect(o.auto).toBe(true);
  });

  it('above the HUD band; labels and readouts avoid it', async () => {
    const look: Look = { ...EXPORT_LOOK, hud: ['chord', 'key', 'time', 'title'] };
    const L = lay(piece, { ...(await ready(piece)), look });
    const o = qrOf(L);
    expect(L.hudBand).not.toBeNull();
    expect(o.box.y + o.box.h).toBeLessThanOrEqual(L.hudBand!.y);
    for (const x of L.objects) {
      if (x.type !== 'label') continue;
      const b = x.box;
      const meets =
        b.x < o.box.x + o.box.w &&
        o.box.x < b.x + b.w &&
        b.y < o.box.y + o.box.h &&
        o.box.y < b.y + b.h;
      expect(meets, `${x.group} ${x.member}`).toBe(false);
    }
    // The right-hand readouts are still shown (below the code).
    expect(L.objects.some((x) => x.type === 'label' && x.group === 'hud')).toBe(true);
  });

  it('in the text band when the band holds it', async () => {
    const doc: PosterDoc = {
      texts: [
        {
          id: 'title',
          kind: 'title',
          text: '{name}\nby the sea\nin May\nat noon',
          style: { size: 0.1 },
        },
      ],
      qr: {},
    };
    const p = withQr(KITE, {}, doc);
    const L = lay(p, await ready(p));
    const o = qrOf(L);
    expect(L.band).not.toBeNull();
    expect(o.box.y).toBeGreaterThanOrEqual(L.band!.y - 0.5);
    expect(o.box.y + o.box.h).toBeLessThanOrEqual(L.band!.y + L.band!.h + 0.5);
  });

  it('a placed box: a square of its smaller side; the hint hides before it', async () => {
    const base = lay(KITE);
    const hint = base.objects.find((x) => x.type === 'text' && x.member === POSTER_HINT_ID);
    expect(hint).toBeDefined();
    // Over the hint: the hint goes, the title and credit stay.
    const hb = hint!.box;
    const box = { x: (hb.x + hb.w / 2) / base.width, y: hb.y / base.height, w: 0.1, h: 0.5 };
    const p = withQr(KITE, { box });
    const L = lay(p, await ready(p));
    const o = qrOf(L);
    expect(o.box.w).toBe(o.box.h);
    expect(o.box.w).toBeLessThanOrEqual(0.1 * L.width + 0.5);
    expect(o.box.w).toBeGreaterThan(0.1 * L.width - qrModulePx(o.box.w, o.matrix) - 1);
    expect(o.auto).toBe(false);
    const texts = L.objects.filter((x) => x.type === 'text').map((x) => x.member);
    expect(texts).not.toContain(POSTER_HINT_ID);
    expect(texts).toEqual(expect.arrayContaining(['title', 'credit']));
  });

  it('structured-cloneable (the video worker takes the layout)', async () => {
    const L = lay(piece, await ready(piece));
    expect(structuredClone(L).objects.at(-1)).toEqual(qrOf(L));
  });
});

describe('editing', () => {
  it('add, colour, remove; boxes square; Re-fit puts it back', async () => {
    let d = setQr(undefined, {});
    expect(d).toEqual({ qr: {} });
    d = setQr(d, { colour: '#111111', card: '#eeeeee' });
    d = setQr(d, { colour: undefined });
    expect(d).toEqual({ qr: { card: '#eeeeee' } });
    expect(removeQr(d)).toBeUndefined();
    const L = lay(KITE);
    const b = qrBoxFor(L, { x: 100, y: 200, w: 500, h: 300 });
    expect(b.w * L.width).toBeCloseTo(300);
    expect(b.h * L.height).toBeCloseTo(300);
    expect(refitPoster({ qr: { box: b, card: '#eeeeee' } })).toEqual({ qr: { card: '#eeeeee' } });
  });

  it('click selects it; move, resize and nudge store a square box', async () => {
    const p = withQr(KITE);
    const L = lay(p, { qr: await qrReady(p) });
    const o = qrOf(L);
    expect(selectionAt(L, o.box.x + 5, o.box.y + 5, false)).toEqual({ kind: 'qr' });
    const moved = placeRect(p.poster, L, { kind: 'qr' }, o.box, { ...o.box, x: 300, y: 400 });
    expect(moved?.qr?.box?.x).toBeCloseTo(300 / L.width);
    const big = placeRect(p.poster, L, { kind: 'qr' }, o.box, { ...o.box, w: 900, h: 700 });
    expect((big?.qr?.box?.w ?? 0) * L.width).toBeCloseTo(700);
    const n1 = nudgeDoc(moved, L, { kind: 'qr' }, 10, 0);
    expect((n1?.qr?.box?.x ?? 0) * L.width).toBeCloseTo(310);
  });
});

describe('default size: modules of 1/400 of the shorter side, 12–40 % of it', () => {
  const m = (n: number) => ({ n, bits: '0'.repeat(n * n) });
  it('grows with the density, clamped', () => {
    // 2160 px: modules of 6 px (5.4 rounded up to whole px).
    expect(qrMinModule(2160)).toBeCloseTo(5.4);
    expect(qrMinModule(800)).toBe(QR_MIN_MODULE_PX);
    expect(qrDefaultSide(2160, m(105))).toBe(6 * 113);
    // Clamped to whole modules: 9 px × 29 ≥ 12 %; 4 px × 185 ≤ 40 %.
    expect(qrDefaultSide(2160, m(21))).toBe(9 * 29);
    expect(qrDefaultSide(2160, m(21))).toBeGreaterThanOrEqual(QR_DEFAULT_MIN * 2160);
    expect(qrDefaultSide(2160, m(177))).toBe(4 * 185);
    expect(qrDefaultSide(2160, m(177))).toBeLessThanOrEqual(QR_DEFAULT_MAX * 2160);
  });

  it("Kite Day's code: whole modules of at least 1/400, as laid out at 16:9, square and A4", async () => {
    const piece = withQr(KITE);
    const qr = await qrReady(piece);
    for (const size of [
      { w: 3840, h: 2160 },
      { w: 2160, h: 2160 },
      { w: 2480, h: 3508 },
    ]) {
      const L = layoutPoster({ compiled: compile(piece), piece, base: { size }, qr });
      const o = qrOf(L);
      const S = Math.min(size.w, size.h);
      expect(qrModulePx(o.box.w, o.matrix)).toBeGreaterThanOrEqual(S / 400);
      expect(Number.isInteger(qrModulePx(o.box.w, o.matrix))).toBe(true);
    }
  });

  it('every bundled piece with a code: the default poster passes posterIssues', async () => {
    const root = join(import.meta.dirname, '../../../examples');
    const files = ['', 'songs', 'experiments'].flatMap((d) =>
      readdirSync(join(root, d))
        .filter((f) => f.endsWith('.algorhythms.json'))
        .map((f) => join(root, d, f)),
    );
    expect(files.length).toBeGreaterThanOrEqual(17);
    for (const f of files) {
      const piece = withQr(parsed(JSON.parse(readFileSync(f, 'utf8'))));
      const qr = await qrReady(piece);
      const compiled = compile(piece);
      for (const size of [
        { w: 3840, h: 2160 },
        { w: 2160, h: 2160 },
        { w: 2480, h: 3508 },
      ]) {
        for (const rows of [1, 3]) {
          const L = layoutPoster({ compiled, piece, base: { size, rows }, qr });
          const at = `${f.split('/').pop()} ${size.w}×${size.h} rows ${rows}`;
          expect(qrObject(L), at).toBeDefined();
          expect(posterIssues(L), at).toEqual([]);
        }
      }
    }
  });
});

describe('short links for unedited examples', () => {
  it('an unedited example holds `#w&<id>`; an edited one `#w&p=…`', async () => {
    // As `loadPiece(KITE, { example: 'kite-day' })` records it (the store needs a page to load).
    const info = loadInfo() as { example?: string; examplePiece?: Piece; exampleFrame?: string };
    Object.assign(info, { example: 'kite-day', examplePiece: KITE });
    const opened = KITE;
    const coded: Piece = {
      ...opened,
      poster: { ...opened.poster, qr: { box: { x: 0.7, y: 0.6, w: 0.2, h: 0.36 } } },
    };
    expect(exampleIdOf(coded)).toBe('kite-day');
    // A poster doc (the code's) plays Over the poster; the bare example plays One row.
    expect(await qrLinkOf(coded)).toBe(`${SITE_URL}#w&kite-day&f=poster`);
    expect(await qrLinkLength(opened)).toBe(`${SITE_URL}#w&kite-day&f=poster`.length);
    // An example whose own video is Over the poster needs no frame.
    Object.assign(info, { exampleFrame: 'poster' });
    expect(await qrLinkOf({ ...coded, meta: { ...coded.meta } })).toBe(`${SITE_URL}#w&kite-day`);
    Object.assign(info, { exampleFrame: undefined });
    const q = await qrReady(coded);
    expect(q.matrix!.n).toBeLessThanOrEqual(33);
    // The poster settings the first poster edit seeds (the viewer's) still count as unedited.
    expect(KITE.poster).toBeUndefined();
    const seeded: Piece = { ...KITE, poster: { look: { theme: 'dark' }, qr: {} } };
    expect(exampleIdOf(seeded)).toBeUndefined();
    noteQrSeed(KITE, seeded);
    expect(exampleIdOf(seeded)).toBe('kite-day');
    // The seeded poster makes the maker's video Over the poster; the bare example's is One row.
    expect(await qrLinkOf(seeded)).toBe(`${SITE_URL}#w&kite-day&f=poster`);
    expect(exampleIdOf({ ...seeded, poster: { ...seeded.poster, rows: 2 } })).toBeUndefined();
    // Edited: the full link.
    const edited: Piece = { ...coded, meta: { ...coded.meta, title: 'Kite Night' } };
    expect(exampleIdOf(edited)).toBeUndefined();
    expect((await qrLinkOf(edited)).startsWith(`${SITE_URL}#w&p=2.`)).toBe(true);
    const posterEdit: Piece = { ...coded, poster: { ...coded.poster, rows: 2 } };
    expect(exampleIdOf(posterEdit)).toBeUndefined();
    // Not opened as an example: the full link.
    Object.assign(info, { example: undefined, examplePiece: undefined });
    expect(exampleIdOf(coded)).toBeUndefined();
  });
});

describe('readable by default', () => {
  it('black on white; contrast and inverted codes warned', () => {
    expect(qrReadable('#000000', '#ffffff')).toBe(true);
    expect(qrReadable('#777777', '#999999')).toBe(false);
    expect(qrContrast('#ffffff', '#000000')).toBeLessThan(0);
    expect(qrReadable('#ffffff', '#000000')).toBe(false);
    expect(qrReadable('#1d3557', '#f1faee')).toBe(true);
  });

  for (const theme of ['light', 'dark'] as const) {
    const look: Look = { ...EXPORT_LOOK, theme };

    it(`${theme}: Kite Day's code decodes from the SVG at the export size`, async () => {
      const piece = withQr(KITE);
      const q = await qrReady(piece);
      const L = lay(piece, { qr: q, look });
      const o = qrOf(L);
      expect(qrModulePx(o.box.w, o.matrix)).toBeGreaterThanOrEqual(QR_MIN_MODULE_PX);
      const svg = drawnSvg(piece, L);
      expect(decodeDrawn(svg, 1)).toBe(q.link);
      // Downscaled until a module is 2 image px: the 3840 px poster about 1,900 px wide. (Its
      // ~1,300-character link needs that; jsQR misses fractional modules a camera would blur.)
      const k = 2 / qrModulePx(o.box.w, o.matrix);
      expect(Math.round(L.width * k)).toBeLessThan(2000);
      expect(decodeDrawn(svg, k)).toBe(q.link);
    });

    it(`${theme}: a short piece's code decodes from an A4 poster downscaled to 1,000 px wide`, async () => {
      const piece = withQr(withOpening(newPiece({ seed: 1 })), {}, { size: { w: 2480, h: 3508 } });
      const q = await qrReady(piece);
      expect(q.link.length).toBeLessThan(400);
      const L = lay(piece, { qr: q, look });
      expect(decodeDrawn(drawnSvg(piece, L), 1000 / L.width)).toBe(q.link);
    });
  }

  it('exports leave out a code that is too long or still encoding', async () => {
    const long = longPiece();
    const L = lay(long, { qr: await qrReady(long) });
    expect(drawnSvg(long, L)).not.toContain('crispEdges');
    expect(drawnSvg(withQr(KITE), lay(withQr(KITE)))).not.toContain('crispEdges');
  });
});
