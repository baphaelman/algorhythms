/**
 * Seams ahead of the playhead (PLAN.md §11.3 "Thickness transitions": no steps, necks, beads or end
 * caps at the seam). Thirteen lines merge into a unison on B3 and split out of it again, drawn by
 * the renderer alone (src/render/dev/entry.ts, as in render.spec.ts) with the playhead 1.5 s before
 * each. Reads the canvas back along the rope's centre line: across the seam the luminance changes
 * smoothly (the dimmed future once drew a brighter bead where translucent strands overlapped);
 * at the playhead the past stops at the rule (once its round cap showed past it); along a level
 * fade there are no hairline gaps between the opacity slices. Light and dark, dpr 1 and 2, the
 * future dimmed and not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { shot } from './shots';

const ROOT = join(import.meta.dirname, '../..');
/** Largest luminance change (0–255) allowed between neighbouring columns' trend. */
const BUMP = 14;

let bundle: string | null = null;
async function renderBundle(): Promise<string> {
  if (bundle) return bundle;
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: join(ROOT, 'src/render/dev/entry.ts'),
        formats: ['iife'],
        name: 'algorhythmsRender',
      },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  if (!('output' in result)) throw new Error('unexpected vite build result');
  bundle = result.output[0].code;
  return bundle;
}

const P13 = [43, 47, 50, 55, 59, 62, 64, 67, 71, 74, 76, 79, 83];
const glide = { length: 3, stagger: 0, jitter: 0, ease: 'smootherstep' };
function ropePiece(): unknown {
  const p = JSON.parse(
    readFileSync(join(ROOT, 'examples/the-cartographers-rain.algorhythms.json'), 'utf8'),
  ) as Record<string, unknown>;
  const notes = { kind: 'pitches', pitches: P13 };
  p.moments = [
    { id: 'start0', type: 'chord', at: 0, notes, voicing: 'even', assign: 'ordered' },
    { id: 'u', type: 'unison', at: 1, pitch: 59, octaves: false, glide },
    { id: 'c', type: 'chord', at: 8, notes, voicing: 'even', assign: 'ordered', glide },
    { id: 'u2', type: 'unison', at: 13, pitch: 59, octaves: false, glide },
  ];
  p.end = { at: 20, fade: 1 };
  return p;
}
function fadePiece(): unknown {
  const p = JSON.parse(
    readFileSync(join(ROOT, 'examples/the-cartographers-rain.algorhythms.json'), 'utf8'),
  ) as Record<string, unknown>;
  const notes = { kind: 'pitches', pitches: [48, 55, 60, 64, 67, 72] };
  p.moments = [
    { id: 'start0', type: 'chord', at: 0, notes, voicing: 'even', assign: 'ordered' },
    { id: 'l', type: 'level', at: 4, gain: 0, over: 3 },
    { id: 'l2', type: 'level', at: 9, gain: 1, over: 3 },
  ];
  p.end = { at: 16, fade: 1 };
  return p;
}

interface Row {
  /** Luminance per device column from x0. */
  lum: number[];
  /** Inked device rows per column around the centre line. */
  width: number[];
  /** Device columns (from x0) of the playhead rule and of `mark`. */
  head: number;
  mark: number;
}

interface Frame {
  json: unknown;
  t: number;
  start: number;
  window: number;
  dark: boolean;
  future: number;
  dpr: number;
  pitch: number;
  /** Row from time a to time b, `mark` a time of interest. */
  a: number;
  b: number;
  mark: number;
  /** Half height of the band whose ink is counted, CSS px. */
  band: number;
}

async function row(page: Page, f: Frame): Promise<Row> {
  return page.evaluate((f) => {
    const hook = (
      globalThis as unknown as {
        __render: { seamFrame(c: HTMLCanvasElement, j: unknown, o: unknown): unknown };
      }
    ).__render;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const v = hook.seamFrame(c, f.json, { ...f, heads: false }) as {
      start: number;
      pps: number;
      xHead: number;
      padT: number;
      padB: number;
      height: number;
      pLo: number;
      pHi: number;
    };
    const X = (t: number) => (t - v.start) * v.pps * f.dpr;
    const y = v.padT + ((v.pHi - f.pitch) / (v.pHi - v.pLo)) * (v.height - v.padT - v.padB);
    const x0 = Math.round(X(f.a));
    const x1 = Math.round(X(f.b));
    const d = c.getContext('2d')!.getImageData(x0, Math.round(y * f.dpr), x1 - x0, 1).data;
    const lum: number[] = [];
    for (let i = 0; i < x1 - x0; i++)
      lum.push(0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2]);
    // Inked rows per column within ±BAND CSS px of the centre line (the line's drawn width).
    const band = Math.round(f.band * f.dpr);
    const yb = Math.round(y * f.dpr) - band;
    const box = c.getContext('2d')!.getImageData(x0, yb, x1 - x0, 2 * band + 1).data;
    const paper = c.getContext('2d')!.getImageData(x0, 2, 1, 1).data;
    const width: number[] = [];
    for (let i = 0; i < x1 - x0; i++) {
      let n = 0;
      for (let r = 0; r <= 2 * band; r++) {
        const o = 4 * (r * (x1 - x0) + i);
        if (Math.max(...[0, 1, 2].map((k) => Math.abs(box[o + k] - paper[k]))) > 12) n++;
      }
      width.push(n);
    }
    return {
      lum,
      width,
      head: Math.round(v.xHead) * f.dpr - x0,
      mark: Math.round(X(f.mark)) - x0,
    };
  }, f);
}

/** Largest |second difference| of the luminance over columns [i0, i1). */
function roughness(lum: number[], i0: number, i1: number): { worst: number; at: number } {
  let worst = 0;
  let at = -1;
  for (let i = Math.max(1, i0); i < Math.min(lum.length - 1, i1); i++) {
    const s = Math.abs(2 * lum[i] - lum[i - 1] - lum[i + 1]);
    if (s > worst) {
      worst = s;
      at = i;
    }
  }
  return { worst, at };
}

async function open(page: Page, dpr: number): Promise<void> {
  await page.goto('about:blank');
  await page.setContent(
    `<body style="margin:0"><canvas id="c" width="${800 * dpr}" height="${500 * dpr}" ` +
      'style="width:800px;height:500px"></canvas></body>',
  );
  await page.addScriptTag({ content: await renderBundle() });
}

for (const dpr of [1, 2]) {
  test.describe(`dpr ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr, viewport: { width: 820, height: 520 } });

    test('no bead where the rope meets its strands, no cap at the playhead', async ({
      page,
    }, info) => {
      test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
      await open(page, dpr);
      const json = ropePiece();
      // Merges at 4 s and 16 s, a split at 8 s.
      for (const [seam, kind] of [
        [4, 'merge'],
        [8, 'split'],
      ] as const) {
        for (const dark of [false, true]) {
          for (const future of [0.35, 1]) {
            const t = seam - 1.5;
            const f = { json, t, start: t - 2, window: 6, dark, future, dpr, pitch: 59, band: 10 };
            // From just past the playhead to 30 px past the seam (800 px / 6 s).
            const r = await row(page, { ...f, a: t + 0.02, b: seam + 0.25, mark: seam });
            const label = `${kind} ${dark ? 'dark' : 'light'} ghost ${future} dpr ${dpr}`;
            // Across the seam (±12 px): smooth, no bump.
            const k = roughness(r.lum, r.mark - 12 * dpr, r.mark + 12 * dpr);
            expect(k.worst, `${label}: bump at column ${k.at - r.mark} from the seam`).toBeLessThan(
              BUMP,
            );
            // The rope just before the seam and the strands just after it: one level.
            const before = r.lum[r.mark - 8 * dpr];
            const after = r.lum[r.mark + 2 * dpr];
            expect(Math.abs(after - before), `${label}: step at the seam`).toBeLessThan(BUMP);
            // Thickness: up to 20 px past the seam the drawn width changes by at most a device px
            // or so per column (no step, neck or bead). A split is checked from before the
            // playhead (its rule's columns skipped); a merge from the meeting, since before it the
            // arriving glides cross the band.
            const a = kind === 'split' ? t - 0.1 : seam - 0.05;
            const w = await row(page, { ...f, a, b: seam + 0.15, mark: seam });
            for (let i = 1; i < w.width.length; i++) {
              if (i >= w.head - 1 && i <= w.head + dpr) continue;
              expect(
                Math.abs(w.width[i] - w.width[i - 1]),
                `${label}: width step at column ${i - w.mark} from the seam`,
              ).toBeLessThanOrEqual(dpr + 1);
            }
            if (kind === 'split') {
              // The playhead cut: the past (bright) stops at the rule; the column right of the
              // rule is the dimmed rope's, as further on.
              const p = await row(page, { ...f, a: t - 0.1, b: t + 0.2, mark: t });
              const rule = p.head;
              const right = p.lum[rule + dpr];
              const further = p.lum[rule + 8 * dpr];
              expect(Math.abs(right - further), `${label}: cap past the playhead`).toBeLessThan(3);
            }
            if (future < 1 && dpr === 2) {
              await page.locator('#c').screenshot({ path: info.outputPath('seam.png') });
              await shot(page.locator('#c'), `seam-${kind}-${dark ? 'dark' : 'light'}.png`);
            }
          }
        }
      }
    });

    test('a level fade has no hairline gaps between its slices', async ({ page }, info) => {
      test.skip(info.project.name.endsWith('-prod'), 'engine-only test: run once per engine');
      await open(page, dpr);
      const json = fadePiece();
      for (const dark of [false, true]) {
        for (const future of [0.35, 1]) {
          const f = { json, t: 3, start: 2, window: 12, dark, future, dpr, pitch: 60, band: 4 };
          // Fade out over 4–7 s, back in over 9–12 s.
          const r = await row(page, { ...f, a: 3.2, b: 13, mark: 4 });
          const k = roughness(r.lum, 0, r.lum.length);
          expect(k.worst, `${dark ? 'dark' : 'light'} ghost ${future}: gap`).toBeLessThan(BUMP);
        }
      }
      await shot(page.locator('#c'), `seam-fade-dpr${dpr}.png`);
    });
  });
}
