/**
 * Master glue and width (PLAN.md §12 "Ready for YouTube"): defaults are bit-identical to a mix
 * without them; glue takes 2–4 dB off the peaks of a dense passage (Crease) and leaves quiet
 * passages alone; width 0 is mono, 2 is wider (L/R correlation measured). Stems with them on:
 * stems.test.ts. No allocation: no-gc.test.ts ('fx').
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_MIX, stressScore } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { compile } from '../../src/core/compiler/compile';
import { flatten } from '../../src/core/flat';
import { parsePiece } from '../../src/core/schema';
import type { MixSettings, Piece } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { Driver, RATE } from './helpers';

vi.setConfig({ testTimeout: 600_000 });

const frames = (s: number) => Math.ceil((s * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;

/** L/R correlation and side/mid energy ratio. */
function stereoStats(l: Float32Array, r: Float32Array, from = 0, to = l.length) {
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let mm = 0;
  let ss = 0;
  for (let i = from; i < to; i++) {
    ll += l[i] * l[i];
    rr += r[i] * r[i];
    lr += l[i] * r[i];
    const m = 0.5 * (l[i] + r[i]);
    const s = 0.5 * (l[i] - r[i]);
    mm += m * m;
    ss += s * s;
  }
  return { corr: lr / Math.sqrt(ll * rr), sideToMid: ss / mm };
}

function loadPiece(file: string): Piece {
  const p = parsePiece(JSON.parse(readFileSync(`examples/${file}.algorhythms.json`, 'utf8')));
  if (!p.ok) throw new Error(p.errors.join('; '));
  return p.piece;
}

describe('defaults are bit-identical', () => {
  it('glue 0 and width 1 render exactly as a mix without them', () => {
    const score = flatten(stressScore(8, 6, 1, 3));
    const n = frames(6);
    const a = renderOffline({ score, mix: FIXTURE_MIX, sampleRate: RATE }, n);
    const b = renderOffline(
      { score, mix: { ...FIXTURE_MIX, glue: 0, width: 1 }, sampleRate: RATE },
      n,
    );
    expect(b.left).toEqual(a.left);
    expect(b.right).toEqual(a.right);
  });
});

describe('width', () => {
  it('0 is mono, 2 is wider; side scales by the width', () => {
    const score = flatten(stressScore(8, 6, 1, 3));
    const n = frames(6);
    const at = (width: number) =>
      renderOffline({ score, mix: { ...FIXTURE_MIX, width }, sampleRate: RATE }, n);
    const one = at(1);
    const mono = at(0);
    const wide = at(2);
    expect(mono.left).toEqual(mono.right);
    const s1 = stereoStats(one.left, one.right);
    const s2 = stereoStats(wide.left, wide.right);
    console.info(`width: correlation 1 → ${s1.corr.toFixed(3)}, 2 → ${s2.corr.toFixed(3)}`);
    expect(s2.corr).toBeLessThan(s1.corr - 0.05);
    // Linear and before the limiter (idle here): side energy × 4, mid unchanged.
    expect(s2.sideToMid / s1.sideToMid).toBeCloseTo(4, 1);
  });

  it('a live width change ramps over a block (no step)', () => {
    const score = stressScore(6, 4, 1, 2);
    const d = new Driver(score, FIXTURE_MIX);
    d.graph.play(0);
    d.run(1);
    // The output lags the change by the limiter's look-ahead.
    const at = d.left.length + d.graph.limiterDelayFrames;
    expect(d.graph.setParam('width', 0)).toBe(true);
    d.run(0.2);
    // L − R shrinks smoothly to 0 over one block.
    const diff = (i: number) => d.left[i] - d.right[i];
    let worst = 0;
    for (let i = at; i < at + BLOCK_FRAMES; i++)
      worst = Math.max(worst, Math.abs(diff(i) - diff(i - 1)));
    let typical = 0;
    for (let i = at - 4800; i < at; i++)
      typical = Math.max(typical, Math.abs(diff(i) - diff(i - 1)));
    expect(worst).toBeLessThanOrEqual(typical * 2);
    expect(Math.abs(diff(at - 1))).toBeGreaterThan(0);
    for (let i = at + BLOCK_FRAMES; i < d.left.length; i++) expect(diff(i)).toBe(0);
  });
});

describe('glue on a dense passage (Crease)', () => {
  it('takes 2–4 dB off the loudest peaks and leaves the quiet opening alone', () => {
    const piece = loadPiece('experiments/crease');
    const score = flatten(compile(piece));
    const n = frames(56);
    const input = (mix: MixSettings) => ({
      score,
      mix,
      timbres: piece.timbres,
      sampleRate: RATE,
    });
    const gOff = new Float32Array(n);
    const gOn = new Float32Array(n);
    const off = renderOffline(input(piece.mix), n, { kind: 'mix', captureGain: gOff });
    const on = renderOffline(input({ ...piece.mix, glue: 1 }), n, {
      kind: 'mix',
      captureGain: gOn,
    });
    const db = (x: number) => 20 * Math.log10(x);
    // Deepest reduction the glue adds (g_L with glue over g_L without), over the dense part.
    let deepest = 0;
    for (let i = RATE * 36; i < n; i++) deepest = Math.min(deepest, db(gOn[i] / gOff[i]));
    // The peak of each 2 s window, without and with glue, over the same span.
    let loudest = 0;
    let atLoudest = 0;
    for (let s = 36; s + 2 <= 56; s += 2) {
      let pa = 0;
      let pb = 0;
      for (let i = s * RATE; i < (s + 2) * RATE; i++) {
        pa = Math.max(pa, Math.abs(off.left[i]), Math.abs(off.right[i]));
        pb = Math.max(pb, Math.abs(on.left[i]), Math.abs(on.right[i]));
      }
      if (pa > loudest) {
        loudest = pa;
        atLoudest = db(pa / pb);
      }
    }
    let quiet = 0;
    for (let i = 0; i < RATE; i++) quiet = Math.min(quiet, db(gOn[i] / gOff[i]));
    const corr = stereoStats(off.left, off.right).corr;
    console.info(
      `glue 1 on Crease 36–56 s: deepest ${deepest.toFixed(2)} dB, loudest window's peak ` +
        `−${atLoudest.toFixed(2)} dB; opening ${quiet.toFixed(3)} dB; L/R correlation ${corr.toFixed(3)}`,
    );
    expect(deepest).toBeLessThanOrEqual(-2);
    expect(deepest).toBeGreaterThanOrEqual(-4);
    expect(atLoudest).toBeGreaterThan(1);
    expect(quiet).toBeGreaterThan(-0.05);
  });
});
