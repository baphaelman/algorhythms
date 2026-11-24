/**
 * Poster speed and size on long pieces (PLAN §15 M9, line 3), opt-in: `POSTER_LONG=1`, Chromium
 * dev only (`POSTER_LONG=all`: every engine's dev project). Not run in CI.
 * - 4K PNG (16:9 3840×2160) as the dialog makes it (`renderPosterPng` with the store's compiled
 *   score: draw + `convertToBlob`), and with the compile; median of 3 after a warm-up;
 *   gate < 2 s (the 4K PNG of a 3-minute piece);
 * - SVG bytes and time; gate < 10 MB;
 * - pieces: the longest bundled composition, the one closest to 3 minutes, Kite Day cut to 180 s
 *   and 600 s (its material ends at 108 s; its lines continue); each in the dialog's default Look
 *   (EXPORT_LOOK, no HUD, title on) and the player's look (guides and their labels on); the
 *   longest piece also at 1:1 and A4.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type * as Poster from '../../src/app/poster-export';
import { EXPORT_LOOK } from '../../src/render';

const ROOT = join(import.meta.dirname, '../..');
const FILES = ['examples', 'examples/songs', 'examples/experiments'].flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => join(ROOT, d, f)),
);

interface HookWindow {
  __algorhythms: {
    parsePiece(j: unknown): { ok: boolean; piece: Parameters<typeof Poster.renderPosterSvg>[0] };
    poster(): Promise<typeof Poster>;
    actions: { loadPiece(p: unknown): void };
    store: {
      getState(): {
        piece: Parameters<typeof Poster.renderPosterSvg>[0];
        compiled: Parameters<typeof Poster.renderPosterPng>[2] & { duration: number };
      };
    };
  };
}

interface Row {
  piece: string;
  seconds: number;
  look: string;
  size: Poster.PosterOptions['size'];
  /** Draw + encode with the compiled score (the dialog's path), median of 3, ms. */
  pngMs: number;
  /** Compile + draw + encode, median of 3, ms. */
  pngWithCompileMs: number;
  pngMB: number;
  svgMs: number;
  svgMB: number;
  svgElements: number;
}

test.beforeEach(async ({ page }, info) => {
  const env = process.env.POSTER_LONG;
  test.skip(!env, 'set POSTER_LONG=1');
  test.skip(
    env === 'all' ? !info.project.name.endsWith('-dev') : info.project.name !== 'chromium-dev',
    'chromium-dev only (POSTER_LONG=all: every dev project)',
  );
  await page.goto('./');
  await page.waitForFunction(() => '__algorhythms' in window);
});

test('4K PNG < 2 s and SVG < 10 MB: longest, ~3-minute and stretched pieces (reported)', async ({
  page,
  browserName,
}) => {
  test.setTimeout(900_000);
  const jsons = FILES.map((f) => ({
    name: f.replace(/^.*\//, '').replace('.algorhythms.json', ''),
    j: JSON.parse(readFileSync(f, 'utf8')) as unknown,
  }));
  const rows = await page.evaluate(
    async ({ jsons, exportLook }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.poster();
      const load = (piece: unknown) => {
        h.actions.loadPiece(piece);
        const s = h.store.getState();
        return { piece: s.piece, compiled: s.compiled };
      };
      const all = jsons.map(({ name, j }) => {
        const piece = h.parsePiece(j).piece;
        return { name, piece, seconds: load(piece).compiled.duration };
      });
      const longest = all.reduce((a, b) => (b.seconds > a.seconds ? b : a));
      const near3 = all.reduce((a, b) =>
        Math.abs(b.seconds - 180) < Math.abs(a.seconds - 180) ? b : a,
      );
      const kite = all.find((p) => p.name === 'kite-day')!;
      const cut = (at: number) => {
        const p = structuredClone(kite.piece) as typeof kite.piece & {
          end?: { at: number; fade: number };
        };
        p.end = { at, fade: 2 };
        return { name: `kite-day cut to ${at} s`, piece: p };
      };
      const looks = {
        export: { look: { ...exportLook, theme: 'light' as const, hud: [] } },
        player: {},
      };
      const cases: {
        name: string;
        piece: unknown;
        look: keyof typeof looks;
        size: Poster.PosterOptions['size'];
      }[] = [];
      const pieces = [longest, ...(near3 === longest ? [] : [near3]), cut(180), cut(600)];
      for (const p of pieces)
        for (const look of ['export', 'player'] as const)
          cases.push({ name: p.name, piece: p.piece, look, size: '16:9' });
      cases.push({ ...longest, look: 'export', size: '1:1' });
      cases.push({ ...longest, look: 'export', size: 'a4' });
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
      const out: Row[] = [];
      for (const c of cases) {
        const { piece, compiled } = load(c.piece);
        const opts: Poster.PosterOptions = {
          size: c.size,
          theme: 'light',
          transparent: false,
          title: true,
          thickness: true,
          ...looks[c.look],
        };
        await m.renderPosterPng(piece, opts, compiled);
        const png: number[] = [];
        const full: number[] = [];
        let bytes = 0;
        for (let i = 0; i < 3; i++) {
          let t0 = performance.now();
          const b = await m.renderPosterPng(piece, opts, compiled);
          png.push(performance.now() - t0);
          bytes = b.size;
          t0 = performance.now();
          await m.renderPosterPng(piece, opts);
          full.push(performance.now() - t0);
        }
        const t0 = performance.now();
        const svg = m.renderPosterSvg(piece, opts, compiled);
        const svgMs = performance.now() - t0;
        out.push({
          piece: c.name,
          seconds: compiled.duration,
          look: c.look,
          size: c.size,
          pngMs: median(png),
          pngWithCompileMs: median(full),
          pngMB: bytes / 1e6,
          svgMs,
          svgMB: new Blob([svg]).size / 1e6,
          svgElements: (svg.match(/<(path|text|rect|line|circle)\b/g) ?? []).length,
        });
      }
      return out;
    },
    { jsons, exportLook: EXPORT_LOOK },
  );
  for (const r of rows)
    console.log(
      `[${browserName}] poster long: ${r.piece} (${r.seconds.toFixed(1)} s) ${r.size} ${r.look}: ` +
        `PNG ${r.pngMs.toFixed(0)} ms (with compile ${r.pngWithCompileMs.toFixed(0)}), ${r.pngMB.toFixed(2)} MB; ` +
        `SVG ${r.svgMs.toFixed(0)} ms, ${r.svgMB.toFixed(2)} MB, ${r.svgElements} elements`,
    );
  test.info().annotations.push({ type: 'poster-long', description: JSON.stringify(rows) });
  expect(rows.some((r) => r.seconds >= 179)).toBe(true);
  for (const r of rows) {
    const what = `${r.piece} ${r.size} ${r.look}`;
    if (r.size === '16:9') expect(r.pngMs, `${what}: 4K PNG ms`).toBeLessThan(2000);
    expect(r.svgMB, `${what}: SVG MB`).toBeLessThan(10);
  }
});
