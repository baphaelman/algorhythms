/**
 * Thickness transitions (PLAN.md §11.3, owner 2026-11-21): eight lines glide into a unison and
 * bundle into one thick line, which later splits back. Reads the canvas back and measures the
 * ink per pixel column across both transitions: it narrows steadily into the meeting point and
 * widens steadily out of the split, with no thin neck at either, and the merged line is one
 * constant width.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

interface V {
  start: number;
  pps: number;
  pLo: number;
  pHi: number;
  padT: number;
  padB: number;
  height: number;
}

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const PITCHES = [48, 52, 55, 60, 64, 67, 72, 76];
/** The unison's lines meet at 4 s (glide 1–4 s); the chord's forks leave at 8 s. */
const MEET = 4;
const SPLIT = 8;

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(
    ({ pitches, split }) => {
      const h = window.__algorhythms!;
      const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown>;
      const glide = { length: 3, stagger: 0, jitter: 0, ease: 'smootherstep' };
      const notes = { kind: 'pitches', pitches };
      p.moments = [
        { id: 'start0', type: 'chord', at: 0, notes, voicing: 'even', assign: 'ordered' },
        { id: 'u', type: 'unison', at: 1, pitch: 60, octaves: false, glide },
        { id: 'c', type: 'chord', at: split, notes, voicing: 'even', assign: 'ordered', glide },
      ];
      p.key = { tonic: 'C', scale: 'major' };
      p.end = { at: 14, fade: 1 };
      h.actions.loadPiece(p);
    },
    { pitches: PITCHES, split: SPLIT },
  );
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  // Everything in the past: drawn at full opacity, no ghost fading in.
  await seek(page, 13.9);
  await frames(page);
}

/**
 * Per column at piece times ts: the number of inked pixels (device px) within ±`band` CSS px of
 * pitch 60, and their top-to-bottom extent. Columns crossed by a vertical rule are NaN.
 */
async function columns(
  page: Page,
  ts: number[],
  band = 30,
): Promise<{ ink: number[]; extent: number[]; dpr: number }> {
  await frames(page);
  return page.evaluate(
    ({ ts, band }) => {
      const v = (window.__algorhythms!.frameStats as unknown as { view: V }).view;
      const c = document.querySelector<HTMLCanvasElement>('#score')!;
      const g = c.getContext('2d')!;
      const dpr = c.width / c.getBoundingClientRect().width;
      const yc = v.padT + ((v.pHi - 60) / (v.pHi - v.pLo)) * (v.height - v.padT - v.padB);
      const y0 = Math.round((yc - band) * dpr);
      const rows = Math.round(2 * band * dpr);
      const ink: number[] = [];
      const extent: number[] = [];
      for (const t of ts) {
        const x = Math.round((t - v.start) * v.pps * dpr);
        const paper = g.getImageData(x, y0 - Math.round(40 * dpr), 1, 1).data;
        const far = g.getImageData(x, y0 - Math.round(20 * dpr), 1, 1).data;
        const d = g.getImageData(x, y0, 1, rows).data;
        const dark = (i: number, p: Uint8ClampedArray) =>
          Math.max(...[0, 1, 2].map((k) => Math.abs(d[i + k] - p[k]))) > 40;
        // A vertical rule (bar, marker) inks the whole column: skip it.
        const rule = Math.max(...[0, 1, 2].map((k) => Math.abs(far[k] - paper[k]))) > 4;
        let n = 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (let r = 0; r < rows; r++) {
          if (!dark(r * 4, paper)) continue;
          n++;
          lo = Math.min(lo, r);
          hi = Math.max(hi, r);
        }
        ink.push(rule ? NaN : n);
        extent.push(rule ? NaN : hi >= lo ? hi - lo + 1 : 0);
      }
      return { ink, extent, dpr };
    },
    { ts, band },
  );
}

/** Times stepping by about 2 px from a to b. */
async function steps(page: Page, a: number, b: number): Promise<number[]> {
  const pps = await page.evaluate(
    () => (window.__algorhythms!.frameStats as unknown as { view: V }).view.pps,
  );
  const out: number[] = [];
  for (let t = a; t <= b + 1e-9; t += 2 / pps) out.push(t);
  return out;
}

const valid = (xs: number[]) => xs.filter((x) => x === x);

test('lines bundle into the unison and peel off it, with no neck', async ({ page }) => {
  await open(page);
  // The merged line, well after the meeting.
  const mid = await columns(page, await steps(page, MEET + 1, SPLIT - 1));
  const rope = Math.max(...valid(mid.ink));
  expect(Math.min(...valid(mid.ink))).toBeGreaterThanOrEqual(rope - 1);
  // √8 lines' width: clearly thicker than one line (1.5 CSS px).
  expect(rope).toBeGreaterThanOrEqual(3.5 * mid.dpr);

  // Into the meeting: the band narrows steadily and never pinches below the merged line.
  const into = await columns(page, await steps(page, MEET - 0.6, MEET + 0.6));
  const ts = await steps(page, MEET - 0.6, MEET + 0.6);
  let last = Infinity;
  for (let i = 0; i < ts.length; i++) {
    const e = into.extent[i];
    if (e !== e) continue;
    expect(e, `extent at ${ts[i].toFixed(3)} s`).toBeLessThanOrEqual(last + 1);
    expect(into.ink[i], `ink at ${ts[i].toFixed(3)} s`).toBeGreaterThanOrEqual(rope - 1);
    last = Math.min(last, e);
  }
  // From the meeting on, one constant width (no cap, no step).
  const after = into.ink.filter((_, i) => ts[i] >= MEET + 0.03);
  expect(Math.max(...valid(after)) - Math.min(...valid(after))).toBeLessThanOrEqual(1);

  // Out of the split: the mirror image.
  const outTs = await steps(page, SPLIT - 0.6, SPLIT + 0.6);
  const out = await columns(page, outTs);
  last = 0;
  for (let i = 0; i < outTs.length; i++) {
    const e = out.extent[i];
    if (e !== e) continue;
    expect(e, `extent at ${outTs[i].toFixed(3)} s`).toBeGreaterThanOrEqual(last - 1);
    expect(out.ink[i], `ink at ${outTs[i].toFixed(3)} s`).toBeGreaterThanOrEqual(rope - 1);
    last = Math.max(last, e);
  }
  expect(last).toBeGreaterThan(3 * rope);
});
