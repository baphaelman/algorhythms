/**
 * Poster export (src/app/poster-export.ts, PLAN.md §12 "Poster export", §15 M9):
 * - the PNG equals a direct `drawScore` render with the same camera and style (pixel-identical);
 * - the SVG is well-formed XML with text as `<text>`, and rasterised by the browser (an `<img>`
 *   drawn on a canvas of the same size) matches the PNG within an anti-aliasing tolerance;
 * - speed of a ~3-minute piece at 4K (PNG), and SVG size of every bundled piece (< 10 MB).
 * Chromium saves review posters to $POSTER_OUT_DIR when it is set.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type * as Poster from '../../src/app/poster-export';
import { EXPORT_LOOK, HUD_ITEMS } from '../../src/render';

const ROOT = join(import.meta.dirname, '../..');
const OUT = process.env.POSTER_OUT_DIR;
const FILES = [
  ...readdirSync(join(ROOT, 'examples'))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => join(ROOT, 'examples', f)),
  ...readdirSync(join(ROOT, 'examples/compositions'))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => join(ROOT, 'examples/compositions', f)),
];
const json = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      FILES.find((f) => f.endsWith(`/${name}.algorhythms.json`))!,
      'utf8',
    ),
  );

interface HookWindow {
  __algorhythms: {
    parsePiece(j: unknown): { ok: boolean; piece: Parameters<typeof Poster.renderPosterSvg>[0] };
    poster(): Promise<typeof Poster>;
    actions: { loadPiece(p: unknown): void };
    store: { getState(): { compiled: { duration: number } } };
  };
}

/**
 * SVG vs PNG of the same poster (title on, 4K): the SVG must reach MIN_PSNR (RGB) and beat the
 * PNG against itself moved by one pixel (the control: the size of an edge's anti-aliasing) by
 * MIN_MARGIN dB. Measured (Linux): Chromium 44.7 / 54.1 dB, Firefox 49.5 / 51.6 dB; the
 * control 27.6–28.8 dB; the other theme ~1.4 dB. Residue: text (canvas vs SVG text layout),
 * OKLCH → hex rounding, anti-aliasing of the same paths. WebKit is measured on CI only.
 */
const MIN_PSNR = 36;
const MIN_MARGIN = 6;

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
  await page.goto('./');
  await page.waitForFunction(() => '__algorhythms' in window);
});

const BASE: Poster.PosterOptions = {
  size: '16:9',
  theme: 'light',
  transparent: false,
  title: false,
  thickness: true,
};

interface Diff {
  width: number;
  height: number;
  /** Bytes (RGBA) that differ, and the largest difference. */
  diff: number;
  max: number;
  /** Max difference over pixels with alpha 255 in the reference / alpha of the PNG's corner. */
  maxOpaque: number;
  /** Max alpha difference, and max premultiplied colour difference (c·a/255). */
  maxAlpha: number;
  maxPremul: number;
  corner: number;
  inked: number;
}

async function pngVsReference(page: Page, name: string, opts: Poster.PosterOptions): Promise<Diff> {
  return page.evaluate(
    async ({ j, opts }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.poster();
      const piece = h.parsePiece(j).piece;
      const blob = await m.renderPosterPng(piece, opts);
      const ref = m.referencePoster(piece, opts);
      const bmp = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d', { alpha: opts.transparent })!;
      g.drawImage(bmp, 0, 0);
      const got = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const r = ref.data;
      let diff = 0;
      let max = 0;
      let maxOpaque = 0;
      let maxAlpha = 0;
      let maxPremul = 0;
      let inked = 0;
      const paper = [r[0], r[1], r[2]];
      for (let i = 0; i < r.length; i++) {
        const d = Math.abs(got[i] - r[i]);
        if (d) diff++;
        if (d > max) max = d;
        if (r[i | 3] === 255 && d > maxOpaque) maxOpaque = d;
        if ((i & 3) === 3) maxAlpha = Math.max(maxAlpha, d);
        else {
          const p = Math.abs(got[i] * got[i | 3] - r[i] * r[i | 3]) / 255;
          if (p > maxPremul) maxPremul = p;
        }
      }
      for (let i = 0; i < r.length; i += 4)
        if (r[i] !== paper[0] || r[i + 1] !== paper[1] || r[i + 2] !== paper[2]) inked++;
      return {
        width: bmp.width,
        height: bmp.height,
        diff,
        max,
        maxOpaque,
        maxAlpha,
        maxPremul,
        corner: got[3],
        inked,
      };
    },
    { j: json(name), opts },
  );
}

test('PNG equals a direct drawScore render (pixel-identical)', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const cases: [string, Poster.PosterOptions][] = [
    ['tide-pools', BASE],
    ['kite-day', { ...BASE, size: 'a4', theme: 'dark' }],
    ['night-ferry', { ...BASE, size: '1:1', thickness: false }],
    // The export Look (§12), with every HUD readout.
    ['kite-day', { ...BASE, look: EXPORT_LOOK }],
    [
      'harbour-song',
      { ...BASE, size: 'a4', look: { ...EXPORT_LOOK, theme: 'dark', hud: HUD_ITEMS } },
    ],
  ];
  for (const [name, opts] of cases) {
    const r = await pngVsReference(page, name, opts);
    console.log(`[${browserName}] ${name} ${opts.size} ${opts.theme}: ${JSON.stringify(r)}`);
    expect([r.width, r.height]).toEqual(
      opts.size === '16:9' ? [3840, 2160] : opts.size === '1:1' ? [2160, 2160] : [2480, 3508],
    );
    expect(r.inked).toBeGreaterThan(20_000);
    // CI WebKit (macOS) PNG round trip: tide-pools 16:9 light had 167 bytes off by 1 (max 1); others exact.
    if (browserName === 'webkit') {
      expect(r.max, `${name}: max byte error`).toBeLessThanOrEqual(1);
      expect(r.diff, `${name}: differing bytes`).toBeLessThanOrEqual(r.width * r.height * 4 * 1e-4);
    } else expect(r.diff, `${name}: differing bytes`).toBe(0);
  }
  // Transparent: no background; opaque pixels and alpha identical. Translucent edges go through
  // PNG's un-premultiplied colours and back, so they are compared premultiplied (two roundings, ≤ 2;
  // straight colours of nearly transparent pixels differ by up to 128 in Firefox).
  const t = await pngVsReference(page, 'tide-pools', { ...BASE, theme: 'dark', transparent: true });
  console.log(`[${browserName}] transparent: ${JSON.stringify(t)}`);
  expect(t.corner).toBe(0);
  expect(t.maxOpaque).toBe(0);
  expect(t.maxAlpha).toBe(0);
  expect(t.maxPremul).toBeLessThanOrEqual(2);
});

interface SvgResult {
  parseError: string | null;
  root: string;
  attrs: { width: string | null; height: string | null; viewBox: string | null };
  texts: string[];
  bytes: number;
  psnr: number;
  mae: number;
  control: number;
  theme: number;
}

test('SVG is well-formed and matches the PNG when rasterised', async ({ page, browserName }) => {
  test.setTimeout(180_000);
  const results: Record<string, SvgResult> = {};
  for (const [name, theme, look] of [
    ['tide-pools', 'light', false],
    ['harbour-song', 'dark', false],
    ['kite-day', 'light', true],
  ] as const) {
    const opts: Poster.PosterOptions = {
      ...BASE,
      title: true,
      theme,
      // No HUD: its five rows of text add canvas-vs-SVG text residue (35.9 dB on Chromium with
      // the default list); the PNG test covers the HUD.
      ...(look ? { look: { ...EXPORT_LOOK, theme, hud: [] } } : {}),
    };
    const r = await page.evaluate(
      async ({ j, opts }): Promise<SvgResult> => {
        const h = (window as unknown as HookWindow).__algorhythms;
        const m = await h.poster();
        const piece = h.parsePiece(j).piece;
        const svg = m.renderPosterSvg(piece, opts);
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const err = doc.getElementsByTagName('parsererror')[0];
        const root = doc.documentElement;
        const texts = [...doc.getElementsByTagName('text')].map((t) => t.textContent ?? '');
        const W = 3840;
        const H = 2160;
        const pixels = async (src: Blob): Promise<Uint8ClampedArray> => {
          const c = new OffscreenCanvas(W, H);
          const g = c.getContext('2d')!;
          if (src.type === 'image/svg+xml') {
            const url = URL.createObjectURL(src);
            const img = new Image(W, H);
            img.src = url;
            await img.decode();
            g.drawImage(img, 0, 0, W, H);
            URL.revokeObjectURL(url);
          } else {
            g.drawImage(await createImageBitmap(src), 0, 0);
          }
          return g.getImageData(0, 0, W, H).data;
        };
        const svgPx = await pixels(new Blob([svg], { type: 'image/svg+xml' }));
        const png = await pixels(await m.renderPosterPng(piece, opts));
        const other = await pixels(
          await m.renderPosterPng(piece, {
            ...opts,
            theme: opts.theme === 'dark' ? 'light' : 'dark',
            ...(opts.look
              ? { look: { ...opts.look, theme: opts.look.theme === 'dark' ? 'light' : 'dark' } }
              : {}),
          }),
        );
        // PSNR over RGB; `dx` compares a with b moved right by dx pixels.
        const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray, dx = 0) => {
          let se = 0;
          let n = 0;
          for (let y = 0; y < H; y++)
            for (let x = dx; x < W; x++) {
              const i = (y * W + x) * 4;
              const k = (y * W + x - dx) * 4;
              for (let c = 0; c < 3; c++) {
                const d = a[i + c] - b[k + c];
                se += d * d;
              }
              n += 3;
            }
          return 10 * Math.log10((255 * 255) / Math.max(se / n, 1e-9));
        };
        let ae = 0;
        for (let i = 0; i < png.length; i++) if ((i & 3) !== 3) ae += Math.abs(svgPx[i] - png[i]);
        return {
          parseError: err ? (err.textContent ?? 'parsererror') : null,
          root: root.nodeName,
          attrs: {
            width: root.getAttribute('width'),
            height: root.getAttribute('height'),
            viewBox: root.getAttribute('viewBox'),
          },
          texts,
          bytes: new Blob([svg]).size,
          psnr: psnr(svgPx, png),
          mae: ae / ((png.length / 4) * 3),
          control: psnr(png, png, 1),
          theme: psnr(svgPx, other),
        };
      },
      { j: json(name), opts },
    );
    results[`${name}-${theme}${look ? '-look' : ''}`] = r;
    const { texts, ...summary } = r;
    console.log(
      `[${browserName}] SVG ${name} ${theme}: ${JSON.stringify(summary)} texts ${texts.length}`,
    );
    expect(r.parseError).toBeNull();
    expect(r.root).toBe('svg');
    expect(r.attrs).toEqual({ width: '3840', height: '2160', viewBox: '0 0 3840 2160' });
    expect(texts.length).toBeGreaterThan(look ? 2 : 3);
    expect(texts).toContain('AlgoRhythms');
    // The octave guides' labels: on in the player look, off in the export look.
    expect(texts.some((t) => /^A\d \d+ Hz$/.test(t))).toBe(!look);
    expect(r.psnr, `${name} PSNR`).toBeGreaterThanOrEqual(MIN_PSNR);
    expect(r.control, `${name} 1 px shift control`).toBeLessThanOrEqual(r.psnr - MIN_MARGIN);
    expect(r.theme).toBeLessThan(r.control);
  }
  test.info().annotations.push({ type: 'poster-svg', description: JSON.stringify(results) });
});

test('speed at 4K and SVG size of every bundled piece', async ({ page, browserName }) => {
  test.setTimeout(240_000);
  const jsons = FILES.map((f) => ({
    name: f.replace(/^.*\//, '').replace('.algorhythms.json', ''),
    j: JSON.parse(readFileSync(f, 'utf8')) as unknown,
  }));
  const r = await page.evaluate(async (jsons) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.poster();
    const out: { name: string; svgBytes: number; svgMs: number }[] = [];
    for (const { name, j } of jsons) {
      const piece = h.parsePiece(j).piece;
      const t0 = performance.now();
      const svg = m.renderPosterSvg(piece, {
        size: '16:9',
        theme: 'dark',
        transparent: false,
        title: true,
        thickness: true,
      });
      const svgMs = performance.now() - t0;
      out.push({ name, svgBytes: new Blob([svg]).size, svgMs });
    }
    return out;
  }, jsons);
  for (const x of r) expect(x.svgBytes, x.name).toBeLessThan(10e6);
  console.log(
    `[${browserName}] SVG 16:9 sizes: ${r.map((x) => `${x.name} ${(x.svgBytes / 1e3).toFixed(0)} kB ${x.svgMs.toFixed(0)} ms`).join('; ')}`,
  );
  // PNG speed: the piece closest to 3 minutes, 4K, three runs after a warm-up.
  const speed = await page.evaluate(async (jsons) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.poster();
    const pieces = jsons.map(({ name, j }) => ({ name, piece: h.parsePiece(j).piece }));
    // Durations through the player's store (it compiles what it loads).
    let best = pieces[0];
    let bestD = Infinity;
    for (const p of pieces) {
      h.actions.loadPiece(p.piece);
      const d = h.store.getState().compiled.duration;
      if (Math.abs(d - 180) < Math.abs(bestD - 180)) {
        best = p;
        bestD = d;
      }
    }
    const opts = {
      size: '16:9',
      theme: 'light',
      transparent: false,
      title: true,
      thickness: true,
    } as const;
    await m.renderPosterPng(best.piece, opts);
    const ms: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const b = await m.renderPosterPng(best.piece, opts);
      ms.push(performance.now() - t0);
      bytes = b.size;
    }
    return { name: best.name, duration: bestD, ms, bytes };
  }, jsons);
  console.log(
    `[${browserName}] 4K PNG of ${speed.name} (${speed.duration.toFixed(0)} s): ${speed.ms.map((x) => x.toFixed(0)).join(', ')} ms, ${(speed.bytes / 1e6).toFixed(2)} MB`,
  );
  test.info().annotations.push({ type: 'poster-png-ms', description: JSON.stringify(speed) });
  expect(Math.min(...speed.ms)).toBeLessThan(10_000);

  if (OUT && browserName === 'chromium') {
    mkdirSync(OUT, { recursive: true });
    const save = await page.evaluate(async (jsons) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.poster();
      const get = (n: string) => h.parsePiece(jsons.find((x) => x.name === n)!.j).piece;
      const b64 = async (b: Blob) => {
        const bytes = new Uint8Array(await b.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const base = { transparent: false, title: true, thickness: true } as const;
      return {
        a: await b64(
          await m.renderPosterPng(get('kite-day'), { ...base, size: '16:9', theme: 'light' }),
        ),
        b: await b64(
          await m.renderPosterPng(get('night-ferry'), { ...base, size: 'a4', theme: 'dark' }),
        ),
        svg: m.renderPosterSvg(get('harbour-song'), { ...base, size: '16:9', theme: 'dark' }),
      };
    }, jsons);
    writeFileSync(join(OUT, 'kite-day-16x9-light.png'), Buffer.from(save.a, 'base64'));
    writeFileSync(join(OUT, 'night-ferry-a4-dark.png'), Buffer.from(save.b, 'base64'));
    writeFileSync(join(OUT, 'harbour-song-16x9-dark.svg'), save.svg);
  }
});

test('EXPORT_LOOK poster: differs from the default one; saved for review', async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  const r = await page.evaluate(
    async ({ j, look }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.poster();
      const piece = h.parsePiece(j).piece;
      const base = {
        size: '16:9',
        theme: 'light',
        transparent: false,
        title: true,
        thickness: true,
      } as const;
      const b64 = async (b: Blob) => {
        const bytes = new Uint8Array(await b.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return {
        look: await b64(await m.renderPosterPng(piece, { ...base, look })),
        plain: await b64(await m.renderPosterPng(piece, base)),
      };
    },
    { j: json('kite-day'), look: EXPORT_LOOK },
  );
  expect(r.look.length).toBeGreaterThan(10_000);
  expect(r.look).not.toBe(r.plain);
  const dir = process.env.LOOK_OUT_DIR;
  if (dir && browserName === 'chromium') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'look-poster.png'), Buffer.from(r.look, 'base64'));
  }
});
